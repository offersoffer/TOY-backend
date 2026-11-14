'use strict';

const { execute, rawQuery } = require('../db/pool');
const logger = require('../utils/logger');
const config = require('../config/analyticsRetention');
const env = require('../config/env');
const partitions = require('./analyticsPartitions');

/**
 * Nightly deletion of raw analytics events past their retention window.
 *
 * ## Why this exists
 *
 * Nothing pruned these tables. The `prune` job swept tokens, read
 * notifications, the failure log and settled idempotency keys, and left the
 * four event tables to grow forever. Measured on a generated dataset,
 * `visibility_events` costs about **800 bytes a row on disk** once its eight
 * secondary indexes are counted - so a shop network drawing 600,000
 * impressions a day adds roughly half a gigabyte a day, about 14 GB a month,
 * and never gives any of it back.
 *
 * ## Why it deletes in batches
 *
 * One `DELETE ... WHERE created_at < ?` covering a day of impressions is a
 * single transaction holding hundreds of thousands of row locks, with an undo
 * log to match. On a small instance that is a long stall on the table every
 * reader of the dashboards also wants. Deleting in bounded batches keeps each
 * transaction short and lets normal traffic interleave; `ORDER BY` the dated
 * column so each batch walks the index rather than scanning.
 *
 * ## Why it has a budget
 *
 * A job that must finish cannot be trusted to stop. If this has not run for a
 * month, the first run would otherwise try to delete a month of events in one
 * sitting. Instead each table gets a row budget per run: the job removes what
 * it can, reports the backlog it did not clear, and the next night continues.
 * Falling behind becomes a number in a log line rather than a stalled database.
 */

/** Rows removed per statement. Small enough that no single lock is long-lived. */
const BATCH_SIZE = 2000;

/** Rows removed per table per run. One night of a very busy day, with room over. */
const DEFAULT_BUDGET = 1000000;

/**
 * Deletes rows older than `days` from one table, in batches, up to `budget`.
 *
 * The table and column are interpolated rather than bound because MySQL does
 * not accept identifiers as placeholders. They come from `EVENT_TABLES` in
 * config, never from a request, and are checked against it here so that remains
 * true however this is called.
 *
 * @returns {Promise<{table: string, deleted: number, batches: number, budgetSpent: boolean, remaining: number|null}>}
 */
async function pruneTable({ table, column }, days, budget = DEFAULT_BUDGET) {
  // Both lists, because a partitioned table still needs deleting on a database
  // where the conversion has not run yet.
  const known = [...config.EVENT_TABLES, ...config.PARTITIONED_TABLES].some(
    (t) => t.table === table && t.column === column,
  );
  if (!known) throw new Error(`Refusing to prune unknown table/column: ${table}.${column}`);

  let deleted = 0;
  let batches = 0;

  while (deleted < budget) {
    const limit = Math.min(BATCH_SIZE, budget - deleted);
    /*
     * `LIMIT` is interpolated, not bound.
     *
     * MySQL's prepared-statement protocol does not accept a placeholder for
     * LIMIT here: `execute` with `LIMIT ?` fails outright with "Incorrect
     * arguments to mysqld_stmt_execute". That is not a thing a mocked pool can
     * tell you - it only shows up against a real server, which is where this
     * was found.
     *
     * It is interpolated safely: `limit` is derived from BATCH_SIZE and the
     * caller's budget, never from a request, and it is forced to a
     * non-negative integer on the line below so no expression can survive the
     * trip even if a future caller passes something odd.
     */
    const safeLimit = Math.max(0, Math.floor(Number(limit)));
    if (!Number.isSafeInteger(safeLimit) || safeLimit === 0) break;

    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: the
    // point of batching is that only one of these is in flight at a time.
    const result = await execute(
      `DELETE FROM \`${table}\` WHERE \`${column}\` < DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY \`${column}\` LIMIT ${safeLimit}`,
      [days],
    );
    const affected = result.affectedRows ?? 0;
    deleted += affected;
    batches += 1;
    if (affected < safeLimit) break; // nothing older is left
  }

  const budgetSpent = deleted >= budget;
  let remaining = null;
  if (budgetSpent) {
    // Only counted when the budget ran out, because that is the only time the
    // answer is interesting and the only time it is not zero. Counting it on
    // every run would add a full index scan of old rows to a job whose whole
    // purpose is to touch the table as little as possible.
    const [row] = await rawQuery(
      `SELECT COUNT(*) AS remaining FROM \`${table}\`
        WHERE \`${column}\` < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days],
    );
    remaining = Number(row?.remaining ?? 0);
  }

  return { table, deleted, batches, budgetSpent, remaining };
}

/**
 * Prunes every table in `EVENT_TABLES`.
 *
 * Sequential rather than parallel: these are the largest tables in the
 * database and three concurrent delete storms would be the stall that batching
 * exists to avoid.
 */
async function pruneAll(days, budget = DEFAULT_BUDGET) {
  config.assertWindowIsServable(days);

  const results = [];
  for (const target of config.EVENT_TABLES) {
    // eslint-disable-next-line no-await-in-loop -- see above.
    results.push(await pruneTable(target, days, budget));
  }

  const behind = results.filter((r) => r.budgetSpent);
  if (behind.length) {
    logger.warn(
      {
        event: 'ANALYTICS_RETENTION_BEHIND',
        category: 'DATABASE',
        retention_days: days,
        tables: behind.map((r) => ({ table: r.table, remaining: r.remaining })),
      },
      'Analytics retention spent its budget before clearing the backlog',
    );
  }

  return {
    retentionDays: days,
    deleted: results.reduce((sum, r) => sum + r.deleted, 0),
    perTable: results,
  };
}

/**
 * The whole nightly policy, in the order it has to happen.
 *
 * Partitions first: adding next month's partition is what keeps inserts out of
 * the catch-all, and that is cheap only while the catch-all is empty. Dropping
 * expired partitions comes with it, inside `maintain`.
 *
 * Then the row-by-row tables. And then the fallback that makes this safe to
 * deploy before the partition conversion has run: if `visibility_events` is
 * still a plain table, it is pruned by deletion like the others rather than
 * left to grow because a migration has not happened yet.
 */
async function run(days = env.analytics.retentionDays, budget = DEFAULT_BUDGET) {
  config.assertWindowIsServable(days);

  const partitionWork = await partitions.maintain(days);
  const deleted = await pruneAll(days, budget);

  const fallbacks = [];
  for (const target of config.PARTITIONED_TABLES) {
    // eslint-disable-next-line no-await-in-loop -- one table at a time, as above.
    if (await partitions.isPartitioned(target.table)) continue;
    logger.warn(
      {
        event: 'ANALYTICS_RETENTION_FALLBACK',
        category: 'DATABASE',
        table: target.table,
      },
      `${target.table} is not partitioned yet; pruning it by deletion instead`,
    );
    // eslint-disable-next-line no-await-in-loop -- see above.
    fallbacks.push(await pruneTable(target, days, budget));
  }

  return {
    retentionDays: days,
    partitions: partitionWork,
    deleted: deleted.deleted + fallbacks.reduce((sum, r) => sum + r.deleted, 0),
    perTable: [...deleted.perTable, ...fallbacks],
  };
}

module.exports = { run, pruneAll, pruneTable, BATCH_SIZE, DEFAULT_BUDGET };
