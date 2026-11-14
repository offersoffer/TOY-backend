'use strict';

/**
 * How long raw analytics events are kept, and the rule that keeps that number
 * honest.
 *
 * ## The invariant
 *
 * Retention must be **longer than the longest window the API will serve.** If
 * it is not, a merchant asking for twelve months gets a chart that is complete
 * for eleven and silently zero for the twelfth - which is worse than refusing
 * the question, because nothing on screen says the data was deleted rather than
 * never earned.
 *
 * `MAX_QUERY_DAYS` is therefore the single source of truth for both: the
 * dashboards validate `days` against it, and `assertWindowIsServable` refuses
 * to start if retention has been configured below it. One of the two numbers
 * cannot be lowered without the other noticing.
 *
 * ## Why these are separate numbers at all
 *
 * The operational readers of these tables - ranking, fairness, frequency caps,
 * anti-manipulation - all work in hours or a handful of days. Only the merchant
 * dashboards reach back a year. So retention is set by reporting, not by the
 * machinery, and if the dashboards ever move to the daily rollup
 * (`analytics_daily_snapshots`, which nothing reads today) this number can drop
 * to about 90 days and the storage question goes away with it.
 */

/**
 * The longest window any dashboard may ask for, in days.
 *
 * 365 because `config/businessMetrics.js` offers a 12-Month retention cohort
 * and the analytics routes accept `days` up to a year. Raising it means raising
 * `ANALYTICS_RETENTION_DAYS` too, and the assertion below enforces that.
 */
const MAX_QUERY_DAYS = 365;

/**
 * The margin between the two. A year of retention and a year of query window
 * would mean the oldest day a merchant can ask for is the same day the prune
 * job is deleting, and which of the two ran first would decide what the chart
 * showed.
 */
const MIN_MARGIN_DAYS = 30;

/**
 * The tables pruned by deleting rows, with the column each one dates them by.
 *
 * `visibility_events` is deliberately not here. It is partitioned by month, and
 * a partitioned table must have whole partitions dropped rather than rows
 * deleted - measured, batched deletion against it runs at 4,585 rows a second
 * where the same unpartitioned table managed 31,000, because every statement
 * has to consider every partition. `services/analyticsPartitions.js` owns it,
 * and `PARTITIONED_TABLES` names it so the two cannot both claim it.
 */
const EVENT_TABLES = [
  { table: 'analytics_events', column: 'created_at' },
  { table: 'offer_views', column: 'created_at' },
];

/**
 * Tables whose retention is a DROP PARTITION rather than a DELETE.
 *
 * Kept as a list rather than assumed, because the fallback matters: on a
 * database where the conversion has not run yet the table is still a plain
 * table, and something has to prune it in the meantime. `retentionFor` below
 * is what decides, per table, at runtime.
 */
const PARTITIONED_TABLES = [{ table: 'visibility_events', column: 'created_at' }];

/**
 * `search_history` is deliberately absent. `recommendations.rememberSearch`
 * already trims each user to their 20 most recent terms on every insert, so it
 * is bounded by user count rather than by time, and a date-based prune would
 * fight that rule rather than help it.
 */

/**
 * @throws when retention is configured too low to answer what the API accepts.
 */
function assertWindowIsServable(retentionDays) {
  const floor = MAX_QUERY_DAYS + MIN_MARGIN_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < floor) {
    throw new Error(
      `ANALYTICS_RETENTION_DAYS is ${retentionDays}, but the dashboards serve windows up to ` +
        `${MAX_QUERY_DAYS} days and need ${MIN_MARGIN_DAYS} days of margin. Set it to at least ${floor}, ` +
        'or lower MAX_QUERY_DAYS in config/analyticsRetention.js and the dashboards with it.',
    );
  }
}

/**
 * The oldest instant the raw tables can still answer for.
 *
 * A day of margin is subtracted so a request for exactly the horizon is not
 * refused by the few hours between the prune job running and the question being
 * asked.
 */
function earliestServable(retentionDays, now = new Date()) {
  return new Date(now.getTime() - (retentionDays - 1) * 86400000);
}

/**
 * Whether a custom range starts inside what is still stored.
 *
 * `days` is capped at `MAX_QUERY_DAYS`, which is below any legal retention, so
 * only an explicit `from`/`to` can fall outside - which is exactly the case
 * that used to return a confident zero for a period that had been deleted.
 */
function isWithinRetention(from, retentionDays, now = new Date()) {
  if (!from) return true;
  return new Date(from).getTime() >= earliestServable(retentionDays, now).getTime();
}

module.exports = {
  MAX_QUERY_DAYS,
  MIN_MARGIN_DAYS,
  EVENT_TABLES,
  PARTITIONED_TABLES,
  assertWindowIsServable,
  earliestServable,
  isWithinRetention,
};
