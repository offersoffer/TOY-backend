'use strict';

const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const geo = require('../../utils/geo');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');
const entitlements = require('../../services/entitlements');
const shopVerification = require('../../services/shopVerification');
const analyticsEvents = require('../../services/analyticsEvents');
const notifications = require('../../services/notifications');
const { FEATURES } = require('../../config/plans');

/**
 * Services are a parallel listing type to offers (V4 §1-§4): same shop/branch/
 * image/category ownership and discovery conventions, service-specific fields
 * instead of discount fields. This module mirrors offer.service.js function
 * for function; see that file for the rationale behind each pattern.
 */

const branchPredicate = (alias) => `(
  (sv.applicability_type = 'shop_wide' AND ${alias}.shop_id = sv.shop_id)
  OR (sv.applicability_type = 'selected_branches' AND EXISTS (
       SELECT 1 FROM service_locations sl WHERE sl.service_id = sv.id AND sl.branch_id = ${alias}.id))
)`;

function nearestDistanceSql() {
  return `(
    SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')})
      FROM shop_branches b
     WHERE b.status = 'active'
       AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
       AND ${branchPredicate('b')}
  )`;
}

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
  SELECT si.image_url FROM service_images si
   WHERE si.service_id = sv.id ORDER BY si.display_order ASC, si.id ASC LIMIT 1
)`;
const PRIMARY_THUMB_SQL = `(
  SELECT si.thumbnail_url FROM service_images si
   WHERE si.service_id = sv.id ORDER BY si.display_order ASC, si.id ASC LIMIT 1
)`;

/** Nearest active offer on this service, for the "View Services" badge (§10). */
const ACTIVE_OFFER_SQL = `(
  SELECT so.id FROM service_offers so
   WHERE so.service_id = sv.id AND so.status = 'active'
     AND so.start_date <= NOW() AND so.end_date >= NOW()
   ORDER BY so.end_date ASC LIMIT 1
)`;

const SORT_SQL = {
  newest: 'sv.created_at DESC, sv.id DESC',
  mostViewed: 'sv.view_count DESC, sv.id DESC',
  mostPopular: '(sv.save_count * 3 + sv.click_count * 2 + sv.view_count) DESC, sv.id DESC',
  nearest: 'distance_km IS NULL, distance_km ASC',
};

const PLAN_RANK_SQL = `(CASE
  WHEN sub.status = 'active' AND sub.plan = 'PREMIUM'  THEN 2
  WHEN sub.status = 'active' AND sub.plan = 'BUSINESS' THEN 1
  ELSE 0 END)`;

/** Discovery ordering with the same premium tie-break boost as offers (§36). */
const BOOSTED_SORT_SQL = {
  newest: 'DATE(sv.created_at) DESC, plan_rank DESC, sv.created_at DESC, sv.id DESC',
  mostViewed: 'ROUND(sv.view_count / 100) DESC, plan_rank DESC, sv.view_count DESC, sv.id DESC',
  mostPopular:
    'ROUND((sv.save_count * 3 + sv.click_count * 2 + sv.view_count) / 100) DESC, plan_rank DESC, sv.id DESC',
  nearest: 'distance_km IS NULL, ROUND(distance_km, 0) ASC, plan_rank DESC, distance_km ASC',
};

function mapActiveOffer(row) {
  if (!row.active_offer_id) return null;
  return {
    id: Number(row.active_offer_id),
    offerText: row.active_offer_text,
    discountType: row.active_offer_discount_type,
    discountValue: row.active_offer_discount_value === null ? null : Number(row.active_offer_discount_value),
    offerPrice: row.active_offer_price === null ? null : Number(row.active_offer_price),
    endDate: row.active_offer_end_date,
  };
}

function mapService(row, { includeRelations = false } = {}) {
  const service = {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    pricingType: row.pricing_type,
    price: row.price === null ? null : Number(row.price),
    durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
    durationLabel: row.duration_label,
    availableDays: row.available_days ? row.available_days.split(',').filter(Boolean) : [],
    availableTimeStart: row.available_time_start,
    availableTimeEnd: row.available_time_end,
    homeService: Boolean(row.home_service),
    walkInAvailable: Boolean(row.walk_in_available),
    appointmentRequired: Boolean(row.appointment_required),
    bookingType: row.booking_type,
    serviceArea: row.service_area,
    termsConditions: row.terms_conditions,
    applicabilityType: row.applicability_type,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    imageUrl: row.image_url ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    viewCount: Number(row.view_count ?? 0),
    clickCount: Number(row.click_count ?? 0),
    saveCount: Number(row.save_count ?? 0),
    distanceKm:
      row.distance_km === null || row.distance_km === undefined ? null : Number(Number(row.distance_km).toFixed(2)),
    locationLabel: row.location_label ?? null,
    isSaved: Boolean(row.is_saved),
    activeOffer: row.active_offer_id !== undefined ? mapActiveOffer(row) : undefined,
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
    service.subcategory = row.subcategory_id
      ? { id: Number(row.subcategory_id), name: row.subcategory_name }
      : null;
    service.createdBy = row.created_by_name ? { id: Number(row.created_by), name: row.created_by_name } : null;
    service.updatedBy = row.updated_by_name ? { id: Number(row.updated_by), name: row.updated_by_name } : null;
  }

  return service;
}

function buildListQuery(params, user) {
  const hasPosition = params.latitude !== undefined && params.longitude !== undefined;

  const selectParams = [];
  const whereParams = [];
  const where = ['1 = 1'];

  let distanceSelect = 'NULL AS distance_km';
  if (hasPosition) {
    distanceSelect = `${nearestDistanceSql()} AS distance_km`;
    selectParams.push(...geo.distanceKmParams(params.latitude, params.longitude));
  }

  let labelSelect = `${locationLabelSql(hasPosition)} AS location_label`;
  const labelParams = hasPosition ? geo.distanceKmParams(params.latitude, params.longitude) : [];

  let savedSelect = '0 AS is_saved';
  const savedParams = [];
  if (user) {
    savedSelect = '(SELECT 1 FROM saved_services sv2 WHERE sv2.service_id = sv.id AND sv2.user_id = ?) AS is_saved';
    savedParams.push(user.id);
  }

  const managing = Boolean(params.manage) || (params.status && params.status !== 'active');

  if (managing) {
    if (!user) throw ApiError.unauthorized('Sign in to manage services');
    const scope = accessControl.shopScopeFor(user, 'EDIT_SERVICE');
    if (scope !== null) {
      if (scope.length === 0) throw ApiError.forbidden('You are not assigned to any shop');
      where.push(`sv.shop_id IN (${scope.map(() => '?').join(',')})`);
      whereParams.push(...scope);
    }
    if (params.status && params.status !== 'all') {
      where.push('sv.status = ?');
      whereParams.push(params.status);
    }
  } else {
    where.push(
      "sv.status = 'active'",
      "s.status = 'active'",
      "(sv.start_date IS NULL OR sv.start_date <= NOW())",
      "(sv.end_date IS NULL OR sv.end_date >= NOW())",
    );
  }

  if (params.search) {
    const term = `%${params.search}%`;
    where.push(`(
      sv.name LIKE ? OR sv.description LIKE ? OR sv.service_area LIKE ?
      OR s.name LIKE ? OR c.name LIKE ?
      OR EXISTS (SELECT 1 FROM shop_branches sb WHERE sb.shop_id = sv.shop_id
                   AND (sb.city LIKE ? OR sb.pincode LIKE ?))
    )`);
    whereParams.push(term, term, term, term, term, term, term);
  }

  if (params.categoryId) {
    where.push('(sv.category_id = ? OR sv.subcategory_id = ?)');
    whereParams.push(params.categoryId, params.categoryId);
  } else if (params.category) {
    where.push(`(c.slug = ? OR c.name = ? OR sv.category_id = ?)`);
    whereParams.push(params.category, params.category, Number.parseInt(params.category, 10) || 0);
  }

  if (params.shopId) {
    where.push('sv.shop_id = ?');
    whereParams.push(params.shopId);
  } else if (params.shop) {
    where.push('(s.slug = ? OR s.name = ? OR sv.shop_id = ?)');
    whereParams.push(params.shop, params.shop, Number.parseInt(params.shop, 10) || 0);
  }

  if (params.branchId) {
    where.push(`EXISTS (SELECT 1 FROM shop_branches b3 WHERE b3.id = ? AND ${branchPredicate('b3')})`);
    whereParams.push(params.branchId);
  }

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

  if (params.pricingType) {
    where.push('sv.pricing_type = ?');
    whereParams.push(params.pricingType);
  }
  if (params.bookingType) {
    where.push('sv.booking_type = ?');
    whereParams.push(params.bookingType);
  }
  if (params.homeService !== undefined) {
    where.push('sv.home_service = ?');
    whereParams.push(params.homeService ? 1 : 0);
  }
  if (params.hasOffer) {
    where.push(`EXISTS (SELECT 1 FROM service_offers so2
                         WHERE so2.service_id = sv.id AND so2.status = 'active'
                           AND so2.start_date <= NOW() AND so2.end_date >= NOW())`);
  }
  if (params.startDate) {
    where.push('(sv.end_date IS NULL OR sv.end_date >= ?)');
    whereParams.push(params.startDate);
  }
  if (params.endDate) {
    where.push('(sv.start_date IS NULL OR sv.start_date <= ?)');
    whereParams.push(params.endDate);
  }

  if (params.minPlanRank) {
    where.push(`${PLAN_RANK_SQL} >= ?`);
    whereParams.push(params.minPlanRank);
  }

  if (params.saved) {
    if (!user) throw ApiError.unauthorized('Sign in to view saved services');
    where.push('EXISTS (SELECT 1 FROM saved_services ss2 WHERE ss2.service_id = sv.id AND ss2.user_id = ?)');
    whereParams.push(user.id);
  }

  const from = `
      FROM services sv
      JOIN shops s ON s.id = sv.shop_id
      LEFT JOIN categories c ON c.id = sv.category_id
      LEFT JOIN shop_subscriptions sub ON sub.shop_id = sv.shop_id`;

  return {
    from,
    managing,
    whereSql: `WHERE ${where.join('\n       AND ')}`,
    having,
    distanceSelect,
    labelSelect,
    savedSelect,
    selectParams,
    labelParams,
    savedParams,
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
    SELECT sv.*,
           s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
           c.name AS category_name, c.slug AS category_slug,
           ${PRIMARY_IMAGE_SQL} AS image_url,
           ${PRIMARY_THUMB_SQL} AS thumbnail_url,
           ${ACTIVE_OFFER_SQL} AS active_offer_id,
           (SELECT so.offer_text FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_text,
           (SELECT so.discount_type FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_discount_type,
           (SELECT so.discount_value FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_discount_value,
           (SELECT so.offer_price FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_price,
           (SELECT so.end_date FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_end_date,
           ${PLAN_RANK_SQL} AS plan_rank,
           ${built.distanceSelect},
           ${built.labelSelect},
           ${built.savedSelect}
    ${built.from}
    ${built.whereSql}
    ${built.having}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const sqlParams = [
    ...built.selectParams,
    ...built.labelParams,
    ...built.savedParams,
    ...built.whereParams,
    ...built.havingParams,
  ];

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      SELECT sv.id, ${built.distanceSelect}
      ${built.from}
      ${built.whereSql}
      ${built.having}
    ) AS matched`;
  const countParams = [...built.selectParams, ...built.whereParams, ...built.havingParams];

  const [rows, countRows] = await Promise.all([rawQuery(sql, sqlParams), rawQuery(countSql, countParams)]);

  return {
    items: rows.map((row) => mapService(row)),
    pagination: { page, limit, total: Number(countRows[0]?.total ?? 0) },
  };
}

async function getById(id, user, { forManagement = false, position = null } = {}) {
  const hasPosition = position?.latitude !== undefined && position?.longitude !== undefined && position !== null;

  const selectParams = [];
  let distanceSelect = 'NULL AS distance_km';
  if (hasPosition) {
    distanceSelect = `${nearestDistanceSql()} AS distance_km`;
    selectParams.push(...geo.distanceKmParams(position.latitude, position.longitude));
  }

  const savedParams = user ? [user.id] : [];
  const savedSelect = user
    ? '(SELECT 1 FROM saved_services sv2 WHERE sv2.service_id = sv.id AND sv2.user_id = ?) AS is_saved'
    : '0 AS is_saved';

  const row = await rawQuery(
    `SELECT sv.*,
            s.name AS shop_name, s.slug AS shop_slug, s.logo_url AS shop_logo_url,
            s.description AS shop_description, s.contact_number AS shop_contact,
            s.status AS shop_status,
            c.name AS category_name, c.slug AS category_slug,
            sc.name AS subcategory_name,
            cu.name AS created_by_name, uu.name AS updated_by_name,
            ${PRIMARY_IMAGE_SQL} AS image_url,
            ${PRIMARY_THUMB_SQL} AS thumbnail_url,
            ${ACTIVE_OFFER_SQL} AS active_offer_id,
            (SELECT so.offer_text FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_text,
            (SELECT so.discount_type FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_discount_type,
            (SELECT so.discount_value FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_discount_value,
            (SELECT so.offer_price FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_price,
            (SELECT so.end_date FROM service_offers so WHERE so.id = ${ACTIVE_OFFER_SQL}) AS active_offer_end_date,
            ${distanceSelect},
            ${savedSelect}
       FROM services sv
       JOIN shops s ON s.id = sv.shop_id
       LEFT JOIN categories c ON c.id = sv.category_id
       LEFT JOIN categories sc ON sc.id = sv.subcategory_id
       LEFT JOIN users cu ON cu.id = sv.created_by
       LEFT JOIN users uu ON uu.id = sv.updated_by
      WHERE sv.id = ?`,
    [...selectParams, ...savedParams, id],
  ).then((rows) => rows[0]);

  if (!row) throw ApiError.notFound('Service not found');

  const canManage = Boolean(user) && accessControl.hasShopPermission(user, row.shop_id, 'EDIT_SERVICE');
  const isPubliclyVisible = row.status === 'active' && row.shop_status === 'active';
  if (!isPubliclyVisible && !canManage && !forManagement) {
    throw ApiError.notFound('Service not found');
  }

  const [images, branches] = await Promise.all([
    query(
      'SELECT id, image_url, thumbnail_url, display_order FROM service_images WHERE service_id = ? ORDER BY display_order, id',
      [id],
    ),
    rawQuery(
      `SELECT b.id, b.branch_name, b.address, b.city, b.state, b.country, b.pincode,
              b.latitude, b.longitude, b.contact_number, b.is_primary
              ${hasPosition ? `, ${geo.distanceKmSql('b.latitude', 'b.longitude')} AS distance_km` : ', NULL AS distance_km'}
         FROM shop_branches b
         JOIN services sv ON sv.id = ?
        WHERE b.status = 'active' AND ${branchPredicate('b')}
        ORDER BY ${hasPosition ? 'distance_km IS NULL, distance_km ASC,' : ''} b.is_primary DESC, b.id`,
      hasPosition ? [...geo.distanceKmParams(position.latitude, position.longitude), id] : [id],
    ),
  ]);

  const service = mapService(row, { includeRelations: true });
  service.images = images.map((image) => ({
    id: Number(image.id),
    url: image.image_url,
    thumbnailUrl: image.thumbnail_url,
    displayOrder: image.display_order,
  }));
  service.branches = branches.map((branch) => ({
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
  service.shop.description = row.shop_description;
  service.shop.contactNumber = row.shop_contact;
  service.branchIds = service.branches.map((branch) => branch.id);

  // The caller's own claim on this service's live offer (§3, §5, §22), so the
  // page can show the code instead of the Claim button. Mirrors what the
  // product-offer detail does, and carries no QR - that is the claim
  // endpoint's business, and this response is served to staff too.
  if (user && service.activeOffer) {
    const held = await queryOne(
      `SELECT id, code, status, expires_at FROM service_offer_claims
        WHERE service_offer_id = ? AND user_id = ? AND status NOT IN ('cancelled','revoked')
        ORDER BY FIELD(status, 'claimed', 'redeemed', 'expired'), claimed_at DESC LIMIT 1`,
      [service.activeOffer.id, user.id],
    );
    service.myClaim = held
      ? {
          id: Number(held.id),
          code: held.code,
          status: held.status,
          expiresAt: held.expires_at,
        }
      : null;
  }

  return service;
}

/** Derives the initial lifecycle status from the requested one and the dates. */
function resolveStatus(requested, startDate, endDate) {
  const now = new Date();
  if (requested === 'draft') return 'draft';
  if (endDate && endDate <= now) return 'expired';
  if (startDate && startDate > now) return 'scheduled';
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

/** Subscription rules that apply to publishing a service (mirrors offers). */
async function assertPublishingAllowed(shopId, payload, { isNew }) {
  const startsLater = payload.startDate ? new Date(payload.startDate) > new Date() : false;
  if (payload.status === 'scheduled' || startsLater) {
    await entitlements.assertFeature(shopId, FEATURES.SERVICE_SCHEDULING);
  }

  const countsAgainstAllowance = isNew && payload.status !== 'draft';
  if (countsAgainstAllowance) {
    // Fails fast; `create` re-checks inside its transaction where it is
    // race-free (§24).
    await entitlements.assertUsageWithinLimit(shopId, 'servicesPerMonth', 'servicesThisMonth');
  }

  // Resolved outside any transaction - see `assertUsageWithinLimitLocked`.
  return { countsAgainstAllowance, resolved: countsAgainstAllowance ? await entitlements.resolve(shopId) : null };
}

async function insertImagesAndLocations(connection, serviceId, payload) {
  if (payload.applicabilityType === 'selected_branches') {
    for (const branchId of payload.branchIds) {
      await connection.execute('INSERT INTO service_locations (service_id, branch_id) VALUES (?, ?)', [
        serviceId,
        branchId,
      ]);
    }
  }
  for (const [index, image] of (payload.images || []).entries()) {
    await connection.execute(
      'INSERT INTO service_images (service_id, image_url, thumbnail_url, display_order) VALUES (?, ?, ?, ?)',
      [serviceId, image.url, image.thumbnailUrl ?? null, index],
    );
  }
}

async function create(payload, user) {
  const shop = await queryOne(
    'SELECT id, name, status, verification_status FROM shops WHERE id = ?',
    [payload.shopId],
  );
  if (!shop) throw ApiError.badRequest('Shop not found');

  const allowance = await assertPublishingAllowed(payload.shopId, payload, { isNew: true });

  const status = resolveStatus(payload.status, payload.startDate ?? null, payload.endDate ?? null);

  // Onboarding §12: the same rule as offers. A shop in review may prepare
  // drafts; it may not put a service in front of customers.
  if (status !== 'draft') {
    shopVerification.assertMayPublishListing(shop.verification_status, user, 'service');
  }

  const serviceId = await transaction(async (connection) => {
    // §24: re-checked under a lock, because the check above raced.
    if (allowance.countsAgainstAllowance) {
      await entitlements.assertUsageWithinLimitLocked(
        connection,
        payload.shopId,
        'servicesPerMonth',
        'servicesThisMonth',
        allowance.resolved,
      );
    }

    await assertBranchesBelongToShop(connection, payload.shopId, payload.branchIds);

    const [result] = await connection.execute(
      `INSERT INTO services (
         shop_id, category_id, subcategory_id, name, description, pricing_type, price,
         duration_minutes, duration_label, available_days, available_time_start, available_time_end,
         home_service, walk_in_available, appointment_required, booking_type, service_area,
         terms_conditions, applicability_type, status, start_date, end_date, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.shopId,
        payload.categoryId ?? null,
        payload.subcategoryId ?? null,
        payload.name,
        payload.description ?? null,
        payload.pricingType,
        payload.price ?? null,
        payload.durationMinutes ?? null,
        payload.durationLabel ?? null,
        payload.availableDays?.length ? payload.availableDays.join(',') : null,
        payload.availableTimeStart ?? null,
        payload.availableTimeEnd ?? null,
        payload.homeService ? 1 : 0,
        payload.walkInAvailable ? 1 : 0,
        payload.appointmentRequired ? 1 : 0,
        payload.bookingType,
        payload.serviceArea ?? null,
        payload.termsConditions ?? null,
        payload.applicabilityType,
        status,
        payload.startDate ?? null,
        payload.endDate ?? null,
        user.id,
        user.id,
      ],
    );
    const newId = result.insertId;
    await insertImagesAndLocations(connection, newId, payload);
    return newId;
  });

  return getById(serviceId, user, { forManagement: true });
}

async function update(serviceId, payload, user, previous) {
  if (Number(payload.shopId) !== Number(previous.shop_id)) {
    throw ApiError.forbidden('A service cannot be moved to a different shop');
  }

  await assertPublishingAllowed(previous.shop_id, payload, { isNew: false });

  const keepStatus = ['deactivated', 'draft', 'paused'].includes(previous.status)
    ? previous.status
    : resolveStatus(
        payload.status === 'draft' ? previous.status : payload.status,
        payload.startDate ?? null,
        payload.endDate ?? null,
      );

  await transaction(async (connection) => {
    await assertBranchesBelongToShop(connection, previous.shop_id, payload.branchIds);

    await connection.execute(
      `UPDATE services SET
         category_id = ?, subcategory_id = ?, name = ?, description = ?, pricing_type = ?, price = ?,
         duration_minutes = ?, duration_label = ?, available_days = ?, available_time_start = ?,
         available_time_end = ?, home_service = ?, walk_in_available = ?, appointment_required = ?,
         booking_type = ?, service_area = ?, terms_conditions = ?, applicability_type = ?,
         status = ?, start_date = ?, end_date = ?, updated_by = ?
       WHERE id = ?`,
      [
        payload.categoryId ?? null,
        payload.subcategoryId ?? null,
        payload.name,
        payload.description ?? null,
        payload.pricingType,
        payload.price ?? null,
        payload.durationMinutes ?? null,
        payload.durationLabel ?? null,
        payload.availableDays?.length ? payload.availableDays.join(',') : null,
        payload.availableTimeStart ?? null,
        payload.availableTimeEnd ?? null,
        payload.homeService ? 1 : 0,
        payload.walkInAvailable ? 1 : 0,
        payload.appointmentRequired ? 1 : 0,
        payload.bookingType,
        payload.serviceArea ?? null,
        payload.termsConditions ?? null,
        payload.applicabilityType,
        keepStatus,
        payload.startDate ?? null,
        payload.endDate ?? null,
        user.id,
        serviceId,
      ],
    );

    await connection.execute('DELETE FROM service_locations WHERE service_id = ?', [serviceId]);
    if (payload.images) {
      await connection.execute('DELETE FROM service_images WHERE service_id = ?', [serviceId]);
    }
    await insertImagesAndLocations(connection, serviceId, payload);
  });

  return getById(serviceId, user, { forManagement: true });
}

const ALLOWED_TRANSITIONS = {
  draft: ['scheduled', 'active', 'deactivated'],
  scheduled: ['active', 'paused', 'deactivated', 'draft'],
  active: ['paused', 'deactivated', 'expired'],
  paused: ['active', 'deactivated'],
  expired: ['deactivated', 'scheduled', 'active'],
  deactivated: ['active', 'scheduled', 'draft'],
};

async function changeStatus(service, status, user) {
  if (service.status === status) return getById(service.id, user, { forManagement: true });

  if (!ALLOWED_TRANSITIONS[service.status]?.includes(status)) {
    throw ApiError.badRequest(`A service cannot move from "${service.status}" to "${status}"`);
  }
  if (['active', 'scheduled'].includes(status) && service.end_date && new Date(service.end_date) <= new Date()) {
    throw ApiError.badRequest('Extend the end date before republishing this service');
  }

  const resolved =
    status === 'active'
      ? resolveStatus(
          'active',
          service.start_date ? new Date(service.start_date) : null,
          service.end_date ? new Date(service.end_date) : null,
        )
      : status;

  await execute('UPDATE services SET status = ?, updated_by = ? WHERE id = ?', [resolved, user.id, service.id]);
  return getById(service.id, user, { forManagement: true });
}

/** Clones a service (and its images/branches) as a new draft (§16). */
async function duplicate(service, user) {
  const images = await query(
    'SELECT image_url, thumbnail_url, display_order FROM service_images WHERE service_id = ? ORDER BY display_order, id',
    [service.id],
  );
  const locations = await query('SELECT branch_id FROM service_locations WHERE service_id = ?', [service.id]);

  const newId = await transaction(async (connection) => {
    const [result] = await connection.execute(
      `INSERT INTO services (
         shop_id, category_id, subcategory_id, name, description, pricing_type, price,
         duration_minutes, duration_label, available_days, available_time_start, available_time_end,
         home_service, walk_in_available, appointment_required, booking_type, service_area,
         terms_conditions, applicability_type, status, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [
        service.shop_id,
        service.category_id,
        service.subcategory_id,
        `${service.name} (copy)`,
        service.description,
        service.pricing_type,
        service.price,
        service.duration_minutes,
        service.duration_label,
        service.available_days,
        service.available_time_start,
        service.available_time_end,
        service.home_service,
        service.walk_in_available,
        service.appointment_required,
        service.booking_type,
        service.service_area,
        service.terms_conditions,
        service.applicability_type,
        user.id,
        user.id,
      ],
    );
    const newId = result.insertId;
    for (const branch of locations) {
      await connection.execute('INSERT INTO service_locations (service_id, branch_id) VALUES (?, ?)', [
        newId,
        branch.branch_id,
      ]);
    }
    for (const [index, image] of images.entries()) {
      await connection.execute(
        'INSERT INTO service_images (service_id, image_url, thumbnail_url, display_order) VALUES (?, ?, ?, ?)',
        [newId, image.image_url, image.thumbnail_url, index],
      );
    }
    return newId;
  });

  return getById(newId, user, { forManagement: true });
}

async function remove(serviceId) {
  await execute('DELETE FROM services WHERE id = ?', [serviceId]);
}

/** Records a view/click/share/enquire (§40) - no raw events table, straight into analytics_events. */
async function trackEvent(serviceId, { event, branchId, city, latitude, longitude }, user, ip) {
  const service = await queryOne('SELECT id, shop_id, category_id FROM services WHERE id = ?', [serviceId]);
  if (!service) throw ApiError.notFound('Service not found');

  const resolvedCity =
    city ?? (branchId ? (await queryOne('SELECT city FROM shop_branches WHERE id = ?', [branchId]))?.city ?? null : null);

  const eventType = {
    view: analyticsEvents.EVENT_TYPES.SERVICE_VIEW,
    click: analyticsEvents.EVENT_TYPES.SERVICE_VIEW,
    share: analyticsEvents.EVENT_TYPES.SERVICE_SHARE,
    enquire: analyticsEvents.EVENT_TYPES.SERVICE_ENQUIRE,
  }[event];

  await analyticsEvents.record(eventType, {
    shopId: service.shop_id,
    serviceId: service.id,
    categoryId: service.category_id,
    branchId: branchId ?? null,
    userId: user?.id ?? null,
    city: resolvedCity,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
  });

  if (event === 'view') {
    await execute('UPDATE services SET view_count = view_count + 1 WHERE id = ?', [serviceId]);
  } else if (event === 'click') {
    await execute('UPDATE services SET click_count = click_count + 1 WHERE id = ?', [serviceId]);
  }

  if (user) await analyticsEvents.touchShopCustomer(service.shop_id, user.id);
}

function mapBooking(row) {
  return {
    id: Number(row.id),
    serviceId: Number(row.service_id),
    userId: Number(row.user_id),
    branchId: row.branch_id === null ? null : Number(row.branch_id),
    serviceOfferId: row.service_offer_id === null ? null : Number(row.service_offer_id),
    requestedAt: row.requested_at,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createBooking(serviceId, payload, user) {
  const service = await queryOne('SELECT id, shop_id, status FROM services WHERE id = ?', [serviceId]);
  if (!service) throw ApiError.notFound('Service not found');
  if (service.status !== 'active') throw ApiError.badRequest('This service is not available to book');

  const result = await execute(
    `INSERT INTO service_bookings (service_id, user_id, branch_id, service_offer_id, requested_at, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      serviceId,
      user.id,
      payload.branchId ?? null,
      payload.serviceOfferId ?? null,
      payload.requestedAt ?? null,
      payload.notes ?? null,
    ],
  );

  await analyticsEvents.record(analyticsEvents.EVENT_TYPES.SERVICE_BOOK, {
    shopId: service.shop_id,
    serviceId: service.id,
    userId: user.id,
    branchId: payload.branchId ?? null,
  });
  await analyticsEvents.touchShopCustomer(service.shop_id, user.id);

  // Both halves of the same event (Push §18): the customer learns their request
  // is in, and the shop learns it has one to answer. Kept as two calls rather
  // than one so a failure on either side still leaves the other delivered -
  // and the shop's half is the one that must not be dropped, since a booking
  // waits in `requested` until somebody there accepts it.
  //
  // Fire-and-forget - the booking exists either way, and a push outage must not
  // fail the request that made it.
  const bookingNotificationFailed = (notification) => (error) =>
    logger.error(
      {
        event: 'NOTIFICATION_SEND_FAILED',
        error_code: 'NOTIFICATION_SEND_FAILED',
        category: 'NOTIFICATION',
        dependency: 'PUSH',
        notification,
        err_message: error.message,
      },
      'Notification fan-out failed',
    );

  notifications
    .notifyBooking(result.insertId, 'BOOKING_CREATED')
    .catch(bookingNotificationFailed('BOOKING_CREATED'));

  notifications
    .notifyBookingRequested(result.insertId)
    .catch(bookingNotificationFailed('BOOKING_REQUESTED'));

  return mapBooking(await queryOne('SELECT * FROM service_bookings WHERE id = ?', [result.insertId]));
}

async function updateBookingStatus(bookingId, status, user) {
  const booking = await queryOne(
    `SELECT b.*, sv.shop_id FROM service_bookings b JOIN services sv ON sv.id = b.service_id WHERE b.id = ?`,
    [bookingId],
  );
  if (!booking) throw ApiError.notFound('Booking not found');
  if (!accessControl.hasShopPermission(user, booking.shop_id, 'MANAGE_SERVICE_BOOKING')) {
    throw ApiError.forbidden('This booking belongs to another shop');
  }

  await execute('UPDATE service_bookings SET status = ? WHERE id = ?', [status, bookingId]);

  if (status === 'cancelled') {
    await analyticsEvents.record(analyticsEvents.EVENT_TYPES.SERVICE_CANCEL, {
      shopId: booking.shop_id,
      serviceId: Number(booking.service_id),
      userId: Number(booking.user_id),
    });
  }

  // Tell the customer their appointment moved or was called off (Push §18).
  // Re-saving the status a booking already had is not a change worth a push.
  if (status !== booking.status) {
    notifications
      .notifyBookingStatusChanged(bookingId, status)
      .catch((error) => logger.error(
        {
          event: 'NOTIFICATION_SEND_FAILED',
          error_code: 'NOTIFICATION_SEND_FAILED',
          category: 'NOTIFICATION',
          dependency: 'PUSH',
          notification: 'BOOKING_UPDATED',
          err_message: error.message,
        },
        'Notification fan-out failed',
      ));
  }

  return mapBooking(await queryOne('SELECT * FROM service_bookings WHERE id = ?', [bookingId]));
}

/** Lifecycle maintenance, run on a schedule alongside offer-lifecycle. */
async function syncLifecycleStatuses() {
  const activated = await execute(
    `UPDATE services SET status = 'active'
      WHERE status = 'scheduled' AND (start_date IS NULL OR start_date <= NOW())
        AND (end_date IS NULL OR end_date > NOW())`,
  );
  const expired = await execute(
    `UPDATE services SET status = 'expired'
      WHERE status IN ('active', 'scheduled', 'paused') AND end_date IS NOT NULL AND end_date <= NOW()`,
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
  duplicate,
  remove,
  trackEvent,
  createBooking,
  updateBookingStatus,
  syncLifecycleStatuses,
  mapService,
  resolveStatus,
  buildListQuery,
  branchPredicate,
  PLAN_RANK_SQL,
};
