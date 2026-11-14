'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Monthly partitions on `visibility_events`: the naming, the maintenance, and
 * the thing partitioning cost us.
 *
 * InnoDB will not keep a foreign key on a partitioned table - "Foreign keys
 * are not yet supported in conjunction with partitioning", error 1506 - so all
 * six of this table's keys had to go. Five of them were housekeeping. One was
 * not: `fk_ve_user ON DELETE SET NULL` is what anonymised a deleted account's
 * impression rows, and that is a promise to a person. `scrubUser` is its
 * replacement, and the last test in this file is the one that fails if the
 * account-deletion path ever stops calling it.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

process.env.LOG_LEVEL = 'silent';

/** Statements issued, so the generated DDL can be asserted on. */
const calls = [];
/** What `information_schema.PARTITIONS` should appear to contain. */
let partitions = [];

stub('db/pool', {
  execute: async (sql, params) => {
    calls.push({ sql, params });
    return { affectedRows: 1 };
  },
  rawQuery: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('PARTITION_NAME IS NOT NULL LIMIT 1')) {
      return partitions.length ? [{ 1: 1 }] : [];
    }
    if (sql.includes('information_schema.PARTITIONS')) {
      return partitions.map((p) => ({
        name: p.name,
        bound: p.bound === 'MAXVALUE' ? 'MAXVALUE' : `'${p.bound}'`,
        row_estimate: p.rows ?? 0,
      }));
    }
    return [];
  },
});

const parts = require(resolve('services/analyticsPartitions'));
const config = require(resolve('config/analyticsRetention'));

const monthly = (names) => [
  ...names.map((n) => ({ name: `p${n.replace('-', '_')}`, bound: nextMonth(n), rows: 100 })),
  { name: 'p_future', bound: 'MAXVALUE', rows: 0 },
];
function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
const reset = (p = []) => {
  calls.length = 0;
  partitions = p;
};

// ---------------------------------------------------------------------------
// Naming and bounds.
// ---------------------------------------------------------------------------

test('a partition is named for the month it holds', () => {
  assert.equal(parts.partitionNameFor(new Date('2026-11-14T00:00:00Z')), 'p2026_11');
  assert.equal(parts.partitionNameFor(new Date('2026-01-01T00:00:00Z')), 'p2026_01');
});

test('the bound is the first instant NOT in the month, which is what RANGE wants', () => {
  assert.equal(parts.upperBoundFor(new Date('2026-11-14T00:00:00Z')), '2026-12-01');
});

test('December rolls the year rather than producing month 13', () => {
  const dec = new Date('2026-12-05T00:00:00Z');
  assert.equal(parts.partitionNameFor(dec), 'p2026_12');
  assert.equal(parts.upperBoundFor(dec), '2027-01-01');
});

test('names sort in the same order as the ranges they cover', () => {
  const months = parts.monthsBetween(
    new Date('2026-09-01T00:00:00Z'),
    new Date('2027-02-01T00:00:00Z'),
  );
  const names = months.map(parts.partitionNameFor);
  assert.deepEqual(names, [...names].sort());
});

// ---------------------------------------------------------------------------
// monthsBetween, which exists because of a rehearsal failure.
// ---------------------------------------------------------------------------

test('spans every month inclusive of both ends', () => {
  const months = parts.monthsBetween(
    new Date('2026-08-17T00:00:00Z'),
    new Date('2027-01-05T00:00:00Z'),
  );
  assert.deepEqual(months.map(parts.partitionNameFor), [
    'p2026_08', 'p2026_09', 'p2026_10', 'p2026_11', 'p2026_12', 'p2027_01',
  ]);
});

test('one month in and one month out', () => {
  const months = parts.monthsBetween(
    new Date('2026-11-14T00:00:00Z'),
    new Date('2026-11-20T00:00:00Z'),
  );
  assert.equal(months.length, 1);
});

test('a row dated absurdly long ago cannot spin the loop', () => {
  // The conversion reads MIN(created_at) from real data. A bad clock or an
  // imported row from 1970 must not try to declare six hundred partitions.
  const months = parts.monthsBetween(new Date('1970-01-01Z'), new Date('2026-11-14Z'));
  assert.ok(months.length <= 600);
});

// ---------------------------------------------------------------------------
// Creating the months ahead.
// ---------------------------------------------------------------------------

test('creates the current month and the months ahead when they are missing', async () => {
  reset([{ name: 'p_future', bound: 'MAXVALUE', rows: 0 }]);
  const result = await parts.ensureFuturePartitions(parts.TABLE, new Date('2026-11-14Z'));

  assert.deepEqual(result.added, ['p2026_11', 'p2026_12', 'p2027_01']);
  const ddl = calls.filter((c) => c.sql.includes('REORGANIZE'));
  assert.equal(ddl.length, 3);
  // Splitting the empty catch-all, never an occupied partition.
  assert.ok(ddl.every((c) => c.sql.includes('REORGANIZE PARTITION `p_future`')));
  assert.ok(ddl.every((c) => c.sql.includes('VALUES LESS THAN (MAXVALUE)')));
});

test('adds nothing when the months already exist', async () => {
  reset(monthly(['2026-11', '2026-12', '2027-01']));
  const result = await parts.ensureFuturePartitions(parts.TABLE, new Date('2026-11-14Z'));
  assert.deepEqual(result.added, []);
  assert.equal(calls.filter((c) => c.sql.includes('ALTER TABLE')).length, 0);
});

test('does nothing at all on a table that is not partitioned yet', async () => {
  reset([]);
  const result = await parts.ensureFuturePartitions(parts.TABLE, new Date('2026-11-14Z'));
  assert.equal(result.skipped, 'not partitioned');
  assert.equal(calls.filter((c) => c.sql.includes('ALTER TABLE')).length, 0);
});

// ---------------------------------------------------------------------------
// Dropping the months past the horizon.
// ---------------------------------------------------------------------------

test('drops only the months whose last day is past the horizon', async () => {
  reset(monthly(['2025-09', '2025-10', '2026-10', '2026-11']));
  const now = new Date('2026-11-14T00:00:00Z');
  // 200 days back from 14 Nov 2026 is 28 Apr 2026.
  const result = await parts.dropExpiredPartitions(200, parts.TABLE, now);

  assert.deepEqual(result.dropped.map((d) => d.partition), ['p2025_09', 'p2025_10']);
  assert.ok(calls.filter((c) => c.sql.includes('DROP PARTITION')).length === 2);
});

test('a partition is kept until its upper bound passes, never its oldest day', async () => {
  // The month containing the horizon must survive whole: dropping it for the
  // sake of its first days would delete data a merchant can still ask for.
  reset(monthly(['2026-04', '2026-05']));
  const now = new Date('2026-11-14T00:00:00Z');
  const result = await parts.dropExpiredPartitions(200, parts.TABLE, now);
  // April ends 1 May, which is after the 28 Apr horizon - so it stays.
  assert.deepEqual(result.dropped, []);
});

test('never drops the catch-all, whatever the retention', async () => {
  reset([{ name: 'p_future', bound: 'MAXVALUE', rows: 0 }]);
  const result = await parts.dropExpiredPartitions(1, parts.TABLE, new Date('2026-11-14Z'));
  assert.deepEqual(result.dropped, []);
  assert.equal(calls.filter((c) => c.sql.includes('DROP PARTITION')).length, 0);
});

test('drops nothing on a table that is not partitioned yet', async () => {
  reset([]);
  const result = await parts.dropExpiredPartitions(400, parts.TABLE, new Date('2026-11-14Z'));
  assert.equal(result.skipped, 'not partitioned');
});

// ---------------------------------------------------------------------------
// Order, and the two tables not claiming each other.
// ---------------------------------------------------------------------------

test('maintain creates before it drops', async () => {
  reset(monthly(['2025-01', '2026-11']));
  await parts.maintain(200, new Date('2026-11-14T00:00:00Z'));
  const ddl = calls.filter((c) => c.sql.includes('ALTER TABLE')).map((c) => c.sql);
  const firstDrop = ddl.findIndex((s) => s.includes('DROP PARTITION'));
  const lastAdd = ddl.map((s) => s.includes('REORGANIZE')).lastIndexOf(true);
  assert.ok(lastAdd < firstDrop, 'every REORGANIZE must precede the first DROP');
});

test('the partitioned table is not also on the delete list', () => {
  // Deleting rows from a partitioned table is measurably worse than from a
  // plain one - 4,585 rows a second against 31,000 - so only one of the two
  // mechanisms may own it.
  assert.ok(config.PARTITIONED_TABLES.some((t) => t.table === parts.TABLE));
  assert.ok(!config.EVENT_TABLES.some((t) => t.table === parts.TABLE));
});

// ---------------------------------------------------------------------------
// The promise the dropped foreign key used to keep.
// ---------------------------------------------------------------------------

test('scrubUser anonymises by user id, and is indexable', async () => {
  reset(monthly(['2026-11']));
  await parts.scrubUser(7);
  const update = calls.find((c) => c.sql.includes('UPDATE'));
  assert.ok(update, 'an UPDATE should have been issued');
  assert.match(update.sql, /SET user_id = NULL WHERE user_id = \?/);
  // Bound, not interpolated - this one takes a value from a request path.
  assert.deepEqual(update.params, [7]);
});

test('the account-deletion path still calls it', () => {
  // The replacement for `fk_ve_user ON DELETE SET NULL`. If this file stops
  // mentioning it, deleting an account silently leaves that person's browsing
  // attached to their id, and nothing else in the system would notice.
  const source = require('node:fs').readFileSync(
    path.join(SRC, 'modules/users/user.routes.js'),
    'utf8',
  );
  assert.match(source, /analyticsPartitions\.scrubUser\(req\.user\.id\)/);
  // Before the DELETE, or there is no id left to match on.
  assert.ok(
    source.indexOf('scrubUser(req.user.id)') < source.indexOf("DELETE FROM users WHERE id = ?"),
    'the scrub must run before the user row is deleted',
  );
});
