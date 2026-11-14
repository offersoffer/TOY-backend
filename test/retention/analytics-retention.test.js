'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * The rules that keep analytics retention from deleting something a dashboard
 * will still be asked for, and from deleting it in a way that stalls the
 * database.
 *
 * Nothing pruned `visibility_events`, `analytics_events` or `offer_views`. The
 * reason that mattered is a measurement: on a generated 1-lakh-user dataset
 * `visibility_events` cost about 800 bytes a row on disk once its eight
 * secondary indexes were counted, so the table grows by roughly half a
 * gigabyte for every 600,000 impressions and never gives any of it back.
 *
 * The reason it needs tests is that the obvious fix is wrong in two ways:
 *
 *   - delete more than the dashboards can still be asked for, and a
 *     twelve-month chart is complete for eleven months and confidently zero
 *     for the twelfth. A deleted number presented as a measured one is worse
 *     than a refusal;
 *   - delete it in one statement, and a day of impressions is one transaction
 *     holding hundreds of thousands of row locks on the largest table in the
 *     database, which every reader of those dashboards also wants.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

process.env.LOG_LEVEL = 'silent';

/** Every DELETE the service issues, so the SQL itself can be asserted on. */
const calls = [];
/** Rows the fake table still has older than the horizon. */
let pending = 0;

stub('db/pool', {
  execute: async (sql, params) => {
    calls.push({ sql, params });
    // LIMIT is interpolated, not bound - MySQL takes no placeholder for it in
    // a prepared DELETE. Read it back out of the SQL, which also means these
    // tests fail if it ever silently becomes a placeholder again.
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1]);
    assert.ok(Number.isSafeInteger(limit) && limit > 0, `no integer LIMIT in: ${sql}`);
    const affected = Math.min(limit, pending);
    pending -= affected;
    return { affectedRows: affected };
  },
  rawQuery: async (sql, params) => {
    calls.push({ sql, params });
    return [{ remaining: pending }];
  },
});

const config = require(resolve('config/analyticsRetention'));
const retention = require(resolve('services/analyticsRetention'));

const reset = (rows) => {
  calls.length = 0;
  pending = rows;
};

// ---------------------------------------------------------------------------
// The invariant: retention cannot be set below what the API will answer.
// ---------------------------------------------------------------------------

test('retention longer than the longest query window is accepted', () => {
  config.assertWindowIsServable(400);
  config.assertWindowIsServable(config.MAX_QUERY_DAYS + config.MIN_MARGIN_DAYS);
});

test('retention equal to the longest query window is refused', () => {
  // The day the prune job deletes and the oldest day a merchant may ask for
  // would be the same day, and which ran first would decide the chart.
  assert.throws(() => config.assertWindowIsServable(config.MAX_QUERY_DAYS), /at least/);
});

test('retention below the margin is refused, and the error says what to set', () => {
  assert.throws(
    () => config.assertWindowIsServable(90),
    (error) =>
      error.message.includes(String(config.MAX_QUERY_DAYS + config.MIN_MARGIN_DAYS)) &&
      error.message.includes('maxQueryDays'),
  );
});

test('a non-numeric retention is refused rather than coerced', () => {
  assert.throws(() => config.assertWindowIsServable(Number.NaN), /Retention is/);
  assert.throws(() => config.assertWindowIsServable(undefined), /Retention is/);
});

test('each table is checked against its own window, not one shared number', () => {
  // The whole point of the split: visibility_events keeps 90 days because its
  // dashboards ask for at most 60, while offer_views keeps 400 because seven
  // premium dashboards still ask it for a year.
  config.assertHorizonsAreServable();
  assert.equal(config.retentionFor('visibility_events'), 90);
  assert.equal(config.retentionFor('offer_views'), 400);
  assert.ok(config.MAX_VISIBILITY_QUERY_DAYS < config.MAX_QUERY_DAYS);
  for (const [table, spec] of Object.entries(config.TABLES)) {
    assert.ok(
      spec.retentionDays >= spec.maxQueryDays + config.MIN_MARGIN_DAYS,
      `${table} cannot answer its own window`,
    );
  }
});

test('a table with no retention configured is refused rather than defaulted', () => {
  assert.throws(() => config.retentionFor('users'), /No retention configured/);
});

// ---------------------------------------------------------------------------
// The horizon a custom range is checked against.
// ---------------------------------------------------------------------------

test('a range inside the horizon is servable', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  assert.equal(config.isWithinRetention(new Date('2026-06-01'), 400, now), true);
});

test('a range older than the horizon is not servable', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  assert.equal(config.isWithinRetention(new Date('2023-01-01'), 400, now), false);
});

test('no explicit range is always servable, because `days` is already capped', () => {
  // The default path cannot reach past retention: `days` maxes at
  // MAX_QUERY_DAYS, which is below any retention the assertion permits.
  assert.equal(config.isWithinRetention(undefined, 400), true);
  assert.ok(config.MAX_QUERY_DAYS < config.MAX_QUERY_DAYS + config.MIN_MARGIN_DAYS);
});

test('the horizon keeps a day of margin, so asking for it exactly is not refused', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const earliest = config.earliestServable(400, now);
  assert.equal(config.isWithinRetention(earliest, 400, now), true);
  // 400 days before now is outside; the margin is one day, not more.
  const exact = new Date(now.getTime() - 400 * 86400000);
  assert.equal(config.isWithinRetention(exact, 400, now), false);
});

// ---------------------------------------------------------------------------
// Deleting: batching, budget, and the identifier guard.
// ---------------------------------------------------------------------------

test('deletes in batches rather than one statement', async () => {
  reset(5000);
  const result = await retention.pruneTable(config.EVENT_TABLES[0], 400);

  assert.equal(result.deleted, 5000);
  // 5000 rows at 2000 a batch: three statements, the last one short.
  assert.equal(result.batches, 3);
  // Interpolated as an integer, and never larger than one batch.
  assert.ok(calls.every((c) => /LIMIT \d+$/m.test(c.sql)));
  assert.ok(
    calls.every((c) => Number(/LIMIT (\d+)/.exec(c.sql)[1]) <= retention.BATCH_SIZE),
  );
  // `days` stays bound; only the LIMIT is interpolated.
  assert.ok(calls.every((c) => c.params.length === 1 && c.params[0] === 400));
});

test('walks the dated column so each batch uses the index', async () => {
  reset(10);
  await retention.pruneTable({ table: 'offer_views', column: 'created_at' }, 400);
  assert.ok(calls[0].sql.includes('ORDER BY `created_at`'));
  assert.ok(calls[0].sql.includes('`created_at` < DATE_SUB(NOW(), INTERVAL ? DAY)'));
});

test('stops as soon as a batch comes back short, without a wasted statement', async () => {
  reset(500);
  const result = await retention.pruneTable(config.EVENT_TABLES[0], 400);
  assert.equal(result.deleted, 500);
  assert.equal(result.batches, 1);
  assert.equal(result.budgetSpent, false);
  // No COUNT(*) when the backlog is clear - that count is an index scan of
  // exactly the rows the job exists to avoid touching.
  assert.ok(!calls.some((c) => c.sql.includes('COUNT(*)')));
});

test('stops at its budget and reports the backlog instead of running on', async () => {
  reset(50000);
  const result = await retention.pruneTable(config.EVENT_TABLES[0], 400, 4000);

  assert.equal(result.deleted, 4000);
  assert.equal(result.budgetSpent, true);
  // Falling behind is a number, not a stalled database.
  assert.equal(result.remaining, 46000);
  assert.ok(calls.some((c) => c.sql.includes('COUNT(*)')));
});

test('a budget smaller than one batch is still honoured exactly', async () => {
  reset(10000);
  const result = await retention.pruneTable(config.EVENT_TABLES[0], 400, 500);
  assert.equal(result.deleted, 500);
  assert.equal(Number(/LIMIT (\d+)/.exec(calls[0].sql)[1]), 500);
});

test('refuses a table it was not configured for', async () => {
  reset(100);
  // The table and column are interpolated, because MySQL takes no placeholder
  // for an identifier. This is what keeps that from being a way in.
  await assert.rejects(
    () => retention.pruneTable({ table: 'users', column: 'created_at' }, 400),
    /Refusing to prune unknown table/,
  );
  await assert.rejects(
    () => retention.pruneTable({ table: 'offer_views', column: 'id`; DROP TABLE users; --' }, 400),
    /Refusing to prune unknown table/,
  );
  assert.equal(calls.length, 0, 'nothing should have been issued');
});

test('search_history is deliberately not in scope', () => {
  // `recommendations.rememberSearch` already trims each user to 20 terms on
  // every insert, so the table is bounded by user count, not by time.
  assert.ok(!config.EVENT_TABLES.some((t) => t.table === 'search_history'));
});

test('the delete list and the partition list are disjoint and complete', () => {
  // `visibility_events` moved to PARTITIONED_TABLES: deleting rows from a
  // partitioned table is measurably worse than from a plain one, so exactly
  // one mechanism owns each table.
  assert.deepEqual(config.EVENT_TABLES.map((t) => t.table).sort(), [
    'analytics_events',
    'offer_views',
  ]);
  assert.deepEqual(config.PARTITIONED_TABLES.map((t) => t.table), ['visibility_events']);
  const all = [...config.EVENT_TABLES, ...config.PARTITIONED_TABLES];
  assert.equal(new Set(all.map((t) => t.table)).size, all.length, 'no table on both lists');
  assert.ok(all.every((t) => t.column === 'created_at'));
});

test('pruneAll covers every delete-managed table and totals what it removed', async () => {
  reset(300);
  const result = await retention.pruneAll();
  assert.equal(result.perTable.length, config.EVENT_TABLES.length);
  assert.equal(
    result.deleted,
    result.perTable.reduce((sum, r) => sum + r.deleted, 0),
  );
  // 300 rows shared across the fake table: the first clears them, the rest
  // find nothing, which is what a caught-up run looks like.
  assert.equal(result.deleted, 300);
});

test('pruneAll asks each table for its own retention', async () => {
  reset(10);
  await retention.pruneAll();
  // The DELETEs bind `days`; every one should be that table's own number.
  const deletes = calls.filter((c) => c.sql.includes('DELETE FROM'));
  assert.ok(deletes.length > 0);
  for (const call of deletes) {
    const table = /DELETE FROM `([a-z_]+)`/.exec(call.sql)[1];
    assert.equal(call.params[0], config.retentionFor(table), `${table} got the wrong horizon`);
  }
});
