'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Localhost must not reach a recipient.
 *
 * An offer notification arrived in a real inbox reading
 * `http://localhost:4200/offers/...` - both on the "View this offer" button and
 * on the copy-paste link printed beneath it. Two separate things allowed it:
 *
 *   1. `productionGuard` validated `STORAGE_PUBLIC_URL` but never `APP_URL`, so
 *      a production process could boot with the development default.
 *   2. The mailer sent through SMTP whenever `SMTP_HOST` was set, with no
 *      interest in whether the links it was sending were reachable - so a
 *      developer `.env` holding working Gmail credentials mailed real people.
 *
 * These tests pin both. The transport is stubbed; nothing here sends mail or
 * opens a socket.
 */

const nodemailerPath = require.resolve('nodemailer');

let sent = [];
require.cache[nodemailerPath] = {
  id: nodemailerPath,
  filename: nodemailerPath,
  loaded: true,
  exports: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (message) => {
        sent.push(message);
        return { messageId: 'stub' };
      },
    }),
  },
};

// A configured transport, and links that only work on this machine. This is the
// combination that produced the bad email, and it must not send.
process.env.SMTP_HOST = 'smtp.example.test';
process.env.APP_URL = 'http://localhost:4200';
process.env.LOG_LEVEL = 'silent';
delete process.env.MAIL_SEND_WITH_LOCAL_LINKS;

const mailer = require('../../src/utils/mailer');
const { check, LOCAL_ADDRESS } = require('../../src/config/productionGuard');

test.beforeEach(() => {
  sent = [];
});

test('a configured transport withholds mail whose links are local', async () => {
  const result = await mailer.send({
    to: 'customer@example.test',
    subject: 'Zara: Scan test - free coffee',
    text: 'View it here: http://localhost:4200/offers/41',
    html: '<a href="http://localhost:4200/offers/41">View this offer</a>',
  });

  assert.equal(sent.length, 0, 'nothing may reach the SMTP transport');
  assert.equal(result.delivered, false);
  assert.equal(result.transport, 'outbox');
  assert.equal(result.reason, 'LOCAL_APP_URL');
});

test('the withheld message is still written to the outbox, so the flow is testable', async () => {
  const before = new Set(fs.existsSync(mailer.OUTBOX_DIR) ? fs.readdirSync(mailer.OUTBOX_DIR) : []);

  await mailer.send({
    to: 'outbox-probe@example.test',
    subject: 'Reset your password',
    text: 'http://localhost:4200/auth/reset-password?token=abc',
  });

  const written = (fs.existsSync(mailer.OUTBOX_DIR) ? fs.readdirSync(mailer.OUTBOX_DIR) : []).filter(
    (name) => !before.has(name),
  );
  assert.equal(written.length, 1, 'the developer still gets the message to look at');

  const file = path.join(mailer.OUTBOX_DIR, written[0]);
  assert.match(fs.readFileSync(file, 'utf8'), /reset-password\?token=abc/);
  fs.rmSync(file, { force: true });
});

test('every template renders a public link when APP_URL is public', () => {
  // The templates themselves hold no address; they interpolate whatever the
  // caller passes. This asserts that - so a localhost link can only ever come
  // from configuration, never from the mail layer.
  const url = 'https://offersoffer.in/offers/41';
  const offer = { id: 41, title: 'Scan test - free coffee', shop_name: 'Zara', offer_text: 'Free coffee' };

  const rendered = [
    mailer.templates.verifyEmail('Ravi', url),
    mailer.templates.resetPassword('Ravi', url),
    mailer.templates.newOffer('Ravi', offer, 'A shop you follow published an offer.', url),
    mailer.templates.offerExpiring('Ravi', offer, url),
    mailer.templates.serviceOfferExpiring('Ravi', offer, url),
  ];

  for (const message of rendered) {
    const body = `${message.subject}\n${message.text}\n${message.html}`;
    assert.ok(!LOCAL_ADDRESS.test(body), `a local address survived into "${message.subject}"`);
    assert.match(body, /https:\/\/offersoffer\.in\/offers\/41/);
  }
});

test('production refuses to start when APP_URL or PUBLIC_API_URL is local', () => {
  const base = {
    isProduction: true,
    db: { database: 'offers_production', host: 'db', user: 'offers_app_prod', password: 'x' },
    seed: { demoData: false },
    storage: {
      driver: 's3',
      s3: { bucket: 'offersoffer-media-prod', publicUrl: 'https://media.offersoffer.in' },
    },
    appUrl: 'https://offersoffer.in',
    publicApiUrl: 'https://offersoffer.in',
  };

  const previous = process.env.PRODUCTION_DB_NAME;
  process.env.PRODUCTION_DB_NAME = 'offers_production';
  try {
    const problemsFor = (overrides) => check({ ...base, ...overrides }).join(' | ');

    assert.deepEqual(check(base), [], 'a fully public configuration is accepted');

    // The exact value that shipped in the bad email.
    assert.match(problemsFor({ appUrl: 'http://localhost:4200' }), /APP_URL.*localhost/);
    assert.match(problemsFor({ appUrl: 'http://127.0.0.1:4200' }), /APP_URL/);
    assert.match(problemsFor({ appUrl: 'http://10.0.2.2:4200' }), /APP_URL/);
    assert.match(problemsFor({ appUrl: '' }), /APP_URL is not set/);

    // Public host but plain http: still not something to put in a customer's
    // inbox, and the same rule STORAGE_PUBLIC_URL already applies.
    assert.match(problemsFor({ appUrl: 'http://offersoffer.in' }), /https/);

    assert.match(problemsFor({ publicApiUrl: 'http://localhost:3000' }), /PUBLIC_API_URL.*localhost/);
    assert.match(problemsFor({ publicApiUrl: '' }), /PUBLIC_API_URL is not set/);

    // The message has to name the setting and say what it breaks, because it is
    // read once by someone who needs to know which line to change.
    const message = problemsFor({ appUrl: 'http://localhost:4200' });
    assert.match(message, /QR code/);
  } finally {
    if (previous === undefined) delete process.env.PRODUCTION_DB_NAME;
    else process.env.PRODUCTION_DB_NAME = previous;
  }
});

test('the local-address pattern catches the addresses that actually appear', () => {
  for (const value of [
    'http://localhost:4200',
    'https://localhost',
    'http://127.0.0.1:3000',
    'http://0.0.0.0:3000',
    'http://[::1]:4200',
    'http://host.docker.internal:3000',
    'http://10.0.2.2:3000',
  ]) {
    assert.ok(LOCAL_ADDRESS.test(value), `${value} should be rejected`);
  }

  for (const value of [
    'https://offersoffer.in',
    'https://www.offersoffer.in',
    'https://media.offersoffer.in',
    // Not a local address just because a hostname contains the substring.
    'https://localhost.offersoffer.in',
  ]) {
    assert.ok(!LOCAL_ADDRESS.test(value), `${value} should be accepted`);
  }
});
