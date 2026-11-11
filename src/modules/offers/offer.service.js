'use strict';

const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const geo = require('../../utils/geo');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');
const entitlements = require('../../services/entitlements');
const shopVerification = require('../../services/shopVerification');
const branchReadiness = require('../../services/branchReadiness');
const analyticsEvents = require('../../services/analyticsEvents');
const visibilityEvents = require('../../services/visibility/visibilityAnalytics.service');
const subscriptions = require('../subscriptions/subscription.service');
const { FEATURES } = require('../../config/plans');
const notifications = require('../../services/notifications');

/**
 * Predicate matching the branches an offer applies to (§8.3):
 *   shop_wide         -> every active branch of the shop
 *   selected_branches -> the branches listed in offer_locations
 *   online            -> no physical branch, so nothing matches
 */
const branchPredicate = (alias) => `(
  (o.applicability_type = 'shop_wide' AND ${alias}.shop_id = o.shop_id)
  OR (o.applicability_type = 'selected_branches' AND EXISTS (
       SELECT 1 FROM offer_locations ol WHERE ol.offer_id = o.id AND ol.branch_id = ${alias}.id))
)`;

/** Distance in km to the closest applicable branch, or NULL when not locatable. */
function nearestDistanceSql() {
  return `(
    SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')})
      FROM shop_branches b
     WHERE b.status = 'active'
       AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
       AND ${branchPredicate('b')}
  )`;
}

/** City label for the closest applicable branch (falls back to the primary branch). */
function locationLabelSql(hasPosition) {
  if (hasPosition) {
    return `(
      SELECT b.city FROM shop_branches b
       WHERE b.status = 'active' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
         AND ${branchPredicate('b')}
       ORDER BY ${geo.distanceKmSql('b.latitude', 'b.longitude')} ASC LIMIT 1
    )`;
  }
  return `(
    SELECT b.city FROM shop_branches b
     WHERE b.status = 'active' AND ${branchPredicate('b')}
     ORDER BY b.is_primary DESC, b.id ASC LIMIT 1
  )`;
}

const PRIMARY_IMAGE_SQL = `(
  SELECT oi.image_url FROM offer_images oi
   WHERE oi.offer_id = o.id ORDER BY oi.display_order ASC, oi.id ASC LIMIT 1
)`;
const PRIMARY_THUMB_SQL = `(
  SELECT oi.thumbnail_url FROM offer_images oi
   WHERE oi.offer_id = o.id ORDER BY oi.display_order ASC, oi.id ASC LIMIT 1
)`;

const SORT_SQL = {
  newest: 'o.created_at DESC, o.id DESC',
  endingSoon: 'o.end_date ASC, o.id ASC',
  highestDiscount:
    "(CASE WHEN o.discount_type = 'percentage' THEN o.discount_value ELSE 0 END) DESC, o.discount_value DESC",
  mostViewed: 'o.view_count DESC, o.id DESC',
  mostPopular: '(o.favorite_count * 3 + o.click_count * 2 + o.view_count) DESC, o.id DESC',
  nearest: 'distance_km IS NULL, distance_km ASC',
};

/**
 * Subscription rank of the offer's shop: Premium 2, Business 1, Free 0 (V3 §36).
 * A lapsed subscription scores 0, so an unpaid Premium plan stops boosting.
 */
const PLAN_RANK_SQL = `(CASE
  WHEN sub.status = 'active' AND sub.plan = 'PREMIUM'  THEN 2
  WHEN sub.status = 'active' AND sub.plan = 'BUSINESS' THEN 1
  ELSE 0 END)`;

/**
 * Discovery ordering with the premium boost applied (§36, §37).
 *
 * The boost is deliberately a *tie-breaker inside a relevance band*, never a
 * key that outranks relevance: offers are first bucketed by the thing the
 * customer actually asked for - the day it was posted, the kilometre it sits
 * in, how soon it ends - and only within that bucket does a paid plan surface
 * first. That is what keeps §36's "priority eligibility, not guaranteed
 * placement" true, and stops the feed degrading into a paid-ad list.
 */
const BOOSTED_SORT_SQL = {
  newest: 'DATE(o.created_at) DESC, plan_rank DESC, o.created_at DESC, o.id DESC',
  endingSoon: 'DATE(o.end_date) ASC, plan_rank DESC, o.end_date ASC, o.id ASC',
  highestDiscount:
    "ROUND((CASE WHEN o.discount_type = 'percentage' THEN o.discount_value ELSE 0 END) / 10) DESC, plan_rank DESC, o.discount_value DESC",
  mostViewed: 'ROUND(o.view_count / 100) DESC, plan_rank DESC, o.view_count DESC, o.id DESC',
  mostPopular:
    'ROUND((o.favorite_count * 3 + o.click_count * 2 + o.view_count) / 100) DESC, plan_rank DESC, o.id DESC',
  // Distance is bucketed to the kilometre: a Premium shop can win a tie at the
  // same distance, but never jump ahead of a genuinely nearer one.
  nearest: 'distance_km IS NULL, ROUND(distance_km, 0) ASC, plan_rank DESC, distance_km ASC',
};

/** Maps a joined offer row onto the API representation. */
function mapOffer(row, { includeRelations = false } = {}) {
  const offer = {
    id: Number(row.id),
    title: row.title,
    productName: row.product_name,
    description: row.description,
    offerText: row.offer_text,
    offerType: row.offer_type,
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : Number(row.discount_value),
    originalPrice: row.original_price === null ? null : Number(row.original_price),
    discountedPrice: row.discounted_price === null ? null : Number(row.discounted_price),
    buyQuantity: row.buy_quantity === null ? null : Number(row.buy_quantity),
    getQuantity: row.get_quantity === null ? null : Number(row.get_quantity),
    minPurchase: row.min_purchase === null ? null : Number(row.min_purchase),
    termsConditions: row.terms_conditions,
    eligibility: row.eligibility,
    usageRestrictions: row.usage_restrictions,
    applicableProducts: row.applicable_products,
    isRecurring: Boolean(row.is_recurring),
    recurrenceType: row.recurrence_type,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    applicabilityType: row.applicability_type,
    // Claim rules (Claim/Redemption §17). Present on every offer so the Claim
    // button can say "1 per customer" without a second request.
    claimLimitPerCustomer: Number(row.claim_limit_per_customer ?? 1),
    totalClaimLimit: row.total_claim_limit === null || row.total_claim_limit === undefined
      ? null
      : Number(row.total_claim_limit),
    claimValidityHours: row.claim_validity_hours === null || row.claim_validity_hours === undefined
      ? null
      : Number(row.claim_validity_hours),
    maxRedemptionsPerClaim: Number(row.max_redemptions_per_claim ?? 1),
    imageUrl: row.image_url ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    viewCount: Number(row.view_count ?? 0),
    clickCount: Number(row.click_count ?? 0),
    favoriteCount: Number(row.favorite_count ?? 0),
    distanceKm: row.distance_km === null || row.distance_km === undefined ? null : Number(Number(row.distance_km).toFixed(2)),
    locationLabel: row.location_label ?? null,
    isFavorite: Boolean(row.is_favorite),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shop: {
      id: Number(row.shop_id),
      name: row.shop_name,
      slug: row.shop_slug,
      logoUrl: row.shop_logo_url,
    },
    category: row.category_id
      ? { id: Number(row.category_id), name: row.category_name, slug: row.category_slug }
      : null,
  };

  if (includeRelations) {
    offer.subcategory = row.subcategory_id
      ? { id: Number(row.subcategory_id), name: row.subcategory_name }
      : null;
    offer.createdBy = row.created_by_name
      ? { id: Number(row.created_by), name: row.created_by_name }
      : null;
    offer.updatedBy = row.updated_by_name
      ? { id: Number(row.updated_by), name: row.updated_by_name }
      : null;
  }

  return offer;
}

/**
 * Builds the shared FROM/WHERE for offer discovery.
 * Returns SQL fragments plus the ordered parameter lists.
 */
function buildListQuery(params, user) {
  const hasPosition = params.latitude !== undefined && params.longitude !== undefined;

  const selectParams = [];
  const whereParams = [];
  const where = ['1 = 1'];

  // --- distance projection -------------------------------------------------
  let distanceSelect = 'NULL AS distance_km';
  if (hasPosition) {
    distanceSelect = `${nearestDistanceSql()} AS distance_km`;
    selectParams.push(...geo.distanceKmParams(params.latitude, params.longitude));
  }

  let labelSelect = `${locationLabelSql(hasPosition)} AS location_label`;
  const labelParams = hasPosition ? geo.distanceKmParams(params.latitude, params.longitude) : [];

  // --- favourite flag ------------------------------------------------------
  let favoriteSelect = '0 AS is_favorite';
  const favoriteParams = [];
  if (user) {
    favoriteSelect = '(SELECT 1 FROM favorites fv WHERE fv.offer_id = o.id AND fv.user_id = ?) AS is_favorite';
    favoriteParams.push(user.id);
  }

  // --- visibility ----------------------------------------------------------
  // Management mode returns drafts/expired offers but only for shops the caller
  // may administer. Discovery mode is limited to live offers of active shops.
  const managing = Boolean(params.manage) || (params.status && params.status !== 'active');

  if (managing) {
    if (!user) throw ApiError.unauthorized('Sign in to manage offers');
    // Scope on EDIT_OFFER, not VIEW_OFFERS: every customer holds VIEW_OFFERS
    // globally (it just means "may browse"), so it would widen this to all shops.
    const scope = accessControl.shopScopeFor(user, 'EDIT_OFFER');
    if (scope !== null) {
      if (scope.length === 0) throw ApiError.forbidden('You are not assigned to any shop');
      where.push(`o.shop_id IN (${scope.map(() => '?').join(',')})`);
      whereParams.push(...scope);
    }
    if (params.status && params.status !== 'all') {
      where.push('o.status = ?');
      whereParams.push(params.status);
    }
  } else {
    where.push("o.status = 'active'", "s.status = 'active'", 'o.end_date >= NOW()', 'o.start_date <= NOW()');
  }

  // --- text search (§7) ----------------------------------------------------
  if (params.search) {
    const term = `%${params.search}%`;
    where.push(`(
      o.title LIKE ? OR o.product_name LIKE ? OR o.description LIKE ? OR o.offer_text LIKE ?
      OR s.name LIKE ? OR c.name LIKE ?
      OR EXISTS (SELECT 1 FROM shop_branches sb WHERE sb.shop_id = o.shop_id
                   AND (sb.city LIKE ? OR sb.pincode LIKE ?))
    )`);
    whereParams.push(term, term, term, term, term, term, term, term);
  }

  // --- category / shop -----------------------------------------------------
  if (params.categoryId) {
    where.push('(o.category_id = ? OR o.subcategory_id = ?)');
    whereParams.push(params.categoryId, params.categoryId);
  } else if (params.category) {
    where.push(`(c.slug = ? OR c.name = ? OR o.category_id = ?)`);
    whereParams.push(params.category, params.category, Number.parseInt(params.category, 10) || 0);
  }

  if (params.shopId) {
    where.push('o.shop_id = ?');
    whereParams.push(params.shopId);
  } else if (params.shop) {
    where.push('(s.slug = ? OR s.name = ? OR o.shop_id = ?)');
    whereParams.push(params.shop, params.shop, Number.parseInt(params.shop, 10) || 0);
  }

  if (params.branchId) {
    where.push(`EXISTS (SELECT 1 FROM shop_branches b3
                         WHERE b3.id = ? AND ${branchPredicate('b3')})`);
    whereParams.push(params.branchId);
  }

  // --- location filters (§8.5) --------------------------------------------
  if (params.city) {
    where.push(`EXISTS (SELECT 1 FROM shop_branches b4
                         WHERE b4.status = 'active' AND b4.city = ? AND ${branchPredicate('b4')})`);
    whereParams.push(params.city);
  }
  if (params.pincode) {
    where.push(`EXISTS (SELECT 1 FROM shop_branches b5
                         WHERE b5.status = 'active' AND b5.pincode = ? AND ${branchPredicate('b5')})`);
    whereParams.push(params.pincode);
  }

  // Bounding box first so MySQL can range-scan idx_branch_geo before the
  // trigonometry runs; the exact radius is applied by the HAVING clause.
  let having = '';
  const havingParams = [];
  if (params.radius && hasPosition) {
    const box = geo.boundingBox(params.latitude, params.longitude, params.radius);
    where.push(`EXISTS (SELECT 1 FROM shop_branches b6
                         WHERE b6.status = 'active'
                           AND b6.latitude BETWEEN ? AND ?
                           AND b6.longitude BETWEEN ? AND ?
                           AND ${branchPredicate('b6')})`);
    whereParams.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
    having = 'HAVING distance_km IS NOT NULL AND distance_km <= ?';
    havingParams.push(params.radius);
  }

  // --- discount / type / dates --------------------------------------------
  if (params.minDiscount !== undefined) {
    where.push("(o.discount_type = 'percentage' AND o.discount_value >= ?)");
    whereParams.push(params.minDiscount);
  }
  if (params.maxDiscount !== undefined) {
    where.push("(o.discount_type = 'percentage' AND o.discount_value <= ?)");
    whereParams.push(params.maxDiscount);
  }
  if (params.offerType) {
    where.push('o.offer_type = ?');
    whereParams.push(params.offerType);
  }
  if (params.expiringInDays) {
    where.push('o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? DAY)');
    whereParams.push(params.expiringInDays);
  }
  if (params.expiringInHours) {
    where.push('o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)');
    whereParams.push(params.expiringInHours);
  }
  if (params.startDate) {
    where.push('o.end_date >= ?');
    whereParams.push(params.startDate);
  }
  if (params.endDate) {
    where.push('o.start_date <= ?');
    whereParams.push(params.endDate);
  }

  // --- subscription eligibility (V3 §3) ------------------------------------
  // The Ending Soon rail is a Business/Premium placement, so Free shops are
  // filtered out of it here rather than merely hidden by the client.
  if (params.minPlanRank) {
    where.push(`${PLAN_RANK_SQL} >= ?`);
    whereParams.push(params.minPlanRank);
  }

  // --- personalised collections -------------------------------------------
  if (params.favorites) {
    if (!user) throw ApiError.unauthorized('Sign in to view saved offers');
    where.push('EXISTS (SELECT 1 FROM favorites f2 WHERE f2.offer_id = o.id AND f2.user_id = ?)');
    whereParams.push(user.id);
  }
  if (params.following) {
    if (!user) throw ApiError.unauthorized('Sign in to view offers you follow');
    where.push(`(
      EXISTS (SELECT 1 FROM followed_shops fs WHERE fs.shop_id = o.shop_id AND fs.user_id = ?)
      OR EXISTS (SELECT 1 FROM followed_categories fc
                  WHERE fc.user_id = ? AND fc.category_id IN (o.category_id, o.subcategory_id))
    )`);
    whereParams.push(user.id, user.id);
  }

  const from = `
      FROM offers o
      JOIN shops s ON s.id = o.shop_id
      LEFT JOIN categories c ON c.id = o.category_id
      LEFT JOIN shop_subscriptions sub ON sub.shop_id = o.shop_id`;

  return {
    from,
    // Management listings are the merchant's own inventory, so a paid plan must
    // not reorder them - the boost only applies to customer discovery (§36).
    managing,
    whereSql: `WHERE ${where.join('\n       AND ')}`,
    having,
    distanceSelect,
    labelSelect,
    favoriteSelect,
    selectParams,
    labelParams,
    favoriteParams,
    whereParams,
    havingParams,
    hasPosition,
  };
}

async function list(params, user) {
  const built = buildListQuery(params, user);
  const { limit, page, offset } = limitOffset(params);

  const sortTable = built.managing ? SORT_SQL : BOOSTED_SORT_SQL;
  const orderBy = sortTable[params.sort] || sortTable.newest;

  const sql = `
    SELECT o.*,
           s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
           c.name AS category_name, c.slug AS category_slug,
           ${PRIMARY_IMAGE_SQL} AS image_url,
           ${PRIMARY_THUMB_SQL} AS thumbnail_url,
           ${PLAN_RANK_SQL} AS plan_rank,
           ${built.distanceSelect},
           ${built.labelSelect},
           ${built.favoriteSelect}
    ${built.from}
    ${built.whereSql}
    ${built.having}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const sqlParams = [
    ...built.selectParams,
    ...built.labelParams,
    ...built.favoriteParams,
    ...built.whereParams,
    ...built.havingParams,
  ];

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      SELECT o.id, ${built.distanceSelect}
      ${built.from}
      ${built.whereSql}
      ${built.having}
    ) AS matched`;
  const countParams = [...built.selectParams, ...built.whereParams, ...built.havingParams];

  const [rows, countRows] = await Promise.all([
    rawQuery(sql, sqlParams),
    rawQuery(countSql, countParams),
  ]);

  return {
    items: rows.map((row) => mapOffer(row)),
    pagination: { page, limit, total: Number(countRows[0]?.total ?? 0) },
  };
}

/**
 * Full offer detail including images, applicable branches and rating summary.
 * `position` is the customer's current/selected location, used for distances.
 */
async function getById(id, user, { forManagement = false, position = null } = {}) {
  const hasPosition = position?.latitude !== undefined && position?.longitude !== undefined && position !== null;

  const selectParams = [];
  let distanceSelect = 'NULL AS distance_km';
  if (hasPosition) {
    distanceSelect = `${nearestDistanceSql()} AS distance_km`;
    selectParams.push(...geo.distanceKmParams(position.latitude, position.longitude));
  }

  const favoriteParams = user ? [user.id] : [];
  const favoriteSelect = user
    ? '(SELECT 1 FROM favorites fv WHERE fv.offer_id = o.id AND fv.user_id = ?) AS is_favorite'
    : '0 AS is_favorite';

  const row = await rawQuery(
    `SELECT o.*,
            s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
            s.description AS shop_description, s.contact_number AS shop_contact,
            s.status AS shop_status,
            c.name AS category_name, c.slug AS category_slug,
            sc.name AS subcategory_name,
            cu.name AS created_by_name, uu.name AS updated_by_name,
            ${PRIMARY_IMAGE_SQL} AS image_url,
            ${PRIMARY_THUMB_SQL} AS thumbnail_url,
            ${distanceSelect},
            ${favoriteSelect}
       FROM offers o
       JOIN shops s ON s.id = o.shop_id
       LEFT JOIN categories c ON c.id = o.category_id
       LEFT JOIN categories sc ON sc.id = o.subcategory_id
       LEFT JOIN users cu ON cu.id = o.created_by
       LEFT JOIN users uu ON uu.id = o.updated_by
      WHERE o.id = ?`,
    [...selectParams, ...favoriteParams, id],
  ).then((rows) => rows[0]);

  if (!row) throw ApiError.notFound('Offer not found');

  // Customers only ever see live offers; shop staff and super admins see the rest.
  const canManage = Boolean(user) && accessControl.hasShopPermission(user, row.shop_id, 'EDIT_OFFER');
  const isPubliclyVisible = row.status === 'active' && row.shop_status === 'active';
  if (!isPubliclyVisible && !canManage && !forManagement) {
    throw ApiError.notFound('Offer not found');
  }

  const [images, branches, rating] = await Promise.all([
    query(
      'SELECT id, image_url, thumbnail_url, display_order FROM offer_images WHERE offer_id = ? ORDER BY display_order, id',
      [id],
    ),
    rawQuery(
      `SELECT b.id, b.branch_name, b.address, b.city, b.state, b.country, b.pincode,
              b.latitude, b.longitude, b.contact_number, b.is_primary
              ${hasPosition ? `, ${geo.distanceKmSql('b.latitude', 'b.longitude')} AS distance_km` : ', NULL AS distance_km'}
         FROM shop_branches b
         JOIN offers o ON o.id = ?
        WHERE b.status = 'active' AND ${branchPredicate('b')}
        ORDER BY ${hasPosition ? 'distance_km IS NULL, distance_km ASC,' : ''} b.is_primary DESC, b.id`,
      hasPosition ? [...geo.distanceKmParams(position.latitude, position.longitude), id] : [id],
    ),
    queryOne(
      `SELECT COUNT(*) AS count, ROUND(AVG(rating), 2) AS average
         FROM reviews WHERE offer_id = ? AND status = 'approved'`,
      [id],
    ),
  ]);

  const offer = mapOffer(row, { includeRelations: true });
  offer.images = images.map((image) => ({
    id: Number(image.id),
    url: image.image_url,
    thumbnailUrl: image.thumbnail_url,
    displayOrder: image.display_order,
  }));
  offer.branches = branches.map((branch) => ({
    id: Number(branch.id),
    branchName: branch.branch_name,
    address: branch.address,
    city: branch.city,
    state: branch.state,
    country: branch.country,
    pincode: branch.pincode,
    latitude: branch.latitude === null ? null : Number(branch.latitude),
    longitude: branch.longitude === null ? null : Number(branch.longitude),
    contactNumber: branch.contact_number,
    isPrimary: Boolean(branch.is_primary),
    distanceKm: branch.distance_km === null ? null : Number(Number(branch.distance_km).toFixed(2)),
  }));
  offer.shop.description = row.shop_description;
  offer.shop.contactNumber = row.shop_contact;
  offer.rating = { count: Number(rating.count), average: rating.average === null ? null : Number(rating.average) };
  offer.branchIds = offer.branches.map((branch) => branch.id);

  // Claim/Redemption §3/§5: a customer who already holds a code must see the
  // code, not the Claim button. Only the id, code and status travel - the QR is
  // the claim endpoint's business, and this response is also served to staff.
  if (user) {
    const held = await queryOne(
      `SELECT id, code, status, expires_at FROM offer_claims
        WHERE offer_id = ? AND user_id = ? AND status NOT IN ('cancelled','revoked')
        ORDER BY FIELD(status, 'claimed', 'redeemed', 'expired'), claimed_at DESC LIMIT 1`,
      [id, user.id],
    );
    offer.myClaim = held
      ? {
          id: Number(held.id),
          code: held.code,
          status: held.status,
          expiresAt: held.expires_at,
        }
      : null;
  }

  return offer;
}

/** Derives the initial lifecycle status from the requested one and the dates (§14). */
function resolveStatus(requested, startDate, endDate) {
  const now = new Date();
  if (requested === 'draft') return 'draft';
  if (endDate <= now) return 'expired';
  if (startDate > now) return 'scheduled';
  return 'active';
}

async function assertBranchesBelongToShop(connection, shopId, branchIds) {
  if (!branchIds.length) return;
  const placeholders = branchIds.map(() => '?').join(',');
  const [rows] = await connection.query(
    `SELECT id FROM shop_branches WHERE shop_id = ? AND id IN (${placeholders})`,
    [shopId, ...branchIds],
  );
  if (rows.length !== branchIds.length) {
    throw ApiError.badRequest('One or more selected branches do not belong to this shop');
  }
}

/**
 * Subscription rules that apply to publishing an offer (V3 §4, §5, §30).
 *
 * Drafts are exempt from the monthly allowance: a Free merchant can keep
 * working on next month's offer, they just cannot publish a second one now.
 */
async function assertPublishingAllowed(shopId, payload, { isNew }) {
  if (payload.isRecurring) {
    await entitlements.assertFeature(shopId, FEATURES.RECURRING_OFFERS);
  }

  // Scheduling means "publish later" - either an explicit scheduled status or a
  // start date the merchant has pushed into the future.
  const startsLater = new Date(payload.startDate) > new Date();
  if (payload.status === 'scheduled' || startsLater) {
    await entitlements.assertFeature(shopId, FEATURES.OFFER_SCHEDULING);
  }

  const countsAgainstAllowance = isNew && payload.status !== 'draft';
  if (countsAgainstAllowance) {
    // Fails fast on the common case, and is the only check an update needs.
    // A create re-runs it inside its transaction, where it is race-free (§24).
    await entitlements.assertUsageWithinLimit(shopId, 'offersPerMonth', 'offersThisMonth');
  }

  // Resolved out here so the transaction never has to ask the pool for a
  // second connection while holding one - see `assertUsageWithinLimitLocked`.
  return { countsAgainstAllowance, resolved: countsAgainstAllowance ? await entitlements.resolve(shopId) : null };
}

async function create(payload, user) {
  const shop = await queryOne(
    'SELECT id, name, status, verification_status FROM shops WHERE id = ?',
    [payload.shopId],
  );
  if (!shop) throw ApiError.badRequest('Shop not found');

  const allowance = await assertPublishingAllowed(payload.shopId, payload, { isNew: true });

  const status = resolveStatus(payload.status, payload.startDate, payload.endDate);

  // Onboarding §12: a shop still in review may prepare drafts but may not put
  // anything in front of customers. Checked on the resolved status, not the
  // requested one, because "scheduled" and "active" are both published as far
  // as a seller waiting on approval is concerned.
  if (status !== 'draft') {
    shopVerification.assertMayPublishListing(shop.verification_status, user, 'offer');
  }

  const offerId = await transaction(async (connection) => {
    // §24: the monthly allowance is re-checked here, under a lock, because the
    // check above raced - two simultaneous posts both saw the same free slot.
    if (allowance.countsAgainstAllowance) {
      await entitlements.assertUsageWithinLimitLocked(
        connection,
        payload.shopId,
        'offersPerMonth',
        'offersThisMonth',
        allowance.resolved,
      );
    }

    await assertBranchesBelongToShop(connection, payload.shopId, payload.branchIds);

    // A draft is not a promise to anyone, so an incomplete branch may still
    // carry one. Everything else is about to be shown to customers.
    if (status !== 'draft') {
      await branchReadiness.assertBranchesReadyToPublish(
        connection,
        payload.shopId,
        payload.applicabilityType,
        payload.branchIds,
      );
    }

    const [result] = await connection.execute(
      `INSERT INTO offers (
         shop_id, category_id, subcategory_id, title, product_name, description, offer_text,
         offer_type, discount_type, discount_value, original_price, discounted_price,
         buy_quantity, get_quantity, min_purchase, terms_conditions, eligibility,
         usage_restrictions, applicable_products, is_recurring, recurrence_type,
         start_date, end_date, status, applicability_type,
         claim_limit_per_customer, total_claim_limit, claim_validity_hours,
         max_redemptions_per_claim, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.shopId,
        payload.categoryId ?? null,
        payload.subcategoryId ?? null,
        payload.title,
        payload.productName ?? null,
        payload.description ?? null,
        payload.offerText ?? null,
        payload.offerType,
        payload.discountType,
        payload.discountValue ?? null,
        payload.originalPrice ?? null,
        payload.discountedPrice ?? null,
        payload.buyQuantity ?? null,
        payload.getQuantity ?? null,
        payload.minPurchase ?? null,
        payload.termsConditions ?? null,
        payload.eligibility ?? null,
        payload.usageRestrictions ?? null,
        payload.applicableProducts ?? null,
        payload.isRecurring ? 1 : 0,
        payload.isRecurring ? payload.recurrenceType ?? null : null,
        payload.startDate,
        payload.endDate,
        status,
        payload.applicabilityType,
        payload.claimLimitPerCustomer,
        payload.totalClaimLimit ?? null,
        payload.claimValidityHours ?? null,
        payload.maxRedemptionsPerClaim,
        user.id,
        user.id,
      ],
    );
    const newId = result.insertId;

    if (payload.applicabilityType === 'selected_branches') {
      for (const branchId of payload.branchIds) {
        await connection.execute(
          'INSERT INTO offer_locations (offer_id, branch_id) VALUES (?, ?)',
          [newId, branchId],
        );
      }
    }

    for (const [index, image] of (payload.images || []).entries()) {
      await connection.execute(
        'INSERT INTO offer_images (offer_id, image_url, thumbnail_url, display_order) VALUES (?, ?, ?, ?)',
        [newId, image.url, image.thumbnailUrl ?? null, index],
      );
    }

    return newId;
  });

  if (status !== 'draft') {
    // The counter is the audit trail of what was published; the limit itself is
    // checked against the offers table, so a drifted counter cannot unblock it.
    await subscriptions.recordUsage(payload.shopId, 'offers_published');
  }

  if (status === 'active') {
    // Fan-out runs after the transaction so a notification failure cannot roll
    // back a published offer.
    notifications.notifyNewOffer(offerId).catch((error) =>
      logger.error(
        {
          event: 'NOTIFICATION_SEND_FAILED',
          error_code: 'NOTIFICATION_SEND_FAILED',
          category: 'NOTIFICATION',
          dependency: 'PUSH',
          notification: 'NEW_OFFER',
          err_message: error.message,
        },
        'Notification fan-out failed',
      ),
    );
  }

  return getById(offerId, user, { forManagement: true });
}

async function update(offerId, payload, user, previous) {
  if (Number(payload.shopId) !== Number(previous.shop_id)) {
    // Moving an offer between shops would bypass the ownership check.
    throw ApiError.forbidden('An offer cannot be moved to a different shop');
  }

  // An edit never consumes another month's allowance - the offer is already
  // published - but it must not be a way to add scheduling or recurrence to an
  // offer on a plan that does not include them.
  await assertPublishingAllowed(previous.shop_id, payload, { isNew: false });

  const keepStatus = ['deactivated', 'draft'].includes(previous.status)
    ? previous.status
    : resolveStatus(payload.status === 'draft' ? previous.status : payload.status, payload.startDate, payload.endDate);

  // The same gate as create: editing must not be the way round it.
  if (keepStatus !== 'draft' && previous.status === 'draft') {
    const shop = await queryOne('SELECT verification_status FROM shops WHERE id = ?', [previous.shop_id]);
    shopVerification.assertMayPublishListing(shop?.verification_status, user, 'offer');
  }

  await transaction(async (connection) => {
    await assertBranchesBelongToShop(connection, previous.shop_id, payload.branchIds);

    /**
     * Branch readiness is checked when an offer *becomes* a promise to a
     * customer, not on every edit.
     *
     * Publishing a draft, or pointing a live offer at different branches, is
     * new activity and meets the rule. Fixing a typo in the title of an offer
     * that has been live for a month is not, and refusing that would make the
     * rule retroactive by the back door - the merchant would be unable to
     * correct a mistake until they had finished an unrelated form.
     */
    const [previousLinks] = await connection.execute(
      'SELECT branch_id FROM offer_locations WHERE offer_id = ?',
      [offerId],
    );
    const before = new Set(previousLinks.map((row) => Number(row.branch_id)));
    const after = new Set((payload.branchIds || []).map(Number));
    const retargeted =
      payload.applicabilityType !== previous.applicability_type ||
      before.size !== after.size ||
      [...after].some((id) => !before.has(id));

    if (keepStatus !== 'draft' && (previous.status === 'draft' || retargeted)) {
      await branchReadiness.assertBranchesReadyToPublish(
        connection,
        previous.shop_id,
        payload.applicabilityType,
        payload.branchIds,
      );
    }

    await connection.execute(
      `UPDATE offers SET
         category_id = ?, subcategory_id = ?, title = ?, product_name = ?, description = ?,
         offer_text = ?, offer_type = ?, discount_type = ?, discount_value = ?,
         original_price = ?, discounted_price = ?, buy_quantity = ?, get_quantity = ?,
         min_purchase = ?, terms_conditions = ?, eligibility = ?, usage_restrictions = ?,
         applicable_products = ?, is_recurring = ?, recurrence_type = ?, start_date = ?,
         end_date = ?, status = ?, applicability_type = ?,
         claim_limit_per_customer = ?, total_claim_limit = ?, claim_validity_hours = ?,
         max_redemptions_per_claim = ?, updated_by = ?
       WHERE id = ?`,
      [
        payload.categoryId ?? null,
        payload.subcategoryId ?? null,
        payload.title,
        payload.productName ?? null,
        payload.description ?? null,
        payload.offerText ?? null,
        payload.offerType,
        payload.discountType,
        payload.discountValue ?? null,
        payload.originalPrice ?? null,
        payload.discountedPrice ?? null,
        payload.buyQuantity ?? null,
        payload.getQuantity ?? null,
        payload.minPurchase ?? null,
        payload.termsConditions ?? null,
        payload.eligibility ?? null,
        payload.usageRestrictions ?? null,
        payload.applicableProducts ?? null,
        payload.isRecurring ? 1 : 0,
        payload.isRecurring ? payload.recurrenceType ?? null : null,
        payload.startDate,
        payload.endDate,
        keepStatus,
        payload.applicabilityType,
        payload.claimLimitPerCustomer,
        payload.totalClaimLimit ?? null,
        payload.claimValidityHours ?? null,
        payload.maxRedemptionsPerClaim,
        user.id,
        offerId,
      ],
    );

    await connection.execute('DELETE FROM offer_locations WHERE offer_id = ?', [offerId]);
    if (payload.applicabilityType === 'selected_branches') {
      for (const branchId of payload.branchIds) {
        await connection.execute(
          'INSERT INTO offer_locations (offer_id, branch_id) VALUES (?, ?)',
          [offerId, branchId],
        );
      }
    }

    if (payload.images) {
      await connection.execute('DELETE FROM offer_images WHERE offer_id = ?', [offerId]);
      for (const [index, image] of payload.images.entries()) {
        await connection.execute(
          'INSERT INTO offer_images (offer_id, image_url, thumbnail_url, display_order) VALUES (?, ?, ?, ?)',
          [offerId, image.url, image.thumbnailUrl ?? null, index],
        );
      }
    }
  });

  notifications.notifyOfferUpdated(offerId).catch((error) =>
    logger.error(
        {
          event: 'NOTIFICATION_SEND_FAILED',
          error_code: 'NOTIFICATION_SEND_FAILED',
          category: 'NOTIFICATION',
          dependency: 'PUSH',
          notification: 'OFFER_UPDATED',
          err_message: error.message,
        },
        'Notification fan-out failed',
      ),
  );

  return getById(offerId, user, { forManagement: true });
}

const ALLOWED_TRANSITIONS = {
  draft: ['scheduled', 'active', 'deactivated'],
  scheduled: ['active', 'deactivated', 'draft'],
  active: ['deactivated', 'expired'],
  expired: ['deactivated', 'scheduled', 'active'],
  deactivated: ['active', 'scheduled', 'draft'],
};

async function changeStatus(offer, status, user) {
  if (offer.status === status) return getById(offer.id, user, { forManagement: true });

  if (!ALLOWED_TRANSITIONS[offer.status]?.includes(status)) {
    throw ApiError.badRequest(`An offer cannot move from "${offer.status}" to "${status}"`);
  }
  if (['active', 'scheduled'].includes(status) && new Date(offer.end_date) <= new Date()) {
    throw ApiError.badRequest('Extend the end date before republishing this offer');
  }

  const resolved =
    status === 'active' ? resolveStatus('active', new Date(offer.start_date), new Date(offer.end_date)) : status;

  // The third way an offer reaches a customer, after create and update. A gate
  // on two of the three is not a gate.
  if (resolved !== 'draft' && offer.status === 'draft') {
    const links = await query('SELECT branch_id FROM offer_locations WHERE offer_id = ?', [offer.id]);
    await branchReadiness.assertBranchesReadyToPublish(
      query,
      offer.shop_id,
      offer.applicability_type,
      links.map((row) => Number(row.branch_id)),
    );
  }

  await execute('UPDATE offers SET status = ?, updated_by = ? WHERE id = ?', [resolved, user.id, offer.id]);

  if (resolved === 'active' && offer.status !== 'active') {
    notifications.notifyNewOffer(offer.id).catch(() => {});
  }
  if (resolved === 'deactivated') {
    notifications.notifyOfferDeactivated(offer.id).catch(() => {});
  }

  return getById(offer.id, user, { forManagement: true });
}

async function remove(offerId) {
  await execute('DELETE FROM offers WHERE id = ?', [offerId]);
}

/**
 * Records a view/click/share. The denormalised counters on `offers` keep the
 * card listings cheap; `offer_views` retains the raw events for analytics.
 */
async function trackEvent(offerId, { event, branchId, city, latitude, longitude }, user, ip) {
  const offer = await queryOne('SELECT id, shop_id FROM offers WHERE id = ?', [offerId]);
  if (!offer) throw ApiError.notFound('Offer not found');

  // V3 §11: the customer's coarse location is stored on the event itself, which
  // is what the location intelligence dashboard aggregates. It falls back to the
  // branch city when the customer has not shared a position.
  const resolvedCity =
    city ??
    (branchId
      ? (await queryOne('SELECT city FROM shop_branches WHERE id = ?', [branchId]))?.city ?? null
      : null);

  await execute(
    `INSERT INTO offer_views (offer_id, user_id, branch_id, event_type, ip_address, city, latitude, longitude)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      offerId,
      user?.id ?? null,
      branchId ?? null,
      event,
      ip ?? null,
      resolvedCity,
      latitude ?? null,
      longitude ?? null,
    ],
  );

  if (event === 'view') {
    await execute('UPDATE offers SET view_count = view_count + 1 WHERE id = ?', [offerId]);
  } else if (event === 'click') {
    await execute('UPDATE offers SET click_count = click_count + 1 WHERE id = ?', [offerId]);
  }

  // Feeds the new-vs-returning split (§14) without a second pass over events.
  if (user) await analyticsEvents.touchShopCustomer(offer.shop_id, user.id);

  /**
   * Mirror into the visibility stream (Visibility §32).
   *
   * Recorded here rather than left to `analyticsEvents`' mirror, because this
   * path never calls it: an offer view lands in `offer_views`, its own table,
   * and nothing else. Without this the strongest mid-funnel signal there is -
   * a customer actually opening an offer - reached neither the ranking's
   * ENGAGEMENT factor (§2.4) nor the merchant's "Opened" counter (§15), and
   * both would have read zero forever while looking perfectly healthy.
   *
   * Only 'view' is mirrored. Impressions arrive from the client with a surface
   * and a rank attached (§32), and a second copy from here with neither would
   * corrupt the average-position figure §15 reports.
   */
  if (event === 'view') {
    visibilityEvents
      .record({
        eventType: 'VIEW',
        listingType: 'offer',
        listingId: Number(offerId),
        shopId: offer.shop_id,
        branchId: branchId ?? null,
        userId: user?.id ?? null,
        city: resolvedCity,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
      })
      .catch(() => {});
  }
}

/**
 * Lifecycle maintenance (§14, §45). Run on a schedule:
 *   scheduled -> active  once the start date passes
 *   active    -> expired once the end date passes
 */
async function syncLifecycleStatuses() {
  const activated = await execute(
    `UPDATE offers SET status = 'active'
      WHERE status = 'scheduled' AND start_date <= NOW() AND end_date > NOW()`,
  );
  const expired = await execute(
    `UPDATE offers SET status = 'expired'
      WHERE status IN ('active', 'scheduled') AND end_date <= NOW()`,
  );
  return { activated: activated.affectedRows, expired: expired.affectedRows };
}

module.exports = {
  list,
  getById,
  create,
  assertPublishingAllowed,
  update,
  changeStatus,
  remove,
  trackEvent,
  syncLifecycleStatuses,
  mapOffer,
  resolveStatus,
  buildListQuery,
  branchPredicate,
  PLAN_RANK_SQL,
};
