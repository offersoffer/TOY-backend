'use strict';

const express = require('express');
const { z } = require('zod');
const { queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
const audit = require('../../utils/audit');
const exporters = require('../../utils/exporters');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/authorize');
const { claimVerifyLimiter } = require('../../middleware/rateLimit');
const accessControl = require('../../services/accessControl');
const analyticsEvents = require('../../services/analyticsEvents');
const notifications = require('../../services/notifications');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, paginated } = require('../../utils/respond');
const claims = require('./claim.service');

const router = express.Router();

/**
 * The merchant's half of the workflow: Verify Claim (§7-§9), Confirm Redemption
 * (§10, §11), Redemption History (§24) and the Super Admin console (§26).
 *
 * Verification and redemption are two calls rather than one, because §38.7
 * requires the merchant to confirm explicitly. The verify call is what answers
 * "is this coupon good?"; nothing is written to the claim until a human at the
 * counter has looked at the answer and pressed the second button. That gap is
 * the entire point - it is what separates a scan from a redemption.
 */

const codeField = z.string().trim().min(3).max(32);
const methodField = z.enum(['QR_SCAN', 'CODE_ENTRY']).default('CODE_ENTRY');
const branchField = z.coerce.number().int().positive().nullable().optional();

/**
 * `code` or `qrToken`, never both required. The scanner posts the token it read;
 * the keypad posts what the shopkeeper typed.
 */
const verifyBody = z
  .object({
    code: codeField.optional(),
    qrToken: z.string().min(10).max(512).optional(),
    method: methodField,
    branchId: branchField,
  })
  .refine((body) => Boolean(body.code || body.qrToken), {
    message: 'Provide a claim code or a scanned QR token',
    path: ['code'],
  });

router.use(authenticate);

/**
 * Resolves what the merchant presented into a claim row, and records the
 * attempt (§30, §32) whatever the outcome.
 *
 * The rate-limit check comes first, so a run of guesses is stopped before it
 * gets to touch the claims table at all (§28).
 */
async function resolveAttempt(req, { code, qrToken, method, branchId }) {
  await claims.assertNotRateLimited(req.user.id);

  // A scanned QR names its own kind; a typed code names nothing, so both
  // tables are searched (§22). Either way the shopkeeper is never asked which
  // sort of coupon they are holding.
  const scanned = qrToken ? claims.readQrPayload(qrToken) : null;
  const presented = qrToken ? scanned?.code ?? null : claims.normaliseCode(code);

  await analyticsEvents.record(analyticsEvents.EVENT_TYPES.CLAIM_VERIFICATION_ATTEMPT, {
    userId: req.user.id,
  });

  const found = presented ? await claims.findAnyByCode(presented, scanned?.kind) : null;
  const row = found?.row ?? null;
  const kind = found?.kind ?? 'offer';

  // A forged QR and an invented code are the same event as far as anyone
  // outside is concerned (§13); the log below is where they are told apart.
  if (!row) {
    await claims.logVerification(req, {
      code: presented ?? null,
      method,
      action: 'REJECTED',
      reason: qrToken && !presented ? 'BAD_QR_SIGNATURE' : 'NOT_FOUND',
    });
    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.CLAIM_VERIFICATION_FAILURE, {
      userId: req.user.id,
    });
    throw ApiError.notFound(claims.REJECTIONS.NOT_FOUND);
  }

  const branch = claims.resolveBranch(req.user, row.shop_id, branchId);
  const verdict = await claims.evaluate(row, req.user, branch, kind);

  if (!verdict.ok) {
    await claims.logVerification(req, {
      claimId: Number(row.id),
      kind,
      parentId: Number(row.offer_id),
      // A claim for another shop is logged against the shop that *tried*, not
      // the one that owns it - it is the attempt that is worth investigating,
      // and attributing it to the innocent shop would bury it.
      shopId: verdict.reason === 'WRONG_SHOP' ? null : Number(row.shop_id),
      branchId: branch,
      customerId: verdict.reason === 'WRONG_SHOP' ? null : Number(row.user_id),
      code: row.code,
      method,
      action: 'REJECTED',
      reason: verdict.reason,
    });
    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.CLAIM_VERIFICATION_FAILURE, {
      shopId: verdict.reason === 'WRONG_SHOP' ? null : Number(row.shop_id),
      offerId: kind === 'offer' ? Number(row.offer_id) : null,
      userId: req.user.id,
    });

    // A wrong-shop claim must read exactly like a code that does not exist, or
    // the verify screen becomes a way to ask whether a code is live anywhere.
    if (verdict.reason === 'WRONG_SHOP') throw ApiError.notFound(verdict.message);

    const error =
      verdict.reason === 'ALREADY_REDEEMED'
        ? ApiError.conflict(verdict.message)
        : ApiError.badRequest(verdict.message);
    // The merchant screen (§14, §15) shows more than the sentence: which
    // reason it was, and when it was redeemed if that is the answer.
    error.details = {
      reason: verdict.reason,
      redeemedAt: row.redeemed_at,
      expiresAt: row.expires_at,
    };
    throw error;
  }

  return { row, branch, kind };
}

/**
 * Verify Claim (§8, §9, §10). Read-only: it tells the merchant what they are
 * holding and stops there.
 */
router.post(
  '/verify',
  claimVerifyLimiter,
  requirePermission('VERIFY_CLAIM'),
  validate({ body: verifyBody }),
  asyncHandler(async (req, res) => {
    const { row, branch, kind } = await resolveAttempt(req, req.body);

    await claims.logVerification(req, {
      claimId: Number(row.id),
      kind,
      parentId: Number(row.offer_id),
      shopId: Number(row.shop_id),
      branchId: branch,
      customerId: Number(row.user_id),
      code: row.code,
      method: req.body.method,
      action: 'VERIFIED',
    });
    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.CLAIM_VERIFICATION_SUCCESS, {
      shopId: Number(row.shop_id),
      offerId: kind === 'offer' ? Number(row.offer_id) : null,
      userId: req.user.id,
    });

    ok(res, {
      ...claims.mapClaim(row, 'merchant', kind),
      // §10's "READY TO REDEEM". Verifying does not redeem, so the screen needs
      // to be told in as many words that the second button is still to come.
      verdict: 'READY_TO_REDEEM',
      canRedeem: accessControl.hasShopPermission(req.user, row.shop_id, 'REDEEM_OFFER'),
      branchId: branch,
    });
  }),
);

/**
 * Confirm Redemption (§11). The only place in the codebase that writes
 * `redeemed`, and it re-runs every check verify ran: the customer may have
 * cancelled, the claim may have expired, or a second till may have redeemed it
 * in the seconds between the two calls.
 */
router.post(
  '/redeem',
  claimVerifyLimiter,
  requirePermission('REDEEM_OFFER'),
  validate({ body: verifyBody }),
  asyncHandler(async (req, res) => {
    const { row, branch, kind } = await resolveAttempt(req, req.body);
    if (!accessControl.hasShopPermission(req.user, row.shop_id, 'REDEEM_OFFER')) {
      throw ApiError.forbidden('You do not have permission to redeem claims for this shop');
    }

    const allowed = Number(row.max_redemptions_per_claim ?? 1);
    // The guard against a double-tap and against two tills at once: the WHERE
    // clause re-checks the count that `evaluate` already read, so only one
    // UPDATE of the two can match. Losing that race is not an error the
    // shopkeeper caused, so it is reported as §15's "already redeemed".
    const result = await execute(
      `UPDATE ${claims.kindOf(kind).claimsTable}
          SET redemption_count = redemption_count + 1,
              status = CASE WHEN redemption_count + 1 >= ? THEN 'redeemed' ELSE status END,
              redeemed_at = NOW(),
              redeemed_by = ?,
              branch_id = COALESCE(?, branch_id),
              verification_method = ?
        WHERE id = ? AND status = 'claimed' AND redemption_count < ?`,
      [allowed, req.user.id, branch, req.body.method, row.id, allowed],
    );

    if (!Number(result.affectedRows)) {
      await claims.logVerification(req, {
        claimId: Number(row.id),
        kind,
        parentId: Number(row.offer_id),
        shopId: Number(row.shop_id),
        branchId: branch,
        customerId: Number(row.user_id),
        code: row.code,
        method: req.body.method,
        action: 'REJECTED',
        reason: 'ALREADY_REDEEMED',
      });
      throw ApiError.conflict(claims.REJECTIONS.ALREADY_REDEEMED);
    }

    await claims.logVerification(req, {
      claimId: Number(row.id),
      kind,
      parentId: Number(row.offer_id),
      shopId: Number(row.shop_id),
      branchId: branch,
      customerId: Number(row.user_id),
      code: row.code,
      method: req.body.method,
      action: 'REDEEMED',
    });

    // §18/§19: this is the verified offline conversion, and the only event in
    // the funnel that says a customer actually walked in.
    await analyticsEvents.touchShopCustomer(Number(row.shop_id), Number(row.user_id), 'redeem');
    await analyticsEvents.record(
      kind === 'service_offer'
        ? analyticsEvents.EVENT_TYPES.SERVICE_OFFER_REDEEM
        : analyticsEvents.EVENT_TYPES.OFFER_REDEMPTION,
      {
        shopId: Number(row.shop_id),
        // analytics_events.offer_id has a foreign key to `offers`, so a service
        // redemption is tagged by shop and branch alone.
        offerId: kind === 'offer' ? Number(row.offer_id) : null,
        // `row.offer_id` is aliased from `service_offer_id` for a service
        // claim, so this names the service offer without a second lookup. The
        // visibility stream has no FK to `offers` and can therefore credit a
        // verified service redemption to the listing that earned it - which
        // §2.4 makes the strongest ranking signal on the platform.
        serviceOfferId: kind === 'service_offer' ? Number(row.offer_id) : null,
        userId: Number(row.user_id),
        branchId: branch,
      },
    );

    await audit.record(req, {
      action: kind === 'service_offer' ? 'SERVICE_OFFER_CLAIM_REDEEMED' : 'CLAIM_REDEEMED',
      entityType: kind === 'service_offer' ? 'service_offer_claim' : 'offer_claim',
      entityId: Number(row.id),
      newValue: {
        kind,
        listingId: Number(row.offer_id),
        code: row.code,
        branchId: branch,
        method: req.body.method,
      },
    });

    const notify =
      kind === 'service_offer' ? notifications.notifyServiceOfferRedeemed : notifications.notifyOfferRedeemed;
    notify(Number(row.id)).catch((error) =>
      logger.error(
        {
          event: 'NOTIFICATION_SEND_FAILED',
          error_code: 'NOTIFICATION_SEND_FAILED',
          category: 'NOTIFICATION',
          dependency: 'PUSH',
          notification: 'REDEMPTION_CONFIRMED',
          err_message: error.message,
        },
        'Notification fan-out failed',
      ),
    );

    ok(res, claims.mapClaim(await claims.findById(row.id, kind), 'merchant', kind));
  }),
);

/**
 * The merchant looked at a verified claim and did not honour it (§32
 * OFFER_REDEMPTION_REJECTED) - the customer changed their mind, the stock ran
 * out. Recorded because a shop that verifies far more than it redeems is worth
 * asking about, and because the customer's claim stays live either way.
 */
router.post(
  '/reject',
  claimVerifyLimiter,
  requirePermission('VERIFY_CLAIM'),
  validate({
    body: z.object({
      code: codeField,
      reason: z.string().trim().max(60).optional(),
      method: methodField,
    }),
  }),
  asyncHandler(async (req, res) => {
    const found = await claims.findAnyByCode(req.body.code);
    const row = found?.row;
    const kind = found?.kind ?? 'offer';
    if (!row || !accessControl.hasShopPermission(req.user, row.shop_id, 'VERIFY_CLAIM')) {
      throw ApiError.notFound(claims.REJECTIONS.NOT_FOUND);
    }

    await claims.logVerification(req, {
      claimId: Number(row.id),
      kind,
      parentId: Number(row.offer_id),
      shopId: Number(row.shop_id),
      customerId: Number(row.user_id),
      code: row.code,
      method: req.body.method,
      action: 'REJECTED',
      reason: req.body.reason || 'MERCHANT_DECLINED',
    });
    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.OFFER_REDEMPTION_REJECTED, {
      shopId: Number(row.shop_id),
      offerId: kind === 'offer' ? Number(row.offer_id) : null,
      userId: req.user.id,
    });

    ok(res, { recorded: true });
  }),
);

/** How many failed attempts this user has left before §28 shuts them out. */
router.get(
  '/attempts',
  requirePermission('VERIFY_CLAIM'),
  asyncHandler(async (req, res) => {
    ok(res, {
      remaining: await claims.failureBudget(req.user.id),
      limit: claims.FAILURE_LIMIT,
      windowMinutes: claims.FAILURE_WINDOW_MINUTES,
    });
  }),
);

// ---------------------------------------------------------------------------
// History and oversight (§24, §26)
// ---------------------------------------------------------------------------

/**
 * Narrows a query to the shops the caller may see (§24, §26).
 *
 * `shopScopeFor` returns null for a Super Admin, meaning every shop - so the
 * distinction between "no shops" and "all shops" has to survive, which is why
 * this returns a clause rather than an array of ids.
 */
function shopScopeClause(user, permission, requestedShopId) {
  const scope = accessControl.shopScopeFor(user, permission);

  if (requestedShopId) {
    if (scope !== null && !scope.includes(Number(requestedShopId))) {
      throw ApiError.forbidden('You do not have access to this shop');
    }
    return { sql: 'c.shop_id = ?', params: [Number(requestedShopId)] };
  }
  if (scope === null) return { sql: '1 = 1', params: [] };
  if (!scope.length) return { sql: '1 = 0', params: [] };
  return { sql: `c.shop_id IN (${scope.map(() => '?').join(',')})`, params: scope };
}

/**
 * The joins and searchable columns each kind's list queries need.
 *
 * The COUNT(*) beside every list has to repeat the joins its WHERE touches,
 * and the searchable title lives on a different table for each kind - so both
 * are described once here rather than spelled out at four call sites.
 */
const LIST_SHAPES = {
  offer: {
    countFrom: `FROM offer_claims c
                  JOIN offers o ON o.id = c.offer_id
                  JOIN users  u ON u.id = c.user_id`,
    titleColumn: 'o.title',
  },
  service_offer: {
    countFrom: `FROM service_offer_claims c
                  JOIN service_offers so ON so.id = c.service_offer_id
                  JOIN services sv ON sv.id = so.service_id
                  JOIN users u ON u.id = c.user_id`,
    titleColumn: 'sv.name',
  },
};

const shapeFor = (kind) => LIST_SHAPES[kind] ?? LIST_SHAPES.offer;

const kindQuery = z.enum(['offer', 'service_offer']).default('offer');

const historyQuery = z.object({
  ...paginationSchema,
  /**
   * Which listing type to report on (§22). The merchant console shows one at a
   * time rather than a union: the two have different column headings, and a
   * merged list would have to blank half of each row.
   */
  kind: kindQuery,
  shopId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
  offerId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  code: codeField.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().trim().max(120).optional(),
});

/**
 * Narrows a claims query to the branches the caller is confined to (§16).
 *
 * Separate from `shopScopeClause` because the two answer different questions
 * and a caller can be confined in one of their shops and not in another; see
 * `claim.service.js`'s `branchScopeClause` for the rule itself.
 */
function branchScope(req, permission, kind) {
  return claims.branchScopeClause(
    accessControl.branchScopesFor(req.user, permission),
    kind,
  );
}

/** Builds the shared WHERE for the history and claims lists. */
function historyWhere(req, permission, extra = []) {
  const scope = shopScopeClause(req.user, permission, req.query.shopId);
  const shape = shapeFor(req.query.kind);
  const where = [scope.sql, ...extra];
  const params = [...scope.params];

  const branch = branchScope(req, permission, req.query.kind);
  if (branch) {
    where.push(branch.sql);
    params.push(...branch.params);
  }

  // A branch admin asking for another branch of a shop they are confined in is
  // told so, rather than handed an empty list they would read as a quiet week.
  // Without a shop id there is nothing to match the branch against, so that
  // case falls through to the scope clause above and simply returns nothing.
  if (req.query.branchId && req.query.shopId) {
    const allowed = accessControl
      .branchScopesFor(req.user, permission)
      .get(Number(req.query.shopId));
    if (allowed !== undefined && Number(req.query.branchId) !== allowed) {
      throw ApiError.forbidden('You can only view claims for your own branch');
    }
  }

  if (req.query.branchId) {
    where.push('c.branch_id = ?');
    params.push(req.query.branchId);
  }
  if (req.query.offerId) {
    where.push('c.offer_id = ?');
    params.push(req.query.offerId);
  }
  if (req.query.customerId) {
    where.push('c.user_id = ?');
    params.push(req.query.customerId);
  }
  if (req.query.code) {
    where.push('c.code = ?');
    params.push(claims.normaliseCode(req.query.code));
  }
  if (req.query.search) {
    where.push(`(${shape.titleColumn} LIKE ? OR u.name LIKE ? OR c.code LIKE ?)`);
    const like = `%${req.query.search}%`;
    params.push(like, like, like);
  }
  return { where, params };
}

/** Recent Redemptions (§24). Redeemed claims only, newest first. */
router.get(
  '/',
  requirePermission('VIEW_REDEMPTION_HISTORY'),
  validate({ query: historyQuery }),
  asyncHandler(async (req, res) => {
    const kind = req.query.kind;
    const { limit, page, offset } = limitOffset(req.query);
    const { where, params } = historyWhere(req, 'VIEW_REDEMPTION_HISTORY', [
      'c.redeemed_at IS NOT NULL',
    ]);

    if (req.query.from) {
      where.push('c.redeemed_at >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      where.push('c.redeemed_at <= ?');
      params.push(req.query.to);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(
        `${claims.selectFor(kind)} ${whereSql} ORDER BY c.redeemed_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total ${shapeFor(kind).countFrom} ${whereSql}`, params),
    ]);

    const audience = req.user.isSuperAdmin ? 'admin' : 'merchant';
    paginated(
      res,
      rows.map((row) => claims.mapClaim(row, audience, kind)),
      { page, limit, total: Number(countRows[0].total) },
    );
  }),
);

/**
 * Today's Activity for the merchant dashboard (§35), plus the §20 conversion.
 * Deliberately cheap: three counts the shopkeeper sees on the home screen of a
 * phone they are also using to serve customers.
 */
router.get(
  '/summary',
  requirePermission('VIEW_CLAIMS'),
  validate({ query: z.object({ shopId: z.coerce.number().int().positive().optional() }) }),
  asyncHandler(async (req, res) => {
    const scope = shopScopeClause(req.user, 'VIEW_CLAIMS', req.query.shopId);

    // Both kinds, added together. The shopkeeper looking at this is asking
    // "how busy was the counter today", and a customer redeeming a service
    // coupon walked through the same door as one redeeming a product coupon.
    const totals = { claims_today: 0, redemptions_today: 0, pending: 0, claims_total: 0, redemptions_total: 0 };
    for (const descriptor of Object.values(claims.KINDS)) {
      // The branch clause is per kind, because where a claim's branch rule
      // lives differs between them - and this query has no joins to lean on,
      // which is why that fragment is written to be self-contained.
      const branch = branchScope(req, 'VIEW_CLAIMS', descriptor.key);
      const row = await queryOne(
        `SELECT
           SUM(DATE(c.claimed_at) = CURDATE())                  AS claims_today,
           SUM(DATE(c.redeemed_at) = CURDATE())                 AS redemptions_today,
           SUM(c.status = 'claimed' AND c.expires_at >= NOW())  AS pending,
           COUNT(*)                                             AS claims_total,
           SUM(c.redeemed_at IS NOT NULL)                       AS redemptions_total
         FROM ${descriptor.claimsTable} c
          WHERE ${scope.sql}${branch ? ` AND ${branch.sql}` : ''}`,
        [...scope.params, ...(branch ? branch.params : [])],
      );
      for (const key of Object.keys(totals)) totals[key] += Number(row?.[key] ?? 0);
    }

    const claimsTotal = totals.claims_total;
    const redemptionsTotal = totals.redemptions_total;

    /**
     * A branch admin's claim counts and their redemption counts are not
     * measured the same way, and cannot be.
     *
     * A redemption happened at one branch and says so. A claim that has not
     * been redeemed happened at no branch at all, so it is counted at every
     * branch that could honour it - which is the only useful answer to "what
     * might walk in today", and which deliberately counts one shop-wide claim
     * once per branch. Dividing the second into the first would therefore
     * report a conversion rate that falls as a shop opens more branches, so
     * the ratio is withheld instead of quietly misstated.
     */
    const confinedHere = accessControl.branchScopesFor(req.user, 'VIEW_CLAIMS').size > 0;

    ok(res, {
      claimsToday: totals.claims_today,
      redemptionsToday: totals.redemptions_today,
      pending: totals.pending,
      claimsTotal,
      redemptionsTotal,
      // §20's "Claim → Redemption". Null rather than 0 when nothing has been
      // claimed: a shop with no claims has no conversion rate, and printing
      // 0.0% would read as a failure rather than as an empty dashboard.
      claimToRedemption:
        claimsTotal && !confinedHere
          ? Number(((redemptionsTotal / claimsTotal) * 100).toFixed(1))
          : null,
      /**
       * Says out loud that these counters cover one branch, so the dashboard
       * can label them rather than let a branch admin read a shop-wide claim
       * count as their own footfall.
       */
      branchScoped: confinedHere,
    });
  }),
);

/**
 * Every claim, not only the redeemed ones (§24 filters, §26 search). This is
 * the screen a Super Admin investigates a dispute from, and the one a merchant
 * uses to see what is outstanding.
 */
router.get(
  '/claims',
  requirePermission('VIEW_CLAIMS'),
  validate({
    query: historyQuery.extend({
      status: z
        .enum(['claimed', 'redeemed', 'expired', 'cancelled', 'revoked', 'active', 'all'])
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const kind = req.query.kind;
    const { limit, page, offset } = limitOffset(req.query);
    const { where, params } = historyWhere(req, 'VIEW_CLAIMS');

    if (req.query.status && req.query.status !== 'all') {
      if (req.query.status === 'active') {
        where.push("c.status = 'claimed' AND c.expires_at >= NOW()");
      } else {
        where.push('c.status = ?');
        params.push(req.query.status);
      }
    }
    if (req.query.from) {
      where.push('c.claimed_at >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      where.push('c.claimed_at <= ?');
      params.push(req.query.to);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(
        `${claims.selectFor(kind)} ${whereSql} ORDER BY c.claimed_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total ${shapeFor(kind).countFrom} ${whereSql}`, params),
    ]);

    const audience = req.user.isSuperAdmin ? 'admin' : 'merchant';
    paginated(
      res,
      rows.map((row) => claims.mapClaim(row, audience, kind)),
      { page, limit, total: Number(countRows[0].total) },
    );
  }),
);

/**
 * The verification trail for one claim (§26 "view audit history", §30).
 *
 * Includes the rejections, which is the point: when a customer says their code
 * was refused, this is the record of what the till was told and why.
 */
router.get(
  '/claims/:claimId(\\d+)/audit',
  requirePermission('VIEW_CLAIMS'),
  validate({
    params: z.object({ claimId: z.coerce.number().int().positive() }),
    query: z.object({ kind: kindQuery }),
  }),
  asyncHandler(async (req, res) => {
    const kind = req.query.kind;
    const claim = await claims.findById(req.params.claimId, kind);
    if (!claim) throw ApiError.notFound('Claim not found');
    if (!accessControl.hasShopPermission(req.user, claim.shop_id, 'VIEW_CLAIMS')) {
      throw ApiError.forbidden('That claim belongs to another shop');
    }
    if (!(await claims.mayViewClaim(req.user, claim, kind, 'VIEW_CLAIMS'))) {
      throw ApiError.forbidden('That claim belongs to another branch');
    }

    const rows = await rawQuery(
      `SELECT v.id, v.action, v.reason, v.method, v.created_at,
              v.branch_id, b.branch_name, u.id AS actor_id, u.name AS actor_name
         FROM claim_verifications v
         LEFT JOIN users u ON u.id = v.verified_by
         LEFT JOIN shop_branches b ON b.id = v.branch_id
        WHERE v.${claims.kindOf(kind).verificationClaimColumn} = ?
        ORDER BY v.created_at DESC, v.id DESC LIMIT 100`,
      [req.params.claimId],
    );

    ok(res, {
      claim: claims.mapClaim(claim, req.user.isSuperAdmin ? 'admin' : 'merchant', kind),
      events: rows.map((row) => ({
        id: Number(row.id),
        action: row.action,
        reason: row.reason,
        method: row.method,
        at: row.created_at,
        branch: row.branch_id ? { id: Number(row.branch_id), name: row.branch_name } : null,
        actor: row.actor_id ? { id: Number(row.actor_id), name: row.actor_name } : null,
      })),
    });
  }),
);

/**
 * Revokes a claim (§12, §26). Super Admin only by default, because it is what
 * happens when a customer and a shop disagree and neither should be able to
 * settle that alone. §26 requires the override to be logged explicitly, so this
 * writes to both the audit log and the claim's own verification trail.
 */
router.post(
  '/claims/:claimId(\\d+)/revoke',
  requirePermission('REVOKE_CLAIM'),
  validate({
    params: z.object({ claimId: z.coerce.number().int().positive() }),
    query: z.object({ kind: kindQuery }),
    body: z.object({ reason: z.string().trim().min(3).max(255) }),
  }),
  asyncHandler(async (req, res) => {
    const kind = req.query.kind;
    const claim = await claims.findById(req.params.claimId, kind);
    if (!claim) throw ApiError.notFound('Claim not found');
    if (!accessControl.hasShopPermission(req.user, claim.shop_id, 'REVOKE_CLAIM')) {
      throw ApiError.forbidden('That claim belongs to another shop');
    }
    if (!(await claims.mayViewClaim(req.user, claim, kind, 'REVOKE_CLAIM'))) {
      throw ApiError.forbidden('That claim belongs to another branch');
    }
    if (claim.status === 'revoked') throw ApiError.conflict('This claim is already revoked');

    await execute(
      `UPDATE ${claims.kindOf(kind).claimsTable}
          SET status = 'revoked', revoked_at = NOW(), revoked_by = ?, revoke_reason = ?
        WHERE id = ?`,
      [req.user.id, req.body.reason, claim.id],
    );

    await claims.logVerification(req, {
      claimId: Number(claim.id),
      kind,
      parentId: Number(claim.offer_id),
      shopId: Number(claim.shop_id),
      customerId: Number(claim.user_id),
      code: claim.code,
      method: 'CODE_ENTRY',
      action: 'REVOKED',
      reason: 'ADMIN_REVOKED',
    });
    await audit.record(req, {
      action: kind === 'service_offer' ? 'SERVICE_OFFER_CLAIM_REVOKED' : 'CLAIM_REVOKED',
      entityType: kind === 'service_offer' ? 'service_offer_claim' : 'offer_claim',
      entityId: Number(claim.id),
      oldValue: { status: claim.status },
      newValue: { status: 'revoked', reason: req.body.reason },
    });

    ok(res, claims.mapClaim(await claims.findById(claim.id, kind), 'admin', kind));
  }),
);

// ---------------------------------------------------------------------------
// Export (§25 EXPORT_REDEMPTION_REPORT)
// ---------------------------------------------------------------------------

const EXPORT_COLUMNS = [
  { key: 'code', label: 'Claim code' },
  { key: 'offer', label: 'Offer' },
  { key: 'shop', label: 'Shop' },
  { key: 'branch', label: 'Branch' },
  { key: 'customer', label: 'Customer' },
  { key: 'claimedAt', label: 'Claimed' },
  { key: 'redeemedAt', label: 'Redeemed' },
  { key: 'method', label: 'Verified by' },
  { key: 'redeemedBy', label: 'Redeemed by' },
];

router.get(
  '/export',
  requirePermission('EXPORT_REDEMPTION_REPORT'),
  validate({
    query: historyQuery.extend({ format: z.enum(['csv', 'xlsx', 'excel']).default('csv') }),
  }),
  asyncHandler(async (req, res) => {
    const { where, params } = historyWhere(req, 'EXPORT_REDEMPTION_REPORT', [
      'c.redeemed_at IS NOT NULL',
    ]);
    if (req.query.from) {
      where.push('c.redeemed_at >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      where.push('c.redeemed_at <= ?');
      params.push(req.query.to);
    }

    // Capped rather than unbounded: an export is a synchronous response held in
    // memory, and a merchant who needs more than this needs a date range.
    const rows = await rawQuery(
      `${claims.selectFor(req.query.kind)} WHERE ${where.join(' AND ')}
        ORDER BY c.redeemed_at DESC LIMIT 10000`,
      params,
    );

    const file = exporters.render(
      req.query.format,
      EXPORT_COLUMNS,
      rows.map((row) => ({
        code: row.code,
        offer: row.offer_title,
        shop: row.shop_name,
        branch: row.branch_name ?? '',
        customer: row.customer_name,
        claimedAt: row.claimed_at,
        redeemedAt: row.redeemed_at,
        method: row.verification_method ?? '',
        redeemedBy: row.redeemed_by_name ?? '',
      })),
      { sheetName: 'Redemptions', fileName: `redemptions-${new Date().toISOString().slice(0, 10)}` },
    );

    // Taking customer names off the platform is worth an audit entry (§24).
    await audit.record(req, {
      action: 'REDEMPTION_REPORT_EXPORTED',
      entityType: 'offer_claim',
      newValue: { format: req.query.format, rows: rows.length, shopId: req.query.shopId ?? null },
    });

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.body.length);
    res.send(file.body);
  }),
);

module.exports = router;
