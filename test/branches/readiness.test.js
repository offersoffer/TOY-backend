'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * When a branch is complete enough to put an offer in front of a customer.
 *
 * The rule exists because a branch is the thing a customer travels to: an
 * offer published against one with no street address, no pincode, no confirmed
 * pin and nobody to ring is an offer they cannot act on, and the shop finds
 * out only when they stop arriving.
 *
 * Two properties matter more than the field list and are asserted first,
 * because getting either wrong is how a rule like this takes a live shop down:
 *
 *   - nothing already published is re-validated, so no offer goes dark on the
 *     morning this deploys;
 *   - an inactive branch is never checked, which is the merchant's exit when
 *     they cannot complete one.
 */

const SRC = path.join(__dirname, '../../src');
const readiness = require(path.join(SRC, 'services/branchReadiness'));

/** A branch that satisfies every rule; tests take it away a field at a time. */
const COMPLETE = {
  id: 7,
  branch_name: 'Peelamedu',
  address: '12 Avinashi Road',
  city: 'Coimbatore',
  pincode: '641004',
  latitude: 11.0168,
  longitude: 76.9558,
  location_confirmed_at: new Date('2026-11-01T10:00:00Z'),
  contact_number: '+91 90000 00000',
  contact_person_name: 'R. Kavitha',
  contact_person_email: 'kavitha@example.test',
  status: 'active',
};

const without = (field, value = null) => ({ ...COMPLETE, [field]: value });
const labels = (branch) => readiness.missingFor(branch).map((m) => m.label);

test('a fully filled branch is ready', () => {
  assert.deepEqual(readiness.missingFor(COMPLETE), []);
  assert.equal(readiness.isReady(COMPLETE), true);
});

test('each required field is required', () => {
  assert.deepEqual(labels(without('address')), ['street address']);
  assert.deepEqual(labels(without('city')), ['city']);
  assert.deepEqual(labels(without('pincode')), ['pincode']);
  assert.deepEqual(labels(without('contact_number')), ['contact number']);
  assert.deepEqual(labels(without('contact_person_name')), ['contact person']);
  assert.deepEqual(labels(without('contact_person_email')), ['contact person email']);
});

test('whitespace is not a value', () => {
  // A merchant who types a space into a required field has not filled it in.
  assert.deepEqual(labels(without('address', '   ')), ['street address']);
  assert.deepEqual(labels(without('contact_person_name', '\t')), ['contact person']);
});

test('opening hours are deliberately not required', () => {
  // Asked and answered: hours are useful, but a shop that has not typed them
  // can still be found and telephoned.
  assert.deepEqual(readiness.missingFor({ ...COMPLETE, opening_hours: null }), []);
});

test('a confirmed pin needs both the confirmation and the coordinates', () => {
  // The onboarding gate's reasoning, applied per branch: a confirmation with
  // no coordinates means something marked the pin confirmed without a provider
  // ever returning one, so the flag alone cannot be trusted.
  assert.deepEqual(labels(without('location_confirmed_at')), ['confirmed map location']);
  assert.deepEqual(labels(without('latitude')), ['confirmed map location']);
  assert.deepEqual(labels(without('longitude')), ['confirmed map location']);
});

test('every missing field is reported at once', () => {
  // One round trip per missing field would be a miserable form to fill in.
  const bare = { id: 9, branch_name: 'New branch', status: 'active' };
  assert.deepEqual(labels(bare), [
    'street address',
    'city',
    'pincode',
    'confirmed map location',
    'contact number',
    'contact person',
    'contact person email',
  ]);
});

// ---------------------------------------------------------------------------
// Which branches an offer is actually checked against
// ---------------------------------------------------------------------------

/** Stands in for the pool's `query` helper: returns rows, not [rows, fields]. */
function runnerFor(rows) {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return rows;
  };
  run.calls = calls;
  return run;
}

test('an online offer is checked against no branch at all', async () => {
  const run = runnerFor([]);
  const out = await readiness.targetedBranches(run, 1, 'online', []);
  assert.deepEqual(out, []);
  assert.equal(run.calls.length, 0, 'an online offer must not query branches');
});

test('a shop-wide offer is checked against every active branch', async () => {
  const run = runnerFor([COMPLETE]);
  await readiness.targetedBranches(run, 1, 'shop_wide', []);

  assert.equal(run.calls.length, 1);
  assert.match(run.calls[0].sql, /WHERE shop_id = \? AND status = 'active'/);
  assert.deepEqual(run.calls[0].params, [1]);
});

test('a selected-branches offer is checked against only those branches', async () => {
  const run = runnerFor([COMPLETE]);
  await readiness.targetedBranches(run, 1, 'selected_branches', [7, 9]);

  assert.match(run.calls[0].sql, /id IN \(\?,\?\)/);
  assert.deepEqual(run.calls[0].params, [1, 7, 9]);
  assert.match(run.calls[0].sql, /status = 'active'/, 'an inactive branch is not a target');
});

test('a mysql2 connection works as well as the pool helper', async () => {
  // Create and update run inside a transaction and hand over a connection,
  // whose `execute` answers [rows, fields]; changeStatus hands over the pool's
  // `query`, which answers rows. Both have to work.
  const connection = { execute: async () => [[COMPLETE], []] };
  const out = await readiness.targetedBranches(connection, 1, 'shop_wide', []);
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------------------
// The refusal itself
// ---------------------------------------------------------------------------

test('publishing against a complete branch is allowed', async () => {
  await readiness.assertBranchesReadyToPublish(runnerFor([COMPLETE]), 1, 'shop_wide', []);
});

test('publishing against an incomplete branch is refused, and says which', async () => {
  const incomplete = { ...without('pincode'), id: 7, branch_name: 'Peelamedu' };
  const run = runnerFor([incomplete]);

  await assert.rejects(
    () => readiness.assertBranchesReadyToPublish(run, 1, 'shop_wide', []),
    (error) => {
      assert.equal(error.status, 422);
      // The merchant is on an offer form and the thing to fix is on another
      // screen, so the message has to name the branch and the field.
      assert.match(error.message, /Peelamedu/);
      assert.match(error.message, /pincode/);
      assert.match(error.message, /set it inactive/, 'the way out is offered too');
      assert.deepEqual(error.details, [
        { field: 'branches.7.pincode', message: 'Peelamedu: pincode is required before publishing' },
      ]);
      return true;
    },
  );
});

test('several incomplete branches are all named', async () => {
  const run = runnerFor([
    { ...without('pincode'), id: 7, branch_name: 'Peelamedu' },
    { ...without('contact_number'), id: 8, branch_name: 'R.S. Puram' },
  ]);

  await assert.rejects(
    () => readiness.assertBranchesReadyToPublish(run, 1, 'shop_wide', []),
    (error) => {
      assert.match(error.message, /Peelamedu/);
      assert.match(error.message, /R\.S\. Puram/);
      assert.equal(error.details.length, 2);
      return true;
    },
  );
});

test('an offer targeting no branches has nothing to refuse', async () => {
  // `selected_branches` with an empty list is already rejected by the offer
  // schema; readiness must not invent a second, different error for it.
  const run = runnerFor([]);
  await readiness.assertBranchesReadyToPublish(run, 1, 'selected_branches', []);
});
