'use strict';

/** Local copy of env.js's integer reader: this file must not require env.js,
 *  which requires this one for its startup assertion. */
const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

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
 * The retention and query horizons, **per table**.
 *
 * One number for all three was forcing the worst case onto the cheapest
 * tables. Measured on disk at identical row counts of 200,000:
 *
 * | table | bytes/row | gets a row when |
 * |---|---|---|
 * | `visibility_events` | **1,094** | every impression - about 20 per feed render |
 * | `analytics_events` | 503 | a tracked action happens |
 * | `offer_views` | 314 | somebody opens an offer |
 *
 * So `visibility_events` is the storage problem almost on its own: three and a
 * half times the row cost, and one to two orders of magnitude more rows. Its
 * only long-window reader is the merchant visibility dashboard - everything
 * else that touches it (ranking, fairness, frequency caps, anti-manipulation)
 * works in hours. Capping that one dashboard to 90 days is what lets the
 * firehose keep 90 days instead of 400.
 *
 * `offer_views` and `analytics_events` stay at 400 because seven premium
 * dashboards still read them over a full year; see `docs/caching-and-rollups.md`
 * for which, and what converting them would take.
 *
 * `maxQueryDays` is what the routes validate against, and
 * `assertHorizonsAreServable` refuses to start if any table's retention cannot
 * answer the window its own readers accept. Neither number can move without
 * the other noticing.
 */
const TABLES = {
  visibility_events: {
    column: 'created_at',
    retentionDays: int(process.env.VISIBILITY_RETENTION_DAYS, 90),
    maxQueryDays: 60,
    // Monthly partitions: retention is a DROP PARTITION, never a row delete.
    managedBy: 'partitions',
  },
  analytics_events: {
    column: 'created_at',
    retentionDays: int(process.env.ANALYTICS_RETENTION_DAYS, 400),
    maxQueryDays: 365,
    managedBy: 'delete',
  },
  offer_views: {
    column: 'created_at',
    retentionDays: int(process.env.ANALYTICS_RETENTION_DAYS, 400),
    maxQueryDays: 365,
    managedBy: 'delete',
  },
};

/**
 * The longest window the **offer** dashboards may ask for.
 *
 * Kept as the headline number because it is what `/analytics` and
 * `/analytics/premium` validate against, and what the roll-up has to be able
 * to answer. The visibility dashboards have their own, lower limit.
 */
const MAX_QUERY_DAYS = TABLES.offer_views.maxQueryDays;

/** The visibility dashboards' limit, which is lower on purpose. */
const MAX_VISIBILITY_QUERY_DAYS = TABLES.visibility_events.maxQueryDays;

/**
 * The margin between a table's retention and the window its readers accept. A
 * year of retention and a year of window would mean the oldest day a merchant
 * can ask for is the same day the prune job is deleting, and which ran first
 * would decide what the chart showed.
 */
const MIN_MARGIN_DAYS = 30;

/** Tables pruned by deleting rows, with the column each one dates them by. */
const EVENT_TABLES = Object.entries(TABLES)
  .filter(([, spec]) => spec.managedBy === 'delete')
  .map(([table, spec]) => ({ table, column: spec.column }));

/**
 * Tables whose retention is a DROP PARTITION rather than a DELETE.
 *
 * Kept as a list rather than assumed, because the fallback matters: on a
 * database where the conversion has not run yet the table is still a plain
 * table, and something has to prune it in the meantime.
 */
const PARTITIONED_TABLES = Object.entries(TABLES)
  .filter(([, spec]) => spec.managedBy === 'partitions')
  .map(([table, spec]) => ({ table, column: spec.column }));

/**
 * `search_history` is absent from both. `recommendations.rememberSearch`
 * already trims each user to their 20 most recent terms on every insert, so it
 * is bounded by user count rather than by time, and a date-based prune would
 * fight that rule rather than help it.
 */

/** How long a given table keeps its rows. */
function retentionFor(table) {
  const spec = TABLES[table];
  if (!spec) throw new Error(`No retention configured for ${table}`);
  return spec.retentionDays;
}

/**
 * Every table's retention, checked against the window its own readers accept.
 *
 * @throws when any table is configured too low to answer what its routes take.
 */
function assertHorizonsAreServable() {
  for (const [table, spec] of Object.entries(TABLES)) {
    const floor = spec.maxQueryDays + MIN_MARGIN_DAYS;
    if (!Number.isFinite(spec.retentionDays) || spec.retentionDays < floor) {
      throw new Error(
        `Retention for ${table} is ${spec.retentionDays}, but its dashboards serve windows up to ` +
          `${spec.maxQueryDays} days and need ${MIN_MARGIN_DAYS} days of margin. ` +
          `Set it to at least ${floor}, or lower maxQueryDays for ${table} in ` +
          'config/analyticsRetention.js and the routes that read it.',
      );
    }
  }
}

/**
 * The per-table form, for a caller that has one number in hand.
 *
 * @throws when `retentionDays` cannot answer `maxQueryDays` for that table.
 */
function assertWindowIsServable(retentionDays, maxQueryDays = MAX_QUERY_DAYS) {
  const floor = maxQueryDays + MIN_MARGIN_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < floor) {
    throw new Error(
      `Retention is ${retentionDays}, but the dashboards serve windows up to ${maxQueryDays} days ` +
        `and need ${MIN_MARGIN_DAYS} days of margin. Set it to at least ${floor}, or lower ` +
        'maxQueryDays in config/analyticsRetention.js and the dashboards with it.',
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
  TABLES,
  MAX_VISIBILITY_QUERY_DAYS,
  retentionFor,
  assertHorizonsAreServable,
  MAX_QUERY_DAYS,
  MIN_MARGIN_DAYS,
  EVENT_TABLES,
  PARTITIONED_TABLES,
  assertWindowIsServable,
  earliestServable,
  isWithinRetention,
};
