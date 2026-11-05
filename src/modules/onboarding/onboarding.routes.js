'use strict';

const express = require('express');
const controller = require('./onboarding.controller');
const schema = require('./onboarding.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { onboardingLimiter } = require('../../middleware/rateLimit');

const router = express.Router();

/**
 * Seller self-registration (§21).
 *
 * Every route is authenticated and none carries a permission check, which is
 * the point: §3 says a seller signs in with an ordinary account and is granted
 * merchant access by trusted backend logic, so requiring CREATE_SHOP here
 * would mean no new seller could ever reach it. Ownership is enforced inside
 * the service against `shop_members` for each registration, which is also
 * what stops one seller reading another's by changing the id (§19, §27.18).
 */
router.use(authenticate);

/** Resume whatever is in flight (§4). */
router.get('/me', asyncHandler(controller.mine));

router.post(
  '/',
  // §19: registration rate limiting, keyed by account.
  onboardingLimiter,
  validate({ body: schema.startSchema }),
  asyncHandler(controller.start),
);

router.get('/:id', validate({ params: schema.idParam }), asyncHandler(controller.get));

router.patch(
  '/:id',
  validate({ params: schema.idParam, body: schema.updateSchema }),
  asyncHandler(controller.update),
);

/**
 * Submit for review (§10).
 *
 * POST rather than PATCH because it is an action rather than an edit, and it
 * is idempotent by design: submitting something already pending returns the
 * same registration rather than failing, so a retried request after a dropped
 * connection does not look like an error to the seller (§24).
 */
router.post(
  '/:id/submit',
  onboardingLimiter,
  validate({ params: schema.idParam, body: schema.submitSchema }),
  asyncHandler(controller.submit),
);

module.exports = router;
