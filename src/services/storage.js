'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Image pipeline (§29): validate type/size, strip metadata, resize, compress to
 * webp and emit a thumbnail. MySQL only ever stores the resulting URLs.
 *
 * Two drivers sit behind one interface:
 *
 *   local - files under UPLOAD_DIR, served by this process at `/uploads`.
 *           Development only: the images live on one machine's disk.
 *   s3    - objects in an S3 bucket, served by a CDN at STORAGE_PUBLIC_URL.
 *           What production runs: every API server sees the same images, and
 *           losing or replacing a server loses none of them.
 *
 * Both lay files out as `uploads/<folder>/<file>`, so a URL has the same shape
 * whichever driver produced it - only the origin in front of it differs.
 */

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const SIZES = {
  offer: { width: 1200, height: 900 },
  banner: { width: 1920, height: 640 },
  shopLogo: { width: 512, height: 512 },
  avatar: { width: 256, height: 256 },
};
const THUMB = { width: 400, height: 300 };

const KEY_ROOT = 'uploads';

// Filenames are unique per upload and never reused, so a stored object never
// changes and every cache in front of it may keep it for as long as it likes.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const uniqueName = (extension) =>
  `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${extension}`;

/**
 * Created on first use rather than at require time: development never loads
 * the SDK, and in production the credentials come from the server's IAM role
 * through the SDK's default chain - there are no keys in the environment.
 */
let s3Client = null;
function s3() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { region, endpoint } = env.storage.s3;
    s3Client = new S3Client({
      region,
      // An S3-compatible store (MinIO in development, for instance) is reached
      // by path rather than by bucket subdomain.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }
  return s3Client;
}

function assertDriver() {
  const { driver, s3: config } = env.storage;
  if (driver === 'local') return;
  if (driver !== 's3') {
    throw new ApiError(501, `Storage driver "${driver}" is not implemented`);
  }
  if (!config.bucket || !config.publicUrl) {
    // Misconfiguration, not an outage: production refuses to boot without these
    // (config/productionGuard.js), so this is only reachable in development.
    throw new ApiError(500, 'S3 storage needs S3_BUCKET and STORAGE_PUBLIC_URL');
  }
}

/** Where stored images are served from. */
const publicBase = () =>
  env.storage.driver === 's3' ? env.storage.s3.publicUrl : env.publicApiUrl;

/** An upload that failed because the store did, tagged so the failure log blames storage. */
function storageUnavailable(error, key) {
  logger.error(
    {
      event: 'STORAGE_WRITE_FAILED',
      dependency: 'STORAGE',
      category: 'STORAGE',
      key,
      err_name: error?.name,
      err_message: error?.message,
    },
    `Could not store ${key}`,
  );
  const wrapped = ApiError.serviceUnavailable('The image could not be saved. Please try again.');
  wrapped.internalCode = 'STORAGE_UNAVAILABLE';
  wrapped.dependency = 'STORAGE';
  return wrapped;
}

/** Writes a buffer into the configured store and returns its public URL. */
async function put(folder, filename, buffer, contentType = 'image/webp') {
  assertDriver();
  const relative = `${folder}/${filename}`;

  if (env.storage.driver === 's3') {
    const key = `${KEY_ROOT}/${relative}`;
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await s3().send(
        new PutObjectCommand({
          Bucket: env.storage.s3.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          CacheControl: CACHE_CONTROL,
        }),
      );
    } catch (error) {
      throw storageUnavailable(error, key);
    }
  } else {
    const dir = path.join(env.storage.uploadDir, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buffer);
  }

  return `${publicBase()}/${KEY_ROOT}/${relative}`;
}

/**
 * Processes one uploaded file.
 * @param {{buffer: Buffer, mimetype: string, size: number}} file
 * @param {{folder: string, variant: keyof typeof SIZES, thumbnail?: boolean}} options
 * @returns {Promise<{url: string, thumbnailUrl: string|null, width: number, height: number, bytes: number}>}
 */
async function processImage(file, { folder, variant = 'offer', thumbnail = true }) {
  if (!file) throw ApiError.badRequest('No file received');
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw ApiError.badRequest('Unsupported image type. Use JPEG, PNG, WebP, GIF or AVIF.');
  }
  if (file.size > env.storage.maxUploadBytes) {
    throw ApiError.badRequest(`Image exceeds the ${env.storage.maxUploadBytes / 1048576} MB limit`);
  }

  let pipeline;
  try {
    // Re-encoding through sharp also neutralises polyglot files that merely
    // claim an image mime type.
    pipeline = sharp(file.buffer, { failOn: 'error' }).rotate();
    await pipeline.metadata();
  } catch {
    throw ApiError.badRequest('File is not a readable image');
  }

  const target = SIZES[variant] || SIZES.offer;
  const main = await sharp(file.buffer)
    .rotate()
    .resize({ ...target, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  const filename = uniqueName('webp');
  const url = await put(folder, filename, main.data);

  let thumbnailUrl = null;
  if (thumbnail) {
    const thumb = await sharp(file.buffer)
      .rotate()
      .resize({ ...THUMB, fit: 'cover', position: 'attention' })
      .webp({ quality: 72 })
      .toBuffer();
    try {
      thumbnailUrl = await put(`${folder}/thumbs`, filename, thumb);
    } catch (error) {
      // The caller never learns the main image's URL, so nothing will ever
      // reference it - remove it rather than leave an orphan in the bucket.
      await remove(url);
      throw error;
    }
  }

  return {
    url,
    thumbnailUrl,
    width: main.info.width,
    height: main.info.height,
    bytes: main.info.size,
  };
}

/**
 * The store-relative path (`offers/abc.webp`) of a URL this deployment issued,
 * or null for anything else. Only URLs under our own public base qualify, so a
 * foreign or hand-edited URL can never name an object to delete.
 */
function relativePathOf(url) {
  if (typeof url !== 'string') return null;
  const prefix = `${publicBase()}/${KEY_ROOT}/`;
  if (!url.startsWith(prefix)) return null;
  const relative = url.slice(prefix.length);
  // Reject traversal and empty segments before touching any store.
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return relative;
}

/** Best-effort delete of a previously stored URL. Never throws. */
async function remove(url) {
  const relative = relativePathOf(url);
  if (!relative) return;
  try {
    assertDriver();
    if (env.storage.driver === 's3') {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3().send(
        new DeleteObjectCommand({ Bucket: env.storage.s3.bucket, Key: `${KEY_ROOT}/${relative}` }),
      );
    } else {
      await fs.rm(path.join(env.storage.uploadDir, relative), { force: true });
    }
  } catch (error) {
    logger.warn(
      { event: 'STORAGE_DELETE_FAILED', dependency: 'STORAGE', err_message: error?.message },
      `Could not delete ${relative}`,
    );
  }
}

/**
 * A real write and delete against the configured store, for Platform Health.
 * Resolves true or rejects; the caller owns the timeout.
 *
 * The name is unique per probe. A fixed one looks harmless until two probes
 * overlap - the dashboard polls every 30 seconds and an administrator can hit
 * Re-check on top of that - and then one deletes what the other is about to,
 * and a healthy store is reported as broken at random.
 */
async function probe() {
  assertDriver();
  const name = `.health-probe-${process.pid}-${crypto.randomUUID()}`;

  if (env.storage.driver === 's3') {
    // Outside `uploads/`, so a probe object is never mistaken for an image.
    const key = `.health/${name}`;
    const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const { bucket } = env.storage.s3;
    await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'ok' }));
    await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  }

  // A real write, because a readable directory on a full disk still fails.
  await fs.mkdir(env.storage.uploadDir, { recursive: true });
  const file = path.join(env.storage.uploadDir, name);
  await fs.writeFile(file, 'ok');
  await fs.unlink(file);
  return true;
}

/** A one-line description of where images go, for the health board. */
function describe() {
  return env.storage.driver === 's3'
    ? `S3 bucket ${env.storage.s3.bucket || '(unset)'}`
    : 'Upload directory';
}

module.exports = { processImage, remove, probe, describe, ALLOWED_MIME, SIZES };
