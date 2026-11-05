'use strict';

const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const { parseBusinessDate } = require('../../utils/businessDate');
const { limitOffset } = require('../../utils/pagination');
const access = require('../../services/accessControl');
const subscriptions = require('../../services/subscriptions');
const aiClient = require('../../services/aiClient');
const context = require('./ai.context');
const guard = require('./ai.guard');
const schema = require('./ai.schema');
const { AI_FEATURES, PREMIUM_ONLY_SECTIONS } = require('../../config/aiFeatures');

/**
 * AI feature orchestration.
 *
 * The order is always the same, and every step of it is on the server (§40):
 *
 *   authorise the shop -> check the plan -> gather only authorised data ->
 *   call the AI service -> validate the answer -> re-check it against the offer
 *   -> record usage and history -> return
 *
 * Nothing in here writes to `offers`. §10 and §35 make that non-negotiable: the
 * AI produces a suggestion, the admin's own save request creates the offer.
 */

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/** Throws unless the user administers `shopId` with `permission`. */
function assertShopAccess(user, shopId, permission) {
  if (!access.hasShopPermission(user, shopId, permission)) {
    throw ApiError.forbidden('You do not have access to this shop');
  }
  return Number(shopId);
}

/** Shop ids the caller may see AI data for; `null` means every shop. */
function aiScope(user, permission = 'USE_AI_CONTENT') {
  return access.shopScopeFor(user, permission);
}

// ---------------------------------------------------------------------------
// Offer facts
// ---------------------------------------------------------------------------

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

function factsFromRow(row, extra = {}) {
  return {
    title: row.title ?? null,
    productName: row.product_name ?? null,
    offerType: row.offer_type ?? null,
    offerText: row.offer_text ?? null,
    discountType: row.discount_type ?? null,
    discountValue: toNumber(row.discount_value),
    originalPrice: toNumber(row.original_price),
    discountedPrice: toNumber(row.discounted_price),
    buyQuantity: toNumber(row.buy_quantity),
    getQuantity: toNumber(row.get_quantity),
    minPurchase: toNumber(row.min_purchase),
    startDate: row.start_date ? new Date(row.start_date).toISOString() : null,
    endDate: row.end_date ? new Date(row.end_date).toISOString() : null,
    termsConditions: row.terms_conditions ?? null,
    eligibility: row.eligibility ?? null,
    usageRestrictions: row.usage_restrictions ?? null,
    applicableProducts: row.applicable_products ?? null,
    currency: 'INR',
    ...extra,
  };
}

function factsFromPayload(offer, extra = {}) {
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  return {
    title: offer.title ?? null,
    productName: offer.productName ?? null,
    categoryName: offer.categoryName ?? null,
    offerType: offer.offerType ?? null,
    offerText: offer.offerText ?? null,
    discountType: offer.discountType ?? null,
    discountValue: toNumber(offer.discountValue),
    originalPrice: toNumber(offer.originalPrice),
    discountedPrice: toNumber(offer.discountedPrice),
    buyQuantity: toNumber(offer.buyQuantity),
    getQuantity: toNumber(offer.getQuantity),
    minPurchase: toNumber(offer.minPurchase),
    startDate: iso(offer.startDate),
    endDate: iso(offer.endDate),
    termsConditions: offer.termsConditions ?? null,
    eligibility: offer.eligibility ?? null,
    usageRestrictions: offer.usageRestrictions ?? null,
    applicableProducts: offer.applicableProducts ?? null,
    currency: 'INR',
    ...extra,
  };
}

/**
 * The authoritative offer for a content request.
 *
 * A saved `offerId` always wins over the inline draft: it is the row that will
 * actually be published, and it is re-read from the database so a tampered
 * request body cannot widen the discount the copy is checked against.
 */
async function resolveOfferFacts(payload, shopId) {
  const shop = await queryOne('SELECT name FROM shops WHERE id = ?', [shopId]);
  const shopName = shop?.name ?? null;

  if (payload.offerId) {
    const row = await queryOne(
      `SELECT o.*, c.name AS category_name
         FROM offers o
         LEFT JOIN categories c ON c.id = o.category_id
        WHERE o.id = ?`,
      [payload.offerId],
    );
    if (!row) throw ApiError.notFound('Offer not found');
    if (Number(row.shop_id) !== Number(shopId)) {
      throw ApiError.forbidden('This offer belongs to another shop');
    }
    return {
      facts: factsFromRow(row, { categoryName: row.category_name, shopName }),
      offerId: Number(row.id),
    };
  }

  const facts = factsFromPayload(payload.offer ?? {}, { shopName });
  if (!facts.title && !facts.offerText && !facts.productName) {
    throw ApiError.badRequest('Add an offer title or headline before generating content');
  }
  return { facts, offerId: null };
}

// ---------------------------------------------------------------------------
// Metering (§32) and history (§33)
// ---------------------------------------------------------------------------

async function recordUsage({ shopId, userId, feature, planCode, meta, status, errorCode, durationMs }) {
  try {
    await execute(
      `INSERT INTO ai_usage
         (shop_id, user_id, feature, plan_code, provider, model,
          prompt_tokens, completion_tokens, total_tokens, status, error_code, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId,
        userId ?? null,
        feature,
        planCode ?? null,
        meta?.provider ?? null,
        meta?.model ?? null,
        meta?.usage?.promptTokens ?? 0,
        meta?.usage?.completionTokens ?? 0,
        meta?.usage?.totalTokens ?? 0,
        status,
        errorCode ?? null,
        Math.min(durationMs ?? 0, 4294967295),
      ],
    );
  } catch (error) {
    // Losing a metering row must not lose the merchant their generation.
    logger.error(
      { event: 'AI_USAGE_RECORD_FAILED', category: 'DATABASE', dependency: 'DATABASE', err_message: error.message },
      'Could not record AI usage',
    );
  }
}

async function recordGeneration({
  shopId,
  userId,
  feature,
  offerId,
  requestSummary,
  resultSummary,
  request,
  result,
}) {
  try {
    const inserted = await execute(
      `INSERT INTO ai_generations
         (shop_id, user_id, feature, offer_id, request_summary, result_summary,
          request_payload, result_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId,
        userId ?? null,
        feature,
        offerId ?? null,
        requestSummary ? String(requestSummary).slice(0, 500) : null,
        resultSummary ? String(resultSummary).slice(0, 500) : null,
        JSON.stringify(request ?? {}),
        JSON.stringify(result ?? {}),
      ],
    );
    return Number(inserted.insertId);
  } catch (error) {
    logger.error(
      { event: 'AI_GENERATION_RECORD_FAILED', category: 'DATABASE', dependency: 'DATABASE', err_message: error.message },
      'Could not record an AI generation',
    );
    return null;
  }
}

/**
 * Runs one AI call with the plan check, metering and error translation around
 * it. `call` returns `{ data, durationMs }` from the AI client.
 */
async function withMetering({ shopId, user, feature }, call) {
  const { plan } = await subscriptions.assertFeatureAllowed(shopId, feature);
  const startedAt = Date.now();

  try {
    const { data, durationMs } = await call(plan);
    await recordUsage({
      shopId,
      userId: user.id,
      feature,
      planCode: plan.code,
      meta: data.meta,
      status: 'success',
      durationMs,
    });
    return { data, plan };
  } catch (error) {
    await recordUsage({
      shopId,
      userId: user.id,
      feature,
      planCode: plan.code,
      status: 'failure',
      errorCode: error.aiCode ?? error.code ?? 'UNKNOWN',
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/** §28's validation layer: a malformed answer is a failure, not a render. */
function validateResult(resultSchema, data, feature) {
  const parsed = resultSchema.safeParse(data);
  if (parsed.success) return parsed.data;

  // §22: the feature, the failure and the shape of the problem - never the
  // generated content itself, which carries merchant data the log has no need
  // to retain.
  logger.error(
    {
      event: 'AI_OUTPUT_INVALID',
      error_code: 'INVALID_MODEL_OUTPUT',
      category: 'AI',
      dependency: 'AI',
      ai_feature: feature,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).slice(0, 10),
    },
    `${feature} returned an invalid document`,
  );
  throw new aiClient.AiServiceError('INVALID_MODEL_OUTPUT', 502);
}

// ---------------------------------------------------------------------------
// AI Offer Assistant (§4-§13)
// ---------------------------------------------------------------------------

async function recommend(payload, user, { regenerate = false } = {}) {
  const shopId = assertShopAccess(user, payload.shopId, 'USE_AI_ASSISTANT');
  const feature = AI_FEATURES.AI_OFFER_ASSISTANT;

  const { data, plan } = await withMetering({ shopId, user, feature }, async (resolvedPlan) => {
    const merchantContext = await context.build(shopId, resolvedPlan);
    const body = {
      input: {
        goal: payload.goal,
        goalLabel: payload.goalLabel ?? null,
        details: payload.details ?? null,
        productOrCategory: payload.productOrCategory ?? null,
        preferredDiscount: payload.preferredDiscount ?? null,
        targetCustomer: payload.targetCustomer ?? null,
        locationRadiusKm: payload.locationRadiusKm ?? null,
        startDate: payload.startDate ? new Date(payload.startDate).toISOString().slice(0, 10) : null,
        endDate: payload.endDate ? new Date(payload.endDate).toISOString().slice(0, 10) : null,
        budget: payload.budget ?? null,
        inventoryNotes: payload.inventoryNotes ?? null,
        additionalInstructions: payload.additionalInstructions ?? null,
        optionCount: payload.optionCount,
      },
      context: merchantContext,
      previousTitles: payload.previousTitles ?? [],
      refinement: payload.refinement ?? null,
    };

    return regenerate ? aiClient.regenerateRecommendation(body) : aiClient.recommend(body);
  });

  const result = validateResult(schema.assistantResultSchema, data, feature);

  // Belt and braces on the premium gating: even if the model volunteered an
  // insight, a plan without the entitlement never receives one (§12, §13).
  if (!plan.locationInsights) result.locationInsight = null;
  if (!plan.timingInsights) result.timingInsight = null;
  if (!plan.historicalInsights) {
    result.insufficientData = true;
    for (const recommendation of result.recommendations) {
      recommendation.reasoning = recommendation.reasoning.map((reason) => ({
        ...reason,
        basis: 'general',
      }));
    }
  }

  const historyId = await recordGeneration({
    shopId,
    userId: user.id,
    feature,
    requestSummary: payload.details || payload.goalLabel || payload.goal,
    resultSummary: result.recommendations.map((item) => item.title).join(' | '),
    request: payload,
    result,
  });

  return {
    ...result,
    historyId,
    // What the offer form needs to pre-fill itself (§9).
    prefill: result.recommendations.map((recommendation) =>
      toOfferPrefill(recommendation, shopId, payload),
    ),
  };
}

/**
 * Maps a recommendation onto the fields of the existing offer form.
 *
 * Deliberately *not* a saved offer: this is a suggestion the admin lands on,
 * edits and submits themselves (§9, §10).
 */
function toOfferPrefill(recommendation, shopId, payload) {
  // The model answers with bare calendar days, and `new Date('2026-09-20')`
  // reads one as UTC midnight - 05:30 in the merchant's morning. A suggested
  // window should start when their day starts and run to the end of the last
  // one, so both edges are resolved in the business time zone.
  const start = parseBusinessDate(recommendation.recommendedStartDate, 'start')
    ?? parseBusinessDate(payload.startDate, 'start')
    ?? new Date();

  const durationDays = recommendation.recommendedDurationDays ?? 7;
  const end = parseBusinessDate(recommendation.recommendedEndDate, 'end')
    ?? parseBusinessDate(payload.endDate, 'end')
    ?? new Date(start.getTime() + durationDays * 86400000);

  const valid = (date, fallback) =>
    Number.isFinite(date?.getTime?.()) ? date.toISOString() : fallback.toISOString();

  const startIso = valid(start, new Date());
  const endIso = valid(end, new Date(Date.parse(startIso) + durationDays * 86400000));

  return {
    shopId,
    title: recommendation.title,
    offerText: recommendation.offerText ?? null,
    description: recommendation.description ?? null,
    productName: recommendation.productName ?? payload.productOrCategory ?? null,
    categoryName: recommendation.categoryName ?? null,
    offerType: recommendation.offerType,
    discountType: recommendation.discountType,
    discountValue: recommendation.discountValue ?? null,
    buyQuantity: recommendation.buyQuantity ?? null,
    getQuantity: recommendation.getQuantity ?? null,
    startDate: startIso,
    // An end date that landed before the start would fail the form's own
    // validation, so it is corrected here rather than handed over broken.
    endDate: Date.parse(endIso) > Date.parse(startIso)
      ? endIso
      : new Date(Date.parse(startIso) + durationDays * 86400000).toISOString(),
    targetRadiusKm: recommendation.targetRadiusKm ?? payload.locationRadiusKm ?? null,
  };
}

// ---------------------------------------------------------------------------
// AI Content Generator (§15-§22, §34)
// ---------------------------------------------------------------------------

async function generateContent(payload, user, { regenerate = false } = {}) {
  const shopId = assertShopAccess(user, payload.shopId, 'USE_AI_CONTENT');
  const feature = AI_FEATURES.AI_CONTENT_GENERATOR;

  const { facts, offerId } = await resolveOfferFacts(payload, shopId);

  const { data, plan } = await withMetering({ shopId, user, feature }, async (resolvedPlan) => {
    const sections = subscriptions.allowedSections(resolvedPlan, payload.sections);
    if (!sections.length) {
      throw new ApiError(
        403,
        `Social captions are not included in your ${resolvedPlan.name} plan.`,
        { planCode: resolvedPlan.code },
        'PLAN_UPGRADE_REQUIRED',
      );
    }

    const body = {
      offer: facts,
      sections,
      controls: payload.controls,
      previousVersions: payload.previousVersions ?? {},
      refinement: payload.refinement ?? null,
    };
    return regenerate ? aiClient.regenerateContent(body) : aiClient.generateContent(body);
  });

  const result = validateResult(schema.contentResultSchema, data, feature);

  // Independent re-check against the offer that will actually be published.
  const { sections, rejected } = guard.filterSections(result.sections, facts);
  if (!Object.keys(sections).length) {
    logger.error(
      {
        event: 'AI_FACT_CHECK_REJECTED_ALL',
        error_code: 'INVALID_MODEL_OUTPUT',
        category: 'AI',
        dependency: 'AI',
        ai_feature: feature,
        rejected_count: rejected.length,
      },
      'Every generated variant failed the fact check',
    );
    throw new aiClient.AiServiceError('INVALID_MODEL_OUTPUT', 502);
  }
  if (rejected.length) {
    logger.warn(
      {
        event: 'AI_FACT_CHECK_REJECTED_SOME',
        category: 'AI',
        dependency: 'AI',
        ai_feature: feature,
        rejected_count: rejected.length,
      },
      `Dropped ${rejected.length} unverifiable variant(s)`,
    );
  }

  const skipped = payload.sections.filter(
    (section) => PREMIUM_ONLY_SECTIONS.includes(section) && !plan.socialCaptionEnabled,
  );

  const historyId = await recordGeneration({
    shopId,
    userId: user.id,
    feature,
    offerId,
    requestSummary: facts.title ?? facts.offerText,
    resultSummary: sections.title?.[0] ?? Object.values(sections)[0]?.[0],
    request: { ...payload, offer: facts },
    result: { sections, suggestedTerms: result.suggestedTerms },
  });

  return {
    sections,
    suggestedTerms: result.suggestedTerms,
    offerId,
    historyId,
    /** Sections the plan does not cover, so the UI can explain the gap (§22). */
    skippedSections: skipped,
    warnings: [...(result.meta?.warnings ?? []), ...rejected].slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Improve an existing offer (§14)
// ---------------------------------------------------------------------------

async function improveOffer(payload, user) {
  const shopId = assertShopAccess(user, payload.shopId, 'USE_AI_CONTENT');
  const feature = AI_FEATURES.AI_OFFER_OPTIMIZER;

  const { facts, offerId } = await resolveOfferFacts(payload, shopId);

  const { data } = await withMetering({ shopId, user, feature }, () =>
    aiClient.improveOffer({
      offer: facts,
      controls: payload.controls,
      focus: payload.focus ?? null,
    }),
  );

  const result = validateResult(schema.improveResultSchema, data, feature);

  const { fields, rejected } = guard.filterFields(
    {
      suggestedTitle: result.suggestedTitle,
      suggestedOfferText: result.suggestedOfferText,
      suggestedShortDescription: result.suggestedShortDescription,
      suggestedDescription: result.suggestedDescription,
    },
    facts,
  );

  if (!result.improvements.length && !Object.values(fields).some(Boolean)) {
    throw new aiClient.AiServiceError('INVALID_MODEL_OUTPUT', 502);
  }

  const historyId = await recordGeneration({
    shopId,
    userId: user.id,
    feature,
    offerId,
    requestSummary: facts.title ?? facts.offerText,
    resultSummary: fields.suggestedTitle ?? result.improvements[0],
    request: { ...payload, offer: facts },
    result: { ...fields, improvements: result.improvements },
  });

  return {
    improvements: result.improvements,
    ...fields,
    offerId,
    historyId,
    warnings: [...(result.meta?.warnings ?? []), ...rejected].slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Capabilities, usage and history
// ---------------------------------------------------------------------------

/** What the shop's plan currently allows - drives the whole AI UI. */
async function capabilities(shopId, user) {
  assertShopAccess(user, shopId, 'USE_AI_CONTENT');
  return subscriptions.capabilitiesFor(shopId);
}

/** GET /api/ai/usage (§32). */
async function usage(params, user) {
  const scope = params.shopId
    ? [assertShopAccess(user, params.shopId, 'USE_AI_CONTENT')]
    : aiScope(user);

  if (scope !== null && scope.length === 0) {
    throw ApiError.forbidden('You are not assigned to any shop');
  }

  const since = new Date();
  since.setMonth(since.getMonth() - (params.months - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const clause = scope === null ? '' : ` AND u.shop_id IN (${scope.map(() => '?').join(',')})`;
  const scopeParams = scope === null ? [] : scope;

  const byFeature = await rawQuery(
    `SELECT u.feature,
            DATE_FORMAT(u.created_at, '%Y-%m') AS month,
            SUM(u.status = 'success') AS successes,
            SUM(u.status = 'failure') AS failures,
            COALESCE(SUM(u.total_tokens), 0) AS tokens
       FROM ai_usage u
      WHERE u.created_at >= ?${clause}
      GROUP BY u.feature, month
      ORDER BY month DESC, u.feature`,
    [since, ...scopeParams],
  );

  // The quota that matters is this month's, for the shop being looked at.
  const shopId = params.shopId ?? (scope && scope.length === 1 ? scope[0] : null);
  const current = shopId ? await subscriptions.capabilitiesFor(shopId) : null;

  return {
    scope: scope === null ? 'platform' : 'shop',
    shopIds: scope,
    plan: current?.plan ?? null,
    features: current?.features ?? null,
    timeline: byFeature.map((row) => ({
      feature: row.feature,
      month: row.month,
      successes: Number(row.successes),
      failures: Number(row.failures),
      tokens: Number(row.tokens),
    })),
  };
}

/** GET /api/ai/history (§33). */
async function history(params, user) {
  const scope = params.shopId
    ? [assertShopAccess(user, params.shopId, 'USE_AI_CONTENT')]
    : aiScope(user);

  if (scope !== null && scope.length === 0) {
    throw ApiError.forbidden('You are not assigned to any shop');
  }

  const { limit, page, offset } = limitOffset(params);
  const filters = [];
  const values = [];

  if (scope !== null) {
    filters.push(`g.shop_id IN (${scope.map(() => '?').join(',')})`);
    values.push(...scope);
  }
  if (params.feature) {
    filters.push('g.feature = ?');
    values.push(params.feature);
  }
  if (params.outcome) {
    filters.push('g.outcome = ?');
    values.push(params.outcome);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = await rawQuery(
    `SELECT g.id, g.feature, g.offer_id, g.request_summary, g.result_summary,
            g.outcome, g.created_at,
            s.name AS shop_name, u.name AS user_name, o.title AS offer_title
       FROM ai_generations g
       JOIN shops s ON s.id = g.shop_id
       LEFT JOIN users u  ON u.id = g.user_id
       LEFT JOIN offers o ON o.id = g.offer_id
       ${where}
      ORDER BY g.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    values,
  );

  const total = await queryOne(
    `SELECT COUNT(*) AS total FROM ai_generations g ${where}`,
    values,
  );

  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      feature: row.feature,
      shopName: row.shop_name,
      userName: row.user_name,
      offerId: row.offer_id === null ? null : Number(row.offer_id),
      offerTitle: row.offer_title,
      request: row.request_summary,
      result: row.result_summary,
      outcome: row.outcome,
      createdAt: row.created_at,
    })),
    pagination: { page, limit, total: Number(total?.total ?? 0) },
  };
}

/** Full record for one history entry, so the admin can re-use what they got. */
async function historyDetail(id, user) {
  const row = await queryOne('SELECT * FROM ai_generations WHERE id = ?', [id]);
  if (!row) throw ApiError.notFound('That AI history entry does not exist');
  assertShopAccess(user, row.shop_id, 'USE_AI_CONTENT');

  const parse = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  return {
    id: Number(row.id),
    feature: row.feature,
    offerId: row.offer_id === null ? null : Number(row.offer_id),
    outcome: row.outcome,
    createdAt: row.created_at,
    request: parse(row.request_payload),
    result: parse(row.result_payload),
  };
}

/** §33's Accepted / Rejected column - set when the admin acts on a suggestion. */
async function setHistoryOutcome(id, { outcome, offerId }, user) {
  const row = await queryOne('SELECT * FROM ai_generations WHERE id = ?', [id]);
  if (!row) throw ApiError.notFound('That AI history entry does not exist');
  assertShopAccess(user, row.shop_id, 'USE_AI_CONTENT');

  await execute('UPDATE ai_generations SET outcome = ?, offer_id = COALESCE(?, offer_id) WHERE id = ?', [
    outcome,
    offerId ?? null,
    id,
  ]);

  return { id: Number(id), outcome };
}

/** Shops the signed-in user can point the AI tools at. */
async function assistantShops(user) {
  const scope = aiScope(user, 'USE_AI_CONTENT');
  const rows =
    scope === null
      ? await query("SELECT id, name, slug FROM shops WHERE status = 'active' ORDER BY name LIMIT 100")
      : scope.length
        ? await rawQuery(
            `SELECT id, name, slug FROM shops WHERE id IN (${scope.map(() => '?').join(',')}) ORDER BY name`,
            scope,
          )
        : [];

  return rows.map((row) => ({ id: Number(row.id), name: row.name, slug: row.slug }));
}

module.exports = {
  recommend,
  generateContent,
  improveOffer,
  capabilities,
  usage,
  history,
  historyDetail,
  setHistoryOutcome,
  assistantShops,
  assertShopAccess,
};
