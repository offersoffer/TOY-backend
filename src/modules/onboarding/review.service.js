'use strict';

const { query, queryOne, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const shopVerification = require('../../services/shopVerification');
const notifications = require('../../services/notifications');
const logger = require('../../utils/logger');
const { limitOffset } = require('../../utils/pagination');
const onboarding = require('./onboarding.service');

/**
 * Reviewing seller registrations (Self-Service Onboarding §14).
 *
 * The reviewer's half of onboarding: the queue, the detail a decision is made
 * from, and the decisions themselves. Authorization is the router's job
 * (`REVIEW_SELLER_REGISTRATIONS`, globally) and the lifecycle rules are
 * `shopVerification`'s; what lives here is the part neither can own - making
 * each decision happen exactly once, in one transaction, with the shop's
 * public status moved to match.
 *
 * Kept apart from `onboarding.service` deliberately. That module's entire
 * premise is that the caller owns the registration, and every query in it is
 * written around `shop_members`. This one's premise is the opposite: the
 * caller owns nothing and may see everything. Two files make that impossible
 * to confuse; one file would mean every function needing a comment about
 * which kind of caller it was written for.
 */

/** The decisions a reviewer can make, and what each one means for the shop. */
const DECISIONS = {
  [shopVerification.VERIFIED]: {
    action: 'SELLER_REGISTRATION_VERIFIED',
    notification: 'SELLER_REGISTRATION_VERIFIED',
    title: 'Your shop has been verified',
    message: (shop) => `${shop.name} passed verification.`,
  },
  [shopVerification.REJECTED]: {
    action: 'SELLER_REGISTRATION_REJECTED',
    notification: 'SELLER_REGISTRATION_REJECTED',
    title: 'Your registration was not approved',
    // §18: the reason is written for the seller and §12 requires them to see
    // it, so it travels with the notification rather than being hidden
    // behind a dashboard visit.
    message: (shop, reason) => `${shop.name}: ${reason}`,
  },
  [shopVerification.ADDITIONAL_INFO_REQUIRED]: {
    action: 'SELLER_REGISTRATION_INFO_REQUESTED',
    notification: 'SELLER_REGISTRATION_INFO_REQUESTED',
    title: 'We need a little more information',
    message: (shop, reason) => `${shop.name}: ${reason}`,
  },
  [shopVerification.SUSPENDED]: {
    action: 'SELLER_REGISTRATION_SUSPENDED',
    notification: 'SELLER_REGISTRATION_SUSPENDED',
    title: 'This shop has been suspended',
    message: (shop, reason) => `${shop.name}: ${reason}`,
  },
};

/**
 * Whether a decision takes the shop off the public marketplace, puts it on,
 * or leaves its listing alone.
 *
 * Suspension is the one that would be a security bug if it were forgotten.
 * `assertMayActivate` only fires on a transition *into* active, so a shop
 * that is already live stays live however its verification status changes -
 * suspending without this would move a label and leave the shop in search
 * results, which §11 explicitly forbids.
 */
const LISTING_EFFECT = {
  [shopVerification.REJECTED]: 'inactive',
  [shopVerification.SUSPENDED]: 'inactive',
  // Approval's effect is the reviewer's choice (§11 keeps verified and active
  // apart), so it is not decided here.
};

const REGISTRATION_STATUSES = shopVerification.STATUSES;

/**
 * One row of the queue (§14's list columns).
 *
 * The owner is the shop's longest-standing active member, which for a
 * self-registration is the seller who created it - `shop_members.created_at`
 * rather than a role name, because the role a seller holds is ADMIN, the same
 * as any staff member added later.
 */
function presentRow(row) {
  return {
    shopId: Number(row.id),
    name: row.name,
    slug: row.slug,
    contactNumber: row.contact_number,
    city: row.city,
    pincode: row.pincode,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    // §14 wants a map preview in the list; coordinates are what a thumbnail
    // needs and they are already loaded, so no second request per row.
    locationConfirmed: Boolean(row.location_confirmed_at),
    categories: row.categories ? row.categories.split('||') : [],
    owner: row.owner_name ? { id: Number(row.owner_id), name: row.owner_name, email: row.owner_email } : null,
    registrationSource: row.registration_source,
    verificationStatus: row.verification_status,
    status: row.status,
    submittedAt: row.verification_submitted_at,
    decidedAt: row.verification_decided_at,
    reviewer: row.reviewer_name ? { id: Number(row.verification_reviewer_id), name: row.reviewer_name } : null,
    createdAt: row.created_at,
  };
}

/**
 * The review queue (§14).
 *
 * Shops that never entered review are excluded unless they are asked for by
 * name through `source`. §15 is explicit that an admin-created shop must not
 * be treated as pending, and the surest way to honour that is for the queue
 * not to contain them.
 */
async function list(params) {
  const { page, limit, offset } = limitOffset(params);
  const where = [];
  const values = [];

  if (params.source) {
    where.push('s.registration_source = ?');
    values.push(params.source);
    if (params.source === 'ADMIN_CREATED') {
      // Admin-created shops have no verification status at all; asking for
      // them means asking for exactly those rows.
      where.push('s.verification_status IS NULL');
    }
  } else {
    where.push('s.verification_status IS NOT NULL');
  }

  if (params.status) {
    where.push('s.verification_status = ?');
    values.push(params.status);
  }

  // §14 lists "Active" as a filter alongside the verification states, but it
  // is the listing status, not a verification one - a verified shop can be
  // switched off and is still verified. Kept as its own filter so the two
  // cannot be conflated (§11).
  if (params.listingStatus) {
    where.push('s.status = ?');
    values.push(params.listingStatus);
  }

  if (params.city) {
    where.push('b.city = ?');
    values.push(params.city);
  }
  if (params.pincode) {
    where.push('b.pincode = ?');
    values.push(params.pincode);
  }
  if (params.q) {
    where.push('(s.name LIKE ? OR s.contact_number LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
    const like = `%${params.q}%`;
    values.push(like, like, like, like);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  /*
    The owner is picked by a correlated subquery rather than a join so the
    row count stays one per shop: a shop with three staff would otherwise
    appear three times and break the pagination total.
  */
  const ownerSubquery = `(SELECT sm.user_id FROM shop_members sm
                           WHERE sm.shop_id = s.id AND sm.status = 'active'
                           ORDER BY sm.created_at ASC, sm.id ASC LIMIT 1)`;

  /*
    Every join lives here, before the WHERE clause, because this fragment is
    reused verbatim by the COUNT query - a join added after `${clause}` at the
    call site would be a join after WHERE, which is a syntax error.
  */
  const from = `
      FROM shops s
      LEFT JOIN shop_branches b
             ON b.id = (SELECT b2.id FROM shop_branches b2
                         WHERE b2.shop_id = s.id
                         ORDER BY b2.is_primary DESC, b2.id ASC LIMIT 1)
      LEFT JOIN users u ON u.id = ${ownerSubquery}
      LEFT JOIN users rv ON rv.id = s.verification_reviewer_id
      ${clause}`;

  const total = await queryOne(`SELECT COUNT(*) AS count ${from}`, values);

  const rows = await query(
    `SELECT s.id, s.name, s.slug, s.contact_number, s.status, s.registration_source,
            s.verification_status, s.verification_submitted_at, s.verification_decided_at,
            s.verification_reviewer_id, s.created_at,
            b.city, b.pincode, b.latitude, b.longitude, b.location_confirmed_at,
            u.id AS owner_id, u.name AS owner_name, u.email AS owner_email,
            rv.name AS reviewer_name,
            (SELECT GROUP_CONCAT(c.name SEPARATOR '||')
               FROM shop_categories sc JOIN categories c ON c.id = sc.category_id
              WHERE sc.shop_id = s.id) AS categories
       ${from}
      ORDER BY
        -- Oldest waiting first: a queue sorted newest-first quietly starves
        -- whoever has been waiting longest, which is the one thing §25's
        -- "pending verification age" metric exists to catch.
        (s.verification_status = 'PENDING_VERIFICATION') DESC,
        s.verification_submitted_at ASC,
        s.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    values,
  );

  return {
    items: rows.map(presentRow),
    pagination: { page, limit, total: Number(total.count) },
  };
}

/**
 * Everything a decision is made from (§14).
 *
 * Reuses the seller's own `present()` for the registration body so the
 * reviewer is looking at the same facts the seller is, then adds what only a
 * reviewer may see: who owns it, and the history of previous rounds.
 */
async function detail(shopId) {
  const shop = await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw ApiError.notFound('Registration not found');
  if (shop.verification_status === null) {
    throw ApiError.conflict(
      'This shop was created by the OffersOffer team and has no registration to review.',
    );
  }

  const [registration, members, history] = await Promise.all([
    onboarding.present(shop),
    query(
      `SELECT u.id, u.name, u.email, u.phone, sm.designation, sm.created_at AS joinedAt
         FROM shop_members sm JOIN users u ON u.id = sm.user_id
        WHERE sm.shop_id = ? AND sm.status = 'active'
        ORDER BY sm.created_at ASC, sm.id ASC`,
      [shopId],
    ),
    reviewHistory(shopId),
  ]);

  const reviewer = shop.verification_reviewer_id
    ? await queryOne('SELECT id, name, email FROM users WHERE id = ?', [shop.verification_reviewer_id])
    : null;

  return {
    ...registration,
    listingStatus: shop.status,
    owner: members[0] ?? null,
    members,
    reviewer: reviewer ? { id: Number(reviewer.id), name: reviewer.name, email: reviewer.email } : null,
    history,
  };
}

/**
 * Previous rounds on this registration (§14, §25).
 *
 * Read from `audit_logs` rather than a table of its own: §22 asks us to reuse
 * existing tables and §25 asks for an audit trail of exactly these events, so
 * a second history table would be the same rows written twice and two places
 * to forget to write to.
 */
async function reviewHistory(shopId) {
  const rows = await query(
    `SELECT a.id, a.action, a.new_value, a.created_at, u.id AS actor_id, u.name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'shop_registration' AND a.entity_id = ?
      ORDER BY a.created_at ASC, a.id ASC`,
    [shopId],
  );

  return rows.map((row) => {
    const value = typeof row.new_value === 'string' ? safeParse(row.new_value) : (row.new_value ?? {});
    return {
      id: Number(row.id),
      action: row.action,
      to: value.verificationStatus ?? null,
      reason: value.reason ?? null,
      at: row.created_at,
      by: row.actor_name ? { id: Number(row.actor_id), name: row.actor_name } : null,
    };
  });
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Records one decision (§14).
 *
 * Everything that must agree - the verification status, the shop's public
 * listing, who decided and why - moves in a single transaction, and the
 * UPDATE is conditional on the status the reviewer was looking at. Two
 * reviewers opening the same registration and both pressing Approve is not a
 * hypothetical on a shared queue; without the condition the second write
 * would silently overwrite the first, and the seller would be notified twice
 * about a decision made once.
 *
 * @returns {{registration: object, previous: {verificationStatus: string, status: string}}}
 */
async function decide(shopId, to, { reason = null, activate } = {}, user) {
  const shop = await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw ApiError.notFound('Registration not found');

  if (shop.verification_status === null) {
    // §15: an admin-created shop never entered review, and pushing one into
    // the lifecycle is how an existing live shop would become pending.
    throw ApiError.conflict(
      'This shop was created by the OffersOffer team and has no registration to decide.',
    );
  }

  // Both throw: the first if this reviewer may not make this kind of
  // decision, the second if the move itself is not legal from here.
  shopVerification.assertReason(to, reason);
  shopVerification.assertTransition(shop.verification_status, to, user);

  const previous = { verificationStatus: shop.verification_status, status: shop.status };

  /**
   * What the decision does to the shop's public listing.
   *
   * Approval is the only one the reviewer chooses, because §11 keeps
   * "verified" and "active" apart. The default is to switch it on: a shop
   * approved and left invisible is the state sellers write in about, and a
   * reviewer who wants to stage the launch can pass activate: false.
   */
  let nextStatus = LISTING_EFFECT[to] ?? null;
  if (to === shopVerification.VERIFIED) nextStatus = activate === false ? null : 'active';

  const changed = await transaction(async (connection) => {
    const [result] = await connection.query(
      `UPDATE shops
          SET verification_status = ?,
              verification_reason = ?,
              verification_reviewer_id = ?,
              verification_decided_at = NOW(),
              ${nextStatus ? 'status = ?,' : ''}
              updated_by = ?
        WHERE id = ? AND verification_status = ?`,
      nextStatus
        ? [to, reason, user.id, nextStatus, user.id, shopId, shop.verification_status]
        : [to, reason, user.id, user.id, shopId, shop.verification_status],
    );
    return result.affectedRows > 0;
  });

  if (!changed) {
    // Somebody decided it between our read and our write.
    throw ApiError.conflict(
      'This registration was decided by someone else a moment ago. Reload it to see the current decision.',
    );
  }

  const saved = await queryOne('SELECT * FROM shops WHERE id = ?', [shopId]);
  await notifySeller(saved, to, reason);

  logger.info(
    {
      event: DECISIONS[to]?.action ?? 'SELLER_REGISTRATION_DECIDED',
      shop_id: Number(shopId),
      reviewer_id: user.id,
      from: previous.verificationStatus,
      to,
      listing_status: saved.status,
    },
    'Seller registration decided',
  );

  return { registration: await detail(shopId), previous };
}

/**
 * §18. Never fatal: a notification that does not send must not undo a
 * decision the reviewer has been told was recorded.
 */
async function notifySeller(shop, to, reason) {
  const decision = DECISIONS[to];
  if (!decision) return;
  try {
    await notifications.notifyShopTeam(Number(shop.id), {
      type: decision.notification,
      title: decision.title,
      message: decision.message(shop, reason ?? ''),
      entityType: 'shop',
      entityId: Number(shop.id),
    });
  } catch (error) {
    logger.warn(
      { event: 'ONBOARDING_NOTIFY_FAILED', shop_id: Number(shop.id), decision: to },
      'Registration decided but the seller could not be notified',
    );
  }
}

/**
 * Switches a verified shop on or off without touching its verification (§11).
 *
 * The other half of "do not conflate verified and active". `shop.service`
 * already owns this transition and its activation guard, so this delegates
 * rather than writing `status` itself - otherwise the guard that stops an
 * unreviewed shop going public would have a second, unguarded way in.
 */
async function setListing(shopId, status, user) {
  const shopService = require('../shops/shop.service');
  const shop = await queryOne('SELECT id, verification_status FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw ApiError.notFound('Registration not found');

  await shopService.update(shopId, { status }, user);
  return detail(shopId);
}

module.exports = {
  list,
  detail,
  decide,
  setListing,
  reviewHistory,
  DECISIONS,
  REGISTRATION_STATUSES,
};
