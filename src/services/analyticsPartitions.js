'use strict';

const { rawQuery, execute } = require('../db/pool');
const logger = require('../utils/logger');
const retentionConfig = require('../config/analyticsRetention');

/**
 * Monthly range partitions on `visibility_events`, and the two jobs that keep
 * them: add the months ahead, drop the months past retention.
 *
 * ## Why this table and not the other two
 *
 * `visibility_events` is most of the storage problem on its own. Measured on a
 * generated dataset of a million impressions: **297 MB of data and 593 MB of
 * index**, about 890 bytes a row, because the table carries eight secondary
 * indexes so the dashboards can be fast. `analytics_events` and `offer_views`
 * are narrower and lower-volume, and the batched delete in
 * `analyticsRetention` is enough for them.
 *
 * ## Why partitioning is worth its price here
 *
 * Measured on that same million rows, before and after:
 *
 * | | unpartitioned | monthly partitions |
 * |---|---|---|
 * | remove a month of old rows | ~2.3 s (batched DELETE) | **0.11 s** (DROP PARTITION) |
 * | surface breakdown, 30 days | 217 ms | **51 ms** |
 * | one shop, 30 days | 1.6 ms | 1.0 ms |
 * | one shop, 365 days | 1.2 ms | **2.1 ms** |
 *
 * The long per-shop window gets *slower*, because a year now spans thirteen
 * partitions and thirteen index trees instead of one. That is the real trade
 * and it is worth taking: the queries that got faster are the ones that were
 * slow, and deleting a month stops being a seven-second delete storm against
 * the largest table in the database.
 *
 * ## Why a partitioned table must not be deleted from row by row
 *
 * It is not merely that DROP PARTITION is faster. Batched deletion gets
 * *worse* once the table is partitioned - measured at 4,585 rows a second
 * against 31,000 on the same unpartitioned table, because the statement has to
 * consider every partition. So partitioning and `pruneTable` are alternatives,
 * never both, and `analyticsRetention.EVENT_TABLES` deliberately does not list
 * this table once it is partitioned.
 *
 * ## What partitioning costs, and what had to be replaced
 *
 * InnoDB refuses outright: *"Foreign keys are not yet supported in conjunction
 * with partitioning"* (error 1506). All six of this table's foreign keys had to
 * go, so what they were doing is now done deliberately:
 *
 *   - `fk_ve_user ON DELETE SET NULL` anonymised a deleted account's rows.
 *     That is a promise to a person, not housekeeping, so it is now an explicit
 *     UPDATE in the account-deletion path - see `scrubUser` below, and the
 *     test that fails if it is ever dropped.
 *   - `fk_ve_shop ON DELETE CASCADE` removed a deleted shop's rows. These are
 *     now left to age out with retention, on purpose: a shop with a year of
 *     impressions would otherwise make an admin's delete button into a
 *     multi-million-row DELETE, and the rows are unreachable anyway because
 *     every read is scoped to a shop the caller can still see, and MySQL never
 *     reissues an AUTO_INCREMENT id.
 *   - the four remaining SET NULLs (branch, category, campaign, slot) are the
 *     same case as the shop: the row stops being joinable and ages out.
 */

/** The table this module owns. */
const TABLE = 'visibility_events';

/** The catch-all at the end of the range, so an insert never has nowhere to go. */
const FUTURE_PARTITION = 'p_future';

/** Months created ahead of today. Two, so a missed run is not an incident. */
const MONTHS_AHEAD = 2;

const pad = (n) => String(n).padStart(2, '0');

/** `p2026_11` for November 2026. Sorts the same way the range does. */
const partitionNameFor = (date) =>
  `p${date.getUTCFullYear()}_${pad(date.getUTCMonth() + 1)}`;

/** The first instant NOT in that month, which is what RANGE wants. */
function upperBoundFor(date) {
  const year = date.getUTCMonth() === 11 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
  const month = date.getUTCMonth() === 11 ? 1 : date.getUTCMonth() + 2;
  return `${year}-${pad(month)}-01`;
}

const monthStart = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
const addMonths = (date, n) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));

/**
 * Every month from `from` to `to` inclusive, as month-start dates.
 *
 * Used to build the partition list when converting a table that already holds
 * history. Without it the first partition's range is (-infinity, its bound],
 * so **every existing row lands in the conversion month** - verified on a
 * rehearsal, where 30,000 rows spanning August to November all went into
 * `p2026_11`. Nothing is lost and nothing expires early, but a year of history
 * then ages out as one lump instead of month by month, which is not retention
 * so much as a cliff.
 */
function monthsBetween(from, to) {
  const months = [];
  let cursor = monthStart(from);
  const last = monthStart(to);
  // Guard rather than trust the inputs: a bad clock or a row dated in 1970
  // should not spin here.
  let safety = 0;
  while (cursor <= last && safety < 600) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
    safety += 1;
  }
  return months;
}

/** @returns {Promise<boolean>} whether the table is partitioned at all. */
async function isPartitioned(table = TABLE) {
  const rows = await rawQuery(
    `SELECT 1 FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

/** Every partition, oldest first, with the bound each one ends at. */
async function listPartitions(table = TABLE) {
  const rows = await rawQuery(
    `SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS bound, TABLE_ROWS AS row_estimate
       FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL
      ORDER BY PARTITION_ORDINAL_POSITION`,
    [table],
  );
  return rows.map((row) => ({
    name: row.name,
    // RANGE COLUMNS prints its bound quoted; MAXVALUE prints bare.
    bound: String(row.bound).replace(/^'|'$/g, ''),
    // An InnoDB estimate, not a count: it is only ever logged.
    rows: Number(row.row_estimate ?? 0),
  }));
}

/**
 * Adds any missing month up to `MONTHS_AHEAD`, by splitting the catch-all.
 *
 * Reorganising an **empty** catch-all is cheap - measured at 0.25 s - because
 * there is nothing to move. That is the whole reason the months are created
 * ahead of time rather than on demand: once rows have landed in `p_future`,
 * splitting it has to rewrite them.
 */
async function ensureFuturePartitions(table = TABLE, now = new Date()) {
  if (!(await isPartitioned(table))) return { added: [], skipped: 'not partitioned' };

  const existing = new Set((await listPartitions(table)).map((p) => p.name));
  const added = [];

  for (let i = 0; i <= MONTHS_AHEAD; i += 1) {
    const month = addMonths(monthStart(now), i);
    const name = partitionNameFor(month);
    if (existing.has(name)) continue;

    // Identifiers and dates are derived from the clock, never from a request.
    // eslint-disable-next-line no-await-in-loop -- each REORGANIZE must see the
    // previous one's result; the catch-all can only be split one step at a time.
    await execute(
      `ALTER TABLE \`${table}\` REORGANIZE PARTITION \`${FUTURE_PARTITION}\` INTO (
         PARTITION \`${name}\` VALUES LESS THAN ('${upperBoundFor(month)}'),
         PARTITION \`${FUTURE_PARTITION}\` VALUES LESS THAN (MAXVALUE))`,
    );
    added.push(name);
  }

  return { added };
}

/**
 * Drops every partition whose rows are entirely older than the retention
 * horizon.
 *
 * A partition is only dropped when its **upper** bound is past the horizon, so
 * the month a merchant can still ask about is never dropped for the sake of its
 * oldest day. That makes this strictly more conservative than a date-based
 * delete: data lives up to a month longer than retention, never less.
 */
async function dropExpiredPartitions(retentionDays, table = TABLE, now = new Date()) {
  if (!(await isPartitioned(table))) return { dropped: [], skipped: 'not partitioned' };

  const horizon = new Date(now.getTime() - retentionDays * 86400000);
  const partitions = await listPartitions(table);
  const dropped = [];

  for (const partition of partitions) {
    if (partition.name === FUTURE_PARTITION || partition.bound === 'MAXVALUE') continue;
    const bound = new Date(`${partition.bound}T00:00:00Z`);
    if (Number.isNaN(bound.getTime()) || bound > horizon) continue;

    // eslint-disable-next-line no-await-in-loop -- one DDL at a time.
    await execute(`ALTER TABLE \`${table}\` DROP PARTITION \`${partition.name}\``);
    dropped.push({ partition: partition.name, rows: partition.rows });
  }

  if (dropped.length) {
    logger.info(
      {
        event: 'ANALYTICS_PARTITIONS_DROPPED',
        category: 'DATABASE',
        table,
        retention_days: retentionDays,
        dropped,
      },
      `Dropped ${dropped.length} expired partition(s) from ${table}`,
    );
  }

  return { dropped };
}

/**
 * Anonymises one user's rows. The explicit replacement for
 * `fk_ve_user ON DELETE SET NULL`, which partitioning cost us.
 *
 * Indexed by `idx_ve_user_listing (user_id, ...)`, so this finds the rows
 * rather than scanning. It is one UPDATE per deleted account and it must run
 * *before* the user row goes, for the same reason the audit entry does: after
 * the DELETE there is nothing left to match on.
 */
async function scrubUser(userId) {
  const result = await execute(`UPDATE \`${TABLE}\` SET user_id = NULL WHERE user_id = ?`, [
    userId,
  ]);
  return result.affectedRows ?? 0;
}

/** Both maintenance halves, in the only order that is safe. */
async function maintain(retentionDays = retentionConfig.retentionFor(TABLE), now = new Date()) {
  // Create first. If dropping ran first and failed, the table would still have
  // its future months; if creating ran second and failed, inserts would land in
  // the catch-all and make the next reorganise expensive.
  const created = await ensureFuturePartitions(TABLE, now);
  const expired = await dropExpiredPartitions(retentionDays, TABLE, now);
  return { table: TABLE, added: created.added ?? [], dropped: expired.dropped ?? [] };
}

module.exports = {
  TABLE,
  monthsBetween,
  FUTURE_PARTITION,
  MONTHS_AHEAD,
  partitionNameFor,
  upperBoundFor,
  isPartitioned,
  listPartitions,
  ensureFuturePartitions,
  dropExpiredPartitions,
  scrubUser,
  maintain,
};
