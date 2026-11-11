'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * Which claims and which analytics a branch admin may see.
 *
 * Offers were the first half of this: a branch admin can only publish, edit
 * and delete offers that name their branch. This is the other half - what the
 * records and the dashboards show them - and it turns on one awkward fact
 * about the data:
 *
 *   `offer_claims.branch_id` is written at *redemption*.
 *
 * So a claim has a branch only once somebody has honoured it. Before that it
 * belongs to every counter that could honour it, which is why the rule here is
 * two cases rather than a column comparison, and why the aggregate figures
 * built on it are labelled rather than presented as one branch's footfall.
 *
 * `branchScopesFor` is asserted first and hardest. It is the gate every other
 * rule in this file reads, and the dangerous answers are the empty ones: a
 * membership wrongly reported as confined hides a shop owner's own data from
 * them, and the unconfined cases are the ones that must stay unconfined.
 */

const SRC = path.join(__dirname, '../../src');
const access = require(path.join(SRC, 'services/accessControl'));
const claims = require(path.join(SRC, 'modules/claims/claim.service'));
const branchScope = require(path.join(SRC, 'services/branchScope'));

const SHOP = 4;
const BRANCH = 11;

const context = (shops, extra = {}) => ({
  isSuperAdmin: false,
  globalPermissions: [],
  shops,
  ...extra,
});

/** Confined to branch 11 of shop 4, and may read that shop's claims. */
const branchAdmin = context([
  { shopId: SHOP, branchId: BRANCH, branchRestricted: true, permissions: ['VIEW_CLAIMS', 'VIEW_ANALYTICS'] },
]);

/** Runs the whole of shop 4. */
const shopAdmin = context([
  { shopId: SHOP, branchId: null, branchRestricted: false, permissions: ['VIEW_CLAIMS', 'VIEW_ANALYTICS'] },
]);

// ---------------------------------------------------------------------------
// branchScopesFor - who is confined, and who only looks like it
// ---------------------------------------------------------------------------

test('nobody is confined when nobody is restricted', () => {
  assert.equal(access.branchScopesFor(shopAdmin, 'VIEW_CLAIMS').size, 0);
  assert.equal(access.branchScopesFor(null, 'VIEW_CLAIMS').size, 0);
  assert.equal(access.branchScopesFor(undefined, 'VIEW_CLAIMS').size, 0);
});

test('a super admin is never confined', () => {
  const superAdmin = { isSuperAdmin: true, globalPermissions: [], shops: [] };
  assert.equal(access.branchScopesFor(superAdmin, 'VIEW_CLAIMS').size, 0);
});

test('a global grant is wider than any membership, so it is not confined', () => {
  // `shopScopeFor` already reads a global grant as "every shop". Confining the
  // same person to one branch of one of those shops would contradict it, and
  // would leave the list filter and the by-id check disagreeing.
  const global = context(
    [{ shopId: SHOP, branchId: BRANCH, branchRestricted: true, permissions: ['VIEW_CLAIMS'] }],
    { globalPermissions: ['VIEW_CLAIMS'] },
  );
  assert.equal(access.branchScopesFor(global, 'VIEW_CLAIMS').size, 0);
  // ...but only for the permission actually granted globally.
  assert.deepEqual([...access.branchScopesFor(global, 'VIEW_ANALYTICS')], []);
});

test('a confined membership is reported as its shop and branch', () => {
  assert.deepEqual([...access.branchScopesFor(branchAdmin, 'VIEW_CLAIMS')], [[SHOP, BRANCH]]);
});

test('attachment alone is not confinement', () => {
  // The seeder's Store Manager: attached to a branch, runs the shop's offers.
  const attached = context([
    { shopId: SHOP, branchId: BRANCH, branchRestricted: false, permissions: ['VIEW_CLAIMS'] },
  ]);
  assert.equal(access.branchScopesFor(attached, 'VIEW_CLAIMS').size, 0);
});

test('confinement without a branch confines nobody', () => {
  const malformed = context([
    { shopId: SHOP, branchId: null, branchRestricted: true, permissions: ['VIEW_CLAIMS'] },
  ]);
  assert.equal(access.branchScopesFor(malformed, 'VIEW_CLAIMS').size, 0);
});

test('only the shops where the permission is actually held are confined', () => {
  const partial = context([
    { shopId: 4, branchId: 11, branchRestricted: true, permissions: ['VIEW_CLAIMS'] },
    { shopId: 5, branchId: 12, branchRestricted: true, permissions: ['EDIT_OFFER'] },
  ]);
  assert.deepEqual([...access.branchScopesFor(partial, 'VIEW_CLAIMS')], [[4, 11]]);
});

test('confinement is per membership, not per person', () => {
  // Runs one branch of shop 4 and the whole of shop 5. A list spanning both
  // has to narrow the first and leave the second alone.
  const mixed = context([
    { shopId: 4, branchId: 11, branchRestricted: true, permissions: ['VIEW_CLAIMS'] },
    { shopId: 5, branchId: null, branchRestricted: false, permissions: ['VIEW_CLAIMS'] },
  ]);
  assert.deepEqual([...access.branchScopesFor(mixed, 'VIEW_CLAIMS')], [[4, 11]]);
});

// ---------------------------------------------------------------------------
// The claims filter
// ---------------------------------------------------------------------------

test('an unconfined caller gets no clause at all', () => {
  // Null rather than `1 = 1`, so the ordinary query is untouched.
  assert.equal(claims.branchScopeClause(new Map()), null);
  assert.equal(claims.branchScopeClause(null), null);
});

test('the filter allows a claim redeemed here, or not redeemed and reachable here', () => {
  const clause = claims.branchVisibilityClause(BRANCH);
  assert.match(clause.sql, /c\.branch_id = \?/);
  assert.match(clause.sql, /c\.branch_id IS NULL/);
  assert.deepEqual(clause.params, [BRANCH, BRANCH]);
});

test('a shop-wide listing reaches every active branch; an online one reaches none', () => {
  const sql = claims.branchVisibilityClause(BRANCH).sql;
  // Only these two applicability types can be served at a counter. `online`
  // is absent on purpose: there is no counter to walk into, so an online
  // claim never appears in any branch's list.
  assert.match(sql, /applicability_type = 'shop_wide'/);
  assert.match(sql, /applicability_type = 'selected_branches'/);
  assert.doesNotMatch(sql, /'online'/);
  // Matches `allowedBranchIds`, which the till itself uses: shop-wide means
  // every *active* branch of that shop.
  assert.match(sql, /rb\.status = 'active'/);
});

test('each kind reads its own tables', () => {
  const offer = claims.branchVisibilityClause(BRANCH, 'offer').sql;
  assert.match(offer, /offer_locations/);
  assert.doesNotMatch(offer, /service_locations/);

  // A service offer inherits its branches from the parent service, not the
  // offer, which is where its applicability lives too.
  const service = claims.branchVisibilityClause(BRANCH, 'service_offer').sql;
  assert.match(service, /service_locations/);
  assert.match(service, /JOIN services rsv/);
  assert.doesNotMatch(service, /offer_locations/);
});

test('shops the caller is not confined in pass through untouched', () => {
  const clause = claims.branchScopeClause(new Map([[SHOP, BRANCH]]));
  // The escape hatch: a row in any other shop satisfies the clause outright.
  assert.match(clause.sql, /c\.shop_id NOT IN \(\?\)/);
  assert.deepEqual(clause.params, [SHOP, SHOP, BRANCH, BRANCH]);
});

test('two confinements are paired with their own shops, never crossed', () => {
  // The bug this guards against is applying shop 4's branch to shop 5's rows,
  // which would silently empty shop 5 out of the list.
  const clause = claims.branchScopeClause(new Map([[4, 11], [5, 12]]));
  assert.match(clause.sql, /c\.shop_id NOT IN \(\?,\?\)/);
  assert.deepEqual(clause.params, [4, 5, 4, 11, 11, 5, 12, 12]);
});

// ---------------------------------------------------------------------------
// The analytics filter
// ---------------------------------------------------------------------------

test('an unconfined analytics request keeps the branch filter the caller asked for', () => {
  const filters = { branchId: 99 };
  assert.equal(branchScope.confineFilters(shopAdmin, [SHOP], filters, 'VIEW_ANALYTICS'), null);
  assert.equal(filters.branchId, 99, 'a shop admin may still slice by any of their branches');
});

test('a confined analytics request has its branch chosen for it', () => {
  const filters = {};
  assert.equal(branchScope.confineFilters(branchAdmin, [SHOP], filters, 'VIEW_ANALYTICS'), BRANCH);
  assert.equal(filters.branchId, BRANCH);
  assert.equal(branchScope.isConfined(branchAdmin, 'VIEW_ANALYTICS'), true);
});

test('asking for the branch you are confined to is not an error', () => {
  const filters = { branchId: BRANCH };
  assert.equal(branchScope.confineFilters(branchAdmin, [SHOP], filters, 'VIEW_ANALYTICS'), BRANCH);
  assert.equal(filters.branchId, BRANCH);
});

test('asking for another branch is refused, not quietly answered', () => {
  // An empty chart would be read as a quiet week; worse, the caller's own
  // figures under another branch's heading would be read as that branch's.
  assert.throws(
    () => branchScope.confineFilters(branchAdmin, [SHOP], { branchId: 12 }, 'VIEW_ANALYTICS'),
    (error) => error.status === 403,
  );
});

test('a shop the caller is not confined in is not narrowed', () => {
  const elsewhere = context([
    { shopId: 4, branchId: 11, branchRestricted: true, permissions: ['VIEW_ANALYTICS'] },
    { shopId: 5, branchId: null, branchRestricted: false, permissions: ['VIEW_ANALYTICS'] },
  ]);
  const filters = {};
  assert.equal(branchScope.confineFilters(elsewhere, [5], filters, 'VIEW_ANALYTICS'), null);
  assert.equal(filters.branchId, undefined);
});

test('reporting on several shops at once while confined in one is refused', () => {
  // `branchId` is a single value. Applying shop 4's branch to shop 5's offers
  // would filter shop 5 down to nothing while still printing its name, so the
  // request is sent back asking for a shop instead.
  const elsewhere = context([
    { shopId: 4, branchId: 11, branchRestricted: true, permissions: ['VIEW_ANALYTICS'] },
    { shopId: 5, branchId: null, branchRestricted: false, permissions: ['VIEW_ANALYTICS'] },
  ]);
  assert.throws(
    () => branchScope.confineFilters(elsewhere, [4, 5], {}, 'VIEW_ANALYTICS'),
    (error) => error.status === 400 && /one shop at a time/.test(error.message),
  );
});

test('a platform-wide analytics scope is never confined', () => {
  const filters = {};
  assert.equal(branchScope.confineFilters(branchAdmin, null, filters, 'VIEW_ANALYTICS'), null);
  assert.equal(filters.branchId, undefined);
});
