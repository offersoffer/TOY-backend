'use strict';

const express = require('express');
const { z } = require('zod');
const { businessDate } = require('../../utils/businessDate');
const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const { ok, created, noContent } = require('../../utils/respond');
const vis = require('../../config/visibility');
const config = require('../../services/visibility/config');
const featuredPlacements = require('../../services/visibility/featuredPlacement.service');
const campaigns = require('../../services/visibility/campaign.service');
const merchantEntitlements = require('../../services/visibility/merchantEntitlement.service');
const signals = require('../../services/visibility/signals.service');

const router = express.Router();

/**
 * Super Admin visibility controls (§22).
 *
 * Everything §22 lists lives here: ranking weights, subscription priority
 * weights, featured placement rules, slot availability, rotation rules,
 * frequency limits, campaign approval, campaign start/end, category and
 * location eligibility, merchant feature overrides and promotion permissions.
 *
 * ## Two things this router guarantees
 *
 * §22: "All changes should be audited." Every write below records an audit
 * entry with the old and new value - a ranking weight change is invisible from
 * the outside and can move a merchant's livelihood, so it needs to be at least
 * as traceable as editing their shop.
 *
 * §24: "Admins cannot directly set their own ranking score." The permission
 * these routes require is global, and never granted to a shop Admin. There is
 * no per-listing score to set even for a Super Admin - the weights apply to
 * everyone at once, which is a very different kind of power from putting one
 * shop first.
 */
router.use(authenticate);
router.use(requireGlobalPermission('MANAGE_VISIBILITY'));

// ---------------------------------------------------------------------------
// Ranking weights (§4, §22)

/**
 * The weights document, in one place.
 *
 * Every endpoint that changes a weight answers with this same shape rather than
 * a summary of what it changed. A reset that replied with only `{surfaces,
 * weights}` was enough to blank the admin screen, which renders from `factors`
 * — the kind of mismatch that is invisible in a unit test and obvious the
 * moment a person clicks the button.
 */
/**
 * The rules response, in one place.
 *
 * GET and PUT must answer with the same shape. They did not: PUT returned only
 * `rules`, the client's type promised `defaults` as well, and the admin screen
 * read `defaults[key]` straight after a save - which threw, silently, in a
 * component that had already rendered. The value was saved correctly, so the
 * only symptom was a console error and a "· default N" comparison that stopped
 * appearing. Found by reading the browser console during end-to-end testing.
 */
async function rulesDocument() {
  const current = await config.get();
  return { rules: current.rules, defaults: vis.DEFAULT_RULES };
}

async function weightsDocument() {
  const current = await config.get();
  return {
    surfaces: vis.SURFACE_KEYS,
    factors: vis.FACTOR_KEYS.map((key) => ({ key, label: vis.FACTOR_LABELS[key] })),
    weights: current.weights,
    defaults: vis.DEFAULT_WEIGHTS,
    // §13's recommended search priority, served alongside so the admin screen
    // can show what the ordering is supposed to express rather than nine
    // numbers with no stated intent.
    searchPriority: [
      'Search relevance',
      'Location',
      'Validity',
      'Customer preference',
      'Offer quality',
      'Engagement',
      'Subscription priority',
      'Freshness',
    ],
  };
}

router.get(
  '/weights',
  asyncHandler(async (_req, res) => {
    ok(res, await weightsDocument());
  }),
);

const weightBody = z.object({
  surface: z.enum(vis.SURFACE_KEYS),
  factor: z.enum(vis.FACTOR_KEYS),
  weight: z.coerce.number().min(0).max(10),
  isActive: z.boolean().default(true),
});

router.put(
  '/weights',
  validate({ body: weightBody }),
  asyncHandler(async (req, res) => {
    const before = await config.get();
    const previous = before.weights[req.body.surface]?.[req.body.factor];

    await config.setWeight(
      req.body.surface,
      req.body.factor,
      req.body.weight,
      req.body.isActive,
      req.user.id,
    );

    await audit.record(req, {
      action: 'RANKING_WEIGHT_UPDATED',
      entityType: 'ranking_weight',
      entityId: null,
      oldValue: { surface: req.body.surface, factor: req.body.factor, weight: previous },
      newValue: req.body,
    });

    ok(res, await weightsDocument());
  }),
);

router.post(
  '/weights/reset',
  validate({ body: z.object({ surface: z.enum(vis.SURFACE_KEYS).optional() }) }),
  asyncHandler(async (req, res) => {
    const before = await config.get();
    const surfaces = await config.resetWeights(req.body.surface, req.user.id);

    await audit.record(req, {
      action: 'RANKING_WEIGHTS_RESET',
      entityType: 'ranking_weight',
      entityId: null,
      oldValue: Object.fromEntries(surfaces.map((key) => [key, before.weights[key]])),
      newValue: { surfaces, restoredTo: 'defaults' },
    });

    ok(res, { ...(await weightsDocument()), surfaces });
  }),
);

// ---------------------------------------------------------------------------
// Rules: decay curves, rotation, diversity, anti-manipulation (§22)

router.get(
  '/rules',
  asyncHandler(async (_req, res) => {
    const current = await config.get();
    ok(res, await rulesDocument());
  }),
);

const ruleBody = z.object({
  // Constrained to the known keys: an invented rule name would be stored
  // happily and then never read by anything, which is the worst kind of
  // configuration bug - it looks like it worked.
  ruleKey: z.string().refine((key) => key in vis.DEFAULT_RULES, {
    message: 'Unknown visibility rule',
  }),
  value: z.union([z.number(), z.record(z.number()), z.boolean()]),
  isActive: z.boolean().default(true),
});

router.put(
  '/rules',
  validate({ body: ruleBody }),
  asyncHandler(async (req, res) => {
    const before = await config.get();
    const previous = before.rules[req.body.ruleKey];
    const isScalar = typeof req.body.value === 'number';

    await config.setRule(
      req.body.ruleKey,
      isScalar
        ? { valueNumber: req.body.value, isActive: req.body.isActive }
        : { valueJson: req.body.value, isActive: req.body.isActive },
      req.user.id,
    );

    await audit.record(req, {
      action: 'VISIBILITY_RULE_UPDATED',
      entityType: 'visibility_rule',
      entityId: null,
      oldValue: { ruleKey: req.body.ruleKey, value: previous },
      newValue: req.body,
    });

    ok(res, await rulesDocument());
  }),
);

// ---------------------------------------------------------------------------
// Featured slots (§11, §22)

router.get(
  '/slots',
  validate({
    query: z.object({
      placementType: z.enum(vis.PLACEMENT_TYPE_KEYS).optional(),
      status: z.enum(['active', 'inactive']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    ok(res, await featuredPlacements.listSlots(req.query));
  }),
);

const slotBody = z.object({
  code: z.string().trim().min(2).max(60),
  placementType: z.enum(vis.PLACEMENT_TYPE_KEYS),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  capacity: z.coerce.number().int().min(1).max(50).default(4),
  minPlanRank: z.coerce.number().int().min(0).max(2).default(2),
  categoryId: z.coerce.number().int().positive().optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  status: z.enum(['active', 'inactive']).default('active'),
});

router.put(
  '/slots',
  validate({ body: slotBody }),
  asyncHandler(async (req, res) => {
    const before = await featuredPlacements.getSlot(req.body.code);
    const slot = await featuredPlacements.upsertSlot(req.body);

    await audit.record(req, {
      action: before ? 'FEATURED_SLOT_UPDATED' : 'FEATURED_SLOT_CREATED',
      entityType: 'featured_slot',
      entityId: slot.id,
      oldValue: before,
      newValue: slot,
    });

    if (before) ok(res, slot);
    else created(res, slot);
  }),
);

/** §10's fairness audit: has exposure actually circulated in this slot? */
router.get(
  '/slots/:code/rotation',
  validate({
    params: z.object({ code: z.string().trim().max(60) }),
    query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
  }),
  asyncHandler(async (req, res) => {
    ok(res, await featuredPlacements.rotationReport(req.params.code, req.query.days));
  }),
);

// ---------------------------------------------------------------------------
// Frequency limits (§18, §22)

router.get(
  '/frequency-limits',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT fl.*, u.name AS updated_by_name FROM frequency_limits fl
         LEFT JOIN users u ON u.id = fl.updated_by
        ORDER BY fl.scope, fl.placement_type`,
    );
    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        scope: row.scope,
        placementType: row.placement_type,
        appliesTo: row.applies_to,
        maxImpressions: Number(row.max_impressions),
        windowMinutes: Number(row.window_minutes),
        status: row.status,
        updatedBy: row.updated_by_name ?? null,
        updatedAt: row.updated_at,
      })),
    );
  }),
);

const limitBody = z.object({
  scope: z.enum(['offer', 'shop', 'campaign', 'placement']),
  placementType: z.enum(vis.PLACEMENT_TYPE_KEYS).optional().nullable(),
  appliesTo: z.enum(['user', 'session']).default('user'),
  maxImpressions: z.coerce.number().int().min(1).max(1000),
  windowMinutes: z.coerce.number().int().min(1).max(43200),
  status: z.enum(['active', 'inactive']).default('active'),
});

router.put(
  '/frequency-limits',
  validate({ body: limitBody }),
  asyncHandler(async (req, res) => {
    const payload = req.body;
    const before = await queryOne(
      `SELECT * FROM frequency_limits
        WHERE scope = ? AND applies_to = ?
          AND (placement_type <=> ?)`,
      [payload.scope, payload.appliesTo, payload.placementType ?? null],
    );

    await execute(
      `INSERT INTO frequency_limits
         (scope, placement_type, applies_to, max_impressions, window_minutes, status, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         max_impressions = VALUES(max_impressions), window_minutes = VALUES(window_minutes),
         status = VALUES(status), updated_by = VALUES(updated_by)`,
      [
        payload.scope,
        payload.placementType ?? null,
        payload.appliesTo,
        payload.maxImpressions,
        payload.windowMinutes,
        payload.status,
        req.user.id,
      ],
    );
    config.invalidate();

    await audit.record(req, {
      action: 'FREQUENCY_LIMIT_UPDATED',
      entityType: 'frequency_limit',
      entityId: before ? Number(before.id) : null,
      oldValue: before,
      newValue: payload,
    });

    const after = await config.get();
    ok(res, { frequencyLimits: after.frequencyLimits });
  }),
);

// ---------------------------------------------------------------------------
// Ranking exclusions (§24, §25)

router.get(
  '/exclusions',
  validate({
    query: z.object({
      status: z.enum(['active', 'lifted']).default('active'),
      source: z.enum(['admin', 'auto']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const where = ['rx.status = ?'];
    const params = [req.query.status];
    if (req.query.source) {
      where.push('rx.source = ?');
      params.push(req.query.source);
    }

    const rows = await rawQuery(
      `SELECT rx.*, s.name AS shop_name, u.name AS created_by_name
         FROM ranking_exclusions rx
         LEFT JOIN shops s ON s.id = rx.shop_id
         LEFT JOIN users u ON u.id = rx.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY rx.created_at DESC
        LIMIT ${Number.parseInt(req.query.limit, 10)}`,
      params,
    );

    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        scope: row.scope,
        listingType: row.listing_type,
        listingId: row.listing_id === null ? null : Number(row.listing_id),
        shopId: row.shop_id === null ? null : Number(row.shop_id),
        shopName: row.shop_name ?? null,
        source: row.source,
        reason: row.reason,
        expiresAt: row.expires_at,
        status: row.status,
        createdBy: row.created_by_name ?? null,
        createdAt: row.created_at,
      })),
    );
  }),
);

const exclusionBody = z
  .object({
    scope: z.enum(['listing', 'shop']),
    listingType: z.enum(['offer', 'service_offer', 'shop']).optional(),
    listingId: z.coerce.number().int().positive().optional(),
    shopId: z.coerce.number().int().positive().optional(),
    reason: z.string().trim().min(3).max(255),
    // An exclusion lifted "on the 5th" runs to the end of the 5th.
    expiresAt: businessDate('end').optional().nullable(),
  })
  .refine((data) => (data.scope === 'listing' ? data.listingType && data.listingId : Boolean(data.shopId)), {
    message: 'A listing exclusion needs listingType and listingId; a shop exclusion needs shopId',
  });

router.post(
  '/exclusions',
  validate({ body: exclusionBody }),
  asyncHandler(async (req, res) => {
    const payload = req.body;
    const result = await execute(
      `INSERT INTO ranking_exclusions
         (listing_type, listing_id, shop_id, scope, source, reason, expires_at, created_by)
       VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)`,
      [
        payload.listingType ?? null,
        payload.listingId ?? null,
        payload.shopId ?? null,
        payload.scope,
        payload.reason,
        payload.expiresAt ?? null,
        req.user.id,
      ],
    );

    await audit.record(req, {
      action: 'RANKING_EXCLUSION_CREATED',
      entityType: 'ranking_exclusion',
      entityId: result.insertId,
      newValue: payload,
    });

    created(res, { id: result.insertId, ...payload });
  }),
);

router.delete(
  '/exclusions/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM ranking_exclusions WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('Exclusion not found');

    await execute(
      `UPDATE ranking_exclusions SET status = 'lifted', lifted_by = ?, lifted_at = NOW() WHERE id = ?`,
      [req.user.id, req.params.id],
    );

    await audit.record(req, {
      action: 'RANKING_EXCLUSION_LIFTED',
      entityType: 'ranking_exclusion',
      entityId: Number(req.params.id),
      oldValue: { status: existing.status, reason: existing.reason },
      newValue: { status: 'lifted' },
    });

    noContent(res);
  }),
);

// ---------------------------------------------------------------------------
// Campaign approval (§22)

router.get(
  '/campaigns',
  validate({
    query: z.object({
      status: z.enum(vis.CAMPAIGN_STATUSES).optional(),
      placementType: z.enum(vis.PLACEMENT_TYPE_KEYS).optional(),
      shopId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    // `shopIds` is deliberately absent: a Super Admin's queue is platform-wide,
    // which is the whole point of an approval queue.
    ok(res, await campaigns.list(req.query));
  }),
);

router.post(
  '/campaigns/:id/approve',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const campaign = await campaigns.approve(req.params.id, req.user);
    await audit.record(req, {
      action: 'FEATURED_CAMPAIGN_APPROVED',
      entityType: 'featured_campaign',
      entityId: Number(req.params.id),
      newValue: { name: campaign.name, shopId: campaign.shopId, status: campaign.status },
    });
    ok(res, campaign);
  }),
);

router.post(
  '/campaigns/:id/reject',
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ reason: z.string().trim().min(3).max(500) }),
  }),
  asyncHandler(async (req, res) => {
    const campaign = await campaigns.reject(req.params.id, req.body.reason, req.user);
    await audit.record(req, {
      action: 'FEATURED_CAMPAIGN_REJECTED',
      entityType: 'featured_campaign',
      entityId: Number(req.params.id),
      newValue: { reason: req.body.reason },
    });
    ok(res, campaign);
  }),
);

router.post(
  '/campaigns/:id/status',
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ status: z.enum(vis.CAMPAIGN_STATUSES) }),
  }),
  asyncHandler(async (req, res) => {
    const before = await campaigns.getById(req.params.id);
    if (!before) throw ApiError.notFound('Campaign not found');
    const campaign = await campaigns.setStatus(req.params.id, req.body.status);

    await audit.record(req, {
      action: 'FEATURED_CAMPAIGN_STATUS_CHANGED',
      entityType: 'featured_campaign',
      entityId: Number(req.params.id),
      oldValue: { status: before.status },
      newValue: { status: campaign.status },
    });
    ok(res, campaign);
  }),
);

// ---------------------------------------------------------------------------
// Merchant visibility entitlements (§23)

router.get(
  '/entitlements',
  validate({
    query: z.object({
      shopId: z.coerce.number().int().positive().optional(),
      status: z.enum(['active', 'revoked', 'expired']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    ok(res, await merchantEntitlements.list(req.query));
  }),
);

router.get(
  '/entitlements/shop/:shopId',
  validate({ params: z.object({ shopId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    ok(res, await merchantEntitlements.resolve(req.params.shopId));
  }),
);

const grantBody = z.object({
  shopId: z.coerce.number().int().positive(),
  level: z.enum(['BASIC', 'ENHANCED', 'PRIORITY']),
  reason: z.string().trim().max(255).optional(),
  featuredAccess: z.boolean().default(false),
  startsAt: businessDate('start').optional(),
  expiresAt: businessDate('end').optional().nullable(),
});

/**
 * §23's free-launch grant: Business or Premium visibility without payment.
 *
 * Nothing here touches `shop_subscriptions`. The merchant is still on whatever
 * plan they are on, paying whatever they pay - this only raises what they are
 * eligible for, which is exactly what §23 describes and the only version of it
 * that does not eventually produce a wrong invoice.
 */
router.post(
  '/entitlements',
  validate({ body: grantBody }),
  asyncHandler(async (req, res) => {
    const grant = await merchantEntitlements.grant(req.body.shopId, req.body, req.user.id);
    await audit.record(req, {
      action: 'VISIBILITY_ENTITLEMENT_GRANTED',
      entityType: 'merchant_visibility_entitlement',
      entityId: grant.id,
      newValue: grant,
    });
    created(res, grant);
  }),
);

router.delete(
  '/entitlements/shop/:shopId',
  validate({ params: z.object({ shopId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const revoked = await merchantEntitlements.revoke(req.params.shopId, req.user.id);
    await audit.record(req, {
      action: 'VISIBILITY_ENTITLEMENT_REVOKED',
      entityType: 'merchant_visibility_entitlement',
      entityId: revoked.id,
      oldValue: { level: revoked.level, reason: revoked.reason },
      newValue: { status: 'revoked' },
    });
    ok(res, revoked);
  }),
);

// ---------------------------------------------------------------------------
// Diagnostics

/**
 * Why one listing scores what it scores.
 *
 * The support answer to "why is my offer ranking fourth" (§27). Reading the
 * precomputed checklist rather than re-running the scorer keeps this honest:
 * it reports what ranking actually used, not what a second implementation
 * would have computed.
 */
router.get(
  '/listings/:listingType/:listingId/score',
  validate({
    params: z.object({
      listingType: z.enum(['offer', 'service_offer', 'shop']),
      listingId: z.coerce.number().int().positive(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const detail = await signals.detailFor(req.params.listingType, req.params.listingId);
    if (!detail) throw ApiError.notFound('No computed score for this listing yet');
    ok(res, detail);
  }),
);

module.exports = router;
