'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * Which experience a seller gets while their registration is in review
 * (Self-Service Onboarding §12).
 *
 * A self-registered seller holds ADMIN on their own shop from the moment the
 * draft exists - that is deliberate, and it is what lets them edit and submit
 * it. But ADMIN carries the management permissions, and `canAccessAdmin` is
 * computed from exactly those, so without care the act of starting a
 * registration promotes a customer to merchant. On mobile that is not a
 * cosmetic problem: `RootNavigator` swaps the whole app for the Shop Admin
 * one, mid-wizard, with no route back to the customer tabs.
 *
 * The database is stubbed so these run in CI, which has no MySQL.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));

let roles = [];
let memberships = [];

const poolId = resolve('db/pool');
require.cache[poolId] = {
  id: poolId,
  filename: poolId,
  loaded: true,
  exports: {
    query: async (sql) => (sql.includes('shop_members') ? memberships : roles),
  },
};

const access = require(path.join(SRC, 'services/accessControl'));
const v = require(path.join(SRC, 'services/shopVerification'));

const ADMIN_ROLE = {
  id: 2,
  name: 'ADMIN',
  description: 'Shop admin',
  scope: 'shop',
  permissions: 'EDIT_SHOP,CREATE_OFFER,VIEW_ANALYTICS',
};

const membership = (verificationStatus) => ({
  member_id: 11,
  shop_id: 5,
  branch_id: null,
  designation: 'Owner',
  status: 'active',
  shop_name: 'Vaigai Silks',
  shop_slug: 'vaigai-silks',
  shop_logo_url: null,
  verification_status: verificationStatus,
  role_id: 2,
  role_name: 'ADMIN',
  permissions: 'EDIT_SHOP,CREATE_OFFER,VIEW_ANALYTICS',
});

test.beforeEach(() => {
  roles = [ADMIN_ROLE];
  memberships = [];
});

test('a shop that never entered review still grants the merchant experience', async () => {
  // NULL is every shop an admin created by hand, and every shop that predates
  // the feature (§15). Getting this wrong would lock existing merchants out
  // of their own app the moment the migration ran.
  memberships = [membership(null)];
  const context = await access.loadAccessContext(1);
  assert.equal(context.canAccessAdmin, true);
  assert.equal(context.shops[0].awaitingFirstApproval, false);
  assert.equal(context.shops[0].verificationStatus, null);
});

test('a registration still awaiting its first decision does not', async () => {
  for (const status of [v.DRAFT, v.PENDING_VERIFICATION, v.ADDITIONAL_INFO_REQUIRED, v.REJECTED]) {
    memberships = [membership(status)];
    const context = await access.loadAccessContext(1);
    assert.equal(context.canAccessAdmin, false, `${status} should not open the admin app`);
    assert.equal(context.shops[0].awaitingFirstApproval, true);
  }
});

test('an approved shop grants it, and so does a suspended one', async () => {
  // A suspended merchant was approved once and needs the admin screens to read
  // why and put it right (§12, §14).
  for (const status of [v.VERIFIED, v.SUSPENDED]) {
    memberships = [membership(status)];
    const context = await access.loadAccessContext(1);
    assert.equal(context.canAccessAdmin, true, `${status} should open the admin app`);
  }
});

test('the seller keeps every permission on their own pending registration', async () => {
  // The point of the change is which app shell is shown, not what the seller
  // may do. Narrowing authorization here would break the wizard itself: it is
  // `shop.service.update` that saves each step.
  memberships = [membership(v.PENDING_VERIFICATION)];
  const context = await access.loadAccessContext(1);

  assert.deepEqual(context.shopIds, [5]);
  assert.ok(context.effectivePermissions.includes('EDIT_SHOP'));
  assert.equal(access.hasShopPermission(context, 5, 'EDIT_SHOP'), true);
});

test('a merchant with one live shop and one new registration stays a merchant', async () => {
  // Opening a second shop must not demote someone out of the shop they
  // already run.
  memberships = [membership(null), { ...membership(v.DRAFT), member_id: 12, shop_id: 6 }];
  const context = await access.loadAccessContext(1);

  assert.equal(context.canAccessAdmin, true);
  assert.equal(context.shops.length, 2);
  assert.equal(context.shops[1].awaitingFirstApproval, true);
});

test('a Super Admin is unaffected by any of this', async () => {
  roles = [{ id: 1, name: 'SUPER_ADMIN', description: null, scope: 'global', permissions: 'MANAGE_USERS' }];
  memberships = [membership(v.DRAFT)];
  const context = await access.loadAccessContext(1);
  assert.equal(context.canAccessAdmin, true);
});
