'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'silent';

const v = require('../../src/services/shopVerification');

/**
 * The seller-registration review lifecycle (Self-Service Onboarding §11, §14).
 *
 * These are the rules that decide whether an unreviewed shop can reach the
 * public, and whether a merchant can approve themselves. They are pure
 * functions on purpose: the guard is worth nothing if it only holds in the one
 * call path somebody remembered to test, so the rule lives in one module and
 * is pinned here rather than at each caller.
 */

const SUPER = { id: 1, isSuperAdmin: true };
const SELLER = { id: 2, isSuperAdmin: false };

// ---- what may go public ---------------------------------------------------

test('a shop that never entered review is not blocked', () => {
  // NULL is every shop that existed before this feature. §15 forbids treating
  // those as pending, and getting this wrong would take the entire existing
  // marketplace offline the moment the migration ran.
  assert.equal(v.blocksActivation(null), false);
  assert.equal(v.blocksActivation(undefined), false);
});

test('only VERIFIED may be switched on', () => {
  assert.equal(v.blocksActivation(v.VERIFIED), false);
  for (const status of [v.DRAFT, v.PENDING_VERIFICATION, v.ADDITIONAL_INFO_REQUIRED,
                        v.REJECTED, v.SUSPENDED]) {
    assert.equal(v.blocksActivation(status), true, `${status} should block activation`);
  }
});

test('a seller cannot activate their own unreviewed shop', () => {
  // The whole feature rests on this: a self-registered seller is ADMIN of
  // their shop from the moment it exists, and ADMIN carries EDIT_SHOP.
  assert.throws(
    () => v.assertMayActivate(v.PENDING_VERIFICATION, SELLER),
    (error) => error.status === 403 && /waiting for verification/i.test(error.message),
  );
});

test('a Super Admin may activate after approving', () => {
  assert.doesNotThrow(() => v.assertMayActivate(v.VERIFIED, SUPER));
  // §14 lists Activate as an admin action, so it must work even from a state
  // that refuses the merchant.
  assert.doesNotThrow(() => v.assertMayActivate(v.SUSPENDED, SUPER));
});

test('the refusal says which state the shop is in', () => {
  // A merchant who is told only "forbidden" opens a support ticket.
  const seen = [];
  for (const status of [v.DRAFT, v.REJECTED, v.SUSPENDED]) {
    try {
      v.assertMayActivate(status, SELLER);
      assert.fail(`${status} should have thrown`);
    } catch (error) {
      seen.push(error.message);
    }
  }
  assert.match(seen[0], /not been submitted/i);
  assert.match(seen[1], /rejected/i);
  assert.match(seen[2], /suspended/i);
});

// ---- who may decide -------------------------------------------------------

test('a seller cannot approve their own registration', () => {
  // §29.7. The route has middleware too; this is the second lock, so a new
  // caller that forgets the middleware still cannot get through.
  for (const decision of [v.VERIFIED, v.REJECTED, v.ADDITIONAL_INFO_REQUIRED, v.SUSPENDED]) {
    assert.throws(
      () => v.assertTransition(v.PENDING_VERIFICATION, decision, SELLER),
      (error) => error.status === 403,
      `${decision} should be reviewer-only`,
    );
  }
});

test('a seller may submit their own draft', () => {
  // Submitting is not a decision, so it is the one move a merchant owns.
  assert.doesNotThrow(() => v.assertTransition(v.DRAFT, v.PENDING_VERIFICATION, SELLER));
});

// ---- legal moves ----------------------------------------------------------

test('a decided registration cannot be decided again', () => {
  // Two reviewers opening the same queue item is the ordinary case, not an
  // exotic one, and the second decision must lose rather than overwrite.
  assert.throws(
    () => v.assertTransition(v.VERIFIED, v.REJECTED, SUPER),
    (error) => error.status === 409,
  );
});

test('a seller can answer an information request, and be rejected after it', () => {
  assert.doesNotThrow(() => v.assertTransition(v.ADDITIONAL_INFO_REQUIRED, v.PENDING_VERIFICATION, SELLER));
  assert.doesNotThrow(() => v.assertTransition(v.ADDITIONAL_INFO_REQUIRED, v.REJECTED, SUPER));
});

test('a rejected seller may fix the problem and resubmit', () => {
  assert.doesNotThrow(() => v.assertTransition(v.REJECTED, v.PENDING_VERIFICATION, SELLER));
});

test('a suspended shop is reinstated by verifying it again, not by activating it', () => {
  assert.doesNotThrow(() => v.assertTransition(v.SUSPENDED, v.VERIFIED, SUPER));
  assert.throws(() => v.assertTransition(v.SUSPENDED, v.PENDING_VERIFICATION, SUPER),
    (error) => error.status === 409);
});

test('a shop outside the lifecycle cannot be moved within it', () => {
  // An admin-created shop has NULL, and is not a registration to approve.
  assert.throws(
    () => v.assertTransition(null, v.VERIFIED, SUPER),
    (error) => error.status === 409 && /not part of a seller registration/i.test(error.message),
  );
});

test('an unknown status is rejected rather than stored', () => {
  assert.throws(
    () => v.assertTransition(v.DRAFT, 'APPROVED_PROBABLY', SUPER),
    (error) => error.status === 400,
  );
});

// ---- decisions that need words -------------------------------------------

test('rejection and information requests require a usable reason', () => {
  // §14 makes the reason mandatory, and §12 shows it to the seller verbatim,
  // so "no" on its own is not an answer they can act on.
  for (const decision of [v.REJECTED, v.ADDITIONAL_INFO_REQUIRED]) {
    assert.throws(() => v.assertReason(decision, ''), (e) => e.status === 422);
    assert.throws(() => v.assertReason(decision, '   '), (e) => e.status === 422);
    assert.throws(() => v.assertReason(decision, 'no'), (e) => e.status === 422);
    assert.doesNotThrow(() => v.assertReason(decision, 'The storefront photo does not show the shop name.'));
  }
});

test('approval needs no reason', () => {
  assert.doesNotThrow(() => v.assertReason(v.VERIFIED, undefined));
});

// ---- what a shop in review may publish ------------------------------------

test('a shop in review may not publish a listing', () => {
  // §12 tells the seller they may "prepare offer and service drafts" but not
  // "publish public offers/services". Before this guard the API said
  // otherwise: an offer created while the shop was pending was stored
  // `active`, and would have appeared the instant the shop was approved.
  for (const status of [v.DRAFT, v.PENDING_VERIFICATION, v.ADDITIONAL_INFO_REQUIRED,
                        v.REJECTED, v.SUSPENDED]) {
    assert.throws(
      () => v.assertMayPublishListing(status, SELLER, 'offer'),
      (error) => error.status === 403 && /draft/i.test(error.message),
      `${status} should refuse a published offer`,
    );
  }
});

test('the refusal tells the seller what to do instead', () => {
  // A seller who is only told "forbidden" opens a support ticket; one who is
  // told to save a draft gets on with it.
  try {
    v.assertMayPublishListing(v.PENDING_VERIFICATION, SELLER, 'service');
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /waiting for verification/i);
    assert.match(error.message, /Save the service as a draft/);
  }
});

test('an approved shop publishes freely, and so does a pre-existing one', () => {
  assert.doesNotThrow(() => v.assertMayPublishListing(v.VERIFIED, SELLER, 'offer'));
  // NULL is every shop that predates the feature (§15). Blocking those would
  // stop the entire existing marketplace posting offers.
  assert.doesNotThrow(() => v.assertMayPublishListing(null, SELLER, 'offer'));
  assert.doesNotThrow(() => v.assertMayPublishListing(undefined, SELLER, 'offer'));
});

test('a reviewer is not blocked by the publish gate', () => {
  // Somebody has to be able to put things right on a suspended shop.
  assert.doesNotThrow(() => v.assertMayPublishListing(v.SUSPENDED, SUPER, 'offer'));
});
