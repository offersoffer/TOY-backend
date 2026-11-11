'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * Who may write to a branch, and who may see the publish gate's working.
 *
 * Both were holes left by the first pass at confining a branch admin, and
 * both were found by using the screens rather than by reading the diff:
 *
 *   - `requireShopScope('MANAGE_LOCATIONS')` answers "may you touch this
 *     shop", which for a branch admin is yes. Nothing then asked *which*
 *     branch, so they could edit a sibling branch's address or deactivate it
 *     outright - a good deal more consequential than reading its figures,
 *     which was already refused.
 *
 *   - `publishBlockers` went out on the public shop page and the signed-out
 *     branch listing, so anyone could read which of a merchant's locations
 *     were half-finished and exactly what they lacked. The shop-profile
 *     checklist beside it already gates on the same question, for the reason
 *     written there: a customer has no use for "this shop has not uploaded a
 *     logo yet".
 */

const SRC = path.join(__dirname, '../../src');
const { requireBranchScope } = require(path.join(SRC, 'middleware/authorize'));
const shops = require(path.join(SRC, 'modules/shops/shop.service'));

const SHOP = 4;
const MINE = 11;
const THEIRS = 12;

const user = (shops_) => ({ isSuperAdmin: false, globalPermissions: [], shops: shops_ });

const branchAdmin = user([
  { shopId: SHOP, branchId: MINE, branchRestricted: true, permissions: ['MANAGE_LOCATIONS'] },
]);
const shopAdmin = user([
  { shopId: SHOP, branchId: null, branchRestricted: false, permissions: ['MANAGE_LOCATIONS'] },
]);

/** Runs the middleware and reports what it passed to `next`. */
function run(actor, params) {
  let outcome = 'allowed';
  requireBranchScope('MANAGE_LOCATIONS')({ user: actor, params }, {}, (error) => {
    if (error) outcome = { status: error.status, message: error.message };
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

test('an unconfined member may write to any branch of their shop', () => {
  assert.equal(run(shopAdmin, { id: SHOP, branchId: MINE }), 'allowed');
  assert.equal(run(shopAdmin, { id: SHOP, branchId: THEIRS }), 'allowed');
  // And may add one, which is the no-branch-in-the-URL case.
  assert.equal(run(shopAdmin, { id: SHOP }), 'allowed');
});

test('a super admin is never confined', () => {
  const superAdmin = { isSuperAdmin: true, globalPermissions: [], shops: [] };
  assert.equal(run(superAdmin, { id: SHOP, branchId: THEIRS }), 'allowed');
  assert.equal(run(superAdmin, { id: SHOP }), 'allowed');
});

test('a branch admin may write to their own branch', () => {
  assert.equal(run(branchAdmin, { id: SHOP, branchId: MINE }), 'allowed');
  // Route params arrive as strings; the branch is compared by value.
  assert.equal(run(branchAdmin, { id: String(SHOP), branchId: String(MINE) }), 'allowed');
});

test('a branch admin may not write to a sibling branch', () => {
  const refusal = run(branchAdmin, { id: SHOP, branchId: THEIRS });
  assert.equal(refusal.status, 403);
  assert.match(refusal.message, /not yours/);
});

test('a branch admin may not add a branch to the shop', () => {
  // No branch in the URL. A new branch belongs to the shop, and they have no
  // branch of their own to add it to.
  const refusal = run(branchAdmin, { id: SHOP });
  assert.equal(refusal.status, 403);
  assert.match(refusal.message, /cannot add another/);
});

test('confinement in one shop does not reach another', () => {
  const elsewhere = user([
    { shopId: 4, branchId: MINE, branchRestricted: true, permissions: ['MANAGE_LOCATIONS'] },
    { shopId: 5, branchId: null, branchRestricted: false, permissions: ['MANAGE_LOCATIONS'] },
  ]);
  assert.equal(run(elsewhere, { id: 5, branchId: 99 }), 'allowed');
  assert.equal(run(elsewhere, { id: 5 }), 'allowed');
  assert.equal(run(elsewhere, { id: 4, branchId: 99 }).status, 403);
});

test('attachment alone does not confine a write', () => {
  // The seeder's Store Manager again: attached to a branch, runs the shop.
  const attached = user([
    { shopId: SHOP, branchId: MINE, branchRestricted: false, permissions: ['MANAGE_LOCATIONS'] },
  ]);
  assert.equal(run(attached, { id: SHOP, branchId: THEIRS }), 'allowed');
});

// ---------------------------------------------------------------------------
// Who sees the gate's working
// ---------------------------------------------------------------------------

/** A branch missing the two fields the gate added. */
const INCOMPLETE = {
  id: 7,
  shop_id: SHOP,
  branch_name: 'Phoenix Mall',
  address: '2 Velachery Road',
  city: 'Chennai',
  pincode: '600042',
  latitude: 12.99,
  longitude: 80.21,
  location_confirmed_at: new Date('2026-11-01T10:00:00Z'),
  contact_number: '+91 90000 00000',
  contact_person_name: null,
  contact_person_email: null,
  is_primary: 0,
  status: 'active',
};

test('a customer is not told which of a merchant\'s branches are half-finished', () => {
  const asCustomer = shops.mapBranch(INCOMPLETE);
  assert.equal(asCustomer.publishBlockers, undefined);
  assert.equal(asCustomer.readyToPublish, undefined);
  // The branch itself still renders: only the gate's working is withheld.
  assert.equal(asCustomer.branchName, 'Phoenix Mall');
  assert.equal(asCustomer.city, 'Chennai');
});

test('the contact person is published, because a customer is meant to reach them', () => {
  // Deliberately not withheld. The whole point of the field is that a
  // customer can ask for someone by name at this branch.
  const complete = { ...INCOMPLETE, contact_person_name: 'R. Kavitha' };
  assert.equal(shops.mapBranch(complete).contactPersonName, 'R. Kavitha');
});

test('the merchant is told, and told exactly what is missing', () => {
  const asManager = shops.mapBranch(INCOMPLETE, { forManager: true });
  assert.equal(asManager.readyToPublish, false);
  assert.deepEqual(
    asManager.publishBlockers.map((blocker) => blocker.field),
    ['contactPersonName', 'contactPersonEmail'],
  );
});

test('a complete branch reports ready, with nothing outstanding', () => {
  const complete = {
    ...INCOMPLETE,
    contact_person_name: 'R. Kavitha',
    contact_person_email: 'kavitha@example.test',
  };
  const asManager = shops.mapBranch(complete, { forManager: true });
  assert.equal(asManager.readyToPublish, true);
  assert.deepEqual(asManager.publishBlockers, []);
});
