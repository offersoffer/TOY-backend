'use strict';

const { query, queryOne, execute } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const shopService = require('../shops/shop.service');
const shopVerification = require('../../services/shopVerification');
const notifications = require('../../services/notifications');
const logger = require('../../utils/logger');

/**
 * Self-service seller onboarding (§4-§12, §16).
 *
 * This module owns the *registration*: the lifecycle, what may be edited at
 * each point, and what has to be true before a seller may submit. It owns no
 * shop writing of its own - every change to the shop or its branch goes
 * through `shop.service`, so a rule added there (plan limits, the publish
 * gate, how a moved pin resets confirmation) applies to sellers for free
 * rather than needing to be remembered twice (§22).
 */

/** Which states a seller may still edit their own registration in (§12). */
const EDITABLE = new Set([
  shopVerification.DRAFT,
  shopVerification.ADDITIONAL_INFO_REQUIRED,
  shopVerification.REJECTED,
]);

/** Which states a seller may submit from (§11, §12). */
const SUBMITTABLE = new Set([
  shopVerification.DRAFT,
  shopVerification.ADDITIONAL_INFO_REQUIRED,
  shopVerification.REJECTED,
]);

/**
 * Loads a registration the caller is allowed to touch.
 *
 * Two separate checks, because they fail for different reasons and a seller
 * deserves to know which. Membership answers "is this yours" (§19's IDOR
 * protection); the NULL check answers "is this a registration at all" - an
 * admin-created shop has no lifecycle, and letting the wizard drive one would
 * be how an existing shop accidentally becomes pending, which §15 forbids.
 */
async function loadOwnedRegistration(shopId, user) {
  const shop = await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw ApiError.notFound('Registration not found');

  const isMember = await queryOne(
    `SELECT 1 FROM shop_members
      WHERE shop_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    [shopId, user.id],
  );
  // Super Admin can read anyone's registration; §14 needs that for review.
  if (!isMember && !user.isSuperAdmin) {
    // Deliberately "not found" rather than "forbidden": a seller probing ids
    // should not be able to tell an existing shop from a missing one.
    throw ApiError.notFound('Registration not found');
  }

  if (shop.verification_status === null) {
    throw ApiError.conflict(
      'This shop was set up by the OffersOffer team and is not a self-service registration.',
    );
  }

  return shop;
}

/** The shape every seller-facing endpoint returns, so the wizard has one contract. */
async function present(shop) {
  const branch = await queryOne(
    `SELECT * FROM shop_branches
      WHERE shop_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1`,
    [shop.id],
  );
  const categories = await query(
    'SELECT category_id AS id FROM shop_categories WHERE shop_id = ?',
    [shop.id],
  );

  return {
    shopId: Number(shop.id),
    slug: shop.slug,
    name: shop.name,
    description: shop.description,
    contactNumber: shop.contact_number,
    email: shop.email,
    websiteUrl: shop.website_url,
    logoUrl: shop.logo_url,
    categoryIds: categories.map((row) => Number(row.id)),
    registrationSource: shop.registration_source,
    verificationStatus: shop.verification_status,
    submittedAt: shop.verification_submitted_at,
    decidedAt: shop.verification_decided_at,
    // The seller reads this verbatim when they are asked for more (§12).
    decisionReason: shop.verification_reason,
    // §11: what they may and may not do right now, decided by the backend so
    // the clients never have to work it out and never disagree with it.
    canEdit: EDITABLE.has(shop.verification_status),
    canSubmit: SUBMITTABLE.has(shop.verification_status),
    isPublic: shop.status === 'active' && shop.verification_status === shopVerification.VERIFIED,
    address: branch
      ? {
          branchId: Number(branch.id),
          address: branch.address,
          addressLine2: branch.address_line_2,
          area: branch.area,
          city: branch.city,
          state: branch.state,
          country: branch.country,
          pincode: branch.pincode,
          latitude: branch.latitude === null ? null : Number(branch.latitude),
          longitude: branch.longitude === null ? null : Number(branch.longitude),
          locationSource: branch.location_source,
          // §7's three UI states, resolved here rather than inferred by each
          // client: a pin with no confirmation must never render as confirmed.
          locationState: branch.location_confirmed_at
            ? 'CONFIRMED'
            : branch.latitude !== null
              ? 'PIN_SELECTED_NOT_CONFIRMED'
              : 'NOT_SELECTED',
          locationConfirmedAt: branch.location_confirmed_at,
        }
      : null,
  };
}

/** Maps the wizard's address step onto the branch payload shop.service expects. */
function branchPayloadFrom(address, shopName) {
  if (!address) return undefined;
  return {
    branchName: shopName,
    address: address.address,
    addressLine2: address.addressLine2,
    area: address.area,
    city: address.city,
    state: address.state,
    country: address.country ?? 'India',
    pincode: address.pincode,
    latitude: address.latitude,
    longitude: address.longitude,
    locationSource: address.locationSource,
    locationAccuracy: address.locationAccuracy,
    locationConfirmed: address.locationConfirmed,
    isPrimary: true,
    status: 'active',
  };
}

/**
 * Starts a registration (§4).
 *
 * The shop is created immediately rather than held in a draft table. §22 asks
 * us to reuse existing tables, and the alternative - a parallel draft of shop
 * fields as JSON - would need its own copy of every validation rule and its
 * own map-confirmation handling, then a translation step at submit where the
 * two could disagree. A DRAFT row is inert: `status` is inactive, so every
 * public query already excludes it (§11).
 */
async function start(payload, user) {
  const existing = await queryOne(
    `SELECT s.id FROM shops s
       JOIN shop_members sm ON sm.shop_id = s.id AND sm.user_id = ? AND sm.status = 'active'
      WHERE s.verification_status IN ('DRAFT','PENDING_VERIFICATION','ADDITIONAL_INFO_REQUIRED')
      LIMIT 1`,
    [user.id],
  );
  if (existing) {
    // §24's "repeated submission": a double-tap on Register must resume the
    // registration in flight, not start a second one beside it.
    throw ApiError.conflict(
      'You already have a registration in progress. Continue that one, or finish it before starting another.',
      { shopId: Number(existing.id) },
    );
  }

  const shop = await shopService.create(
    {
      name: payload.name,
      description: payload.description,
      contactNumber: payload.contactNumber,
      email: payload.email || null,
      websiteUrl: payload.websiteUrl || null,
      logoUrl: payload.logoUrl ?? null,
      socialLinks: payload.socialLinks ?? null,
      categoryIds: payload.categoryIds,
      // Never 'active'. A registration that has not been reviewed is not live,
      // and starting it inactive means the publish gate and every public query
      // already behave correctly without knowing this feature exists (§11).
      status: 'inactive',
      primaryBranch: branchPayloadFrom(payload.address, payload.name),
    },
    user,
    {
      registrationSource: 'SELF_REGISTERED',
      verificationStatus: shopVerification.DRAFT,
      grantAdminTo: user.id,
    },
  );

  logger.info(
    { event: 'SELLER_REGISTRATION_STARTED', shop_id: shop.id, user_id: user.id },
    'Seller started a shop registration',
  );

  const row = await queryOne('SELECT * FROM shops WHERE id = ?', [shop.id]);
  return present(row);
}

/** Resumes whatever the seller has in flight (§4, §27.10). */
async function mine(user) {
  const rows = await query(
    `SELECT s.* FROM shops s
       JOIN shop_members sm ON sm.shop_id = s.id AND sm.user_id = ? AND sm.status = 'active'
      WHERE s.verification_status IS NOT NULL
      ORDER BY s.created_at DESC`,
    [user.id],
  );
  return Promise.all(rows.map(present));
}

async function get(shopId, user) {
  return present(await loadOwnedRegistration(shopId, user));
}

/** Saves a wizard step (§4: progress survives leaving). */
async function update(shopId, payload, user) {
  const shop = await loadOwnedRegistration(shopId, user);

  if (!EDITABLE.has(shop.verification_status)) {
    throw ApiError.conflict(
      shop.verification_status === shopVerification.PENDING_VERIFICATION
        ? 'This registration is being reviewed. You will be able to make changes if we ask for more information.'
        : 'This registration can no longer be edited.',
    );
  }

  await shopService.update(
    shopId,
    {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.contactNumber !== undefined ? { contactNumber: payload.contactNumber } : {}),
      ...(payload.email !== undefined ? { email: payload.email || null } : {}),
      ...(payload.websiteUrl !== undefined ? { websiteUrl: payload.websiteUrl || null } : {}),
      ...(payload.logoUrl !== undefined ? { logoUrl: payload.logoUrl } : {}),
      ...(payload.socialLinks !== undefined ? { socialLinks: payload.socialLinks } : {}),
      ...(payload.categoryIds !== undefined ? { categoryIds: payload.categoryIds } : {}),
      ...(payload.address
        ? { primaryBranch: branchPayloadFrom(payload.address, payload.name ?? shop.name) }
        : {}),
      // Deliberately absent: `status`. A seller editing their draft must not
      // be able to send one, and leaving it out means the activation guard in
      // shop.service is never even reached from this path.
    },
    user,
  );

  return present(await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]));
}

/**
 * Submits for review (§10).
 *
 * Everything is re-checked here regardless of what the wizard allowed,
 * because the wizard is a convenience and this is the gate (§10, §19).
 */
async function submit(shopId, user) {
  const shop = await loadOwnedRegistration(shopId, user);

  // §10's "safe against duplicate requests": a second submit of something
  // already pending is the same answer, not a conflict. A seller whose
  // connection dropped mid-request retries, and should see success.
  if (shop.verification_status === shopVerification.PENDING_VERIFICATION) {
    return present(shop);
  }

  if (!SUBMITTABLE.has(shop.verification_status)) {
    throw ApiError.conflict('This registration cannot be submitted from its current state.');
  }

  const branch = await queryOne(
    `SELECT * FROM shop_branches WHERE shop_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1`,
    [shopId],
  );

  const missing = [];
  if (!shop.name) missing.push('Shop name');
  if (!shop.description) missing.push('Shop description');
  if (!shop.contact_number) missing.push('Shop contact number');

  const categories = await query('SELECT 1 FROM shop_categories WHERE shop_id = ?', [shopId]);
  if (!categories.length) missing.push('Business category');

  if (!branch) missing.push('Shop address');
  else {
    if (!branch.address) missing.push('Street address');
    if (!branch.city) missing.push('City');
    if (!branch.state) missing.push('State');
    if (!branch.pincode) missing.push('Pincode');
  }

  if (missing.length) {
    throw ApiError.unprocessable(
      `Finish these before submitting: ${missing.join(', ')}.`,
      missing.map((label) => ({ field: label, message: `${label} is required` })),
    );
  }

  /**
   * §7, and the rule the whole address step exists for.
   *
   * Both halves are required: a confirmation timestamp with no coordinates
   * means something marked the pin confirmed without the provider ever
   * returning one, which §7 explicitly says must not be treated as confirmed.
   * Checking only the flag would let a client fake the whole step.
   */
  const hasCoordinates = branch.latitude !== null && branch.longitude !== null;
  if (!branch.location_confirmed_at || !hasCoordinates) {
    throw ApiError.unprocessable(
      'Confirm your shop location on the map before submitting. Search for your address or drag the pin, then press Confirm Shop Location.',
      [{ field: 'address.locationConfirmed', message: 'Map location must be confirmed' }],
    );
  }

  shopVerification.assertTransition(
    shop.verification_status,
    shopVerification.PENDING_VERIFICATION,
    user,
  );

  await execute(
    `UPDATE shops
        SET verification_status = 'PENDING_VERIFICATION',
            verification_submitted_at = NOW(),
            -- A resubmission is a fresh decision; the previous reviewer and
            -- their reason belong to the round that has just been answered.
            verification_decided_at = NULL,
            verification_reviewer_id = NULL,
            verification_reason = NULL,
            updated_by = ?
      WHERE id = ? AND verification_status = ?`,
    [user.id, shopId, shop.verification_status],
  );

  const saved = await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]);

  // §18. Never fatal: a notification that does not send must not undo a
  // submission the seller has been told succeeded.
  try {
    await notifications.notifyShopTeam(shopId, {
      type: 'SELLER_REGISTRATION_SUBMITTED',
      title: 'Registration submitted',
      message: `${saved.name} has been submitted for verification. We will let you know when the review is complete.`,
      entityType: 'shop',
      entityId: shopId,
    });
  } catch (error) {
    logger.warn(
      { event: 'ONBOARDING_NOTIFY_FAILED', shop_id: shopId },
      'Registration submitted but the seller could not be notified',
    );
  }

  logger.info(
    { event: 'SELLER_REGISTRATION_SUBMITTED', shop_id: shopId, user_id: user.id },
    'Seller submitted a shop registration',
  );

  return present(saved);
}

module.exports = { start, mine, get, update, submit, present, loadOwnedRegistration, EDITABLE, SUBMITTABLE };
