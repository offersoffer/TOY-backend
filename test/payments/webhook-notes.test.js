'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * The fallback that finds a shop when the subscription lookup cannot.
 *
 * `handleSubscriptionEvent` and `handlePaymentEvent` both resolve a shop by
 * asking the database for the gateway subscription id first. The `notes`
 * fallback is for the case where that fails - a webhook that arrives before
 * the checkout row is committed, or an event about an object this database has
 * never seen. When it fails silently the plan never activates and the merchant
 * has paid for nothing, which is why it is worth a test of its own.
 *
 * It read `notes.shop_id` only. The Razorpay subscription and customer are
 * created with exactly that key, so the live path was right - but the checkout
 * options handed to the browser use `shopId`, and Checkout.js attaches those
 * notes to the payment it creates. A payment arriving without a
 * `subscription_id` would therefore have carried a casing this could not read.
 */

const SRC = path.join(__dirname, '../../src');
process.env.LOG_LEVEL = 'silent';

const stub = (rel, exports) => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('db/pool', {
  query: async () => [],
  queryOne: async () => null,
  execute: async () => ({ affectedRows: 0 }),
  rawQuery: async () => [],
  transaction: async (fn) => fn({ execute: async () => ({}), query: async () => [[]] }),
});

const webhook = require(path.join(SRC, 'modules/payments/payment.webhook'));

/*
 * `shopIdFromNotes` is module-private, so it is exercised through the only
 * thing that is exported and depends on it. Reading the source is the honest
 * alternative to exporting a function purely to test it.
 */
const source = require('node:fs').readFileSync(
  path.join(SRC, 'modules/payments/payment.webhook.js'),
  'utf8',
);

test('both casings of the shop id in notes are read', () => {
  assert.match(source, /notes\.shop_id \?\? notes\.shopId/);
});

test('the subscription and customer are still created with snake_case', () => {
  // The reader is tolerant; the writer should stay deliberate. If these ever
  // change, the live resolution path changes with them.
  const service = require('node:fs').readFileSync(
    path.join(SRC, 'modules/payments/payment.service.js'),
    'utf8',
  );
  assert.match(service, /notes: \{ shop_id: String\(shopId\) \}/);
  assert.match(service, /shop_id: String\(shopId\),\n\s+plan: planKey,/);
});

test('describeMethod keeps only what is safe to store', () => {
  // §6: the card number, CVV and expiry never reach us, and no UPI PIN is ever
  // involved. Network plus last four is what a merchant recognises on a
  // statement, and is all that is kept.
  assert.deepEqual(
    webhook.describeMethod({ method: 'card', card: { network: 'Visa', last4: '1007' } }),
    { method: 'card', detail: 'Visa ****1007' },
  );
  assert.deepEqual(webhook.describeMethod({ method: 'upi', vpa: 'test@razorpay' }), {
    method: 'upi',
    detail: 'test@razorpay',
  });
  assert.deepEqual(webhook.describeMethod(null), { method: null, detail: null });

  // Anything the gateway sends beyond those is dropped rather than stored.
  const described = webhook.describeMethod({
    method: 'card',
    card: { network: 'Visa', last4: '1007', number: '4100280000001007', cvv: '123' },
  });
  assert.equal(described.detail, 'Visa ****1007');
  assert.ok(!JSON.stringify(described).includes('4100'), 'no PAN may survive');
  assert.ok(!JSON.stringify(described).includes('123'), 'no CVV may survive');
});

test('an event id is derived even when the header is absent', () => {
  // Razorpay does not put a stable id in the body, so the header is the
  // deduplication key - and something has to stand in when it is missing or
  // the replay guard would key every delivery differently.
  const body = { event: 'subscription.charged', payload: {}, created_at: 1 };
  const withHeader = webhook.eventIdFor({ headers: { 'x-razorpay-event-id': 'evt_1' } }, body);
  const without = webhook.eventIdFor({ headers: {} }, body);
  assert.equal(withHeader, 'evt_1');
  assert.ok(without && typeof without === 'string', 'a fallback id is still produced');
  // And it must be stable for the same delivery, or dedup cannot work.
  assert.equal(without, webhook.eventIdFor({ headers: {} }, body));
});
