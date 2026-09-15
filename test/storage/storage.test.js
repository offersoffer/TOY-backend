'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Configuration is read once, when env.js is first required, so the S3 setup
// has to be in place before anything below loads it. Values set here win over
// any developer `.env` (dotenv never overrides an existing variable).
process.env.STORAGE_DRIVER = 's3';
process.env.S3_BUCKET = 'offersoffer-media-prod';
process.env.S3_REGION = 'ap-south-1';
process.env.STORAGE_PUBLIC_URL = 'https://media.offersoffer.in/';
process.env.PUBLIC_API_URL = 'http://localhost:3000';
process.env.LOG_LEVEL = 'silent';

const sharp = require('sharp');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const env = require('../../src/config/env');
const storage = require('../../src/services/storage');
const { check } = require('../../src/config/productionGuard');

/**
 * The image store's promises, as tests. The AWS client is stubbed at `send`, so
 * these pin exactly what reaches S3 - bucket, key, headers - without a network
 * or credentials.
 */

let sent = [];
let failWith = null;
S3Client.prototype.send = async function send(command) {
  sent.push(command);
  if (failWith && command instanceof PutObjectCommand && failWith(command)) {
    throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
  }
  return {};
};

test.beforeEach(() => {
  sent = [];
  failWith = null;
  env.storage.driver = 's3';
});

async function sampleUpload() {
  const buffer = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 120, b: 20 } },
  })
    .jpeg()
    .toBuffer();
  return { buffer, mimetype: 'image/jpeg', size: buffer.length };
}

test('an upload stores the image and its thumbnail in S3 and returns CDN URLs', async () => {
  const result = await storage.processImage(await sampleUpload(), {
    folder: 'offers',
    variant: 'offer',
  });

  const puts = sent.filter((command) => command instanceof PutObjectCommand);
  assert.equal(puts.length, 2);

  const [main, thumb] = puts.map((command) => command.input);
  assert.match(main.Key, /^uploads\/offers\/[a-z0-9]+-[0-9a-f]{16}\.webp$/);
  assert.equal(thumb.Key, main.Key.replace('uploads/offers/', 'uploads/offers/thumbs/'));
  for (const input of [main, thumb]) {
    assert.equal(input.Bucket, 'offersoffer-media-prod');
    assert.equal(input.ContentType, 'image/webp');
    assert.equal(input.CacheControl, 'public, max-age=31536000, immutable');
    assert.ok(Buffer.isBuffer(input.Body) && input.Body.length > 0);
  }

  // The trailing slash in STORAGE_PUBLIC_URL must not double up in the URL.
  assert.equal(result.url, `https://media.offersoffer.in/${main.Key}`);
  assert.equal(result.thumbnailUrl, `https://media.offersoffer.in/${thumb.Key}`);
  assert.equal(result.width, 1200);
  assert.equal(result.height, 900);
});

test('a failed S3 write is a retryable storage error, not a raw SDK error', async () => {
  failWith = () => true;
  await assert.rejects(
    storage.processImage(await sampleUpload(), { folder: 'shops', variant: 'shopLogo' }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.internalCode, 'STORAGE_UNAVAILABLE');
      assert.equal(error.dependency, 'STORAGE');
      assert.doesNotMatch(error.message, /Access Denied/);
      return true;
    },
  );
});

test('if the thumbnail fails, the already-stored main image is removed', async () => {
  failWith = (command) => command.input.Key.includes('/thumbs/');
  await assert.rejects(storage.processImage(await sampleUpload(), { folder: 'offers' }));

  const mainKey = sent.find((c) => c instanceof PutObjectCommand).input.Key;
  const deletes = sent.filter((c) => c instanceof DeleteObjectCommand);
  assert.deepEqual(
    deletes.map((c) => c.input),
    [{ Bucket: 'offersoffer-media-prod', Key: mainKey }],
  );
});

test('remove deletes only objects this deployment issued', async () => {
  await storage.remove('https://media.offersoffer.in/uploads/offers/abc.webp');
  await storage.remove('https://evil.example.com/uploads/offers/abc.webp');
  await storage.remove('https://media.offersoffer.in/uploads/../secrets.txt');
  await storage.remove('https://media.offersoffer.in/uploads/offers//abc.webp');
  await storage.remove(null);

  assert.deepEqual(
    sent.map((c) => c.input),
    [{ Bucket: 'offersoffer-media-prod', Key: 'uploads/offers/abc.webp' }],
  );
});

test('remove never throws, even when S3 does', async () => {
  const stub = S3Client.prototype.send;
  S3Client.prototype.send = async () => {
    throw new Error('network down');
  };
  try {
    await storage.remove('https://media.offersoffer.in/uploads/offers/abc.webp');
  } finally {
    S3Client.prototype.send = stub;
  }
});

test('the health probe writes and deletes outside uploads/', async () => {
  assert.equal(await storage.probe(), true);
  const [put, del] = sent;
  assert.ok(put instanceof PutObjectCommand && del instanceof DeleteObjectCommand);
  assert.match(put.input.Key, /^\.health\/\.health-probe-/);
  assert.equal(del.input.Key, put.input.Key);
});

test('the local driver keeps the URL shape the apps already use', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oo-uploads-'));
  const previousDir = env.storage.uploadDir;
  env.storage.driver = 'local';
  env.storage.uploadDir = dir;
  t.after(async () => {
    env.storage.uploadDir = previousDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const result = await storage.processImage(await sampleUpload(), { folder: 'avatars', variant: 'avatar' });
  assert.match(result.url, /^http:\/\/localhost:3000\/uploads\/avatars\/[^/]+\.webp$/);

  const relative = result.url.replace('http://localhost:3000/uploads/', '');
  await fs.access(path.join(dir, relative));
  await storage.remove(result.url);
  await assert.rejects(fs.access(path.join(dir, relative)));
  assert.equal(sent.length, 0, 'the local driver never calls S3');
});

test('production refuses to start without shared image storage', () => {
  const base = {
    db: { database: 'offers_production', host: 'db', user: 'offers_app_prod', password: 'x' },
    seed: { demoData: false },
  };
  const previous = process.env.PRODUCTION_DB_NAME;
  process.env.PRODUCTION_DB_NAME = 'offers_production';
  try {
    const problemsFor = (storageConfig) => check({ ...base, storage: storageConfig });
    const s3 = (overrides) => ({
      driver: 's3',
      s3: { bucket: 'offersoffer-media-prod', publicUrl: 'https://media.offersoffer.in', ...overrides },
    });

    assert.deepEqual(problemsFor(s3({})), []);
    assert.match(problemsFor({ driver: 'local', s3: {} }).join(), /STORAGE_DRIVER/);
    assert.match(problemsFor(s3({ bucket: '' })).join(), /S3_BUCKET/);
    assert.match(problemsFor(s3({ bucket: 'offersoffer-media-staging' })).join(), /staging/);
    assert.match(problemsFor(s3({ publicUrl: '' })).join(), /STORAGE_PUBLIC_URL/);
    assert.match(problemsFor(s3({ publicUrl: 'http://media.offersoffer.in' })).join(), /https/);
  } finally {
    if (previous === undefined) delete process.env.PRODUCTION_DB_NAME;
    else process.env.PRODUCTION_DB_NAME = previous;
  }
});
