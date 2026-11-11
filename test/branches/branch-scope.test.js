'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * What a member who runs one branch may do.
 *
 * `shop_members.branch_id` has existed since before this, and until now it
 * bound only one thing: `resolveBranch` refused to let a branch-scoped member
 * redeem a claim at someone else's counter. Everywhere else the branch was a
 * label, so a branch admin could publish an offer shop-wide.
 *
 * The whole risk of tightening that lives in one value. A shop-level member
 * has `branch_id IS NULL` *because* they run the whole shop, and a Super Admin
 * has no membership row at all. Read either as "branch zero" and every shop
 * owner is locked out of their own shop, so the NULL cases are asserted first
 * and in more detail than the restriction itself.
 */

const SRC = path.join(__dirname, '../../src');
const access = require(path.join(SRC, 'services/accessControl'));

const SHOP = 4;

/** A member confined to branch 11 of shop 4. */
const branchAdmin = {
  isSuperAdmin: false,
  globalPermissions: [],
  shops: [{ shopId: SHOP, branchId: 11, branchRestricted: true, permissions: ['EDIT_OFFER'] }],
};

/** A member who runs the whole of shop 4. */
const shopAdmin = {
  isSuperAdmin: false,
  globalPermissions: [],
  shops: [{ shopId: SHOP, branchId: null, permissions: ['EDIT_OFFER'] }],
};

const superAdmin = { isSuperAdmin: true, globalPermissions: [], shops: [] };

// ---------------------------------------------------------------------------
// The NULL cases, first
// ---------------------------------------------------------------------------

test('a shop-level member is unrestricted, not confined to branch zero', () => {
  assert.equal(access.branchScopeFor(shopAdmin, SHOP), null);
  assert.equal(access.mayActOnBranch(shopAdmin, SHOP, 11), true);
  assert.equal(access.mayActOnBranch(shopAdmin, SHOP, 12), true);
  // The shop-wide case: no branch named at all.
  assert.equal(access.mayActOnBranch(shopAdmin, SHOP, null), true);
  assert.equal(access.mayActOnBranch(shopAdmin, SHOP, undefined), true);
});

test('a super admin is unrestricted everywhere, holding no membership', () => {
  assert.equal(access.branchScopeFor(superAdmin, SHOP), null);
  assert.equal(access.mayActOnBranch(superAdmin, SHOP, 11), true);
  assert.equal(access.mayActOnBranch(superAdmin, SHOP, null), true);
  assert.equal(access.mayActOnBranch(superAdmin, 999, 1), true);
});

test('a member of another shop entirely is not confined by this one', () => {
  // No membership here means no branch scope here. Whether they may act at
  // all is `hasShopPermission`'s question, and it answers no.
  assert.equal(access.branchScopeFor(branchAdmin, 999), null);
  assert.equal(access.hasShopPermission(branchAdmin, 999, 'EDIT_OFFER'), false);
});

test('a missing access context is not a branch scope', () => {
  assert.equal(access.branchScopeFor(null, SHOP), null);
  assert.equal(access.branchScopeFor(undefined, SHOP), null);
});

// ---------------------------------------------------------------------------
// The restriction itself
// ---------------------------------------------------------------------------

test('a branch admin is confined to their own branch', () => {
  assert.equal(access.branchScopeFor(branchAdmin, SHOP), 11);
  assert.equal(access.mayActOnBranch(branchAdmin, SHOP, 11), true);
  assert.equal(access.mayActOnBranch(branchAdmin, SHOP, 12), false);
});

test('a branch admin is refused a shop-wide action', () => {
  // "Every branch" includes branches that are not theirs. This is the rule
  // that stops a branch admin publishing a shop-wide offer.
  assert.equal(access.mayActOnBranch(branchAdmin, SHOP, null), false);
  assert.equal(access.mayActOnBranch(branchAdmin, SHOP, undefined), false);
});

test('the branch is compared by value, not by type', () => {
  // Ids arrive as strings from route params and as numbers from the database.
  assert.equal(access.mayActOnBranch(branchAdmin, SHOP, '11'), true);
  assert.equal(access.mayActOnBranch(branchAdmin, String(SHOP), 11), true);
});

test('branch scope does not leak between shops', () => {
  const twoShops = {
    isSuperAdmin: false,
    globalPermissions: [],
    shops: [
      { shopId: 4, branchId: 11, branchRestricted: true, permissions: ['EDIT_OFFER'] },
      { shopId: 5, branchId: null, branchRestricted: false, permissions: ['EDIT_OFFER'] },
    ],
  };
  assert.equal(access.branchScopeFor(twoShops, 4), 11);
  assert.equal(access.branchScopeFor(twoShops, 5), null);
  assert.equal(access.mayActOnBranch(twoShops, 5, 99), true, 'unconfined in shop 5');
  assert.equal(access.mayActOnBranch(twoShops, 4, 99), false, 'still confined in shop 4');
});

// ---------------------------------------------------------------------------
// Attachment is not confinement
// ---------------------------------------------------------------------------

test('a member attached to a branch but not restricted keeps shop-wide powers', () => {
  // The case that made this an explicit column. The seeder creates exactly
  // this - "Store Manager", attached to the Coimbatore branch - and `branch_id`
  // scoped only redemption for far longer than it meant anything else.
  // Inferring confinement from the attachment would have stripped shop-wide
  // powers from every such member on the day this shipped.
  const attachedOnly = {
    isSuperAdmin: false,
    globalPermissions: [],
    shops: [{ shopId: SHOP, branchId: 11, branchRestricted: false, permissions: ['EDIT_OFFER'] }],
  };

  assert.equal(access.branchScopeFor(attachedOnly, SHOP), null);
  assert.equal(access.mayActOnBranch(attachedOnly, SHOP, null), true, 'may still act shop-wide');
  assert.equal(access.mayActOnBranch(attachedOnly, SHOP, 12), true, 'and at another branch');
});

test('confinement without a branch confines nobody', () => {
  // A row cannot be restricted to a branch it does not have. Guarded in the
  // service on write and here on read, because the two can disagree only if
  // somebody edits the database by hand - and then it must fail open to
  // shop-wide, not closed to nothing.
  const malformed = {
    isSuperAdmin: false,
    globalPermissions: [],
    shops: [{ shopId: SHOP, branchId: null, branchRestricted: true, permissions: ['EDIT_OFFER'] }],
  };
  assert.equal(access.branchScopeFor(malformed, SHOP), null);
  assert.equal(access.mayActOnBranch(malformed, SHOP, null), true);
});
