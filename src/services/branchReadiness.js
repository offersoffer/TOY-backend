'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Whether a branch is complete enough to put offers in front of customers.
 *
 * A branch is the thing a customer actually travels to. An offer published
 * against one with no street address, no pincode, no confirmed pin and nobody
 * to ring is an offer they cannot act on, and the shop only finds out when
 * they stop arriving.
 *
 * ## Why this blocks publishing rather than saving
 *
 * Saving an incomplete branch stays legal. A merchant types what they know,
 * leaves, and comes back - a form that refuses half-finished work gets
 * abandoned half-finished. What is gated is the moment the branch becomes a
 * promise to a customer, which is when an offer goes live against it.
 *
 * ## Why nothing goes dark
 *
 * The rule is applied where an offer is *published*, never where one is read,
 * so offers already live against an incomplete branch stay live. Merchants
 * meet the rule the next time they publish, re-target or re-activate - not on
 * the morning this deploys. That is the same stance the seller-onboarding
 * release took with `verification_status`: existing rows are approved by
 * provenance, and backfilling them would be inventing facts.
 *
 * A merchant with one branch they cannot complete has an exit that is already
 * modelled: set that branch `inactive`. Only active branches are checked,
 * because only active branches are offered to customers.
 */

/**
 * Each rule names the field the client knows, so the error can point at the
 * input rather than at a column.
 *
 * `label` is what the merchant is told is missing. `field` is the path the web
 * and mobile forms bind to, so a client can focus the offending input instead
 * of making the merchant hunt for it.
 */
const REQUIREMENTS = [
  {
    field: 'address',
    label: 'street address',
    ok: (b) => Boolean(String(b.address ?? '').trim()),
  },
  {
    field: 'city',
    label: 'city',
    ok: (b) => Boolean(String(b.city ?? '').trim()),
  },
  {
    field: 'pincode',
    label: 'pincode',
    ok: (b) => Boolean(String(b.pincode ?? '').trim()),
  },
  {
    // Both halves, for the reason the onboarding gate gives: a confirmation
    // with no coordinates means something marked the pin confirmed without a
    // provider ever returning one.
    field: 'locationConfirmed',
    label: 'confirmed map location',
    ok: (b) => Boolean(b.location_confirmed_at) && b.latitude !== null && b.longitude !== null,
  },
  {
    field: 'contactNumber',
    label: 'contact number',
    ok: (b) => Boolean(String(b.contact_number ?? '').trim()),
  },
  {
    field: 'contactPersonName',
    label: 'contact person',
    ok: (b) => Boolean(String(b.contact_person_name ?? '').trim()),
  },
  {
    field: 'contactPersonEmail',
    label: 'contact person email',
    ok: (b) => Boolean(String(b.contact_person_email ?? '').trim()),
  },
];

/** The columns `missingFor` reads. Selecting fewer would report false gaps. */
const BRANCH_COLUMNS_NEEDED = [
  'id',
  'branch_name',
  'address',
  'city',
  'pincode',
  'latitude',
  'longitude',
  'location_confirmed_at',
  'contact_number',
  'contact_person_name',
  'contact_person_email',
  'status',
];

/** @returns {Array<{field: string, label: string}>} empty when the branch is ready. */
function missingFor(branch) {
  if (!branch) return [];
  return REQUIREMENTS.filter((rule) => !rule.ok(branch)).map(({ field, label }) => ({
    field,
    label,
  }));
}

const isReady = (branch) => missingFor(branch).length === 0;

/**
 * The branches an offer will actually appear at.
 *
 * `online` has no branch, so nothing is checked - there is no counter for a
 * customer to walk into. `shop_wide` means every active branch, which is the
 * literal promise the offer makes.
 */
async function targetedBranches(runner, shopId, applicabilityType, branchIds = []) {
  // Called both inside a transaction and outside one. A mysql2 connection
  // answers `[rows, fields]` from `execute`; the pool's own `query` helper
  // answers the rows. Taking either keeps the adapter here, once, instead of
  // at every call site.
  const run = async (sql, params) => {
    if (runner && typeof runner.execute === 'function') {
      const [rows] = await runner.execute(sql, params);
      return rows;
    }
    return runner(sql, params);
  };

  const columns = BRANCH_COLUMNS_NEEDED.join(', ');

  if (applicabilityType === 'online') return [];

  if (applicabilityType === 'selected_branches') {
    if (!branchIds.length) return [];
    const placeholders = branchIds.map(() => '?').join(',');
    return run(
      `SELECT ${columns} FROM shop_branches
        WHERE shop_id = ? AND id IN (${placeholders}) AND status = 'active'`,
      [shopId, ...branchIds],
    );
  }

  return run(
    `SELECT ${columns} FROM shop_branches WHERE shop_id = ? AND status = 'active'`,
    [shopId],
  );
}

/**
 * Refuses to publish against a branch that is not ready.
 *
 * The message names the branch and the fields, because the merchant is looking
 * at an offer form and the thing to fix is on a different screen. "Validation
 * failed" would leave them clicking around their own dashboard.
 */
async function assertBranchesReadyToPublish(runner, shopId, applicabilityType, branchIds = []) {
  const branches = await targetedBranches(runner, shopId, applicabilityType, branchIds);

  const incomplete = branches
    .map((branch) => ({ branch, missing: missingFor(branch) }))
    .filter((entry) => entry.missing.length);

  if (!incomplete.length) return;

  const details = incomplete.flatMap(({ branch, missing }) =>
    missing.map((m) => ({
      field: `branches.${branch.id}.${m.field}`,
      message: `${branch.branch_name}: ${m.label} is required before publishing`,
    })),
  );

  const named = incomplete
    .map(({ branch, missing }) => `${branch.branch_name} (${missing.map((m) => m.label).join(', ')})`)
    .join('; ');

  throw ApiError.unprocessable(
    `Complete these branches before publishing: ${named}. ` +
      'Open the branch and fill in the missing details, or set it inactive if it is not trading.',
    details,
  );
}

module.exports = {
  REQUIREMENTS,
  BRANCH_COLUMNS_NEEDED,
  missingFor,
  isReady,
  targetedBranches,
  assertBranchesReadyToPublish,
};
