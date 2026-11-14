'use strict';

const { execute, rawQuery } = require('../db/pool');

/**
 * Daily analytics roll-ups (V3 §29).
 *
 * The premium dashboards would otherwise recompute months of KPI cards from the
 * raw event tables on every page load. This job folds a day's events into
 * `analytics_daily_snapshots` once, per shop and per offer, so trend charts and
 * headline counters read a small, indexed table.
 *
 * Each rebuild replaces the day it covers, so re-running it - after a backfill,
 * or twice from two app instances - converges on the same numbers.
 */

/** Rebuilds one day. `date` is a Date or 'YYYY-MM-DD'; defaults to yesterday. */
async function rebuildDay(date = defaultDay()) {
  const day = toDateString(date);

  await execute('DELETE FROM analytics_daily_snapshots WHERE snapshot_date = ?', [day]);

  // Per-offer rows. The shop-level row is derived from these below rather than
  // queried again, which keeps the two consistent by construction.
  await execute(
    `INSERT INTO analytics_daily_snapshots
       (shop_id, snapshot_date, offer_id, branch_id, impressions, views, shares, clicks,
        saves, claims, redemptions, unique_customers)
     SELECT o.id AS shop_scope, ?, o.offer_id, 0,
            o.impressions, o.views, o.shares, o.clicks,
            COALESCE(f.saves, 0), COALESCE(c.claims, 0), COALESCE(c.redemptions, 0), o.unique_customers
       FROM (
         SELECT off.shop_id AS id, v.offer_id,
                SUM(v.event_type = 'impression') AS impressions,
                SUM(v.event_type = 'view')       AS views,
                SUM(v.event_type = 'share')      AS shares,
                SUM(v.event_type = 'click')      AS clicks,
                COUNT(DISTINCT v.user_id)        AS unique_customers
           FROM offer_views v
           JOIN offers off ON off.id = v.offer_id
          WHERE DATE(v.created_at) = ?
          GROUP BY off.shop_id, v.offer_id
       ) o
       LEFT JOIN (
         SELECT offer_id, COUNT(*) AS saves FROM favorites
          WHERE DATE(created_at) = ? GROUP BY offer_id
       ) f ON f.offer_id = o.offer_id
       LEFT JOIN (
         SELECT offer_id, COUNT(*) AS claims,
                SUM(status = 'redeemed') AS redemptions
           FROM offer_claims WHERE DATE(claimed_at) = ? GROUP BY offer_id
       ) c ON c.offer_id = o.offer_id`,
    [day, day, day, day],
  );

  // Saves and claims can land on a day the offer had no views at all, so those
  // offers need their own rows or the funnel would lose them.
  await execute(
    `INSERT INTO analytics_daily_snapshots
       (shop_id, snapshot_date, offer_id, branch_id, saves, claims, redemptions)
     SELECT off.shop_id, ?, t.offer_id, 0,
            COALESCE(SUM(t.saves), 0), COALESCE(SUM(t.claims), 0), COALESCE(SUM(t.redemptions), 0)
       FROM (
         SELECT offer_id, COUNT(*) AS saves, 0 AS claims, 0 AS redemptions
           FROM favorites WHERE DATE(created_at) = ? GROUP BY offer_id
         UNION ALL
         SELECT offer_id, 0, COUNT(*), SUM(status = 'redeemed')
           FROM offer_claims WHERE DATE(claimed_at) = ? GROUP BY offer_id
       ) t
       JOIN offers off ON off.id = t.offer_id
      WHERE NOT EXISTS (
        SELECT 1 FROM analytics_daily_snapshots s
         WHERE s.snapshot_date = ? AND s.offer_id = t.offer_id AND s.branch_id = 0
      )
      GROUP BY off.shop_id, t.offer_id`,
    [day, day, day, day],
  );

  // Shop-level row (offer_id = 0) plus the new/returning split, which only
  // makes sense per shop rather than per offer.
  await execute(
    `INSERT INTO analytics_daily_snapshots
       (shop_id, snapshot_date, offer_id, branch_id, impressions, views, shares, clicks,
        saves, claims, redemptions, unique_customers, new_customers, returning_customers)
     SELECT s.shop_id, ?, 0, 0,
            SUM(s.impressions), SUM(s.views), SUM(s.shares), SUM(s.clicks),
            SUM(s.saves), SUM(s.claims), SUM(s.redemptions), SUM(s.unique_customers),
            COALESCE(n.new_customers, 0), COALESCE(n.returning_customers, 0)
       FROM analytics_daily_snapshots s
       LEFT JOIN (
         SELECT shop_id,
                SUM(DATE(first_seen_at) = ?) AS new_customers,
                SUM(DATE(first_seen_at) < ? AND DATE(last_seen_at) = ?) AS returning_customers
           FROM shop_customers GROUP BY shop_id
       ) n ON n.shop_id = s.shop_id
      WHERE s.snapshot_date = ? AND s.offer_id <> 0
      GROUP BY s.shop_id, n.new_customers, n.returning_customers`,
    [day, day, day, day, day],
  );

  const counted = await rawQuery(
    'SELECT COUNT(*) AS rows_written FROM analytics_daily_snapshots WHERE snapshot_date = ?',
    [day],
  );

  return { day, rows: Number(counted[0].rows_written) };
}

/** Rebuilds the trailing `days` days, oldest first. Used for backfills. */
async function backfill(days = 30) {
  const written = [];
  for (let offset = days; offset >= 1; offset -= 1) {
    written.push(await rebuildDay(dayOffsetFromToday(-offset)));
  }
  return written;
}

/*
 * ## Days are UTC days here, because that is what the queries above group by
 *
 * `db/pool.js` pins every connection's session time zone to `+00:00`, so the
 * `DATE(v.created_at) = ?` filters in `rebuildDay` select a **UTC** day. The
 * label written into `snapshot_date` therefore has to name that same UTC day.
 *
 * Deriving it from local date parts was wrong in a way that only showed up
 * away from UTC. This job is scheduled at 00:20 local time; in Asia/Kolkata
 * that is 18:50 UTC on the previous day, so "local yesterday" was a UTC day
 * with five hours still to run. The job rolled up a partial day, labelled it
 * final, and never came back to it - and a reader trusting that label would
 * have served those five missing hours as a measured zero.
 *
 * `analyticsRollup.coverageDay` clamps the watermark as well, so neither side
 * depends on the other getting this right.
 */
function dayOffsetFromToday(offset, now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 0, 0, 0, 0),
  );
}

/** The last UTC day that is certainly over. */
function defaultDay() {
  return dayOffsetFromToday(-1);
}

function toDateString(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

module.exports = { rebuildDay, backfill, toDateString, dayOffsetFromToday };
