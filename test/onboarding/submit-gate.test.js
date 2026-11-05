'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * What `submit` refuses (Self-Service Onboarding §10, §7).
 *
 * The wizard checks these too, but the wizard is a convenience and this is the
 * gate: §10 says every required field is validated again on the backend, and
 * §19 says never trust the client's view of the map confirmation. The database
 * and the shop service are stubbed so these run in CI, which has no MySQL.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

let shop;
let branch;
let categories;
let updates;

stub('db/pool', {
  queryOne: async (sql) => {
    if (sql.includes('FROM shops WHERE id')) return shop;
    if (sql.includes('shop_branches')) return branch;
    if (sql.includes('shop_members')) return { 1: 1 };
    return null;
  },
  query: async (sql) => {
    if (sql.includes('shop_categories')) return categories;
    return [];
  },
  execute: async (sql, params) => {
    updates.push({ sql, params });
    return { affectedRows: 1 };
  },
});
stub('modules/shops/shop.service', { create: async () => ({ id: 1 }), update: async () => {} });
stub('services/notifications', { notifyShopTeam: async () => {} });

const service = require(path.join(SRC, 'modules/onboarding/onboarding.service'));
const v = require(path.join(SRC, 'services/shopVerification'));

const SELLER = { id: 7, isSuperAdmin: false };

const completeShop = () => ({
  id: 1,
  name: 'Vaigai Silks',
  description: 'Kanchipuram silks',
  contact_number: '+91 97890 41201',
  status: 'inactive',
  verification_status: v.DRAFT,
});

const confirmedBranch = () => ({
  id: 10,
  address: '14 North Avani Moola Street',
  city: 'Madurai',
  state: 'Tamil Nadu',
  pincode: '625001',
  latitude: 9.9196,
  longitude: 78.1197,
  location_confirmed_at: new Date(),
});

test.beforeEach(() => {
  shop = completeShop();
  branch = confirmedBranch();
  categories = [{ 1: 1 }];
  updates = [];
});

const submitted = () => updates.some((u) => u.sql.includes("verification_status = 'PENDING_VERIFICATION'"));

test('a complete registration submits', async () => {
  const result = await service.submit(1, SELLER);
  assert.equal(submitted(), true);
  assert.equal(result.verificationStatus, v.DRAFT); // re-read is stubbed; the write is what matters
});

test('a confirmation with no coordinates is not a confirmation', async () => {
  // §7: if the provider cannot return coordinates, the location must not be
  // silently treated as confirmed. A flag on its own is a client assertion.
  branch = { ...confirmedBranch(), latitude: null, longitude: null };
  await assert.rejects(() => service.submit(1, SELLER), (e) => e.status === 422);
  assert.equal(submitted(), false);
});

test('coordinates with no confirmation are not enough either', async () => {
  branch = { ...confirmedBranch(), location_confirmed_at: null };
  await assert.rejects(
    () => service.submit(1, SELLER),
    (e) => e.status === 422 && /Confirm your shop location/i.test(e.message),
  );
  assert.equal(submitted(), false);
});

test('missing required shop fields are named, all of them at once', async () => {
  // Returning them one at a time turns finishing a form into a guessing game.
  shop = { ...completeShop(), description: null, contact_number: null };
  categories = [];
  await assert.rejects(
    () => service.submit(1, SELLER),
    (e) => e.status === 422
      && /Shop description/.test(e.message)
      && /Shop contact number/.test(e.message)
      && /Business category/.test(e.message),
  );
});

test('an address without a pincode cannot be submitted', async () => {
  branch = { ...confirmedBranch(), pincode: null };
  await assert.rejects(() => service.submit(1, SELLER), (e) => e.status === 422 && /Pincode/.test(e.message));
});

test('submitting something already pending is not an error', async () => {
  // §10, §24: a retry after a dropped connection must look like success,
  // because from the seller's side it is - the registration is in the queue.
  shop = { ...completeShop(), verification_status: v.PENDING_VERIFICATION };
  const result = await service.submit(1, SELLER);
  assert.equal(result.verificationStatus, v.PENDING_VERIFICATION);
  assert.equal(submitted(), false, 'must not write a second submission');
});

test('a verified registration cannot be resubmitted', async () => {
  shop = { ...completeShop(), verification_status: v.VERIFIED };
  await assert.rejects(() => service.submit(1, SELLER), (e) => e.status === 409);
});

test('an admin-created shop is not a registration', async () => {
  // §15: the wizard must never be able to drag an existing shop into review.
  shop = { ...completeShop(), verification_status: null };
  await assert.rejects(() => service.submit(1, SELLER), (e) => e.status === 409);
});

test('the location state never reads CONFIRMED before it is', async () => {
  // §7 is explicit that a selected pin and a confirmed one are different
  // things, and the clients render straight from this field.
  branch = { ...confirmedBranch(), location_confirmed_at: null };
  assert.equal((await service.present(shop)).address.locationState, 'PIN_SELECTED_NOT_CONFIRMED');

  branch = { ...confirmedBranch(), latitude: null, longitude: null, location_confirmed_at: null };
  assert.equal((await service.present(shop)).address.locationState, 'NOT_SELECTED');

  branch = confirmedBranch();
  assert.equal((await service.present(shop)).address.locationState, 'CONFIRMED');
});

test('a pending registration is not public even once verified, until it is active', async () => {
  shop = { ...completeShop(), verification_status: v.VERIFIED, status: 'inactive' };
  assert.equal((await service.present(shop)).isPublic, false);
  shop = { ...completeShop(), verification_status: v.VERIFIED, status: 'active' };
  assert.equal((await service.present(shop)).isPublic, true);
});
