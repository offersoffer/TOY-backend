'use strict';

const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const geo = require('../../utils/geo');
const { uniqueSlug } = require('../../utils/slug');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');
const entitlements = require('../../services/entitlements');
const shopVerification = require('../../services/shopVerification');
const geocoding = require('../../services/geocoding');
const shopProfile = require('./shopProfile');
const { PLANS, minimumPlanForLimit } = require('../../config/plans');
const passwordUtil = require('../../utils/password');
const tokens = require('../../utils/tokens');
const mailer = require('../../utils/mailer');
const env = require('../../config/env');

/** mysql2 hands JSON columns back parsed on some drivers and raw on others. */
function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Settles the acquisition channel a save should store (Business §17, §32).
 *
 * Two rules, and both exist because this column is read by grouping rather
 * than by lookup:
 *
 * Only a Super Admin may set it. It is sales attribution, not a shop detail -
 * a merchant has no idea which campaign found them, and letting them write it
 * would corrupt the very cohort comparison it exists to support. Anyone else's
 * value is ignored rather than rejected, so a merchant's ordinary profile save
 * still succeeds if their client echoes the field back.
 *
 * A new value is matched case-insensitively against the channels already in
 * use, and the existing spelling wins. Free text plus GROUP BY is how you end
 * up with "Referral", "referral" and "  Referral" as three separate rows on
 * the retention chart, each with a third of the merchants.
 */
async function resolveAcquisitionChannel(payload, user, current = null) {
  if (payload.acquisitionChannel === undefined) return current;
  if (!user?.isSuperAdmin) return current;

  const raw = (payload.acquisitionChannel ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  const existing = await query(
    'SELECT DISTINCT acquisition_channel AS channel FROM shops WHERE acquisition_channel IS NOT NULL',
  );
  const match = existing.find(
    (row) => row.channel.toLowerCase() === raw.toLowerCase(),
  );
  return match ? match.channel : raw.slice(0, 60);
}

function mapShop(row) {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    coverUrl: row.cover_url,
    contactNumber: row.contact_number,
    email: row.email,
    websiteUrl: row.website_url,
    socialLinks: parseJson(row.social_links),
    openingHours: parseJson(row.opening_hours),
    status: row.status,
    acquisitionChannel: row.acquisition_channel ?? null,
    branchCount: row.branch_count === undefined ? undefined : Number(row.branch_count),
    activeOfferCount: row.active_offer_count === undefined ? undefined : Number(row.active_offer_count),
    followerCount: row.follower_count === undefined ? undefined : Number(row.follower_count),
    isFollowing: row.is_following === undefined ? undefined : Boolean(row.is_following),
    distanceKm:
      row.distance_km === null || row.distance_km === undefined
        ? null
        : Number(Number(row.distance_km).toFixed(2)),
    city: row.city ?? null,
    categories: row.category_names
      ? row.category_names.split('||').map((entry) => {
          const [id, name, slug] = entry.split('::');
          return { id: Number(id), name, slug };
        })
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CATEGORY_AGG = `(
  SELECT GROUP_CONCAT(CONCAT(c.id, '::', c.name, '::', c.slug) SEPARATOR '||')
    FROM shop_categories sc JOIN categories c ON c.id = sc.category_id
   WHERE sc.shop_id = s.id
)`;

async function list(params, user) {
  const { limit, page, offset } = limitOffset(params);
  const where = ['1 = 1'];
  const whereParams = [];
  const selectParams = [];

  const hasPosition = params.latitude !== undefined && params.longitude !== undefined;
  const distanceSelect = hasPosition
    ? `(SELECT MIN(${geo.distanceKmSql('b.latitude', 'b.longitude')})
          FROM shop_branches b
         WHERE b.shop_id = s.id AND b.status = 'active'
           AND b.latitude IS NOT NULL) AS distance_km`
    : 'NULL AS distance_km';
  if (hasPosition) selectParams.push(...geo.distanceKmParams(params.latitude, params.longitude));

  const followSelect = user
    ? '(SELECT 1 FROM followed_shops fs WHERE fs.shop_id = s.id AND fs.user_id = ?) AS is_following'
    : '0 AS is_following';
  const followParams = user ? [user.id] : [];

  const wantsInactive = params.status && params.status !== 'active';

  if (params.mine) {
    // "My shops" is always allowed for a signed-in member: these are the shops
    // the caller belongs to, so seeing a deactivated one needs no extra
    // permission. This is what the Post an Offer form asks for.
    if (!user) throw ApiError.unauthorized('Sign in to view your shops');
    const ids = user.isSuperAdmin ? null : user.shopIds;
    if (ids && !ids.length) return { items: [], pagination: { page, limit, total: 0 } };
    if (ids) {
      where.push(`s.id IN (${ids.map(() => '?').join(',')})`);
      whereParams.push(...ids);
    }
    if (!wantsInactive) where.push("s.status = 'active'");
    else if (params.status !== 'all') {
      where.push('s.status = ?');
      whereParams.push(params.status);
    }
  } else if (wantsInactive) {
    // Listing every shop including deactivated ones is a different, wider ask.
    // EDIT_SHOP rather than VIEW_SHOP: customers hold VIEW_SHOP globally, which
    // would otherwise expose every deactivated shop to them.
    if (!user) throw ApiError.unauthorized('Sign in to view inactive shops');
    const scope = accessControl.shopScopeFor(user, 'EDIT_SHOP');
    if (scope !== null) {
      if (!scope.length) throw ApiError.forbidden('You are not assigned to any shop');
      where.push(`s.id IN (${scope.map(() => '?').join(',')})`);
      whereParams.push(...scope);
    }
    if (params.status !== 'all') {
      where.push('s.status = ?');
      whereParams.push(params.status);
    }
  } else {
    where.push("s.status = 'active'");
  }

  if (params.search) {
    const term = `%${params.search}%`;
    where.push('(s.name LIKE ? OR s.description LIKE ?)');
    whereParams.push(term, term);
  }
  if (params.categoryId) {
    where.push('EXISTS (SELECT 1 FROM shop_categories sc2 WHERE sc2.shop_id = s.id AND sc2.category_id = ?)');
    whereParams.push(params.categoryId);
  }
  if (params.city) {
    where.push("EXISTS (SELECT 1 FROM shop_branches b2 WHERE b2.shop_id = s.id AND b2.city = ? AND b2.status = 'active')");
    whereParams.push(params.city);
  }

  let having = '';
  const havingParams = [];
  if (params.radius && hasPosition) {
    const box = geo.boundingBox(params.latitude, params.longitude, params.radius);
    where.push(`EXISTS (SELECT 1 FROM shop_branches b3
                         WHERE b3.shop_id = s.id AND b3.status = 'active'
                           AND b3.latitude BETWEEN ? AND ? AND b3.longitude BETWEEN ? AND ?)`);
    whereParams.push(box.minLat, box.maxLat, box.minLng, box.maxLng);
    having = 'HAVING distance_km IS NOT NULL AND distance_km <= ?';
    havingParams.push(params.radius);
  }

  const orderBy = {
    name: 's.name ASC',
    newest: 's.created_at DESC',
    popular: 'follower_count DESC, active_offer_count DESC',
    nearest: 'distance_km IS NULL, distance_km ASC',
  }[params.sort] || 's.name ASC';

  const whereSql = `WHERE ${where.join('\n       AND ')}`;

  const sql = `
    SELECT s.*,
           ${CATEGORY_AGG} AS category_names,
           (SELECT COUNT(*) FROM shop_branches b4 WHERE b4.shop_id = s.id AND b4.status = 'active') AS branch_count,
           (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS active_offer_count,
           (SELECT COUNT(*) FROM followed_shops fs2 WHERE fs2.shop_id = s.id) AS follower_count,
           (SELECT b5.city FROM shop_branches b5 WHERE b5.shop_id = s.id AND b5.status = 'active'
             ORDER BY b5.is_primary DESC, b5.id LIMIT 1) AS city,
           ${distanceSelect},
           ${followSelect}
      FROM shops s
    ${whereSql}
    ${having}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      SELECT s.id, ${distanceSelect} FROM shops s ${whereSql} ${having}
    ) AS matched`;

  const [rows, countRows] = await Promise.all([
    rawQuery(sql, [...selectParams, ...followParams, ...whereParams, ...havingParams]),
    rawQuery(countSql, [...selectParams, ...whereParams, ...havingParams]),
  ]);

  return {
    items: rows.map(mapShop),
    pagination: { page, limit, total: Number(countRows[0]?.total ?? 0) },
  };
}

/** Shop detail page (§12): profile, categories, branches and rating summary. */
async function getById(idOrSlug, user, position = null) {
  const numeric = Number.parseInt(idOrSlug, 10);
  const followParams = user ? [user.id] : [];
  const followSelect = user
    ? '(SELECT 1 FROM followed_shops fs WHERE fs.shop_id = s.id AND fs.user_id = ?) AS is_following'
    : '0 AS is_following';

  const row = await rawQuery(
    `SELECT s.*, ${CATEGORY_AGG} AS category_names,
            (SELECT COUNT(*) FROM followed_shops fs2 WHERE fs2.shop_id = s.id) AS follower_count,
            (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS active_offer_count,
            (SELECT b5.city FROM shop_branches b5 WHERE b5.shop_id = s.id AND b5.status = 'active'
              ORDER BY b5.is_primary DESC, b5.id LIMIT 1) AS city,
            ${followSelect}
       FROM shops s
      WHERE s.id = ? OR s.slug = ?
      LIMIT 1`,
    [...followParams, Number.isFinite(numeric) ? numeric : 0, String(idOrSlug)],
  ).then((rows) => rows[0]);

  if (!row) throw ApiError.notFound('Shop not found');

  // Staff of the shop (and Super Admins) see it even while it is deactivated.
  const canSeeInactive =
    Boolean(user) && (user.isSuperAdmin || user.shopIds.includes(Number(row.id)));
  if (row.status !== 'active' && !canSeeInactive) throw ApiError.notFound('Shop not found');

  const hasPosition = position?.latitude !== undefined && position?.longitude !== undefined;
  const branches = await rawQuery(
    `SELECT b.*,
            ${hasPosition ? `${geo.distanceKmSql('b.latitude', 'b.longitude')}` : 'NULL'} AS distance_km,
            (SELECT COUNT(*) FROM offers o
              WHERE o.status = 'active'
                AND ((o.applicability_type = 'shop_wide' AND o.shop_id = b.shop_id)
                  OR (o.applicability_type = 'selected_branches'
                      AND EXISTS (SELECT 1 FROM offer_locations ol
                                   WHERE ol.offer_id = o.id AND ol.branch_id = b.id)))) AS offer_count
       FROM shop_branches b
      WHERE b.shop_id = ? ${canSeeInactive ? '' : "AND b.status = 'active'"}
      ORDER BY ${hasPosition ? 'distance_km IS NULL, distance_km ASC,' : ''} b.is_primary DESC, b.id`,
    hasPosition ? [...geo.distanceKmParams(position.latitude, position.longitude), row.id] : [row.id],
  );

  const rating = await queryOne(
    `SELECT COUNT(*) AS count, ROUND(AVG(rating), 2) AS average
       FROM reviews WHERE shop_id = ? AND status = 'approved'`,
    [row.id],
  );

  const shop = mapShop(row);
  shop.branches = branches.map(mapBranch);
  shop.rating = { count: Number(rating.count), average: rating.average === null ? null : Number(rating.average) };

  // §17's completion panel is for whoever runs the shop. A customer looking at
  // the page has no use for "this shop has not uploaded a logo yet", and
  // `canPublish` on someone else's shop is nobody's business.
  if (canSeeInactive) {
    const primary = shop.branches.find((branch) => branch.isPrimary) ?? shop.branches[0] ?? null;
    shop.profile = shopProfile.summarise(shop, primary);
  }

  return shop;
}

function mapBranch(row) {
  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    branchName: row.branch_name,
    address: row.address,
    addressLine2: row.address_line_2 ?? null,
    area: row.area ?? null,
    city: row.city,
    state: row.state,
    country: row.country,
    pincode: row.pincode,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    locationSource: row.location_source ?? null,
    locationAccuracy:
      row.location_accuracy === null || row.location_accuracy === undefined
        ? null
        : Number(row.location_accuracy),
    locationConfirmedAt: row.location_confirmed_at ?? null,
    placeId: row.place_id ?? null,
    openingHours: parseJson(row.opening_hours),
    contactNumber: row.contact_number,
    isPrimary: Boolean(row.is_primary),
    status: row.status,
    offerCount: row.offer_count === undefined ? undefined : Number(row.offer_count),
    distanceKm:
      row.distance_km === null || row.distance_km === undefined
        ? null
        : Number(Number(row.distance_km).toFixed(2)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Coordinates for a branch about to be written, and where they came from.
 *
 * Whatever the caller supplied always wins - a merchant who dropped a precise
 * pin must not have it overwritten by a street-level guess. Only when they are
 * absent is the address geocoded, because §17's radius search and every
 * "near me" screen are dead weight without coordinates and almost nobody can
 * type a lat/long by hand.
 *
 * The lookup is deliberately outside the surrounding transaction: it is a
 * network call, and holding row locks open across one is how a slow third
 * party turns into a stalled database. A geocoder that is off, slow or has no
 * match simply leaves the branch without coordinates; it never fails the save.
 */
async function resolveBranchCoordinates(branch) {
  const latitude = branch.latitude ?? null;
  const longitude = branch.longitude ?? null;
  if (latitude !== null && longitude !== null) {
    return {
      latitude,
      longitude,
      // A client that placed the pin says so; anything else that arrives with
      // coordinates already attached was typed in by hand (§24).
      source: branch.locationSource ?? 'MANUAL',
      accuracy: branch.locationAccuracy ?? null,
      placeId: branch.placeId ?? null,
    };
  }

  const match = await geocoding.lookup(branch);
  if (!match) {
    return { latitude, longitude, source: null, accuracy: null, placeId: branch.placeId ?? null };
  }
  return {
    latitude: match.latitude,
    longitude: match.longitude,
    source: 'ADDRESS_SEARCH',
    accuracy: null,
    placeId: match.placeId ?? branch.placeId ?? null,
  };
}

/**
 * The columns a branch write touches, in one place.
 *
 * Three call sites write a branch - the first one folded into shop creation,
 * `createBranch`, and `updateBranch` - and §24 added six more columns to each.
 * Listing them once is what stops the next field from being remembered in two
 * places and forgotten in the third.
 */
const BRANCH_COLUMNS = [
  'branch_name',
  'address',
  'address_line_2',
  'area',
  'city',
  'state',
  'country',
  'pincode',
  'latitude',
  'longitude',
  'location_source',
  'location_accuracy',
  'location_confirmed_at',
  'place_id',
  'opening_hours',
  'contact_number',
  'is_primary',
  'status',
];

/**
 * Values for `BRANCH_COLUMNS`, in order.
 *
 * `branch` is the payload already merged over whatever is on the row, so this
 * never has to know whether it is serving a create or an update.
 *
 * The confirmation timestamp (§8) is the one field with a rule of its own: a
 * merchant confirms *a pin*, so moving the pin invalidates the confirmation
 * they gave for the old one.
 */
function branchValues(branch, coordinates, existing = null) {
  const moved =
    existing !== null &&
    (Number(existing.latitude) !== Number(coordinates.latitude) ||
      Number(existing.longitude) !== Number(coordinates.longitude));

  let confirmedAt = existing?.location_confirmed_at ?? null;
  if (branch.locationConfirmed && coordinates.latitude !== null) confirmedAt = new Date();
  else if (moved) confirmedAt = null;

  return [
    branch.branchName,
    branch.address ?? null,
    branch.addressLine2 ?? null,
    branch.area ?? null,
    branch.city,
    branch.state ?? null,
    branch.country ?? null,
    branch.pincode ?? null,
    coordinates.latitude,
    coordinates.longitude,
    coordinates.source,
    coordinates.accuracy,
    confirmedAt,
    coordinates.placeId,
    branch.openingHours ? JSON.stringify(branch.openingHours) : null,
    branch.contactNumber ?? null,
    branch.isPrimary ? 1 : 0,
    branch.status ?? 'active',
  ];
}

/**
 * A partial update laid over the row as it stands.
 *
 * `undefined` means "not sent" and keeps what is there; an explicit `null`
 * clears the column. Clearing both coordinates is therefore how a merchant
 * asks for them to be worked out from the address again, and a branch saved
 * before the map picker existed picks them up on its next save.
 */
function mergeBranch(payload, existing) {
  const keep = (value, current) => (value !== undefined ? value : current);
  return {
    branchName: payload.branchName ?? existing.branch_name,
    address: keep(payload.address, existing.address),
    addressLine2: keep(payload.addressLine2, existing.address_line_2),
    area: keep(payload.area, existing.area),
    city: payload.city ?? existing.city,
    state: keep(payload.state, existing.state),
    country: keep(payload.country, existing.country),
    pincode: keep(payload.pincode, existing.pincode),
    latitude: keep(payload.latitude, existing.latitude),
    longitude: keep(payload.longitude, existing.longitude),
    locationSource: keep(payload.locationSource, existing.location_source),
    locationAccuracy: keep(payload.locationAccuracy, existing.location_accuracy),
    placeId: keep(payload.placeId, existing.place_id),
    locationConfirmed: payload.locationConfirmed,
    openingHours: keep(payload.openingHours, parseJson(existing.opening_hours)),
    contactNumber: keep(payload.contactNumber, existing.contact_number),
    isPrimary: payload.isPrimary !== undefined ? payload.isPrimary : Boolean(existing.is_primary),
    status: payload.status ?? existing.status,
  };
}

const BRANCH_INSERT_SQL = `INSERT INTO shop_branches (shop_id, ${BRANCH_COLUMNS.join(', ')})
   VALUES (?, ${BRANCH_COLUMNS.map(() => '?').join(', ')})`;

const BRANCH_UPDATE_SQL = `UPDATE shop_branches
      SET ${BRANCH_COLUMNS.map((column) => `${column} = ?`).join(', ')}
    WHERE id = ? AND shop_id = ?`;

/**
 * The location a shop is published under (§9): its primary branch, falling
 * back to whichever branch exists when none has been marked primary.
 */
async function primaryBranchRow(shopId) {
  return queryOne(
    `SELECT * FROM shop_branches
      WHERE shop_id = ?
      ORDER BY is_primary DESC, status = 'active' DESC, id
      LIMIT 1`,
    [shopId],
  );
}

/**
 * V3 §18: a shop may not go live without the seven required fields, and §29 is
 * explicit that this applies to the Free plan too - location is not something
 * sold back to merchants.
 *
 * Only publishing is gated. Saving a half-finished shop as inactive is how a
 * merchant parks the work, so that path stays open.
 */
function assertPublishable(shop, branch) {
  const { canPublish, missingRequired } = shopProfile.summarise(shop, branch);
  if (canPublish) return;

  throw ApiError.unprocessable(
    `This shop cannot go live yet. Still needed: ${missingRequired.join(', ')}.`,
    missingRequired.map((label) => ({ field: 'primaryBranch', message: `${label} is required` })),
  );
}

/**
 * Creates a shop.
 *
 * `options` is how self-service onboarding reuses this rather than growing a
 * parallel insert that would drift from it (Self-Service Onboarding §3, §22):
 *
 *   registrationSource  which code path made the row. Defaults to
 *                       ADMIN_CREATED, so the existing admin flow records
 *                       itself correctly with no change at its call sites
 *                       (§15). Reporting only - nothing may branch on it for
 *                       authorization (§3).
 *   verificationStatus  DRAFT for a self-registration, null for admin-created,
 *                       because an admin creating a shop by hand *is* the
 *                       verification and §15 forbids making those pending.
 *   grantAdminTo        user id to make ADMIN of this shop, in the same
 *                       transaction. Self-service needs it: the seller has no
 *                       CREATE_SHOP permission and no membership until this
 *                       row exists, so creating the shop and granting access
 *                       have to succeed or fail together or a seller ends up
 *                       locked out of a shop only they were meant to manage.
 */
async function create(payload, user, options = {}) {
  const {
    registrationSource = 'ADMIN_CREATED',
    verificationStatus = null,
    grantAdminTo = null,
  } = options;

  const slug = await uniqueSlug('shops', payload.name);

  // A new shop always starts on Free, so its category allowance is known before
  // the row exists - which is the only reason this check can run up front.
  const freeCategories = PLANS.FREE.limits.categories;
  if ((payload.categoryIds?.length ?? 0) > freeCategories) {
    throw entitlements.upgradeRequired(
      `A new shop starts on the Free plan, which includes ${entitlements.allowanceText('categories', freeCategories)}. Upgrade the shop for more.`,
      minimumPlanForLimit('categories', payload.categoryIds.length),
      { limit: freeCategories, used: payload.categoryIds.length, limitKey: 'categories', currentPlan: 'FREE' },
    );
  }

  const primaryBranchCoordinates = payload.primaryBranch
    ? await resolveBranchCoordinates(payload.primaryBranch)
    : null;

  // §18: the publish gate runs before anything is written, so a shop that
  // cannot go live is never created half-way and then rejected. Saving it as
  // inactive stays open - that is how a merchant parks an unfinished profile.
  if ((payload.status ?? 'active') === 'active') {
    const draft = {
      name: payload.name,
      categories: (payload.categoryIds || []).map((id) => ({ id })),
      logoUrl: payload.logoUrl ?? null,
      description: payload.description ?? null,
      contactNumber: payload.contactNumber ?? null,
      websiteUrl: payload.websiteUrl ?? null,
      socialLinks: payload.socialLinks ?? null,
      openingHours: payload.openingHours ?? null,
    };
    assertPublishable(
      draft,
      payload.primaryBranch
        ? { ...payload.primaryBranch, ...primaryBranchCoordinates }
        : null,
    );
  }

  const acquisitionChannel = await resolveAcquisitionChannel(payload, user);

  const shopId = await transaction(async (connection) => {
    const [result] = await connection.execute(
      `INSERT INTO shops (name, slug, description, logo_url, cover_url, contact_number, email,
                          website_url, social_links, opening_hours, status, acquisition_channel,
                          registration_source, verification_status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.name,
        slug,
        payload.description ?? null,
        payload.logoUrl ?? null,
        payload.coverUrl ?? null,
        payload.contactNumber ?? null,
        payload.email || null,
        payload.websiteUrl || null,
        payload.socialLinks ? JSON.stringify(payload.socialLinks) : null,
        payload.openingHours ? JSON.stringify(payload.openingHours) : null,
        payload.status ?? 'active',
        acquisitionChannel,
        registrationSource,
        verificationStatus,
        user.id,
        user.id,
      ],
    );
    const newId = result.insertId;

    // §3: merchant access is granted by trusted backend logic and never from
    // anything the client sent. The role is looked up by name rather than
    // taken from the payload, so there is no request shape that turns this
    // into "make me a Super Admin of my own shop".
    if (grantAdminTo) {
      const [[adminRole]] = await connection.query(
        "SELECT id FROM roles WHERE name = 'ADMIN' AND scope = 'shop' LIMIT 1",
      );
      if (!adminRole) {
        throw new Error('The shop-scoped ADMIN role is missing; run the seed before self-registration.');
      }
      await connection.execute(
        `INSERT INTO shop_members (shop_id, user_id, role_id, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), status = 'active'`,
        [newId, grantAdminTo, adminRole.id],
      );
    }

    for (const categoryId of payload.categoryIds || []) {
      await connection.execute(
        'INSERT IGNORE INTO shop_categories (shop_id, category_id) VALUES (?, ?)',
        [newId, categoryId],
      );
    }

    // Every shop needs a subscription row; creating it here means no code path
    // ever has to cope with a shop that has none (§38).
    await connection.execute(
      `INSERT INTO shop_subscriptions (shop_id, plan, status, price_amount, payment_status)
       VALUES (?, 'FREE', 'active', 0.00, 'not_required')
       ON DUPLICATE KEY UPDATE shop_id = VALUES(shop_id)`,
      [newId],
    );

    if (payload.primaryBranch) {
      await connection.execute(BRANCH_INSERT_SQL, [
        newId,
        ...branchValues({ ...payload.primaryBranch, isPrimary: true }, primaryBranchCoordinates),
      ]);
    }

    return newId;
  });

  /**
   * The caller's access context was loaded when the request began, which was
   * before this shop existed - so `user.shopIds` does not contain it, and
   * `getById` would refuse to show an inactive shop to someone it believes is
   * not a member. The membership was written in the transaction above, so
   * adding the id here states something already true rather than granting
   * anything: it only affects this read-back, and the next request loads the
   * real context from the database.
   */
  const reader = grantAdminTo
    ? { ...user, shopIds: [...(user.shopIds ?? []), shopId] }
    : user;

  return getById(shopId, reader);
}

/**
 * V3 §3: category breadth is part of the plan (1 / 5 / unlimited).
 *
 * The check is against the *requested* set rather than an increment, so
 * replacing five categories with five others stays allowed while adding a sixth
 * does not. `assertWithinLimit` asks "would one more fit", so it is given
 * `count - 1`.
 */
async function assertCategoriesWithinPlan(shopId, categoryIds) {
  if (!categoryIds || categoryIds.length === 0) return;
  await entitlements.assertWithinLimit(shopId, 'categories', categoryIds.length - 1);
}

async function update(shopId, payload, user) {
  const existing = await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!existing) throw ApiError.notFound('Shop not found');

  if (payload.categoryIds !== undefined) {
    await assertCategoriesWithinPlan(shopId, payload.categoryIds);
  }

  const slug = payload.name && payload.name !== existing.name
    ? await uniqueSlug('shops', payload.name, shopId)
    : existing.slug;

  // `undefined` means "not sent"; an explicit null clears the column.
  const keep = (value, current) => (value !== undefined ? value : current);
  const socialLinks = keep(payload.socialLinks, parseJson(existing.social_links));
  const openingHours = keep(payload.openingHours, parseJson(existing.opening_hours));

  // §19: the location is edited from the shop profile, so the same request can
  // carry both. The branch it targets is the shop's primary one; a shop that
  // somehow has none gets one created, which is also how a shop that predates
  // §4's location requirement is brought up to date without a second screen.
  const branchRow = payload.primaryBranch ? await primaryBranchRow(shopId) : null;
  const mergedBranch = payload.primaryBranch
    ? branchRow
      ? mergeBranch(payload.primaryBranch, branchRow)
      : {
          ...payload.primaryBranch,
          branchName: payload.primaryBranch.branchName || payload.name || existing.name,
          isPrimary: true,
          status: payload.primaryBranch.status ?? 'active',
        }
    : null;

  if (mergedBranch && !mergedBranch.city) {
    throw ApiError.unprocessable('Validation failed', [
      { field: 'primaryBranch.city', message: 'City is required' },
    ]);
  }

  const coordinates = mergedBranch ? await resolveBranchCoordinates(mergedBranch) : null;

  // §18 again, this time against the shop as it will be once saved. Only the
  // published state is gated: deactivating an incomplete shop must stay
  // possible, or a merchant could neither fix it nor take it down.
  const nextStatus = payload.status ?? existing.status;

  // Self-Service Onboarding §11, §27.12: a shop still in review cannot be
  // switched on by its own merchant.
  //
  // This is the guard the whole feature rests on. A self-registered seller is
  // made ADMIN of their shop the moment they create it, and ADMIN carries
  // EDIT_SHOP - so without this line, PATCH /shops/:id {status:'active'} takes
  // an unreviewed draft straight into public discovery, because every public
  // query gates on `status` alone. Shops with a NULL verification_status are
  // untouched, which is every shop that existed before this feature (§15).
  if (nextStatus === 'active' && existing.status !== 'active') {
    shopVerification.assertMayActivate(existing.verification_status, user);
  }

  if (nextStatus === 'active') {
    const next = {
      name: payload.name ?? existing.name,
      categories:
        payload.categoryIds !== undefined
          ? payload.categoryIds.map((id) => ({ id }))
          : await query('SELECT category_id AS id FROM shop_categories WHERE shop_id = ?', [shopId]),
      logoUrl: keep(payload.logoUrl, existing.logo_url),
      description: keep(payload.description, existing.description),
      contactNumber: keep(payload.contactNumber, existing.contact_number),
      websiteUrl: keep(payload.websiteUrl, existing.website_url),
      socialLinks,
      openingHours,
    };
    const untouched = mergedBranch ? null : await primaryBranchRow(shopId);
    assertPublishable(
      next,
      mergedBranch ? { ...mergedBranch, ...coordinates } : untouched && mapBranch(untouched),
    );
  }

  const acquisitionChannel = await resolveAcquisitionChannel(
    payload,
    user,
    existing.acquisition_channel ?? null,
  );

  await transaction(async (connection) => {
    await connection.execute(
      `UPDATE shops SET name = ?, slug = ?, description = ?, logo_url = ?, cover_url = ?,
              contact_number = ?, email = ?, website_url = ?, social_links = ?, opening_hours = ?,
              status = ?, acquisition_channel = ?, updated_by = ?
        WHERE id = ?`,
      [
        payload.name ?? existing.name,
        slug,
        keep(payload.description, existing.description),
        keep(payload.logoUrl, existing.logo_url),
        keep(payload.coverUrl, existing.cover_url),
        keep(payload.contactNumber, existing.contact_number),
        payload.email !== undefined ? payload.email || null : existing.email,
        payload.websiteUrl !== undefined ? payload.websiteUrl || null : existing.website_url,
        socialLinks ? JSON.stringify(socialLinks) : null,
        openingHours ? JSON.stringify(openingHours) : null,
        nextStatus,
        acquisitionChannel,
        user.id,
        shopId,
      ],
    );

    if (mergedBranch) {
      if (branchRow) {
        await connection.execute(BRANCH_UPDATE_SQL, [
          ...branchValues(mergedBranch, coordinates, branchRow),
          branchRow.id,
          shopId,
        ]);
      } else {
        await connection.execute(BRANCH_INSERT_SQL, [
          shopId,
          ...branchValues(mergedBranch, coordinates),
        ]);
      }
    }

    if (payload.categoryIds !== undefined) {
      await connection.execute('DELETE FROM shop_categories WHERE shop_id = ?', [shopId]);
      for (const categoryId of payload.categoryIds) {
        await connection.execute(
          'INSERT IGNORE INTO shop_categories (shop_id, category_id) VALUES (?, ?)',
          [shopId, categoryId],
        );
      }
    }
  });

  return getById(shopId, user);
}

async function remove(shopId) {
  const offers = await queryOne('SELECT COUNT(*) AS count FROM offers WHERE shop_id = ?', [shopId]);
  if (Number(offers.count) > 0) {
    throw ApiError.conflict(
      'This shop still has offers. Deactivate the shop instead, or remove its offers first.',
    );
  }
  await execute('DELETE FROM shops WHERE id = ?', [shopId]);
}

// ---------------------------------------------------------------------------
// Branches (§17)
// ---------------------------------------------------------------------------

async function listBranches(shopId, { includeInactive = false } = {}) {
  const rows = await query(
    `SELECT b.*,
            (SELECT COUNT(*) FROM offers o
              WHERE o.status = 'active'
                AND ((o.applicability_type = 'shop_wide' AND o.shop_id = b.shop_id)
                  OR (o.applicability_type = 'selected_branches'
                      AND EXISTS (SELECT 1 FROM offer_locations ol
                                   WHERE ol.offer_id = o.id AND ol.branch_id = b.id)))) AS offer_count
       FROM shop_branches b
      WHERE b.shop_id = ? ${includeInactive ? '' : "AND b.status = 'active'"}
      ORDER BY b.is_primary DESC, b.branch_name`,
    [shopId],
  );
  return rows.map(mapBranch);
}

async function createBranch(shopId, payload) {
  // V3 §3: Free is a single location, Business up to two, Premium unlimited.
  // Only active branches count, so deactivating one frees the slot back up.
  await entitlements.assertUsageWithinLimit(shopId, 'branches', 'branches');

  const coordinates = await resolveBranchCoordinates(payload);

  const branchId = await transaction(async (connection) => {
    if (payload.isPrimary) {
      await connection.execute('UPDATE shop_branches SET is_primary = 0 WHERE shop_id = ?', [shopId]);
    }
    const [result] = await connection.execute(BRANCH_INSERT_SQL, [
      shopId,
      ...branchValues(payload, coordinates),
    ]);
    return result.insertId;
  });

  return queryOne('SELECT * FROM shop_branches WHERE id = ?', [branchId]).then(mapBranch);
}

async function updateBranch(shopId, branchId, payload) {
  const existing = await queryOne('SELECT * FROM shop_branches WHERE id = ? AND shop_id = ?', [
    branchId,
    shopId,
  ]);
  if (!existing) throw ApiError.notFound('Branch not found for this shop');

  // The update is partial, so the address is geocoded as it will be *after* the
  // merge rather than as it arrived. Clearing the coordinate fields is how a
  // merchant asks for them to be worked out again, and a branch saved before
  // this existed picks them up on its next save.
  const merged = mergeBranch(payload, existing);
  const coordinates = await resolveBranchCoordinates(merged);

  await transaction(async (connection) => {
    if (payload.isPrimary) {
      await connection.execute('UPDATE shop_branches SET is_primary = 0 WHERE shop_id = ?', [shopId]);
    }
    await connection.execute(BRANCH_UPDATE_SQL, [
      ...branchValues(merged, coordinates, existing),
      branchId,
      shopId,
    ]);
  });

  return queryOne('SELECT * FROM shop_branches WHERE id = ?', [branchId]).then(mapBranch);
}

/** Branches are deactivated rather than deleted so historic offers stay intact. */
async function deactivateBranch(shopId, branchId) {
  const result = await execute(
    "UPDATE shop_branches SET status = 'inactive' WHERE id = ? AND shop_id = ?",
    [branchId, shopId],
  );
  if (!result.affectedRows) throw ApiError.notFound('Branch not found for this shop');
}

// ---------------------------------------------------------------------------
// Members (§18)
// ---------------------------------------------------------------------------

async function listMembers(shopId) {
  const rows = await query(
    `SELECT sm.*, u.name, u.email, u.phone, u.status AS user_status,
            r.name AS role_name, b.branch_name
       FROM shop_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN roles r ON r.id = sm.role_id
       LEFT JOIN shop_branches b ON b.id = sm.branch_id
      WHERE sm.shop_id = ?
      ORDER BY u.name`,
    [shopId],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    shopId: Number(row.shop_id),
    userId: Number(row.user_id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    userStatus: row.user_status,
    branchId: row.branch_id === null ? null : Number(row.branch_id),
    branchName: row.branch_name,
    roleId: row.role_id === null ? null : Number(row.role_id),
    roleName: row.role_name,
    designation: row.designation,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/**
 * Adds a member. If the email does not belong to an account yet, a customer
 * account is created and the person receives a password-setup link, which is
 * how a new shop Admin is onboarded (§44 steps 3-5).
 */
async function addMember(shopId, payload) {
  let userId = payload.userId;
  let createdUser = null;

  if (!userId) {
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [payload.email]);
    if (existing) {
      userId = Number(existing.id);
    } else {
      if (!payload.name) throw ApiError.badRequest('A name is required to invite a new member');
      // Random placeholder hash: the invite link is the only way in.
      const placeholder = await passwordUtil.hash(tokens.randomToken(24));
      const result = await execute(
        'INSERT INTO users (name, email, password_hash, phone) VALUES (?, ?, ?, ?)',
        [payload.name, payload.email, placeholder, payload.phone ?? null],
      );
      userId = result.insertId;
      await execute(
        "INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'CUSTOMER'",
        [userId],
      );
      await execute('INSERT INTO notification_preferences (user_id) VALUES (?)', [userId]);
      createdUser = { id: userId, name: payload.name, email: payload.email };
    }
  }

  const duplicate = await queryOne('SELECT id FROM shop_members WHERE shop_id = ? AND user_id = ?', [
    shopId,
    userId,
  ]);
  if (duplicate) throw ApiError.conflict('This user is already a member of the shop');

  if (payload.branchId) {
    const branch = await queryOne('SELECT id FROM shop_branches WHERE id = ? AND shop_id = ?', [
      payload.branchId,
      shopId,
    ]);
    if (!branch) throw ApiError.badRequest('That branch does not belong to this shop');
  }

  const result = await execute(
    `INSERT INTO shop_members (shop_id, branch_id, user_id, role_id, designation, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      shopId,
      payload.branchId ?? null,
      userId,
      payload.roleId ?? null,
      payload.designation ?? null,
      payload.status ?? 'active',
    ],
  );

  if (createdUser) {
    const token = tokens.randomToken();
    await execute(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES (?, 'password_reset', ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [userId, tokens.hashToken(token)],
    );
    const url = `${env.appUrl}/auth/reset-password?token=${token}`;
    await mailer.send({ to: createdUser.email, ...mailer.templates.resetPassword(createdUser.name, url) });
  }

  const members = await listMembers(shopId);
  return members.find((member) => member.id === result.insertId);
}

async function updateMember(shopId, memberId, payload) {
  const existing = await queryOne('SELECT * FROM shop_members WHERE id = ? AND shop_id = ?', [
    memberId,
    shopId,
  ]);
  if (!existing) throw ApiError.notFound('Member not found for this shop');

  if (payload.branchId) {
    const branch = await queryOne('SELECT id FROM shop_branches WHERE id = ? AND shop_id = ?', [
      payload.branchId,
      shopId,
    ]);
    if (!branch) throw ApiError.badRequest('That branch does not belong to this shop');
  }

  await execute(
    `UPDATE shop_members SET branch_id = ?, role_id = ?, designation = ?, status = ?
      WHERE id = ? AND shop_id = ?`,
    [
      payload.branchId !== undefined ? payload.branchId : existing.branch_id,
      payload.roleId !== undefined ? payload.roleId : existing.role_id,
      payload.designation !== undefined ? payload.designation : existing.designation,
      payload.status ?? existing.status,
      memberId,
      shopId,
    ],
  );

  const members = await listMembers(shopId);
  return members.find((member) => member.id === Number(memberId));
}

async function removeMember(shopId, memberId) {
  const result = await execute('DELETE FROM shop_members WHERE id = ? AND shop_id = ?', [
    memberId,
    shopId,
  ]);
  if (!result.affectedRows) throw ApiError.notFound('Member not found for this shop');
}

module.exports = {
  assertCategoriesWithinPlan,
  list,
  getById,
  create,
  update,
  remove,
  listBranches,
  createBranch,
  updateBranch,
  deactivateBranch,
  listMembers,
  addMember,
  updateMember,
  removeMember,
  mapShop,
  mapBranch,
};
