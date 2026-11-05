'use strict';

const { query, queryOne, execute, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const notifications = require('../../services/notifications');
const logger = require('../../utils/logger');
const { limitOffset } = require('../../utils/pagination');

/**
 * Finding a shop that already exists, and asking to run it (§16).
 *
 * Two halves of one story. A seller types their shop's name, we show the
 * shops we already have that might be theirs, and if one is, they ask for it
 * instead of creating a second copy. A reviewer then decides.
 *
 * Seller and reviewer live in the same module here, unlike registrations,
 * because a claim is a short-lived request rather than a long-lived thing the
 * seller owns: it is created, it waits, it is decided. There is no equivalent
 * of the registration wizard's weeks of seller-owned editing to keep apart.
 *
 * Nothing in here ever merges two shops. §16 is explicit that a name match is
 * not identity, and the only thing an approved claim does is add a member to
 * a shop that already existed.
 */

/** Claims that are still live. A decided one drops out of the unique key. */
const OPEN = 'PENDING';

/**
 * Strips a name to the part worth comparing.
 *
 * "Sri Meenakshi Stores (Gandhipuram)" and "sri meenakshi stores" are the
 * same shop typed by two people. Punctuation, case and runs of whitespace
 * carry no signal; the words do.
 */
function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The last ten digits of a phone number.
 *
 * Indian mobile numbers are ten digits and arrive with every combination of
 * +91, 0, spaces and dashes in front. Comparing the tail is what makes
 * "+91 97890 41201" and "09789041201" the same number.
 */
function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * What a stranger is allowed to see about a possible match (§16).
 *
 * Deliberately thin. The seller is being shown shops that are probably not
 * theirs, so this carries only what someone needs to recognise their own
 * shop - the name, roughly where it is, and what it sells. No owner, no
 * email, no phone, no account details, which is what §16 means by not
 * disclosing the current manager.
 */
function presentCandidate(row, matchedOn) {
  return {
    shopId: Number(row.id),
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    area: row.area,
    city: row.city,
    pincode: row.pincode,
    categories: row.categories ? row.categories.split('||') : [],
    /** Why we think this might be theirs; shown so the list is not a mystery. */
    matchedOn,
    /** True when this seller already runs it - then there is nothing to claim. */
    alreadyYours: Boolean(row.is_member),
    /** True when they have a claim on it that nobody has decided yet. */
    claimPending: Boolean(row.has_open_claim),
  };
}

/**
 * Shops that might already be the one this seller is about to register (§16).
 *
 * Scoped to shops a stranger could already find: a shop our own team created,
 * or one that passed review. Another seller's registration in flight is
 * deliberately invisible here - it is not public, and showing it would tell
 * one seller what another is in the middle of doing. The reviewer's version
 * below sees those, because spotting two people registering one shop is the
 * reviewer's job.
 */
async function findPossibleMatches(params, user) {
  const name = normalizeName(params.name);
  const phone = normalizePhone(params.contactNumber);
  if (name.length < 2 && !phone) return [];

  // The first word is a cheap, index-friendly way to narrow before scoring in
  // JS: "meenakshi" finds "Sri Meenakshi Stores" and "Meenakshi Stores".
  const words = name.split(' ').filter((word) => word.length >= 3);
  const likes = words.slice(0, 3).map(() => 's.name LIKE ?');
  const values = words.slice(0, 3).map((word) => `%${word}%`);

  const conditions = [];
  if (likes.length) conditions.push(`(${likes.join(' OR ')})`);
  if (phone) {
    // Compared on the digits alone, so the stored formatting cannot hide a match.
    conditions.push("REPLACE(REPLACE(REPLACE(IFNULL(s.contact_number,''),' ',''),'-',''),'+','') LIKE ?");
    values.push(`%${phone}`);
  }
  if (!conditions.length) return [];

  const rows = await query(
    `SELECT s.id, s.name, s.slug, s.logo_url, s.contact_number,
            b.area, b.city, b.pincode,
            (SELECT GROUP_CONCAT(c.name SEPARATOR '||')
               FROM shop_categories sc JOIN categories c ON c.id = sc.category_id
              WHERE sc.shop_id = s.id) AS categories,
            EXISTS (SELECT 1 FROM shop_members sm
                     WHERE sm.shop_id = s.id AND sm.user_id = ? AND sm.status = 'active') AS is_member,
            EXISTS (SELECT 1 FROM shop_claim_requests cr
                     WHERE cr.shop_id = s.id AND cr.requester_id = ? AND cr.status = 'PENDING') AS has_open_claim
       FROM shops s
       LEFT JOIN shop_branches b
              ON b.id = (SELECT b2.id FROM shop_branches b2
                          WHERE b2.shop_id = s.id
                          ORDER BY b2.is_primary DESC, b2.id ASC LIMIT 1)
      WHERE (${conditions.join(' OR ')})
        -- Only shops a stranger could already see. NULL is a shop our team
        -- created; VERIFIED is one that passed review. Everything else is
        -- somebody's registration in progress.
        AND (s.verification_status IS NULL OR s.verification_status = 'VERIFIED')
      LIMIT 25`,
    [user.id, user.id, ...values],
  );

  const scored = rows
    .map((row) => {
      const matchedOn = [];
      const rowName = normalizeName(row.name);

      if (rowName === name) matchedOn.push('name');
      else if (name && (rowName.includes(name) || name.includes(rowName))) matchedOn.push('similar name');

      if (phone && normalizePhone(row.contact_number) === phone) matchedOn.push('phone number');
      if (params.pincode && row.pincode && String(params.pincode).trim() === String(row.pincode)) {
        matchedOn.push('pincode');
      }
      if (
        params.city &&
        row.city &&
        normalizeName(params.city) === normalizeName(row.city) &&
        !matchedOn.includes('pincode')
      ) {
        matchedOn.push('city');
      }

      return { row, matchedOn };
    })
    // A row that came back on a loose LIKE but matches nothing we can name is
    // noise: showing it would train sellers to ignore the whole list.
    .filter((entry) => entry.matchedOn.length > 0)
    .sort((a, b) => b.matchedOn.length - a.matchedOn.length);

  return scored.map((entry) => presentCandidate(entry.row, entry.matchedOn));
}

/**
 * Possible duplicates of a registration, for the reviewer (§14, §16).
 *
 * The same idea pointed the other way: given the registration in front of
 * them, what else looks like this shop? This one does see other registrations
 * in flight, because two sellers registering the same shop in the same week
 * is exactly the case a reviewer has to catch and a seller must not see.
 */
async function duplicatesFor(shopId) {
  const shop = await queryOne(
    `SELECT s.id, s.name, s.contact_number, b.city, b.pincode
       FROM shops s
       LEFT JOIN shop_branches b
              ON b.id = (SELECT b2.id FROM shop_branches b2
                          WHERE b2.shop_id = s.id
                          ORDER BY b2.is_primary DESC, b2.id ASC LIMIT 1)
      WHERE s.id = ?`,
    [shopId],
  );
  if (!shop) return [];

  const name = normalizeName(shop.name);
  const phone = normalizePhone(shop.contact_number);
  const words = name.split(' ').filter((word) => word.length >= 3).slice(0, 3);
  if (!words.length && !phone) return [];

  const conditions = [];
  const values = [];
  if (words.length) {
    conditions.push(`(${words.map(() => 's.name LIKE ?').join(' OR ')})`);
    values.push(...words.map((word) => `%${word}%`));
  }
  if (phone) {
    conditions.push("REPLACE(REPLACE(REPLACE(IFNULL(s.contact_number,''),' ',''),'-',''),'+','') LIKE ?");
    values.push(`%${phone}`);
  }

  const rows = await query(
    `SELECT s.id, s.name, s.slug, s.contact_number, s.status, s.registration_source,
            s.verification_status, b.city, b.pincode
       FROM shops s
       LEFT JOIN shop_branches b
              ON b.id = (SELECT b2.id FROM shop_branches b2
                          WHERE b2.shop_id = s.id
                          ORDER BY b2.is_primary DESC, b2.id ASC LIMIT 1)
      WHERE s.id <> ? AND (${conditions.join(' OR ')})
      LIMIT 25`,
    [shopId, ...values],
  );

  return rows
    .map((row) => {
      const matchedOn = [];
      const rowName = normalizeName(row.name);
      if (rowName === name) matchedOn.push('name');
      else if (name && (rowName.includes(name) || name.includes(rowName))) matchedOn.push('similar name');
      if (phone && normalizePhone(row.contact_number) === phone) matchedOn.push('phone number');
      if (shop.pincode && row.pincode && String(shop.pincode) === String(row.pincode)) matchedOn.push('pincode');
      if (shop.city && row.city && normalizeName(shop.city) === normalizeName(row.city)) matchedOn.push('city');
      return {
        shopId: Number(row.id),
        name: row.name,
        slug: row.slug,
        city: row.city,
        pincode: row.pincode,
        registrationSource: row.registration_source,
        verificationStatus: row.verification_status,
        status: row.status,
        matchedOn,
      };
    })
    .filter((entry) => entry.matchedOn.length > 0)
    .sort((a, b) => b.matchedOn.length - a.matchedOn.length);
}

/** What the requester is told about their own claim. */
function presentClaim(row) {
  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    shopName: row.shop_name,
    shopSlug: row.shop_slug,
    reason: row.reason,
    contactPhone: row.contact_phone,
    status: row.status,
    /** Verbatim, and only ever set by a reviewer (§16 step 7). */
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    requester: row.requester_name
      ? { id: Number(row.requester_id), name: row.requester_name, email: row.requester_email }
      : undefined,
  };
}

const CLAIM_SELECT = `
  SELECT cr.*, s.name AS shop_name, s.slug AS shop_slug,
         u.name AS requester_name, u.email AS requester_email
    FROM shop_claim_requests cr
    JOIN shops s ON s.id = cr.shop_id
    JOIN users u ON u.id = cr.requester_id`;

/**
 * Asks to manage a shop that already exists (§16 steps 3-5).
 *
 * Grants nothing. The row is a request and the only thing it changes is that
 * a reviewer now has something to look at - §16 is explicit that a claim must
 * not grant access before approval, and the way to guarantee that is for this
 * function to be unable to write to `shop_members` at all.
 */
async function createClaim(payload, user) {
  const shop = await queryOne(
    'SELECT id, name, verification_status FROM shops WHERE id = ?',
    [payload.shopId],
  );
  if (!shop) throw ApiError.notFound('That shop could not be found.');

  // Same scope as the search: you cannot claim a registration somebody else
  // is in the middle of, because you were never shown it.
  if (shop.verification_status !== null && shop.verification_status !== 'VERIFIED') {
    throw ApiError.notFound('That shop could not be found.');
  }

  const member = await queryOne(
    `SELECT 1 FROM shop_members WHERE shop_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    [shop.id, user.id],
  );
  if (member) {
    throw ApiError.conflict('You already manage this shop. Open it from your dashboard.');
  }

  const open = await queryOne(
    `SELECT id FROM shop_claim_requests
      WHERE shop_id = ? AND requester_id = ? AND status = ? LIMIT 1`,
    [shop.id, user.id, OPEN],
  );
  // A second request while the first is undecided is a double-tap, not a new
  // claim. Returning the existing one keeps the endpoint safe to retry (§19).
  if (open) return getClaim(open.id, user);

  const result = await execute(
    `INSERT INTO shop_claim_requests (shop_id, requester_id, reason, contact_phone, status)
     VALUES (?, ?, ?, ?, ?)`,
    [shop.id, user.id, payload.reason, payload.contactPhone ?? null, OPEN],
  );

  logger.info(
    { event: 'SHOP_CLAIM_REQUESTED', shop_id: Number(shop.id), user_id: user.id },
    'Seller asked to manage an existing shop',
  );

  return getClaim(result.insertId, user);
}

/** One claim, readable by the person who made it or by a reviewer. */
async function getClaim(id, user, { asReviewer = false } = {}) {
  const row = await queryOne(`${CLAIM_SELECT} WHERE cr.id = ?`, [id]);
  if (!row) throw ApiError.notFound('Claim not found');
  if (!asReviewer && Number(row.requester_id) !== Number(user.id)) {
    // Not "forbidden": somebody probing ids should not learn that a claim
    // exists on a shop they have nothing to do with.
    throw ApiError.notFound('Claim not found');
  }
  const claim = presentClaim(row);
  if (!asReviewer) delete claim.requester;
  return claim;
}

/** Every claim this person has made, newest first. */
async function myClaims(user) {
  const rows = await query(`${CLAIM_SELECT} WHERE cr.requester_id = ? ORDER BY cr.id DESC`, [user.id]);
  return rows.map((row) => {
    const claim = presentClaim(row);
    delete claim.requester;
    return claim;
  });
}

/** The requester changed their mind. Only an undecided claim can be pulled. */
async function withdrawClaim(id, user) {
  const claim = await getClaim(id, user);
  if (claim.status !== OPEN) {
    throw ApiError.conflict('This claim has already been decided.');
  }
  await execute(
    `UPDATE shop_claim_requests SET status = 'WITHDRAWN' WHERE id = ? AND status = ?`,
    [id, OPEN],
  );
  return getClaim(id, user);
}

// ---- The reviewer's side (§16 steps 6-9) ----------------------------------

/** The claim queue, oldest first for the same reason the registration one is. */
async function listClaims(params) {
  const { page, limit, offset } = limitOffset(params);
  const where = [];
  const values = [];
  if (params.status) {
    where.push('cr.status = ?');
    values.push(params.status);
  }
  if (params.shopId) {
    where.push('cr.shop_id = ?');
    values.push(params.shopId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await queryOne(
    `SELECT COUNT(*) AS count FROM shop_claim_requests cr ${clause}`,
    values,
  );
  const rows = await query(
    `${CLAIM_SELECT} ${clause}
      ORDER BY (cr.status = 'PENDING') DESC, cr.created_at ASC
      LIMIT ${limit} OFFSET ${offset}`,
    values,
  );

  return {
    items: rows.map(presentClaim),
    pagination: { page, limit, total: Number(total.count) },
  };
}

/**
 * Approves a claim and grants the access it asked for (§16 steps 8-9).
 *
 * Adds a member. It does not remove anybody: §16 says existing managers must
 * not be dropped automatically, and a shop with two managers is a supported
 * state, so "approve" means "also", never "instead".
 *
 * The membership and the decision are written together. A grant without a
 * decision row would be access nobody can account for, and a decision without
 * the grant would be a seller told they have access that they do not.
 */
async function approveClaim(id, user) {
  const row = await queryOne(`${CLAIM_SELECT} WHERE cr.id = ?`, [id]);
  if (!row) throw ApiError.notFound('Claim not found');
  if (row.status !== OPEN) {
    throw ApiError.conflict('This claim has already been decided.');
  }

  const changed = await transaction(async (connection) => {
    const [result] = await connection.query(
      `UPDATE shop_claim_requests
          SET status = 'APPROVED', reviewer_id = ?, decided_at = NOW()
        WHERE id = ? AND status = ?`,
      [user.id, id, OPEN],
    );
    // Conditional for the same reason the registration decision is: two
    // reviewers on one queue must not both grant the same access.
    if (result.affectedRows === 0) return false;

    const [[adminRole]] = await connection.query(
      "SELECT id FROM roles WHERE name = 'ADMIN' AND scope = 'shop' LIMIT 1",
    );
    if (!adminRole) {
      throw new Error('The shop-scoped ADMIN role is missing; run the seed.');
    }
    await connection.execute(
      `INSERT INTO shop_members (shop_id, user_id, role_id, status)
       VALUES (?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), status = 'active'`,
      [row.shop_id, row.requester_id, adminRole.id],
    );
    return true;
  });

  if (!changed) throw ApiError.conflict('This claim has already been decided.');

  await notifyDecision(row, 'APPROVED', null);

  logger.info(
    {
      event: 'SHOP_CLAIM_APPROVED',
      shop_id: Number(row.shop_id),
      claim_id: Number(id),
      requester_id: Number(row.requester_id),
      reviewer_id: user.id,
    },
    'Shop claim approved and access granted',
  );

  return getClaim(id, user, { asReviewer: true });
}

/** §16 step 7, with the reason the requester will read. */
async function rejectClaim(id, reason, user) {
  const row = await queryOne(`${CLAIM_SELECT} WHERE cr.id = ?`, [id]);
  if (!row) throw ApiError.notFound('Claim not found');
  if (row.status !== OPEN) {
    throw ApiError.conflict('This claim has already been decided.');
  }

  const result = await execute(
    `UPDATE shop_claim_requests
        SET status = 'REJECTED', reviewer_id = ?, decision_reason = ?, decided_at = NOW()
      WHERE id = ? AND status = ?`,
    [user.id, reason, id, OPEN],
  );
  if (result.affectedRows === 0) throw ApiError.conflict('This claim has already been decided.');

  await notifyDecision(row, 'REJECTED', reason);

  logger.info(
    { event: 'SHOP_CLAIM_REJECTED', claim_id: Number(id), reviewer_id: user.id },
    'Shop claim rejected',
  );

  return getClaim(id, user, { asReviewer: true });
}

/**
 * §16 step 9, §18. Both sides hear about it: the person who asked, and the
 * team already on the shop - who are gaining a colleague and should not find
 * out by noticing a new name.
 *
 * Never fatal: a notification that does not send must not undo a decision the
 * reviewer has been told was recorded.
 */
async function notifyDecision(row, outcome, reason) {
  const approved = outcome === 'APPROVED';
  try {
    await notifications.dispatch(
      [{ id: Number(row.requester_id), name: row.requester_name, email: row.requester_email }],
      {
        type: approved ? 'SHOP_CLAIM_APPROVED' : 'SHOP_CLAIM_REJECTED',
        title: approved ? 'You can now manage this shop' : 'Your request was not approved',
        message: approved
          ? `You have been given access to ${row.shop_name}.`
          : `${row.shop_name}: ${reason}`,
        entityType: 'shop',
        entityId: Number(row.shop_id),
      },
    );

    if (approved) {
      /*
        The people who were already on the shop, which by now excludes the
        person who just joined - `notifyShopTeam` would include them, and
        being told about yourself in the third person reads as a bug.

        Deliberately says who joined and nothing about why they asked: the
        claim's reason was written for the reviewer, not for the incumbents.
      */
      const incumbents = await query(
        `SELECT u.id, u.name, u.email FROM shop_members sm
           JOIN users u ON u.id = sm.user_id AND u.status = 'active'
          WHERE sm.shop_id = ? AND sm.status = 'active' AND sm.user_id <> ?`,
        [row.shop_id, row.requester_id],
      );
      await notifications.dispatch(incumbents, {
        type: 'SHOP_MEMBER_ADDED',
        title: 'Someone was added to your shop',
        message: `${row.requester_name} now has manager access to ${row.shop_name}.`,
        entityType: 'shop',
        entityId: Number(row.shop_id),
      });
    }
  } catch (error) {
    logger.warn(
      { event: 'CLAIM_NOTIFY_FAILED', claim_id: Number(row.id) },
      'Claim decided but somebody could not be notified',
    );
  }
}

module.exports = {
  normalizeName,
  normalizePhone,
  findPossibleMatches,
  duplicatesFor,
  createClaim,
  getClaim,
  myClaims,
  withdrawClaim,
  listClaims,
  approveClaim,
  rejectClaim,
};
