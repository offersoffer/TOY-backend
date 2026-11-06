'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * Claiming a shop that already exists (Self-Service Onboarding §16).
 *
 * The rules that matter here are all about what a claim must *not* do: grant
 * access before anyone approves it, reveal who currently runs the shop, or
 * remove them when it is approved. The database is stubbed so these run in
 * CI, which has no MySQL.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

let shop;
let claimRow;
let existingMember;
let openClaim;
let writes;
let txWrites;
let affectedRows;
let notified;

stub('db/pool', {
  queryOne: async (sql) => {
    if (sql.includes('FROM shops WHERE id')) return shop;
    if (sql.includes('FROM shop_members')) return existingMember;
    if (sql.includes('FROM shop_claim_requests\n      WHERE shop_id')) return openClaim;
    if (sql.includes('shop_claim_requests cr')) return claimRow;
    if (sql.includes('COUNT(*)')) return { count: 0 };
    return null;
  },
  query: async (sql) => (sql.includes('shop_members') ? incumbents : []),
  execute: async (sql, params) => {
    writes.push({ sql, params });
    return { affectedRows, insertId: 55 };
  },
  transaction: async (fn) =>
    fn({
      query: async (sql, params) => {
        txWrites.push({ sql, params });
        if (sql.includes('SELECT id FROM roles')) return [[{ id: 2 }]];
        return [{ affectedRows }];
      },
      execute: async (sql, params) => {
        txWrites.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
    }),
});

stub('services/notifications', {
  dispatch: async (recipients, payload) => notified.push({ to: recipients.map((r) => r.id), ...payload }),
  notifyShopTeam: async (shopId, payload) => notified.push({ shopTeam: shopId, ...payload }),
});

/** The incumbents the team notification goes to, set per test. */
let incumbents = [];

const claims = require(path.join(SRC, 'modules/onboarding/claim.service'));

const SELLER = { id: 7, isSuperAdmin: false };
const REVIEWER = { id: 3, isSuperAdmin: true };

const pendingClaim = () => ({
  id: 55,
  shop_id: 9,
  requester_id: SELLER.id,
  reason: 'This is my family shop and I have the GST certificate.',
  contact_phone: '+91 97890 41201',
  status: 'PENDING',
  reviewer_id: null,
  decision_reason: null,
  decided_at: null,
  created_at: '2026-11-01 10:00:00',
  shop_name: 'Meenakshi Stores',
  shop_slug: 'meenakshi-stores',
  requester_name: 'Lakshmi Iyer',
  requester_email: 'lakshmi@example.com',
});

test.beforeEach(() => {
  shop = { id: 9, name: 'Meenakshi Stores', verification_status: null };
  claimRow = pendingClaim();
  existingMember = null;
  openClaim = null;
  writes = [];
  txWrites = [];
  affectedRows = 1;
  notified = [];
  incumbents = [{ id: 12, name: 'John Mathew', email: 'john@example.com' }];
});

// ---- normalising what people type ----------------------------------------

test('names match across punctuation, case and spacing', () => {
  // "Sri Meenakshi Stores (Gandhipuram)" and "sri meenakshi stores" are one
  // shop typed by two people.
  assert.equal(claims.normalizeName('Sri  MEENAKSHI Stores!'), 'sri meenakshi stores');
  assert.equal(claims.normalizeName('M/s. Kovai-Electronics'), 'm s kovai electronics');
});

test('phone numbers match however they were written', () => {
  // Indian mobiles are ten digits behind every combination of +91, 0, spaces
  // and dashes, so the tail is the only reliable thing to compare.
  const expected = '9789041201';
  for (const written of ['+91 97890 41201', '09789041201', '+91-97890-41201', '9789041201']) {
    assert.equal(claims.normalizePhone(written), expected, `${written} should normalise`);
  }
});

// ---- a claim grants nothing ----------------------------------------------

test('making a claim never touches shop membership', async () => {
  // §16: a claim request must not grant access before approval. The surest
  // version of that rule is that this code path cannot write the grant.
  await claims.createClaim(
    { shopId: 9, reason: 'This is my family shop and I have the GST certificate.' },
    SELLER,
  );

  const membershipWrites = writes.filter((w) => /shop_members/i.test(w.sql));
  assert.equal(membershipWrites.length, 0);
  assert.equal(writes.filter((w) => /INSERT INTO shop_claim_requests/i.test(w.sql)).length, 1);
});

test('a second request while one is open is the same claim, not a new one', async () => {
  // A double-tap on a patchy connection is a retry (§19).
  openClaim = { id: 55 };
  await claims.createClaim({ shopId: 9, reason: 'This is my family shop, truly.' }, SELLER);
  assert.equal(writes.filter((w) => /INSERT INTO shop_claim_requests/i.test(w.sql)).length, 0);
});

test('you cannot claim a shop you already manage', async () => {
  existingMember = { 1: 1 };
  await assert.rejects(
    () => claims.createClaim({ shopId: 9, reason: 'This is my family shop, truly.' }, SELLER),
    (error) => error.status === 409 && /already manage/i.test(error.message),
  );
});

test("you cannot claim someone else's registration in flight", async () => {
  // Those are not public, were never shown in the search, and saying "not
  // found" keeps it that way rather than confirming one exists.
  for (const status of ['DRAFT', 'PENDING_VERIFICATION', 'ADDITIONAL_INFO_REQUIRED', 'REJECTED']) {
    shop = { id: 9, name: 'Meenakshi Stores', verification_status: status };
    await assert.rejects(
      () => claims.createClaim({ shopId: 9, reason: 'This is my family shop, truly.' }, SELLER),
      (error) => error.status === 404,
      `${status} should not be claimable`,
    );
  }
});

// ---- reading a claim ------------------------------------------------------

test('one seller cannot read another seller’s claim', async () => {
  claimRow = { ...pendingClaim(), requester_id: 99 };
  await assert.rejects(
    () => claims.getClaim(55, SELLER),
    (error) => error.status === 404,
  );
});

test('the requester is not told who else is on the shop', async () => {
  // §16: do not disclose current manager account details. The seller's view
  // of their own claim carries the shop and their own words, nothing about
  // whoever runs it today.
  const claim = await claims.getClaim(55, SELLER);
  assert.equal(claim.requester, undefined);
  assert.deepEqual(Object.keys(claim).sort(), [
    'contactPhone',
    'createdAt',
    'decidedAt',
    'decisionReason',
    'id',
    'reason',
    'shopId',
    'shopName',
    'shopSlug',
    'status',
  ]);
});

// ---- approving ------------------------------------------------------------

test('approving adds a member and removes nobody', async () => {
  // §16: existing managers must not be dropped automatically. A shop with
  // two managers is a supported state, so approve means "also", not
  // "instead".
  await claims.approveClaim(55, REVIEWER);

  const inserts = txWrites.filter((w) => /INSERT INTO shop_members/i.test(w.sql));
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].params, [9, SELLER.id, 2]);

  const removals = txWrites.filter((w) => /DELETE FROM shop_members|status = 'inactive'/i.test(w.sql));
  assert.equal(removals.length, 0, 'no existing manager should be touched');
});

test('the grant and the decision are written together', async () => {
  // A grant with no decision row is access nobody can account for; a decision
  // with no grant is a seller told they have access that they do not.
  await claims.approveClaim(55, REVIEWER);
  assert.ok(txWrites.some((w) => /UPDATE shop_claim_requests/i.test(w.sql)));
  assert.ok(txWrites.some((w) => /INSERT INTO shop_members/i.test(w.sql)));
  // Nothing was written outside the transaction.
  assert.equal(writes.filter((w) => /shop_members/i.test(w.sql)).length, 0);
});

test('a claim decided by someone else a moment ago is a conflict', async () => {
  affectedRows = 0;
  await assert.rejects(
    () => claims.approveClaim(55, REVIEWER),
    (error) => error.status === 409,
  );
  assert.equal(
    txWrites.filter((w) => /INSERT INTO shop_members/i.test(w.sql)).length,
    0,
    'a claim that was not approved must not grant access',
  );
});

test('an already-decided claim cannot be approved again', async () => {
  claimRow = { ...pendingClaim(), status: 'APPROVED' };
  await assert.rejects(
    () => claims.approveClaim(55, REVIEWER),
    (error) => error.status === 409 && /already been decided/i.test(error.message),
  );
  assert.equal(txWrites.length, 0);
});

test('both sides are told, and the incumbents are not told why', async () => {
  // §18. The reason was written for the reviewer, not for the people already
  // on the shop.
  await claims.approveClaim(55, REVIEWER);

  const toRequester = notified.find((n) => n.type === 'SHOP_CLAIM_APPROVED');
  const toTeam = notified.find((n) => n.type === 'SHOP_MEMBER_ADDED');
  assert.ok(toRequester && toTeam);
  assert.deepEqual(toRequester.to, [SELLER.id]);
  assert.doesNotMatch(toTeam.message, /GST certificate/);
});

test('the new manager is not told about themselves in the third person', async () => {
  // They get their own "you now have access" message; being included in the
  // team's "someone was added" as well reads as a bug.
  await claims.approveClaim(55, REVIEWER);
  const toTeam = notified.find((n) => n.type === 'SHOP_MEMBER_ADDED');
  assert.deepEqual(toTeam.to, [12]);
  assert.ok(!toTeam.to.includes(SELLER.id));
});

// ---- rejecting ------------------------------------------------------------

test('rejecting records the reason and tells the requester', async () => {
  await claims.rejectClaim(55, 'We could not confirm you are connected to this business.', REVIEWER);

  const update = writes.find((w) => /UPDATE shop_claim_requests/i.test(w.sql));
  assert.match(update.sql, /status = 'REJECTED'/);
  assert.equal(update.params[1], 'We could not confirm you are connected to this business.');

  const message = notified.find((n) => n.type === 'SHOP_CLAIM_REJECTED');
  assert.match(message.message, /could not confirm/);
});

test('rejecting grants nothing', async () => {
  await claims.rejectClaim(55, 'We could not confirm you are connected to this business.', REVIEWER);
  assert.equal(writes.filter((w) => /shop_members/i.test(w.sql)).length, 0);
  assert.equal(txWrites.length, 0);
});

// ---- withdrawing ----------------------------------------------------------

test('only an undecided claim can be withdrawn', async () => {
  claimRow = { ...pendingClaim(), status: 'REJECTED' };
  await assert.rejects(
    () => claims.withdrawClaim(55, SELLER),
    (error) => error.status === 409,
  );
});

// ---- the index that decides how often a claim may be re-tried -------------

/**
 * The stubs above cannot reach this, so it is asserted against the DDL.
 *
 * "One live claim per person per shop" is enforced by a unique key, not by
 * JavaScript - `createClaim` reads an open claim and returns it, which closes
 * the ordinary double-tap but not two concurrent requests. The key shipped as
 * (shop_id, requester_id, status), which also held *decided* rows unique:
 * MySQL exempts only NULLs from a UNIQUE index and `status` is never NULL, so
 * a claimant was capped at one WITHDRAWN and one REJECTED row per shop for
 * life. Withdrawing a second request, and a reviewer rejecting a second
 * attempt, both died on a duplicate key.
 */
test('§16: the unique key constrains live claims only', () => {
  const fs = require('node:fs');
  const ddl = fs.readFileSync(path.join(SRC, 'db/schema.sql'), 'utf8');
  // Comments stripped first: prose in this table contains a semicolon, so
  // splitting the raw text on one lands in the middle of the definition.
  const table = ddl
    .slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS shop_claim_requests'))
    .replace(/--[^\n]*/g, '');
  const body = table.slice(0, table.indexOf(';'));

  const key = body.match(/UNIQUE KEY uq_claim_open \(([^)]*)\)/);
  assert.ok(key, 'uq_claim_open is missing');
  const columns = key[1].split(',').map((c) => c.trim());

  assert.deepEqual(
    columns,
    ['shop_id', 'requester_id', 'claim_open'],
    'the key must discriminate on claim_open, never on status',
  );
  assert.match(
    body,
    /claim_open\s+TINYINT UNSIGNED AS \(IF\(status = 'PENDING', 1, NULL\)\) STORED/,
    'claim_open must be NULL for every decided claim, or the key still binds them',
  );
  // Both foreign keys borrow this index, so shop_id has to stay leftmost.
  assert.equal(columns[0], 'shop_id');
});

test('§16: an existing database is patched to the corrected key', () => {
  const fs = require('node:fs');
  const migrate = fs.readFileSync(path.join(SRC, 'db/migrate.js'), 'utf8');
  assert.match(migrate, /uq_claim_open covers live claims only/);
  // Keyed off the old shape, so the patch runs exactly once.
  assert.match(migrate, /INDEX_NAME = 'uq_claim_open' AND COLUMN_NAME = 'status'/);
});
