'use strict';

const ApiError = require('../utils/ApiError');

/**
 * The seller-onboarding review lifecycle (Self-Service Onboarding §11).
 *
 * Deliberately a separate axis from `shops.status`. `status` answers "is this
 * shop live" and the whole application already reads it, public discovery
 * included; `verification_status` answers "where is this shop in review". §11
 * is explicit that the two are not the same thing - a shop can pass review and
 * still be switched off - so folding them into one column would lose the
 * distinction the spec asks us to keep.
 *
 * **NULL is not a state in this machine.** It means the shop never went
 * through review at all, which is every shop that existed before this feature
 * and every shop an admin creates by hand. §15 forbids treating those as
 * pending, so NULL is approved-by-provenance: it blocks nothing.
 */

const DRAFT = 'DRAFT';
const PENDING_VERIFICATION = 'PENDING_VERIFICATION';
const ADDITIONAL_INFO_REQUIRED = 'ADDITIONAL_INFO_REQUIRED';
const VERIFIED = 'VERIFIED';
const REJECTED = 'REJECTED';
const SUSPENDED = 'SUSPENDED';

const STATUSES = [
  DRAFT,
  PENDING_VERIFICATION,
  ADDITIONAL_INFO_REQUIRED,
  VERIFIED,
  REJECTED,
  SUSPENDED,
];

/**
 * Which moves are legal, as `from -> [to]`.
 *
 * Written down rather than checked ad hoc at each call site because the
 * dangerous transitions are the ones nobody thinks to forbid: a seller moving
 * their own shop to VERIFIED, or a second reviewer deciding a registration
 * that has already been decided.
 */
const TRANSITIONS = {
  [DRAFT]: [PENDING_VERIFICATION],
  [PENDING_VERIFICATION]: [VERIFIED, REJECTED, ADDITIONAL_INFO_REQUIRED],
  // The seller answered the question, so it goes back in the queue.
  [ADDITIONAL_INFO_REQUIRED]: [PENDING_VERIFICATION, REJECTED],
  [VERIFIED]: [SUSPENDED],
  // A rejected seller may fix the problem and come back. §16 lets a rejected
  // *claim* be retried with better evidence and there is no reason a rejected
  // registration should be more final than that - the alternative is a dead
  // account and a duplicate shop.
  [REJECTED]: [PENDING_VERIFICATION],
  [SUSPENDED]: [VERIFIED],
};

/**
 * States a shop has never been approved out of.
 *
 * The difference between "a seller with a registration in flight" and "a
 * merchant". Both hold ADMIN on their shop from the moment the draft exists -
 * that is what lets them edit and submit it - but §12 is explicit that a
 * pending seller cannot yet run a shop: no offers, no staff, nothing public.
 * Giving them the merchant experience would be a screen full of actions that
 * all refuse.
 *
 * VERIFIED and SUSPENDED are deliberately absent. Both were approved once, so
 * the shop is a real shop; a suspended merchant still needs the admin screens
 * to read why and to put it right. NULL is absent for the reason given above:
 * it is every shop that predates review (§15).
 */
const NEVER_APPROVED = new Set([DRAFT, PENDING_VERIFICATION, ADDITIONAL_INFO_REQUIRED, REJECTED]);

/** True for a shop still waiting on its first approval. NULL is not. */
function isAwaitingFirstApproval(verificationStatus) {
  return NEVER_APPROVED.has(verificationStatus);
}

/** Decisions only an authorised reviewer may make (§14). */
const REVIEWER_ONLY = new Set([VERIFIED, REJECTED, ADDITIONAL_INFO_REQUIRED, SUSPENDED]);

/** The grant that makes someone a reviewer (§14). */
const REVIEW_PERMISSION = 'REVIEW_SELLER_REGISTRATIONS';

/**
 * May this user decide registrations?
 *
 * Checks `globalPermissions` rather than the effective set on purpose: a
 * permission held through a shop membership is held *for that shop*, and a
 * merchant who could review their own shop is exactly what §14 forbids. The
 * check is written here rather than imported from `accessControl` because
 * that module already imports this one, and a cycle between the two would
 * make whichever loaded second see a half-built export.
 */
function mayReview(user) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return Array.isArray(user.globalPermissions) && user.globalPermissions.includes(REVIEW_PERMISSION);
}

/** Decisions that must carry an explanation the seller will read (§14). */
const REASON_REQUIRED = new Set([REJECTED, ADDITIONAL_INFO_REQUIRED]);

/**
 * May a shop in this verification state be switched on?
 *
 * The guard that matters. A self-registered seller holds ADMIN on their own
 * shop the moment they create it, and ADMIN carries EDIT_SHOP - so without
 * this, `PATCH /shops/:id {status:'active'}` is a one-request route from
 * unreviewed draft to publicly discoverable (§11, §27.12).
 *
 * NULL passes, because it is every pre-existing shop (§15).
 */
function blocksActivation(verificationStatus) {
  if (verificationStatus === null || verificationStatus === undefined) return false;
  return verificationStatus !== VERIFIED;
}

/** Human wording for a refused activation, by state. */
const ACTIVATION_REFUSAL = {
  [DRAFT]: 'This shop has not been submitted for verification yet.',
  [PENDING_VERIFICATION]: 'This shop is waiting for verification.',
  [ADDITIONAL_INFO_REQUIRED]: 'This shop needs more information before it can be verified.',
  [REJECTED]: 'This shop’s registration was rejected.',
  [SUSPENDED]: 'This shop is suspended.',
};

/**
 * Refuses an activation the verification state does not allow.
 *
 * Reviewers are exempt: §14 gives them Activate as an explicit action, and
 * somebody has to be able to switch a shop on after approving it.
 */
function assertMayActivate(verificationStatus, user) {
  if (!blocksActivation(verificationStatus)) return;
  if (mayReview(user)) return;

  const why = ACTIVATION_REFUSAL[verificationStatus] ?? 'This shop cannot be made live yet.';
  throw ApiError.forbidden(`${why} It cannot be made live until that is resolved.`);
}

/**
 * Refuses an illegal move between verification states.
 *
 * `from` of null means a shop that never entered review; the only way in is to
 * start a draft, which is what self-registration does when it creates the row.
 */
function assertTransition(from, to, user) {
  if (!STATUSES.includes(to)) {
    throw ApiError.badRequest(`Unknown verification status: ${to}`);
  }

  if (REVIEWER_ONLY.has(to) && !mayReview(user)) {
    // §29.7: only authorised reviewers approve, and a merchant may never
    // approve their own shop. Checked here as well as at the route so a new
    // caller cannot reach the decision by a path that forgot the middleware.
    throw ApiError.forbidden('Only an authorised reviewer can make this decision.');
  }

  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ApiError(
      409,
      from
        ? `This registration is ${from.replace(/_/g, ' ').toLowerCase()} and cannot move to ${to.replace(/_/g, ' ').toLowerCase()}.`
        : 'This shop is not part of a seller registration.',
      { from, to, allowed },
      'CONFLICT',
    );
  }
}

/** §14: a rejection or an information request without a reason is unusable. */
function assertReason(to, reason) {
  if (!REASON_REQUIRED.has(to)) return;
  if (typeof reason === 'string' && reason.trim().length >= 10) return;
  throw ApiError.unprocessable(
    'A reason is required, and the seller will read it. Say what is wrong and what they should do.',
    [{ field: 'reason', message: 'At least 10 characters' }],
  );
}

module.exports = {
  DRAFT,
  PENDING_VERIFICATION,
  ADDITIONAL_INFO_REQUIRED,
  VERIFIED,
  REJECTED,
  SUSPENDED,
  STATUSES,
  TRANSITIONS,
  REVIEW_PERMISSION,
  mayReview,
  NEVER_APPROVED,
  isAwaitingFirstApproval,
  blocksActivation,
  assertMayActivate,
  assertTransition,
  assertReason,
};
