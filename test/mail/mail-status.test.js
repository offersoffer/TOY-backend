'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * What the health probes are allowed to claim about email.
 *
 * On 17 Sep `/health` reported mail as fine for fifteen minutes while Gmail
 * rejected every login: the flag behind it only asked whether SMTP_HOST was
 * set. These assertions are about the difference between "configured" and
 * "working", which is the distinction that was missing.
 *
 * nodemailer is stubbed into the module cache before mailer is loaded, because
 * mailer builds its transport lazily but resolves the module at require time.
 */

const nodemailerPath = require.resolve('nodemailer');

let verifyResult = () => true;
let sendResult = () => ({ messageId: 'stub' });

require.cache[nodemailerPath] = {
  id: nodemailerPath,
  filename: nodemailerPath,
  loaded: true,
  exports: {
    createTransport: () => ({
      verify: async () => verifyResult(),
      sendMail: async () => sendResult(),
    }),
  },
};

// A host is what makes the transport "configured"; without it every path below
// short-circuits to the outbox and there is nothing to report on.
process.env.SMTP_HOST = process.env.SMTP_HOST || 'smtp.example.test';

const mailer = require('../../src/utils/mailer');

const message = { to: 'someone@example.test', subject: 'Test', text: 'Body' };

test('a configured transport starts unverified, not ready', async () => {
  // Nothing has been proven yet. Claiming "ready" here is the old bug in
  // miniature: a guess about a dependency, reported as fact.
  assert.equal(mailer.status(), 'unverified');
});

test('a successful boot check reports ready', async () => {
  verifyResult = () => true;
  assert.equal(await mailer.verifyTransport(), true);
  assert.equal(mailer.status(), 'ready');
});

test('a rejected login reports unavailable, not ready', async () => {
  verifyResult = () => {
    throw new Error('Invalid login: 534-5.7.9 Application-specific password required');
  };
  assert.equal(await mailer.verifyTransport(), false);
  assert.equal(mailer.status(), 'unavailable');
});

test('a failed send turns the status over without waiting for a restart', async () => {
  verifyResult = () => true;
  await mailer.verifyTransport();
  assert.equal(mailer.status(), 'ready');

  // The credential is revoked while the process is running - which is exactly
  // what a password rotation does to a server nobody has restarted yet.
  sendResult = () => {
    throw new Error('Invalid login');
  };
  const result = await mailer.send(message);
  assert.equal(result.delivered, false);
  assert.equal(mailer.status(), 'unavailable');
});

test('a send that succeeds again reports ready again', async () => {
  sendResult = () => ({ messageId: 'stub' });
  const result = await mailer.send(message);
  assert.equal(result.delivered, true);
  assert.equal(mailer.status(), 'ready');
});

test('the status vocabulary is exactly what the health probes map', async () => {
  // platformHealth maps these four onto its own; an unmapped value there falls
  // back to "not configured", which would read as reassuring rather than wrong.
  const allowed = new Set(['not-configured', 'unverified', 'ready', 'unavailable']);
  assert.ok(allowed.has(mailer.status()));
});
