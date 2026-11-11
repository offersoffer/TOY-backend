'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./premium.service');
const reports = require('./report.service');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const branchScope = require('../../services/branchScope');
const entitlements = require('../../services/entitlements');
const subscriptions = require('../subscriptions/subscription.service');
const plans = require('../../config/plans');
const exporters = require('../../utils/exporters');
const audit = require('../../utils/audit');
const { ok } = require('../../utils/respond');
// Shared with the Business Dashboard so the two never disagree about what
// "last 30 days" or "the previous period" means (§27, Business §32/§33).
const { DATE_PRESETS, resolvePresetRange } = require('../../utils/dateRange');

const router = express.Router();

const { FEATURES } = plans;

// ---------------------------------------------------------------------------
// Shared query contract (§27)
// ---------------------------------------------------------------------------

const filterQuery = z.object({
  preset: z.enum(DATE_PRESETS).default('last30'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  offerId: z.coerce.number().int().positive().optional(),
  campaignId: z.coerce.number().int().positive().optional(),
  city: z.string().trim().max(120).optional(),
  offerType: z.enum(['percentage', 'flat', 'buy_x_get_y', 'price_drop', 'up_to', 'other']).optional(),
  discountType: z.enum(['percentage', 'flat', 'none']).optional(),
  status: z.enum(['draft', 'scheduled', 'active', 'expired', 'deactivated']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(['views', 'claims', 'redemptions', 'conversion', 'saves', 'newest']).default('views'),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});

/**
 * Resolves which shops this request may report on, then narrows that to the
 * shops whose subscription actually includes `feature`.
 *
 * Ownership comes first and is never relaxed by a plan; a paid plan widens what
 * a merchant can see about *their own* shops, never whose shops they can see.
 */
async function resolveContext(req, feature) {
  const permitted = accessControl.shopScopeFor(req.user, 'VIEW_ANALYTICS');
  const requested = req.query.shopId ? Number(req.query.shopId) : null;

  if (requested !== null && permitted !== null && !permitted.includes(requested)) {
    throw ApiError.forbidden('You can only view analytics for your own shop');
  }

  // Super Admins administer the platform rather than subscribe to it, so their
  // scope is not filtered by any plan.
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
    // One shop in the request gives the precise plan it is on, which makes the
    // upgrade prompt specific rather than generic.
    if (candidates.length === 1) await entitlements.assertFeature(candidates[0], feature);
    throw entitlements.featureRefusal(feature, null);
  }

  const filters = filtersFrom(req.query);
  // A branch admin does not choose the branch filter; it is chosen for them,
  // and a request naming another branch is refused rather than quietly
  // answered about their own.
  const branchId = branchScope.confineFilters(req.user, entitled, filters, 'VIEW_ANALYTICS');

  return {
    shopIds: entitled,
    range: resolvePresetRange(req.query),
    filters,
    confinedToBranch: branchId,
    plan: await subscriptions.planKeyForShop(entitled[0]),
  };
}

function filtersFrom(query) {
  return {
    branchId: query.branchId,
    categoryId: query.categoryId,
    offerId: query.offerId,
    campaignId: query.campaignId,
    city: query.city,
    offerType: query.offerType,
    discountType: query.discountType,
    status: query.status,
  };
}

/** Wires up one dashboard endpoint: feature gate, context, handler. */
function dashboard(path, feature, handler, extraValidation) {
  router.get(
    path,
    validate({ query: extraValidation ?? filterQuery }),
    asyncHandler(async (req, res) => {
      const context = await resolveContext(req, feature);
      ok(res, await handler(context, req));
    }),
  );
}

router.use(authenticate);
router.use(requirePermission('VIEW_ANALYTICS'));

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

/** §8 Executive overview. */
dashboard('/overview', FEATURES.ANALYTICS_ADVANCED, (context) => service.executiveOverview(context));

/** §9 Offer performance. */
dashboard('/offer-performance', FEATURES.ANALYTICS_ADVANCED, (context, req) =>
  service.offerPerformance(context, { limit: req.query.limit, sort: req.query.sort }),
);

/** §10 Customer funnel. Business gets the basic funnel, Premium the advanced one. */
dashboard('/funnel', FEATURES.FUNNEL_BASIC, (context) => service.funnel(context));

/** §11 Location intelligence. */
dashboard('/locations', FEATURES.LOCATION_ANALYTICS_ADVANCED, (context, req) =>
  service.locationInsights(context, {
    position:
      req.query.latitude !== undefined && req.query.longitude !== undefined
        ? { latitude: req.query.latitude, longitude: req.query.longitude }
        : null,
  }),
);

/** §12 Branch performance. */
dashboard('/branches', FEATURES.BRANCH_ANALYTICS, (context) => service.branchPerformance(context));

/** §13, §14 Customer insights. */
dashboard('/customers', FEATURES.CUSTOMER_ANALYTICS_ADVANCED, (context) =>
  service.customerInsights(context),
);

/** §23 Customer acquisition. */
dashboard('/acquisition', FEATURES.CUSTOMER_ANALYTICS_ADVANCED, (context) =>
  service.acquisition(context),
);

/** §24 Customer retention. */
dashboard('/retention', FEATURES.CUSTOMER_TRENDS, (context) => service.retention(context));

/** §15 Campaign performance. */
dashboard('/campaigns', FEATURES.CAMPAIGN_ANALYTICS, (context) =>
  service.campaignPerformance(context),
);

/** §16 Offer comparison. */
router.get(
  '/offer-comparison',
  validate({
    query: filterQuery.extend({
      offerIds: z
        .string()
        .transform((value) =>
          value
            .split(',')
            .map((part) => Number(part.trim()))
            .filter((id) => Number.isInteger(id) && id > 0),
        )
        .pipe(z.array(z.number()).min(1).max(6)),
    }),
  }),
  asyncHandler(async (req, res) => {
    const context = await resolveContext(req, FEATURES.OFFER_COMPARISON);
    ok(res, await service.offerComparison(context, req.query.offerIds));
  }),
);

/** §17 Discount effectiveness. */
dashboard('/discount-effectiveness', FEATURES.OFFER_INTELLIGENCE, (context) =>
  service.discountEffectiveness(context),
);

/** §18 Best time to post. */
dashboard('/best-time', FEATURES.OFFER_INTELLIGENCE, (context) => service.bestTimeToPost(context));

/** §19 Ending soon opportunities. */
dashboard('/ending-soon', FEATURES.OFFER_INTELLIGENCE, (context) =>
  service.endingSoonOpportunities(context),
);

/** §20 Offer health score. */
dashboard('/offer-health', FEATURES.OFFER_INTELLIGENCE, (context, req) =>
  service.offerHealth(context, { limit: Math.min(req.query.limit, 50) }),
);

/** §21 Merchant recommendations. */
dashboard('/recommendations', FEATURES.OFFER_INTELLIGENCE, (context) =>
  service.recommendations(context),
);

/** §22 Category and market insights. */
dashboard('/category-insights', FEATURES.CATEGORY_INSIGHTS, (context) =>
  service.categoryInsights(context),
);

/** §25 ROI. Only calculated where the merchant supplied the inputs. */
dashboard('/roi', FEATURES.ROI_DASHBOARD, (context) => service.roi(context));

/**
 * Everything the Offer Intelligence page shows, in one round trip. The page
 * would otherwise fire five requests that all resolve the same scope.
 */
dashboard('/offer-intelligence', FEATURES.OFFER_INTELLIGENCE, async (context) => {
  const [discount, timing, ending, health, advice] = await Promise.all([
    service.discountEffectiveness(context),
    service.bestTimeToPost(context),
    service.endingSoonOpportunities(context),
    service.offerHealth(context, { limit: 25 }),
    service.recommendations(context),
  ]);
  return { discountEffectiveness: discount, bestTime: timing, endingSoon: ending, health, recommendations: advice };
});

// ---------------------------------------------------------------------------
// §26 Reports
// ---------------------------------------------------------------------------

router.get(
  '/reports',
  asyncHandler(async (_req, res) => {
    ok(res, {
      types: reports.REPORT_TYPES.map((type) => ({
        key: type.key,
        label: type.label,
        description: type.description,
      })),
      formats: ['csv', 'xlsx'],
    });
  }),
);

router.get(
  '/reports/export',
  requirePermission('EXPORT_ANALYTICS'),
  validate({
    query: filterQuery.extend({
      type: z.enum(reports.REPORT_TYPES.map((type) => type.key)),
      format: z.enum(['csv', 'xlsx', 'excel']).default('csv'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const context = await resolveContext(req, FEATURES.ANALYTICS_EXPORT);
    const { columns, rows, label } = await reports.build(req.query.type, context);

    const stamp = context.range.from.toISOString().slice(0, 10);
    const file = exporters.render(req.query.format, columns, rows, {
      sheetName: label,
      fileName: `${req.query.type}-${stamp}`,
    });

    // Exports are a plan entitlement with a counter behind it, and taking data
    // off the platform is worth an audit entry.
    for (const shopId of context.shopIds ?? []) {
      await subscriptions.recordUsage(shopId, 'exports_generated');
    }
    await audit.record(req, {
      action: 'ANALYTICS_EXPORTED',
      entityType: 'analytics',
      newValue: { type: req.query.type, format: req.query.format, rows: rows.length },
    });

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.body.length);
    res.send(file.body);
  }),
);

module.exports = router;
module.exports.filterQuery = filterQuery;
