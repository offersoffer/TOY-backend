'use strict';

const crypto = require('node:crypto');
const { queryOne, execute, rawQuery } = require('../../db/pool');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const accessControl = require('../../services/accessControl');
const analyticsEvents = require('../../services/analyticsEvents');

/**
 * Claim codes and merchant redemption (Claim/Redemption workflow).
 *
 * The one rule the whole module is built around is §38.6/§27: *the frontend's
 * claim status is never trusted*. Every question that decides whether a benefit
 * is handed over - is this code real, has it expired, is this the right branch,
 * was it already used, may this member of staff redeem it - is answered here,
 * from the database, on every single attempt.
 *
 * Claim and redemption stay separate (§18). Claiming records what a customer
 * intends; redeeming records that a shop actually served them. Only the second
 * is evidence of a conversion, so only a merchant action can produce it (§38.7)
 * and a customer can never write it about themselves (§25).
 */

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * Crockford-ish alphabet: no O/0 or I/1, because half of these codes get read
 * aloud across a counter or copied off a cracked phone screen.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_PREFIX = 'OFR-';

/**
 * §4: opaque and hard to guess. 32^8 is about 10^12 codes, so even at the
 * verification rate limit an attacker would be at this for millennia - and
 * §28's lockout would have stopped them in the first minute.
 *
 * `randomInt` rather than `randomBytes(n)[i] % 32`: 256 is a multiple of 32 so
 * the modulo happens to be uniform here, but that is a coincidence of the
 * alphabet length, and it stops being true the moment someone edits ALPHABET.
 */
function generateCode() {
  let body = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    body += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `${CODE_PREFIX}${body}`;
}

/** Accepts `ofr-8x72q`, `8X72Q` and `OFR-8X72Q` as the same code. */
function normaliseCode(input) {
  const upper = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const bare = upper.startsWith(CODE_PREFIX) ? upper.slice(CODE_PREFIX.length) : upper;
  return `${CODE_PREFIX}${bare}`;
}

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

/**
 * The QR is signed rather than being the bare code (§6).
 *
 * The code alone would work - it is what manual entry uses - but a QR is
 * scanned by a camera, so anything that renders as a QR gets pointed at the
 * verify screen. Signing means the server can tell a code the customer's app
 * issued from a code someone typed into a QR generator, and the payload carries
 * only the claim id and code: no name, no phone, no customer id (§4, §6).
 *
 * Deriving the key from the access secret keeps this working on installs that
 * never set CLAIM_QR_SECRET, while staying a different key from the one that
 * signs sessions - a leaked QR must never be a step towards a leaked token.
 */
const QR_KEY = env.claims?.qrSecret
  ? Buffer.from(env.claims.qrSecret)
  : crypto.createHmac('sha256', env.jwt.accessSecret).update('offer-claim-qr').digest();

function signQrPayload(claim, kind = 'offer') {
  const body = Buffer.from(
    // `k` distinguishes a product-offer claim from a service-offer one. Both
    // live in their own table with their own id sequence, so without it a
    // scanned token would be ambiguous the moment the two ids collided.
    JSON.stringify({ v: 1, k: kind, id: Number(claim.id), c: claim.code }),
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', QR_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/**
 * Returns the code the token vouches for, or null. Timing-safe because this is
 * reachable by anyone holding VERIFY_CLAIM, and a comparison that returns early
 * leaks how much of a forged signature was right.
 */
function readQrPayload(token) {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) return null;

  const expected = crypto.createHmac('sha256', QR_KEY).update(body).digest('base64url');
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.c !== 'string') return null;
    // Tokens minted before service claims existed carry no `k`; they are all
    // product-offer claims, which is what the default says.
    return { code: normaliseCode(payload.c), kind: payload.k === 'service_offer' ? 'service_offer' : 'offer' };
  } catch {
    return null;
  }
}

/**
 * What the customer's app renders as a QR. A deep link rather than a raw token
 * so that a scan by any ordinary camera app - not just ours - lands the
 * customer somewhere that explains what they are holding.
 */
const qrValueFor = (claim, kind = 'offer') =>
  `${env.appUrl}/claims/scan?t=${signQrPayload(claim, kind)}`;

// ---------------------------------------------------------------------------
// Reading claims
// ---------------------------------------------------------------------------

const CLAIM_SELECT = `
  SELECT c.*, o.title AS offer_title, o.offer_text, o.end_date AS offer_end_date,
         o.applicability_type, o.max_redemptions_per_claim,
         -- What the branch restriction is keyed on. For a product offer that
         -- is the offer itself; the service kind points at its parent service.
         o.id AS location_parent_id,
         s.name AS shop_name, b.branch_name, u.name AS customer_name, u.phone AS customer_phone,
         ru.name AS redeemed_by_name,
         (SELECT oi.image_url FROM offer_images oi
           WHERE oi.offer_id = o.id ORDER BY oi.display_order, oi.id LIMIT 1) AS image_url
    FROM offer_claims c
    JOIN offers o ON o.id = c.offer_id
    JOIN shops  s ON s.id = c.shop_id
    JOIN users  u ON u.id = c.user_id
    LEFT JOIN shop_branches b ON b.id = c.branch_id
    LEFT JOIN users ru ON ru.id = c.redeemed_by`;

/**
 * Shapes a claim row for the API.
 *
 * `audience` is what decides how much of the customer appears. §24 is explicit
 * that merchants see customer data only as far as authorisation allows, and a
 * shopkeeper needs to know they are serving the right person - not their phone
 * number. So 'customer' sees their own claim in full, 'merchant' gets a name
 * and nothing else, and only 'admin' - a Super Admin investigating a dispute
 * (§26) - sees contact details.
 */
function mapClaim(row, audience = 'customer', kind = 'offer') {
  const claim = {
    id: Number(row.id),
    kind,
    code: row.code,
    status: row.status,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    redemptionCount: Number(row.redemption_count ?? 0),
    maxRedemptions: Number(row.max_redemptions_per_claim ?? 1),
    verificationMethod: row.verification_method ?? null,
    offer: {
      id: Number(row.offer_id),
      title: row.offer_title,
      offerText: row.offer_text,
      endDate: row.offer_end_date,
      imageUrl: row.image_url ?? null,
    },
    shop: { id: Number(row.shop_id), name: row.shop_name },
    branch: row.branch_id ? { id: Number(row.branch_id), name: row.branch_name } : null,
  };

  if (audience === 'customer') {
    claim.qrValue = qrValueFor(row, kind);
    return claim;
  }

  claim.customer = { id: Number(row.user_id), name: row.customer_name };
  claim.redeemedBy = row.redeemed_by ? { id: Number(row.redeemed_by), name: row.redeemed_by_name } : null;

  if (audience === 'admin') {
    claim.customer.phone = row.customer_phone ?? null;
    claim.revokedAt = row.revoked_at;
    claim.revokeReason = row.revoke_reason;
  }
  return claim;
}

/**
 * The service-offer equivalent, aliased column-for-column onto the same names
 * the product-offer select uses. That is what lets one `mapClaim`, one
 * `evaluate` and one set of routes serve both: the difference between the two
 * kinds is confined to these two queries.
 *
 * `offer_title` is the service's name rather than the offer's - "AC Deep
 * Cleaning" is what the customer recognises, and a service offer is only ever
 * a price attached to it.
 */
const SERVICE_CLAIM_SELECT = `
  SELECT c.*, c.service_offer_id AS offer_id,
         sv.name AS offer_title, so.offer_text, so.end_date AS offer_end_date,
         sv.applicability_type, so.max_redemptions_per_claim,
         sv.id AS location_parent_id,
         s.name AS shop_name, b.branch_name, u.name AS customer_name, u.phone AS customer_phone,
         ru.name AS redeemed_by_name,
         (SELECT si.image_url FROM service_images si
           WHERE si.service_id = sv.id ORDER BY si.display_order, si.id LIMIT 1) AS image_url
    FROM service_offer_claims c
    JOIN service_offers so ON so.id = c.service_offer_id
    JOIN services sv ON sv.id = so.service_id
    JOIN shops  s ON s.id = c.shop_id
    JOIN users  u ON u.id = c.user_id
    LEFT JOIN shop_branches b ON b.id = c.branch_id
    LEFT JOIN users ru ON ru.id = c.redeemed_by`;

const selectFor = (kind) => (kindOf(kind).key === 'service_offer' ? SERVICE_CLAIM_SELECT : CLAIM_SELECT);

const findById = (id, kind = 'offer') => queryOne(`${selectFor(kind)} WHERE c.id = ?`, [id]);

/**
 * Looks a claim up by what someone typed or scanned.
 *
 * Both spellings are tried because codes issued before §4 introduced the `OFR-`
 * prefix are still in customers' pockets, and rewriting them in a migration
 * would invalidate every printed and screenshotted code that already exists.
 * The unique index means at most one of the two can match.
 */
function findByCode(code, kind = 'offer') {
  const prefixed = normaliseCode(code);
  const bare = prefixed.slice(CODE_PREFIX.length);
  return queryOne(`${selectFor(kind)} WHERE c.code IN (?, ?)`, [prefixed, bare]);
}

/**
 * Finds a code without being told which kind it is (§22).
 *
 * The shopkeeper at the counter does not know whether the coupon in front of
 * them is for a shirt or for an air-conditioner service, and should not have
 * to pick a tab before scanning. So a lookup tries both tables and reports
 * which one answered.
 *
 * `preferred` is the kind a scanned QR claimed to be - checking that one first
 * saves a query on the common path without trusting it, since the other table
 * is still searched if it misses.
 */
async function findAnyByCode(code, preferred = 'offer') {
  const order = kindOf(preferred).key === 'service_offer'
    ? ['service_offer', 'offer']
    : ['offer', 'service_offer'];

  for (const kind of order) {
    const row = await findByCode(code, kind);
    if (row) return { row, kind };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claiming (§3, §17)
// ---------------------------------------------------------------------------

/**
 * How long a freshly issued code lives.
 *
 * Capped at the offer's own end date, always. §14 says an expired claim cannot
 * be redeemed, and a code that outlived the promotion it belongs to is exactly
 * the argument nobody wants to have at a counter.
 */
function expiryFor(offer, now = new Date()) {
  const offerEnd = new Date(offer.end_date);
  if (!offer.claim_validity_hours) return offerEnd;
  const window = new Date(now.getTime() + Number(offer.claim_validity_hours) * 3600 * 1000);
  return window < offerEnd ? window : offerEnd;
}

/**
 * Loads the listing a claim would hang off, normalised to one shape.
 *
 * The two kinds differ only in where the shop lives: an offer joins to its
 * shop directly, a service offer already carries `shop_id` denormalised. The
 * claim rules and the dates are named identically on both tables, which is
 * what lets every check below read one row without caring which it got.
 */
async function loadClaimableParent(parentId, descriptor) {
  if (descriptor.key === 'service_offer') {
    return queryOne(
      `SELECT so.id, so.shop_id, so.status, so.start_date, so.end_date,
              so.claim_limit_per_customer, so.total_claim_limit, so.claim_validity_hours,
              s.status AS shop_status
         FROM service_offers so
         JOIN services sv ON sv.id = so.service_id
         JOIN shops s ON s.id = so.shop_id
        WHERE so.id = ? AND sv.status <> 'deactivated'`,
      [parentId],
    );
  }
  return queryOne(
    `SELECT o.id, o.shop_id, o.status, o.start_date, o.end_date,
            o.claim_limit_per_customer, o.total_claim_limit, o.claim_validity_hours,
            s.status AS shop_status
       FROM offers o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?`,
    [parentId],
  );
}

/**
 * Everything §3 lists, checked in the order that produces the most useful
 * message: what the offer is, then whether this customer may have it.
 *
 * Returns `{ offer, existing }` or throws. `existing` is a live claim the
 * customer already holds - when the offer allows one claim each (the usual
 * setting), claiming again must hand back the same code rather than mint a
 * second one, so the button stays safe to press twice.
 */
async function assertClaimable(parentId, userId, kind = 'offer') {
  const descriptor = kindOf(kind);
  const offer = await loadClaimableParent(parentId, descriptor);
  if (!offer) throw ApiError.notFound(descriptor.key === 'offer' ? 'Offer not found' : 'Service offer not found');

  const now = new Date();
  const live =
    offer.status === 'active' &&
    offer.shop_status === 'active' &&
    new Date(offer.start_date) <= now &&
    new Date(offer.end_date) >= now;
  if (!live) {
    throw ApiError.badRequest(
      descriptor.key === 'offer'
        ? 'This offer is not available to claim'
        : 'This service offer is not available to claim',
    );
  }

  // Claims this customer already holds. Cancelled and revoked ones do not count
  // against the limit - the customer got nothing for them.
  const mine = await rawQuery(
    `SELECT id, status, claim_seq FROM ${descriptor.claimsTable}
      WHERE user_id = ? AND ${descriptor.parentColumn} = ? AND status NOT IN ('cancelled','revoked')
      ORDER BY claim_seq`,
    [userId, parentId],
  );

  const reusable = mine.find((claim) => claim.status === 'claimed');
  if (reusable) return { offer, existing: reusable };

  const perCustomer = Number(offer.claim_limit_per_customer ?? 1);
  if (mine.length >= perCustomer) {
    throw ApiError.conflict(
      perCustomer === 1
        ? 'You have already claimed this offer'
        : `You have used all ${perCustomer} claims for this offer`,
    );
  }

  if (offer.total_claim_limit) {
    const [{ taken }] = await rawQuery(
      `SELECT COUNT(*) AS taken FROM ${descriptor.claimsTable}
        WHERE ${descriptor.parentColumn} = ? AND status NOT IN ('cancelled','revoked')`,
      [parentId],
    );
    if (Number(taken) >= Number(offer.total_claim_limit)) {
      throw ApiError.conflict('This offer has been fully claimed');
    }
  }

  const nextSeq = mine.reduce((max, claim) => Math.max(max, Number(claim.claim_seq)), 0) + 1;
  return { offer, existing: null, nextSeq };
}

/** MySQL's duplicate-key error, whatever the driver version calls it. */
const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;

/**
 * Issues a code. Retries on a code collision, and treats a duplicate on
 * (user, offer, seq) as "another request beat me to it" - which is §17's
 * "duplicate requests" case, and the reason the unique key exists at all.
 */
async function issue(parentId, userId, kind = 'offer') {
  const descriptor = kindOf(kind);
  const { offer, existing, nextSeq } = await assertClaimable(parentId, userId, kind);
  if (existing) return { claimId: Number(existing.id), isNew: false, offer };

  const expiresAt = expiryFor(offer);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await execute(
        `INSERT INTO ${descriptor.claimsTable}
           (${descriptor.parentColumn}, user_id, shop_id, code, claim_seq, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [parentId, userId, offer.shop_id, generateCode(), nextSeq, expiresAt],
      );
      return { claimId: Number(result.insertId), isNew: true, offer };
    } catch (error) {
      if (!isDuplicate(error)) throw error;

      // Two requests raced for the same sequence number. The other one won, so
      // hand back what it created rather than issuing a second code.
      const raced = await queryOne(
        `SELECT id FROM ${descriptor.claimsTable}
          WHERE user_id = ? AND ${descriptor.parentColumn} = ? AND claim_seq = ?`,
        [userId, parentId, nextSeq],
      );
      if (raced) return { claimId: Number(raced.id), isNew: false, offer };
      // Otherwise it was the code that collided; loop and draw another.
    }
  }
  throw ApiError.conflict('Could not issue a claim code just now. Please try again.');
}

// ---------------------------------------------------------------------------
// Verification (§8, §9, §13-§16)
// ---------------------------------------------------------------------------

/**
 * Why a verification failed, and what the merchant is told.
 *
 * The reasons are for the audit trail; the messages are what §13 permits us to
 * say out loud. "Could not be found" deliberately covers both a typo and a code
 * for a rival shop, because telling someone which one they hit turns the verify
 * screen into an oracle for enumerating live codes.
 */
const REJECTIONS = {
  NOT_FOUND: 'This coupon could not be found. Please check the code and try again.',
  WRONG_SHOP: 'This coupon could not be found. Please check the code and try again.',
  WRONG_BRANCH: 'This offer is not valid at this branch.',
  EXPIRED: 'This claim is no longer valid.',
  ALREADY_REDEEMED: 'This offer was already redeemed.',
  CANCELLED: 'This claim is no longer valid.',
  REVOKED: 'This claim is no longer valid.',
};

/**
 * The two things a claim can be for (§22).
 *
 * A product offer and a service offer are the same workflow with different
 * tables behind them - the shopkeeper holding the scanner cannot tell which
 * they have, and nothing about the counter differs. So rather than a second
 * copy of every check, each kind is described once here and the security
 * logic below reads the description. A rule fixed in `evaluate` is fixed for
 * both, which is the whole point.
 */
const KINDS = {
  offer: {
    key: 'offer',
    claimsTable: 'offer_claims',
    parentColumn: 'offer_id',
    /** Where the branch restriction is configured, and what keys it. */
    locationsTable: 'offer_locations',
    locationsKey: 'offer_id',
    /** Columns in `claim_verifications` that point back at this kind. */
    verificationClaimColumn: 'claim_id',
    verificationParentColumn: 'offer_id',
    /**
     * Whether a claim of this kind, aliased `c`, could be redeemed at the
     * branch `?` names. Correlated rather than joined so the same fragment
     * works in the history queries, which already join the listing, and in
     * `/summary`, which joins nothing at all.
     */
    branchReachSql: `EXISTS (
        SELECT 1 FROM shop_branches rb
          JOIN offers ro ON ro.id = c.offer_id
         WHERE rb.id = ?
           AND ((ro.applicability_type = 'shop_wide' AND rb.shop_id = ro.shop_id AND rb.status = 'active')
             OR (ro.applicability_type = 'selected_branches'
                 AND EXISTS (SELECT 1 FROM offer_locations rl
                              WHERE rl.offer_id = ro.id AND rl.branch_id = rb.id))))`,
  },
  service_offer: {
    key: 'service_offer',
    claimsTable: 'service_offer_claims',
    parentColumn: 'service_offer_id',
    // A service offer inherits its branches from the service it hangs off,
    // not from the offer - the offer is a price, the service is the thing
    // that happens somewhere.
    locationsTable: 'service_locations',
    locationsKey: 'service_id',
    verificationClaimColumn: 'service_claim_id',
    verificationParentColumn: 'service_offer_id',
    // The branch rule reads from the parent service for the same reason the
    // locations table does: the offer is a price, the service is the thing
    // that happens somewhere.
    branchReachSql: `EXISTS (
        SELECT 1 FROM shop_branches rb
          JOIN service_offers rso ON rso.id = c.service_offer_id
          JOIN services rsv ON rsv.id = rso.service_id
         WHERE rb.id = ?
           AND ((rsv.applicability_type = 'shop_wide' AND rb.shop_id = rsv.shop_id AND rb.status = 'active')
             OR (rsv.applicability_type = 'selected_branches'
                 AND EXISTS (SELECT 1 FROM service_locations rl
                              WHERE rl.service_id = rsv.id AND rl.branch_id = rb.id))))`,
  },
};

const kindOf = (key) => KINDS[key] ?? KINDS.offer;

/**
 * The branches a claim may be redeemed at (§16).
 *
 * `shop_wide` means every active branch. `selected_branches` means the ones
 * pinned to the listing. `online` has no counter to walk into, so nothing
 * qualifies and the check falls through to "wrong branch" - which is the
 * honest answer for a merchant trying to redeem a web-only offer in a shop.
 *
 * `locationParentId` is the offer for a product offer and the *service* for a
 * service offer, which is why the caller supplies it rather than this deriving
 * it from the claim.
 */
async function allowedBranchIds({ applicabilityType, shopId, locationParentId, kind = 'offer' }) {
  if (applicabilityType === 'online') return [];

  const descriptor = kindOf(kind);
  if (applicabilityType === 'selected_branches') {
    const rows = await rawQuery(
      `SELECT branch_id FROM ${descriptor.locationsTable} WHERE ${descriptor.locationsKey} = ?`,
      [locationParentId],
    );
    return rows.map((row) => Number(row.branch_id));
  }
  const rows = await rawQuery(
    "SELECT id FROM shop_branches WHERE shop_id = ? AND status = 'active'",
    [shopId],
  );
  return rows.map((row) => Number(row.id));
}

/**
 * Decides whether `claim` may be redeemed right now, by `actor`, at `branchId`.
 *
 * Everything §27 lists is here, and nothing here reads anything the client
 * sent about the claim itself - only the code it typed and the branch it says
 * it is standing in, both of which are then checked against the database.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string, message: string}>}
 */
async function evaluate(claim, actor, branchId, kind = 'offer') {
  const reject = (reason) => ({ ok: false, reason, message: REJECTIONS[reason] });

  if (!accessControl.hasShopPermission(actor, claim.shop_id, 'VERIFY_CLAIM')) {
    return reject('WRONG_SHOP');
  }
  if (claim.status === 'cancelled') return reject('CANCELLED');
  if (claim.status === 'revoked') return reject('REVOKED');

  // Status is a cache that a stalled cron job can leave behind; the timestamp
  // is the truth, so expiry is decided on the date and not on the enum.
  if (claim.status === 'expired' || new Date(claim.expires_at) < new Date()) {
    return reject('EXPIRED');
  }

  const allowed = Number(claim.max_redemptions_per_claim ?? 1);
  if (Number(claim.redemption_count ?? 0) >= allowed) return reject('ALREADY_REDEEMED');

  // No branch means nobody told us where this till is - the usual case for a
  // one-shop merchant whose staff are not assigned to a branch. §16 is a rule
  // about *which* branch, so with no branch to check it has nothing to say,
  // and refusing every redemption instead would break every single-site shop.
  if (branchId !== null && branchId !== undefined) {
    const branches = await allowedBranchIds({
      kind,
      shopId: claim.shop_id,
      applicabilityType: claim.applicability_type,
      // Each kind's CLAIM_SELECT exposes this: the offer for a product offer,
      // the parent service for a service offer.
      locationParentId: claim.location_parent_id,
    });
    if (!branches.includes(Number(branchId))) return reject('WRONG_BRANCH');
  }

  return { ok: true };
}

/**
 * Which branch the merchant is redeeming at.
 *
 * Staff attached to a single branch redeem for that branch and are not asked;
 * a shop owner who covers several may say which, and a request that names one
 * they have no membership of is refused rather than quietly reassigned.
 */
function resolveBranch(actor, shopId, requestedBranchId) {
  const membership = actor.shops?.find((shop) => shop.shopId === Number(shopId));
  if (requestedBranchId === null || requestedBranchId === undefined) {
    return membership?.branchId ?? null;
  }
  const requested = Number(requestedBranchId);
  // A Super Admin has no membership anywhere but may act for any shop (§26).
  if (actor.isSuperAdmin) return requested;
  if (membership?.branchId && membership.branchId !== requested) {
    throw ApiError.forbidden('You can only redeem claims at your own branch');
  }
  return requested;
}

// ---------------------------------------------------------------------------
// What a branch admin may see
// ---------------------------------------------------------------------------

/**
 * Which claims belong to one branch, for a member confined to it.
 *
 * `offer_claims.branch_id` is filled in *at redemption*, so a claim's branch
 * is only a fact once somebody has honoured it. Before that the claim has no
 * branch at all, and refusing to show it would be worse than useless: the
 * shopkeeper looking a code up is standing at the counter the customer just
 * walked into. So two cases, and the second is the one that matters in
 * practice:
 *
 *   - redeemed here, which is the branch's own record of what it served; and
 *   - not yet redeemed, and redeemable here - the same `shop_wide` /
 *     `selected_branches` rule `allowedBranchIds` applies at the till.
 *
 * A claim redeemed at another branch therefore disappears from this branch's
 * list the moment it is redeemed, which is correct: it is now somebody else's
 * record. A claim for an `online` listing never appears, because no counter
 * can serve it.
 */
function branchVisibilityClause(branchId, kind = 'offer') {
  const descriptor = kindOf(kind);
  const branch = Number(branchId);
  return {
    sql: `(c.branch_id = ? OR (c.branch_id IS NULL AND ${descriptor.branchReachSql}))`,
    params: [branch, branch],
  };
}

/**
 * Narrows a claims query to what the caller's branch confinements allow,
 * leaving the shops they are not confined in alone.
 *
 * Confinement is per membership, so this cannot be a single branch id: the
 * same person may run the whole of one shop and one branch of another, and a
 * list that spans both must apply the restriction only where it exists. Hence
 * the shape - every row either belongs to an unconfined shop, or belongs to a
 * confined one *and* passes that shop's branch test.
 *
 * Returns null when nothing is confined, so callers can skip the clause
 * entirely rather than paste `1 = 1` into every query.
 *
 * @param {Map<number, number>} scopes from `accessControl.branchScopesFor`
 */
function branchScopeClause(scopes, kind = 'offer') {
  if (!scopes || scopes.size === 0) return null;

  const shopIds = [...scopes.keys()];
  const parts = [`c.shop_id NOT IN (${shopIds.map(() => '?').join(',')})`];
  const params = [...shopIds];

  for (const [shopId, branchId] of scopes) {
    const branch = branchVisibilityClause(branchId, kind);
    parts.push(`(c.shop_id = ? AND ${branch.sql})`);
    params.push(shopId, ...branch.params);
  }

  return { sql: `(${parts.join(' OR ')})`, params };
}

/**
 * The same question asked about one claim already loaded, for the endpoints
 * that fetch by id rather than list.
 *
 * Deliberately routed through `allowedBranchIds` instead of repeating the
 * rule: that function is what the till itself uses, so a branch admin can see
 * exactly the claims their counter could be asked to honour, and the two can
 * never drift apart.
 *
 * `permission` is read through `branchScopesFor` rather than `branchScopeFor`
 * so this agrees with the list filter in every case, the holder of a global
 * grant included. The alternative - a claim that appears in the list and then
 * 403s when opened - is the kind of disagreement nobody debugs twice.
 */
async function mayViewClaim(actor, claim, kind = 'offer', permission = 'VIEW_CLAIMS') {
  const scope = accessControl.branchScopesFor(actor, permission).get(Number(claim.shop_id));
  if (scope === undefined) return true;
  if (claim.branch_id !== null && claim.branch_id !== undefined) {
    return Number(claim.branch_id) === scope;
  }
  const branches = await allowedBranchIds({
    kind,
    shopId: claim.shop_id,
    applicabilityType: claim.applicability_type,
    locationParentId: claim.location_parent_id,
  });
  return branches.includes(scope);
}

// ---------------------------------------------------------------------------
// The verification log (§30) and the rate limiter it feeds (§28)
// ---------------------------------------------------------------------------

const VERIFICATION_METHODS = ['QR_SCAN', 'CODE_ENTRY'];

/**
 * Appends one attempt. Never throws: a failed log write must not turn a
 * successful redemption into an error the customer watches happen.
 */
async function logVerification(req, entry) {
  // Which pair of columns the claim and its parent listing go in depends on
  // the kind; everything else about the row is identical.
  const descriptor = kindOf(entry.kind);
  try {
    await execute(
      `INSERT INTO claim_verifications
         (claim_kind, ${descriptor.verificationClaimColumn}, ${descriptor.verificationParentColumn},
          shop_id, branch_id, customer_id, verified_by,
          code_attempted, method, action, reason, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        descriptor.key,
        entry.claimId ?? null,
        entry.parentId ?? null,
        entry.shopId ?? null,
        entry.branchId ?? null,
        entry.customerId ?? null,
        req?.user?.id ?? null,
        entry.code ?? null,
        entry.method,
        entry.action,
        entry.reason ?? null,
        req?.ip ?? null,
      ],
    );
  } catch (error) {
    logger.error(
      {
        event: 'CLAIM_VERIFICATION_LOG_FAILED',
        error_code: 'DB_TRANSACTION_FAILED',
        category: 'DATABASE',
        dependency: 'DATABASE',
        action: entry.action,
        err_message: error.message,
      },
      'Could not record a claim verification attempt',
    );
  }
}

/**
 * §28. Counted on rejections only, per merchant user, because that is what
 * distinguishes someone guessing codes from a busy Saturday: a real counter
 * produces mostly successes, and a fat-fingered code twice in a row is normal.
 *
 * Deliberately in the database rather than in express-rate-limit's memory - the
 * general limiter already covers request floods, while this one has to survive
 * a restart and follow the *user* across devices, which is §17's "changing
 * devices" applied to the merchant side.
 */
const FAILURE_WINDOW_MINUTES = 10;
const FAILURE_LIMIT = 10;

/**
 * The window is a module constant rather than a bound parameter: MySQL will not
 * take a placeholder for the count in `INTERVAL ? MINUTE` on every version, and
 * a number we wrote ourselves is not user input to begin with.
 */
async function countRecentFailures(userId) {
  const rows = await rawQuery(
    `SELECT COUNT(*) AS failures FROM claim_verifications
      WHERE verified_by = ? AND action = 'REJECTED'
        AND created_at > (NOW() - INTERVAL ${FAILURE_WINDOW_MINUTES} MINUTE)`,
    [userId],
  );
  return Number(rows[0]?.failures ?? 0);
}

async function assertNotRateLimited(userId) {
  if ((await countRecentFailures(userId)) < FAILURE_LIMIT) return;
  throw ApiError.tooMany('Too many unsuccessful attempts. Please try again later.');
}

/** How many more failures this user may make before the limiter closes in. */
async function failureBudget(userId) {
  return Math.max(FAILURE_LIMIT - (await countRecentFailures(userId)), 0);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Moves live claims past their expiry to `expired` (§12). Idempotent, and
 * purely cosmetic in the sense that `evaluate` never trusts the status anyway -
 * this is what keeps "My Claims" and the merchant's counts honest.
 */
async function syncExpiredClaims() {
  let expired = 0;
  for (const descriptor of Object.values(KINDS)) {
    const result = await execute(
      `UPDATE ${descriptor.claimsTable} SET status = 'expired'
        WHERE status = 'claimed' AND expires_at < NOW()`,
    );
    expired += Number(result.affectedRows ?? 0);
  }
  return expired;
}

/** Records the funnel event pair for a claim (§19, §32). */
async function recordClaimEvents(offer, userId) {
  await analyticsEvents.touchShopCustomer(offer.shop_id, userId, 'claim');
  await analyticsEvents.record(analyticsEvents.EVENT_TYPES.OFFER_CLAIM, {
    shopId: offer.shop_id,
    offerId: Number(offer.id),
    userId,
  });
}

module.exports = {
  CLAIM_SELECT,
  CODE_PREFIX,
  KINDS,
  kindOf,
  VERIFICATION_METHODS,
  FAILURE_LIMIT,
  FAILURE_WINDOW_MINUTES,
  generateCode,
  normaliseCode,
  signQrPayload,
  readQrPayload,
  qrValueFor,
  mapClaim,
  findById,
  findByCode,
  findAnyByCode,
  selectFor,
  SERVICE_CLAIM_SELECT,
  expiryFor,
  assertClaimable,
  issue,
  allowedBranchIds,
  evaluate,
  resolveBranch,
  branchVisibilityClause,
  branchScopeClause,
  mayViewClaim,
  logVerification,
  assertNotRateLimited,
  failureBudget,
  syncExpiredClaims,
  recordClaimEvents,
  REJECTIONS,
};
