'use strict';

const express = require('express');
const controller = require('./review.controller');
const schema = require('./onboarding.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const shopVerification = require('../../services/shopVerification');

const router = express.Router();

/**
 * Seller Management → Registrations (§14).
 *
 * A separate router from the seller's own `/onboarding`, and the difference
 * is the whole point: that one deliberately carries no permission check,
 * because a customer registering their first shop holds nothing yet. This one
 * is behind a global permission for every route, applied once here rather
 * than per route so a handler added later cannot be left open by omission.
 *
 * `requireGlobalPermission` and not `requirePermission`: the second accepts a
 * permission held through a shop membership, which would let a merchant who
 * was somehow granted it approve their own registration (§14, §19).
 */
router.use(authenticate, requireGlobalPermission(shopVerification.REVIEW_PERMISSION));

/** The queue, filtered and paginated (§14, §21). */
router.get('/', validate({ query: schema.reviewListQuery }), asyncHandler(controller.list));

/*
  Claims on shops we already have (§16 steps 6-9). Declared before `/:id` so
  Express does not read "claims" as a registration id, and under the same
  permission: deciding who manages an existing shop is the same kind of
  authority as deciding whether a new one is real.
*/
router.get(
  '/claims',
  validate({ query: schema.claimListQuery }),
  asyncHandler(controller.listClaims),
);

router.get(
  '/claims/:id',
  validate({ params: schema.idParam }),
  asyncHandler(controller.getClaim),
);

router.post(
  '/claims/:id/approve',
  validate({ params: schema.idParam }),
  asyncHandler(controller.approveClaim),
);

router.post(
  '/claims/:id/reject',
  validate({ params: schema.idParam, body: schema.claimRejectSchema }),
  asyncHandler(controller.rejectClaim),
);

router.get('/:id', validate({ params: schema.idParam }), asyncHandler(controller.detail));

router.get('/:id/history', validate({ params: schema.idParam }), asyncHandler(controller.history));

/*
  The decisions. POST rather than PATCH because each is an event with a
  consequence - a notification to the seller, a change to what the public can
  see - rather than an edit to a field. Each is guarded against being applied
  twice by the conditional UPDATE in the service, so a reviewer who
  double-clicks gets one decision and one notification, and a second reviewer
  deciding the same registration gets a 409 rather than silently overwriting.
*/
router.post(
  '/:id/approve',
  validate({ params: schema.idParam, body: schema.approveSchema }),
  asyncHandler(controller.approve),
);

router.post(
  '/:id/reject',
  validate({ params: schema.idParam, body: schema.reasonRequired }),
  asyncHandler(controller.reject),
);

router.post(
  '/:id/request-info',
  validate({ params: schema.idParam, body: schema.reasonRequired }),
  asyncHandler(controller.requestInfo),
);

router.post(
  '/:id/suspend',
  validate({ params: schema.idParam, body: schema.reasonRequired }),
  asyncHandler(controller.suspend),
);

router.post(
  '/:id/reactivate',
  validate({ params: schema.idParam, body: schema.reasonOptional }),
  asyncHandler(controller.reactivate),
);

/** §11: the listing, kept separate from the verification decision. */
router.put(
  '/:id/listing',
  validate({ params: schema.idParam, body: schema.listingSchema }),
  asyncHandler(controller.setListing),
);

module.exports = router;
