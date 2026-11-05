'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./featureOverride.service');
const catalogue = require('../../config/featureCatalogue');
const audit = require('../../utils/audit');
const { businessDate } = require('../../utils/businessDate');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requireSuperAdmin, requireGlobalPermission } = require('../../middleware/authorize');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, paginated } = require('../../utils/respond');

const router = express.Router();

/**
 * Super Admin feature overrides (§11C, §11L).
 *
 * Every route here demands an authenticated Super Admin. That is the whole
 * point of §11L: an Admin must never be able to grant a feature to themselves,
 * to another Admin, or to extend their own access, so there is no shop-scoped
 * path into any of these handlers.
 *
 * `requireGlobalPermission('MANAGE_ROLES')` is layered under the Super Admin
 * check as the "required Super Admin permission" step of §11L's pipeline -
 * being a Super Admin is not by itself taken as permission to do everything.
 */
router.use(authenticate, requireSuperAdmin, requireGlobalPermission('MANAGE_ROLES'));

const shopIdParam = z.object({ shopId: z.coerce.number().int().positive() });

const grantBody = z
  .object({
    featureKey: z
      .string()
      .trim()
      .refine((key) => catalogue.isGrantable(key), 'Unknown feature'),
    adminUserId: z.coerce.number().int().positive().optional(),
    // A bare date names a day, and an override that "expires on the 5th"
    // should last that whole day - see utils/businessDate.js.
    startsAt: businessDate('start').optional(),
    expiresAt: businessDate('end').optional(),
    isPermanent: z.boolean().optional().default(false),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((body) => body.isPermanent || Boolean(body.expiresAt), {
    message: 'Set an expiry date, or mark the override permanent',
    path: ['expiresAt'],
  });

/** The catalogue a Super Admin may grant from (§11D). */
router.get(
  '/catalogue',
  asyncHandler(async (_req, res) => {
    ok(res, { features: catalogue.CATALOGUE });
  }),
);

/** Dashboard tiles (§11M). */
router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    ok(res, await service.summary());
  }),
);

/** Filterable list (§11M): feature, shop, admin, status, expiry, granted by. */
router.get(
  '/',
  validate({
    query: z.object({
      ...paginationSchema,
      shopId: z.coerce.number().int().positive().optional(),
      adminUserId: z.coerce.number().int().positive().optional(),
      featureKey: z.string().trim().max(60).optional(),
      grantedBy: z.coerce.number().int().positive().optional(),
      status: z.enum(['active', 'expired', 'permanent', 'revoked']).optional(),
      expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { limit, offset, page } = limitOffset(req.query);
    const { items, total } = await service.list({ ...req.query, limit, offset });
    paginated(res, items, { page, limit, total });
  }),
);

/** Override history (§11I). */
router.get(
  '/history',
  validate({
    query: z.object({
      shopId: z.coerce.number().int().positive().optional(),
      featureKey: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    ok(res, await service.history(req.query));
  }),
);

/** One shop: current plan, plan features, and everything granted on top (§11C). */
router.get(
  '/shops/:shopId',
  validate({ params: shopIdParam }),
  asyncHandler(async (req, res) => {
    ok(res, await service.shopOverview(Number(req.params.shopId)));
  }),
);

/** Grant, extend or modify one feature for one shop (§11C, §11E). */
router.post(
  '/shops/:shopId',
  validate({ params: shopIdParam, body: grantBody }),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const override = await service.grant(shopId, req.body, req.user);

    await audit.record(req, {
      action: 'FEATURE_OVERRIDE_GRANTED',
      entityType: 'shop',
      entityId: shopId,
      newValue: {
        featureKey: override.featureKey,
        expiresAt: override.expiresAt,
        isPermanent: override.isPermanent,
        reason: override.reason,
      },
    });

    ok(res, override);
  }),
);

/** Revoke one feature (§11C). The row and its history are kept (§11I). */
router.delete(
  '/shops/:shopId/:featureKey',
  validate({
    params: shopIdParam.extend({ featureKey: z.string().trim().max(60) }),
    body: z.object({ reason: z.string().trim().max(500).optional() }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const shopId = Number(req.params.shopId);
    const override = await service.revoke(
      shopId,
      req.params.featureKey,
      req.user,
      req.body?.reason,
    );

    await audit.record(req, {
      action: 'FEATURE_OVERRIDE_REVOKED',
      entityType: 'shop',
      entityId: shopId,
      oldValue: { featureKey: override.featureKey },
      newValue: { reason: req.body?.reason ?? null },
    });

    ok(res, override);
  }),
);

module.exports = router;
