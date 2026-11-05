'use strict';

const service = require('./review.service');
const claims = require('./claim.service');
const audit = require('../../utils/audit');
const shopVerification = require('../../services/shopVerification');
const { ok, paginated } = require('../../utils/respond');

/**
 * Reviewing seller registrations (§14).
 *
 * Thin, like every other controller here, with one job of its own: writing
 * the audit entry. §14 requires reviewer, action, reason and timestamp to be
 * recorded for every decision, and §25 wants that history readable - which it
 * is, because `review.service.reviewHistory` reads back exactly these rows.
 *
 * Audited here rather than in the service to match the rest of the codebase,
 * and because `audit.record` needs the request for the acting user and IP.
 */

exports.list = async (req, res) => {
  const { items, pagination } = await service.list(req.query);
  paginated(res, items, pagination);
};

exports.detail = async (req, res) => {
  ok(res, await service.detail(req.params.id));
};

/**
 * One decision, recorded one way.
 *
 * `entityType` is `shop_registration` rather than `shop` on purpose: these
 * rows are the registration's review history and are read back as such, and
 * mixing them into the shop's own audit trail would make "what happened to
 * this registration" a question about filtering action names.
 */
const decision = (to) => async (req, res) => {
  const { registration, previous } = await service.decide(
    req.params.id,
    to,
    { reason: req.body?.reason || null, activate: req.body?.activate },
    req.user,
  );

  await audit.record(req, {
    action: service.DECISIONS[to].action,
    entityType: 'shop_registration',
    entityId: Number(req.params.id),
    oldValue: previous,
    newValue: {
      verificationStatus: to,
      status: registration.listingStatus,
      reason: req.body?.reason || null,
    },
  });

  /*
    The response carries the review history, and the entry for this very
    decision was written a line ago - so the history is re-read rather than
    returned as it was before the decision. Without this the reviewer presses
    Approve, the badge changes, and the history panel still says "no
    decisions yet" until they reload.
  */
  ok(res, { ...registration, history: await service.reviewHistory(req.params.id) });
};

exports.approve = decision(shopVerification.VERIFIED);
exports.reject = decision(shopVerification.REJECTED);
exports.requestInfo = decision(shopVerification.ADDITIONAL_INFO_REQUIRED);
exports.suspend = decision(shopVerification.SUSPENDED);
/**
 * Lifting a suspension returns the shop to VERIFIED and puts it back on the
 * marketplace, because that is what the reviewer means by it: the shop was
 * live before it was suspended, and reinstating a merchant who then cannot
 * be found is a support ticket rather than a decision. A reviewer who wants
 * it verified but dark can use the listing call below afterwards.
 */
exports.reactivate = decision(shopVerification.VERIFIED);

/** §11: switching the public listing without touching verification. */
exports.setListing = async (req, res) => {
  const before = await service.detail(req.params.id);
  const registration = await service.setListing(req.params.id, req.body.status, req.user);

  await audit.record(req, {
    action: req.body.status === 'active' ? 'SHOP_ACTIVATED' : 'SHOP_DEACTIVATED',
    entityType: 'shop_registration',
    entityId: Number(req.params.id),
    oldValue: { status: before.listingStatus, verificationStatus: before.verificationStatus },
    newValue: { status: registration.listingStatus, verificationStatus: registration.verificationStatus },
  });

  ok(res, { ...registration, history: await service.reviewHistory(req.params.id) });
};

exports.history = async (req, res) => {
  ok(res, await service.reviewHistory(req.params.id));
};

// ---- Claims on shops we already have (§16 steps 6-9) ----------------------

exports.listClaims = async (req, res) => {
  const { items, pagination } = await claims.listClaims(req.query);
  paginated(res, items, pagination);
};

exports.getClaim = async (req, res) => {
  ok(res, await claims.getClaim(req.params.id, req.user, { asReviewer: true }));
};

/**
 * §16 step 9: an ownership change is the kind of thing that has to be
 * accountable afterwards, so the grant is audited as well as notified.
 */
exports.approveClaim = async (req, res) => {
  const claim = await claims.approveClaim(req.params.id, req.user);
  await audit.record(req, {
    action: 'SHOP_CLAIM_APPROVED',
    entityType: 'shop',
    entityId: claim.shopId,
    newValue: { claimId: claim.id, grantedTo: claim.requester?.id, role: 'ADMIN' },
  });
  ok(res, claim);
};

exports.rejectClaim = async (req, res) => {
  const claim = await claims.rejectClaim(req.params.id, req.body.reason, req.user);
  await audit.record(req, {
    action: 'SHOP_CLAIM_REJECTED',
    entityType: 'shop',
    entityId: claim.shopId,
    newValue: { claimId: claim.id, reason: req.body.reason },
  });
  ok(res, claim);
};
