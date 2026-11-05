'use strict';

const shopVerification = require('../../services/shopVerification');
const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const { limitOffset } = require('../../utils/pagination');

/**
 * The promotional layer on a service (§6, §16). One service can carry many
 * offers over time - this module is scoped to a single `service_id`, mirroring
 * how `offer.service.js` owns the offer but keeping the "offer" concept itself
 * a first-class row rather than folding it back into the service.
 */

function mapServiceOffer(row) {
  return {
    id: Number(row.id),
    serviceId: Number(row.service_id),
    offerText: row.offer_text,
    offerType: row.offer_type,
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : Number(row.discount_value),
    originalPrice: row.original_price === null ? null : Number(row.original_price),
    offerPrice: row.offer_price === null ? null : Number(row.offer_price),
    termsConditions: row.terms_conditions,
    isRecurring: Boolean(row.is_recurring),
    recurrenceType: row.recurrence_type,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    viewCount: Number(row.view_count ?? 0),
    claimCount: Number(row.claim_count ?? 0),
    // Claim rules (§17, §22), so the Claim button can state the limit without
    // a second request - exactly as the product-offer mapper does.
    claimLimitPerCustomer: Number(row.claim_limit_per_customer ?? 1),
    totalClaimLimit:
      row.total_claim_limit === null || row.total_claim_limit === undefined
        ? null
        : Number(row.total_claim_limit),
    claimValidityHours:
      row.claim_validity_hours === null || row.claim_validity_hours === undefined
        ? null
        : Number(row.claim_validity_hours),
    maxRedemptionsPerClaim: Number(row.max_redemptions_per_claim ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertServiceExists(serviceId) {
  const service = await queryOne('SELECT id, shop_id FROM services WHERE id = ?', [serviceId]);
  if (!service) throw ApiError.notFound('Service not found');
  return service;
}

async function list(serviceId, params, { manage = false } = {}) {
  await assertServiceExists(serviceId);
  const { limit, page, offset } = limitOffset(params);

  const where = ['service_id = ?'];
  const whereParams = [serviceId];
  if (!manage) {
    where.push("status = 'active'", 'start_date <= NOW()', 'end_date >= NOW()');
  } else if (params.status && params.status !== 'all') {
    where.push('status = ?');
    whereParams.push(params.status);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [rows, countRows] = await Promise.all([
    rawQuery(
      `SELECT * FROM service_offers ${whereSql} ORDER BY end_date ASC, id ASC LIMIT ${limit} OFFSET ${offset}`,
      whereParams,
    ),
    rawQuery(`SELECT COUNT(*) AS total FROM service_offers ${whereSql}`, whereParams),
  ]);

  return {
    items: rows.map(mapServiceOffer),
    pagination: { page, limit, total: Number(countRows[0]?.total ?? 0) },
  };
}

async function getById(serviceId, offerId) {
  const row = await queryOne('SELECT * FROM service_offers WHERE id = ? AND service_id = ?', [
    offerId,
    serviceId,
  ]);
  if (!row) throw ApiError.notFound('Service offer not found');
  return mapServiceOffer(row);
}

function resolveStatus(requested, startDate, endDate) {
  const now = new Date();
  if (requested === 'draft') return 'draft';
  if (endDate <= now) return 'expired';
  if (startDate > now) return 'scheduled';
  return 'active';
}

async function create(serviceId, payload, user) {
  const service = await assertServiceExists(serviceId);
  const status = resolveStatus(payload.status, payload.startDate, payload.endDate);

  // Onboarding §12, the same gate as offers and services: a shop in review
  // may prepare a draft offer on a service, but not publish one.
  if (status !== 'draft') {
    const shop = await queryOne('SELECT verification_status FROM shops WHERE id = ?', [service.shop_id]);
    shopVerification.assertMayPublishListing(shop?.verification_status, user, 'offer');
  }

  const result = await execute(
    `INSERT INTO service_offers (
       service_id, shop_id, offer_text, offer_type, discount_type, discount_value,
       original_price, offer_price, terms_conditions, is_recurring, recurrence_type,
       start_date, end_date, status,
       claim_limit_per_customer, total_claim_limit, claim_validity_hours,
       max_redemptions_per_claim, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      serviceId,
      service.shop_id,
      payload.offerText ?? null,
      payload.offerType,
      payload.discountType,
      payload.discountValue ?? null,
      payload.originalPrice ?? null,
      payload.offerPrice ?? null,
      payload.termsConditions ?? null,
      payload.isRecurring ? 1 : 0,
      payload.isRecurring ? payload.recurrenceType ?? null : null,
      payload.startDate,
      payload.endDate,
      status,
      payload.claimLimitPerCustomer,
      payload.totalClaimLimit ?? null,
      payload.claimValidityHours ?? null,
      payload.maxRedemptionsPerClaim,
      null,
      null,
    ],
  );

  return getById(serviceId, result.insertId);
}

async function update(offerId, payload, previous) {
  const keepStatus =
    previous.status === 'deactivated'
      ? previous.status
      : resolveStatus(payload.status === 'draft' ? previous.status : payload.status, payload.startDate, payload.endDate);

  await execute(
    `UPDATE service_offers SET
       offer_text = ?, offer_type = ?, discount_type = ?, discount_value = ?,
       original_price = ?, offer_price = ?, terms_conditions = ?, is_recurring = ?,
       recurrence_type = ?, start_date = ?, end_date = ?, status = ?,
       claim_limit_per_customer = ?, total_claim_limit = ?, claim_validity_hours = ?,
       max_redemptions_per_claim = ?
     WHERE id = ?`,
    [
      payload.offerText ?? null,
      payload.offerType,
      payload.discountType,
      payload.discountValue ?? null,
      payload.originalPrice ?? null,
      payload.offerPrice ?? null,
      payload.termsConditions ?? null,
      payload.isRecurring ? 1 : 0,
      payload.isRecurring ? payload.recurrenceType ?? null : null,
      payload.startDate,
      payload.endDate,
      keepStatus,
      payload.claimLimitPerCustomer,
      payload.totalClaimLimit ?? null,
      payload.claimValidityHours ?? null,
      payload.maxRedemptionsPerClaim,
      offerId,
    ],
  );

  return getById(previous.service_id, offerId);
}

const ALLOWED_TRANSITIONS = {
  draft: ['scheduled', 'active', 'deactivated'],
  scheduled: ['active', 'deactivated', 'draft'],
  active: ['deactivated', 'expired'],
  expired: ['deactivated', 'scheduled', 'active'],
  deactivated: ['active', 'scheduled', 'draft'],
};

async function changeStatus(offer, status) {
  if (offer.status === status) return getById(offer.service_id, offer.id);
  if (!ALLOWED_TRANSITIONS[offer.status]?.includes(status)) {
    throw ApiError.badRequest(`A service offer cannot move from "${offer.status}" to "${status}"`);
  }
  if (['active', 'scheduled'].includes(status) && new Date(offer.end_date) <= new Date()) {
    throw ApiError.badRequest('Extend the end date before republishing this offer');
  }

  const resolved =
    status === 'active' ? resolveStatus('active', new Date(offer.start_date), new Date(offer.end_date)) : status;

  await execute('UPDATE service_offers SET status = ? WHERE id = ?', [resolved, offer.id]);
  return getById(offer.service_id, offer.id);
}

async function remove(offerId) {
  await execute('DELETE FROM service_offers WHERE id = ?', [offerId]);
}

/** Lifecycle maintenance, run on a schedule alongside offer-lifecycle. */
async function syncLifecycleStatuses() {
  const activated = await execute(
    `UPDATE service_offers SET status = 'active'
      WHERE status = 'scheduled' AND start_date <= NOW() AND end_date > NOW()`,
  );
  const expired = await execute(
    `UPDATE service_offers SET status = 'expired'
      WHERE status IN ('active', 'scheduled') AND end_date <= NOW()`,
  );
  return { activated: activated.affectedRows, expired: expired.affectedRows };
}

module.exports = {
  list,
  getById,
  create,
  update,
  changeStatus,
  remove,
  syncLifecycleStatuses,
  mapServiceOffer,
  resolveStatus,
};
