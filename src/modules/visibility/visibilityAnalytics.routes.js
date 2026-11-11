'use strict';

const express = require('express');
const { z } = require('zod');
const { queryOne } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const entitlements = require('../../services/entitlements');
const plans = require('../../config/plans');
const { ok } = require('../../utils/respond');
const vis = require('../../config/visibility');
const analytics = require('../../services/visibility/visibilityAnalytics.service');
const merchantEntitlements = require('../../services/visibility/merchantEntitlement.service');
const campaigns = require('../../services/visibility/campaign.service');
const signals = require('../../services/visibility/signals.service');

const router = express.Router();

/**
 * The merchant's visibility dashboard (§15), Premium analytics (§16) and
 * campaign performance (§17).
 *
 * Two gates on every route, and they are different questions:
 *
 *   permission   - may this person see a shop's analytics at all?
 *   entitlement  - does this shop's plan include this depth of analytics?
 *
 * §23's rule is the same one the rest of the platform uses:
 * `Role Permission AND (Subscription Entitlement OR Super Admin Override)`.
 * A Super Admin passes the shop scope by holding the permission globally, and
 * the plan gate is skipped for platform-wide reads - the platform owner is not
 * subject to a merchant's subscription.
 */
router.use(authenticate);
router.use(requirePermission('VIEW_VISIBILITY_ANALYTICS'));

const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** One explicit window, so every query in a response covers the same period. */
function resolveRange(params) {
  if (params.from && params.to) {
    const to = new Date(params.to);
    if (to.getHours() === 0 && to.getMinutes() === 0) to.setHours(23, 59, 59, 999);
    return { from: new Date(params.from), to, label: 'custom' };
  }
  const to = new Date();
  return { from: new Date(to.getTime() - params.days * 86400000), to, label: `${params.days}d` };
}

/**
 * Which shops this response may cover.
 *
 * `null` means platform-wide. An Admin is always narrowed to their own shops,
 * and asking for someone else's shop id is a 403 rather than an empty result -
 * an empty result would be indistinguishable from a quiet week and would leak
 * nothing useful while confusing everyone.
 */
function scopeFor(user, requestedShopId) {
  const scope = accessControl.shopScopeFor(user, 'VIEW_VISIBILITY_ANALYTICS');

  if (requestedShopId) {
    if (scope !== null && !scope.includes(Number(requestedShopId))) {
      throw ApiError.forbidden('You can only view visibility analytics for your own shop');
    }
    return [Number(requestedShopId)];
  }
  if (scope !== null && scope.length === 0) throw ApiError.forbidden('You are not assigned to any shop');
  return scope;
}

/**
 * The plan gate. Platform-wide reads skip it; a single-shop read is held to
 * that shop's own entitlement, by plan or by Super Admin override.
 */
async function assertPlanAllows(shopIds, feature) {
  if (shopIds === null) return;
  for (const shopId of shopIds) await entitlements.assertFeature(shopId, feature);
}

/** §15's dashboard: overview, visibility breakdown and the conversion funnel. */
router.get(
  '/dashboard',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = scopeFor(req.user, req.query.shopId);
    await assertPlanAllows(scope, plans.FEATURES.VISIBILITY_ANALYTICS);

    const range = resolveRange(req.query);
    const dashboard = await analytics.merchantDashboard(scope, range);

    // §27: a merchant should be able to understand where they were discovered
    // and what their plan is doing for them, not just read counters.
    const entitlement =
      scope !== null && scope.length === 1 ? await merchantEntitlements.resolve(scope[0]) : null;

    ok(res, {
      ...dashboard,
      visibilityLevel: entitlement?.visibilityLevel ?? null,
      visibilitySource: entitlement?.source ?? null,
      // A platform-wide read covers many shops on many levels, so it falls back
      // to §21's generic text; a single shop gets its own.
      promise: entitlement?.promise ?? vis.VISIBILITY_PROMISE,
    });
  }),
);

/** §16's Premium slices: branch, location, timing, best performers, search. */
router.get(
  '/premium',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = scopeFor(req.user, req.query.shopId);
    await assertPlanAllows(scope, plans.FEATURES.VISIBILITY_ANALYTICS_ADVANCED);

    const range = resolveRange(req.query);
    // A branch admin gets their own branch's row in the breakdown and nobody
    // else's; the rest of the report stays shop-wide, because an impression in
    // a feed did not happen at a branch. See `premiumInsights`.
    const confinedTo = accessControl
      .branchScopesFor(req.user, 'VIEW_VISIBILITY_ANALYTICS')
      .values()
      .next().value ?? null;

    ok(res, {
      range,
      ...(await analytics.premiumInsights(scope, range, {
        limit: req.query.limit,
        branchId: confinedTo,
      })),
      branchScoped: confinedTo !== null,
    });
  }),
);

/** §17's campaign card, for every campaign the caller can see. */
router.get(
  '/campaigns',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = scopeFor(req.user, req.query.shopId);
    await assertPlanAllows(scope, plans.FEATURES.VISIBILITY_ANALYTICS);

    const range = resolveRange(req.query);
    const list = await campaigns.list({ shopIds: scope, shopId: req.query.shopId, limit: 50 });
    const performance = await Promise.all(
      list.map(async (campaign) => ({
        campaign,
        performance: await analytics.campaignPerformance(campaign.id, range),
      })),
    );

    ok(res, { range, campaigns: performance });
  }),
);

router.get(
  '/campaigns/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }), query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const campaign = await campaigns.getById(req.params.id);
    if (!campaign) throw ApiError.notFound('Campaign not found');
    if (!accessControl.hasShopPermission(req.user, campaign.shopId, 'VIEW_VISIBILITY_ANALYTICS')) {
      throw ApiError.forbidden('This campaign belongs to another shop');
    }
    await assertPlanAllows([campaign.shopId], plans.FEATURES.VISIBILITY_ANALYTICS);

    const range = resolveRange(req.query);
    ok(res, {
      campaign,
      range,
      performance: await analytics.campaignPerformance(campaign.id, range),
    });
  }),
);

/**
 * §27's "what should I fix": the offer-quality checklist for one listing.
 *
 * The half of ranking a merchant can actually control. Distance and a
 * customer's interests are not theirs to change; a missing image is.
 */
router.get(
  '/listings/:listingType/:listingId/quality',
  validate({
    params: z.object({
      listingType: z.enum(['offer', 'service_offer']),
      listingId: z.coerce.number().int().positive(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const detail = await signals.detailFor(req.params.listingType, req.params.listingId);
    if (!detail) throw ApiError.notFound('No computed score for this listing yet');

    const shopId = await shopIdForListing(req.params.listingType, req.params.listingId);
    if (!accessControl.hasShopPermission(req.user, shopId, 'VIEW_VISIBILITY_ANALYTICS')) {
      throw ApiError.forbidden('That listing belongs to another shop');
    }

    ok(res, {
      ...detail,
      // Named suggestions rather than raw keys, so the merchant screen renders
      // the advice instead of reinventing this mapping.
      suggestions: detail.missing.map((key) => QUALITY_ADVICE[key] ?? key),
    });
  }),
);

const QUALITY_ADVICE = {
  title: 'Give the offer a clear, descriptive title of at least a few words.',
  description: 'Add a fuller description - customers skip offers they cannot understand.',
  discountValue: 'State the discount or value clearly.',
  image: 'Add a photo. This is the single biggest thing you can do for visibility.',
  category: 'Pick the right category so the offer appears in category browsing.',
  location: 'Confirm at least one active branch location on the map.',
  validDates: 'Check the start and end dates.',
  shopProfile: 'Complete your shop profile - add a logo and a description.',
};

async function shopIdForListing(listingType, listingId) {
  const row =
    listingType === 'offer'
      ? await queryOne('SELECT shop_id FROM offers WHERE id = ?', [listingId])
      : await queryOne('SELECT shop_id FROM service_offers WHERE id = ?', [listingId]);
  if (!row) throw ApiError.notFound('Listing not found');
  return Number(row.shop_id);
}

module.exports = router;
