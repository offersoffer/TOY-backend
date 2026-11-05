'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * Deciding a seller registration (Self-Service Onboarding §14, §11, §19).
 *
 * The rules a reviewer's screen must not be the only thing enforcing: who may
 * decide, what a decision does to the shop's public listing, and what happens
 * when two reviewers decide the same registration at once. The database and
 * the shop service are stubbed so these run in CI, which has no MySQL.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

/** State the stubs answer from, reset before each test. */
let shop;
let updates;
let affectedRows;
let notified;
let shopServiceUpdates;

stub('db/pool', {
  queryOne: async (sql) => {
    if (sql.includes('FROM shops WHERE id')) return shop;
    if (sql.includes('shop_branches')) return { id: 9, shop_id: 1, city: 'Coimbatore', latitude: 11, longitude: 76 };
    if (sql.includes('COUNT(*)')) return { count: 0 };
    if (sql.includes('FROM users WHERE id')) return { id: 3, name: 'Reviewer', email: 'r@example.com' };
    return null;
  },
  query: async () => [],
  transaction: async (fn) =>
    fn({
      query: async (sql, params) => {
        updates.push({ sql, params });
        return [{ affectedRows }];
      },
    }),
});

stub('services/notifications', {
  notifyShopTeam: async (shopId, payload) => notified.push({ shopId, ...payload }),
});

stub('modules/shops/shop.service', {
  update: async (shopId, payload) => shopServiceUpdates.push({ shopId, payload }),
  create: async () => ({ id: 1 }),
});

const service = require(path.join(SRC, 'modules/onboarding/review.service'));
const v = require(path.join(SRC, 'services/shopVerification'));

const SUPER = { id: 3, isSuperAdmin: true, globalPermissions: [] };
/** A delegated reviewer: the permission, globally, without Super Admin. */
const REVIEWER = { id: 4, isSuperAdmin: false, globalPermissions: ['REVIEW_SELLER_REGISTRATIONS'] };
/** A merchant who holds it only through a shop. */
const MERCHANT = {
  id: 7,
  isSuperAdmin: false,
  globalPermissions: [],
  effectivePermissions: ['REVIEW_SELLER_REGISTRATIONS', 'EDIT_SHOP'],
  shops: [{ shopId: 1, permissions: ['REVIEW_SELLER_REGISTRATIONS', 'EDIT_SHOP'] }],
};

const pending = () => ({
  id: 1,
  name: 'Meenakshi Stores',
  slug: 'meenakshi-stores',
  status: 'inactive',
  registration_source: 'SELF_REGISTERED',
  verification_status: v.PENDING_VERIFICATION,
  verification_details: null,
});

/**
 * The UPDATE the decision made, as a `SET column = value` map.
 *
 * Only the SET clause: `verification_status` appears in the WHERE clause too
 * (that is the concurrency guard), and reading both would report the status
 * the row had before rather than the one being written.
 */
const columnsSet = () => {
  const write = updates.find((u) => u.sql.includes('UPDATE shops'));
  assert.ok(write, 'expected an UPDATE on shops');
  const setClause = write.sql.slice(write.sql.indexOf('SET'), write.sql.indexOf('WHERE'));
  const names = [...setClause.matchAll(/(\w+)\s*=\s*\?/g)].map((m) => m[1]);
  return Object.fromEntries(names.map((name, index) => [name, write.params[index]]));
};

test.beforeEach(() => {
  shop = pending();
  updates = [];
  affectedRows = 1;
  notified = [];
  shopServiceUpdates = [];
});

// ---- who may decide -------------------------------------------------------

test('a merchant cannot approve their own registration', async () => {
  // The permission is in their effective set, but only through the shop. §14
  // is explicit that a merchant may never approve their own shop, and a
  // shop-scoped grant is exactly how that would happen by accident.
  await assert.rejects(
    () => service.decide(1, v.VERIFIED, {}, MERCHANT),
    (error) => error.status === 403 && /authorised reviewer/i.test(error.message),
  );
  assert.equal(updates.length, 0, 'nothing should have been written');
  assert.equal(notified.length, 0);
});

test('a signed-in customer cannot decide anything', async () => {
  const customer = { id: 9, isSuperAdmin: false, globalPermissions: [] };
  for (const to of [v.VERIFIED, v.REJECTED, v.ADDITIONAL_INFO_REQUIRED, v.SUSPENDED]) {
    shop = pending();
    await assert.rejects(
      () => service.decide(1, to, { reason: 'Not a real business at all' }, customer),
      (error) => error.status === 403,
      `${to} should be refused`,
    );
  }
});

test('a delegated reviewer can decide without being Super Admin', async () => {
  // The point of the named permission: review is day-to-day work and should
  // not require handing out the keys to the platform.
  const { registration } = await service.decide(1, v.VERIFIED, {}, REVIEWER);
  assert.ok(registration);
  assert.equal(columnsSet().verification_status, v.VERIFIED);
  assert.equal(columnsSet().verification_reviewer_id, REVIEWER.id);
});

// ---- what a decision does -------------------------------------------------

test('approving puts the shop live and records who decided it', async () => {
  await service.decide(1, v.VERIFIED, {}, SUPER);
  const set = columnsSet();
  assert.equal(set.verification_status, v.VERIFIED);
  assert.equal(set.status, 'active');
  assert.equal(set.verification_reviewer_id, SUPER.id);
  assert.equal(notified[0].type, 'SELLER_REGISTRATION_VERIFIED');
});

test('approving without activating leaves the listing alone', async () => {
  // §11: verified and active are different things, and a reviewer may want
  // to approve now and launch later.
  await service.decide(1, v.VERIFIED, { activate: false }, SUPER);
  const set = columnsSet();
  assert.equal(set.verification_status, v.VERIFIED);
  assert.equal(set.status, undefined, 'the listing should not have been touched');
});

test('suspending takes the shop off the marketplace, not just the label', async () => {
  // The one that would be a security bug if it were forgotten. The activation
  // guard only fires on a transition *into* active, so a shop that is already
  // live stays live however its verification status changes - suspending
  // without this would move a label and leave the shop in search results.
  shop = { ...pending(), status: 'active', verification_status: v.VERIFIED };
  await service.decide(1, v.SUSPENDED, { reason: 'Selling counterfeit goods' }, SUPER);

  const set = columnsSet();
  assert.equal(set.verification_status, v.SUSPENDED);
  assert.equal(set.status, 'inactive');
});

test('rejecting also takes it off the marketplace', async () => {
  shop = { ...pending(), status: 'active' };
  await service.decide(1, v.REJECTED, { reason: 'This address is a residential flat' }, SUPER);
  assert.equal(columnsSet().status, 'inactive');
});

test('asking for more information does not change the listing', async () => {
  await service.decide(1, v.ADDITIONAL_INFO_REQUIRED, { reason: 'Send a photo of the shop front' }, SUPER);
  const set = columnsSet();
  assert.equal(set.verification_status, v.ADDITIONAL_INFO_REQUIRED);
  assert.equal(set.status, undefined);
});

// ---- the reason -----------------------------------------------------------

test('a rejection without a usable reason is refused', async () => {
  // §12 shows this text to the seller verbatim, so "no" is not a decision
  // anybody can act on.
  for (const reason of [null, '', 'bad']) {
    shop = pending();
    await assert.rejects(
      () => service.decide(1, v.REJECTED, { reason }, SUPER),
      (error) => error.status === 422,
      `reason ${JSON.stringify(reason)} should be refused`,
    );
  }
  assert.equal(notified.length, 0);
});

test('the reason reaches the seller in the notification', async () => {
  await service.decide(1, v.REJECTED, { reason: 'This address is a residential flat' }, SUPER);
  assert.match(notified[0].message, /residential flat/);
});

// ---- conflicting decisions ------------------------------------------------

test('a second reviewer deciding the same registration gets a conflict', async () => {
  // The UPDATE is conditional on the status the reviewer was looking at. Two
  // people working one queue is not hypothetical, and without the condition
  // the second write would overwrite the first and notify the seller twice.
  affectedRows = 0;
  await assert.rejects(
    () => service.decide(1, v.VERIFIED, {}, SUPER),
    (error) => error.status === 409 && /someone else/i.test(error.message),
  );
  assert.equal(notified.length, 0, 'a decision that did not happen must not notify');
});

test('the UPDATE is conditional on the status that was read', async () => {
  await service.decide(1, v.VERIFIED, {}, SUPER);
  const write = updates.find((u) => u.sql.includes('UPDATE shops'));
  assert.match(write.sql, /WHERE id = \? AND verification_status = \?/);
  assert.equal(write.params[write.params.length - 1], v.PENDING_VERIFICATION);
});

// ---- the existing marketplace ---------------------------------------------

test('an admin-created shop has no registration to decide', async () => {
  // §15: existing shops must not be pushed into the review lifecycle, which
  // is how a live shop would unexpectedly become pending.
  shop = { ...pending(), registration_source: 'ADMIN_CREATED', verification_status: null, status: 'active' };
  await assert.rejects(
    () => service.decide(1, v.SUSPENDED, { reason: 'Something is wrong here' }, SUPER),
    (error) => error.status === 409 && /OffersOffer team/i.test(error.message),
  );
  assert.equal(updates.length, 0);
});

test('a decision the lifecycle does not allow is refused', async () => {
  // Approving a draft nobody submitted, for instance.
  shop = { ...pending(), verification_status: v.DRAFT };
  await assert.rejects(
    () => service.decide(1, v.VERIFIED, {}, SUPER),
    (error) => error.status === 409,
  );
});

// ---- the listing, on its own ----------------------------------------------

test('changing the listing goes through the shop service, not a direct write', async () => {
  // Otherwise the guard that stops an unreviewed shop going public would have
  // a second way in that does not pass it.
  shop = { ...pending(), verification_status: v.VERIFIED, status: 'inactive' };
  await service.setListing(1, 'active', SUPER);

  assert.equal(shopServiceUpdates.length, 1);
  assert.deepEqual(shopServiceUpdates[0], { shopId: 1, payload: { status: 'active' } });
  assert.equal(updates.length, 0, 'no direct UPDATE on shops');
});
