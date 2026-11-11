'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./serviceAnalytics.service');
const premiumRoutes = require('../analytics/premium.routes');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const branchScope = require('../../services/branchScope');
const entitlements = require('../../services/entitlements');
const subscriptions = require('../subscriptions/subscription.service');
const { FEATURES } = require('../../config/plans');
const { ok } = require('../../utils/respond');

/**
 * Service analytics dashboards (V4 §20-§22): basic tier (Business+) and
 * premium tier (Premium only), mirroring the offer premium-analytics module's
 * context resolution (`premium.routes.js`) but scoped to `VIEW_SERVICE_ANALYTICS`.
 */

const router = express.Router();

// `filterQuery` and the shared range resolver are reused as-is - same date-range and filter
// contract as the offer dashboards, so the two analytics areas stay consistent.
const { filterQuery } = premiumRoutes;
const { resolvePresetRange } = require('../../utils/dateRange');

const serviceFilterQuery = filterQuery
  .omit({ offerId: true, campaignId: true, offerType: true, discountType: true })
  .extend({ serviceId: z.coerce.number().int().positive().optional() });

function filtersFrom(query) {
  return {
    branchId: query.branchId,
    categoryId: query.categoryId,
    serviceId: query.serviceId,
    city: query.city,
    status: query.status,
  };
}

/** Mirrors premium.routes.js's resolveContext, scoped to service permissions/features. */
async function resolveContext(req, feature) {
  const permitted = accessControl.shopScopeFor(req.user, 'VIEW_SERVICE_ANALYTICS');
  const requested = req.query.shopId ? Number(req.query.shopId) : null;

  if (requested !== null && permitted !== null && !permitted.includes(requested)) {
    throw ApiError.forbidden('You can only view analytics for your own shop');
  }

  if (permitted === null) {
    return {
      shopIds: requested === null ? null : [requested],
      range: resolvePresetRange(req.query),
      filters: filtersFrom(req.query),
      plan: 'PLATFORM',
    };
  }

  if (permitted.length === 0) throw ApiError.forbidden('You are not assigned to any shop');

  const candidates = requested === null ? permitted : [requested];
  const entitled = feature ? await entitlements.filterShopsWithFeature(candidates, feature) : candidates;

  if (entitled.length === 0) {
    if (candidates.length === 1) await entitlements.assertFeature(candidates[0], feature);
    throw entitlements.featureRefusal(feature, null);
  }

  const filters = filtersFrom(req.query);
  // A branch admin does not choose the branch filter; it is chosen for them,
  // and a request naming another branch is refused rather than quietly
  // answered about their own.
  const branchId = branchScope.confineFilters(req.user, entitled, filters, 'VIEW_SERVICE_ANALYTICS');

  return {
    shopIds: entitled,
    range: resolvePresetRange(req.query),
    filters,
    confinedToBranch: branchId,
    plan: await subscriptions.planKeyForShop(entitled[0]),
  };
}

function dashboard(path, feature, handler) {
  router.get(
    path,
    validate({ query: serviceFilterQuery }),
    asyncHandler(async (req, res) => {
      const context = await resolveContext(req, feature);
      ok(res, await handler(context, req));
    }),
  );
}

router.use(authenticate);
router.use(requirePermission('VIEW_SERVICE_ANALYTICS'));

// ---- Basic tier (Business+) --------------------------------------------------
dashboard('/overview', FEATURES.SERVICE_ANALYTICS_BASIC, (context) => service.overview(context));

// ---- Premium tier (Premium only) --------------------------------------------
dashboard('/performance', FEATURES.SERVICE_ANALYTICS_ADVANCED, (context) => service.servicePerformance(context));
dashboard('/funnel', FEATURES.SERVICE_ANALYTICS_ADVANCED, (context) => service.funnel(context));
dashboard('/offer-performance', FEATURES.SERVICE_ANALYTICS_ADVANCED, (context) => service.offerPerformance(context));
dashboard('/branches', FEATURES.SERVICE_ANALYTICS_ADVANCED, (context) => service.branchPerformance(context));
dashboard('/locations', FEATURES.SERVICE_ANALYTICS_ADVANCED, (context) => service.locationInsights(context));
dashboard('/customers', FEATURES.SERVICE_ANALYTICS_ADVANCED, (context) => service.customerTrends(context));
dashboard('/category-insights', FEATURES.SERVICE_ANALYTICS_ADVANCED, (context) => service.categoryInsights(context));

router.get(
  '/comparison',
  validate({
    query: serviceFilterQuery.extend({
      serviceIds: z
        .string()
        .transform((value) =>
          value.split(',').map((part) => Number(part.trim())).filter((id) => Number.isInteger(id) && id > 0),
        )
        .pipe(z.array(z.number()).min(1).max(6)),
    }),
  }),
  asyncHandler(async (req, res) => {
    const context = await resolveContext(req, FEATURES.SERVICE_ANALYTICS_ADVANCED);
    ok(res, await service.serviceComparison(context, req.query.serviceIds));
  }),
);

module.exports = router;
