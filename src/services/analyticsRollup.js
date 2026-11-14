'use strict';

const { rawQuery } = require('../db/pool');

/**
 * Reading engagement totals from the daily roll-up instead of the raw events.
 *
 * `analytics_daily_snapshots` has been written nightly by the
 * `analytics-snapshots` job since V3 §29 and, until this module, **nothing
 * read it**. Every KPI card and every trend chart recomputed months of counts
 * from `offer_views`, `favorites` and `offer_claims` on each page load.
 *
 * ## The hard part is the window, not the sum
 *
 * A roll-up row covers a calendar day. A dashboard window does not:
 * `resolveRange` builds `to = now` and `from = now - N days`, so **both ends
 * land in the middle of a day**. Summing whole snapshot rows for such a window
 * silently counts the hours before `from` and loses the hours after the last
 * complete day - a number that is wrong by up to two days of traffic and looks
 * entirely plausible.
 *
 * So a window is split into three:
 *
 *     from                                                              to
 *      |<-- raw -->|<------------- snapshots ------------>|<-- raw -->|
 *      |  partial  |         whole days, covered          |  partial  |
 *      |    day    |         by the roll-up               |    day    |
 *
 * ## And the roll-up is allowed to be behind
 *
 * The right-hand raw segment is not just "today". It starts after the last day
 * the roll-up actually covers, read from the table as a watermark rather than
 * assumed to be yesterday. If the job has not run for a week, a week of raw
 * events is read and the answer stays correct; if it has never run, everything
 * is read from raw and this module is a no-op wrapper. That is what makes it
 * safe to deploy before any backfill, and self-healing if the job fails.
 *
 * ## Why it can answer every dashboard filter
 *
 * The snapshot keeps **per-offer** rows, not just a shop total, so joining them
 * to `offers` lets the caller's existing predicate - category, offer type,
 * discount type, status, campaign, city, branch - apply to the same `o` alias
 * it was written for. Filtered and unfiltered answers therefore come from one
 * predicate rather than two that have to be kept in step.
 *
 * The per-offer rows also mean this never reads the shop-level row
 * (`offer_id = 0`), which exists for a different purpose and would double-count
 * if it were summed alongside them.
 */

/** The metrics the roll-up can answer. Anything else still belongs in raw SQL. */
const METRICS = ['impressions', 'views', 'clicks', 'shares', 'saves', 'claims', 'redemptions'];

/*
 * ## Every day boundary here is UTC, and that is not a detail
 *
 * `db/pool.js` pins each connection's session time zone to `+00:00` and tells
 * the driver its DATETIMEs are UTC, so `DATE(created_at)` groups by **UTC**
 * days. Computing "the start of this day" in the server's local zone instead
 * would put the reader's boundaries 5.5 hours away from the roll-up's in
 * Asia/Kolkata - which is precisely the first result this module produced:
 * a five-and-a-half-hour gap at one end of the window and the same overlap at
 * the other, so a few hundred events were lost and a few hundred counted
 * twice, while the total looked entirely reasonable.
 */
const startOfDay = (value) => {
  const date = new Date(value);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
};

const addDays = (value, n) => {
  const date = new Date(value);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n, 0, 0, 0, 0),
  );
};

/** `YYYY-MM-DD` in UTC, which is the day `snapshot_date` names. */
function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

const isMidnight = (value) => {
  const date = new Date(value);
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
};

/**
 * The last calendar day the roll-up covers, or null when it covers nothing.
 *
 * Read rather than inferred. "Yesterday" would be wrong the moment the job
 * fails, is still running, or has never run - and wrong in the direction that
 * loses data silently.
 */
async function coverageDay(now = new Date()) {
  const rows = await rawQuery(
    'SELECT MAX(snapshot_date) AS covered FROM analytics_daily_snapshots',
  );
  const covered = rows[0]?.covered;
  if (!covered) return null;

  // `snapshot_date` is a DATE and `dateStrings: ['DATE']` hands it back as
  // 'YYYY-MM-DD', so it is already the day it names. Taken as-is rather than
  // through a Date, which would re-introduce a zone.
  const day = String(covered).slice(0, 10);

  /*
   * Never trust a day that is not over yet.
   *
   * The roll-up job runs at 00:20 *local* time, which in Asia/Kolkata is
   * 18:50 UTC on the day before - so a row can exist for a UTC day with five
   * hours still to run, and the job never revisits it. Clamping the watermark
   * to the last finished UTC day means those hours are read from raw events
   * instead of being silently taken as final.
   */
  const lastFinished = dateKey(addDays(startOfDay(now), -1));
  return day > lastFinished ? lastFinished : day;
}

/**
 * Splits `[from, to]` into the snapshot range and the raw ranges around it.
 *
 * Exported because the date arithmetic is the part worth testing on its own:
 * every way of getting this wrong produces numbers that look fine.
 *
 * @returns {{snapshot: {fromDay: string, toDay: string}|null,
 *            raw: Array<{from: Date, to: Date}>}}
 */
function planWindow(from, to, coveredDay) {
  const start = new Date(from);
  const end = new Date(to);
  if (!(start < end)) return { snapshot: null, raw: [{ from: start, to: end }] };

  // A day is only safe to take from the roll-up if the window contains all of
  // it. `from` at midnight already includes its whole day; otherwise the first
  // complete day is the next one.
  const firstFullDay = isMidnight(start) ? startOfDay(start) : addDays(startOfDay(start), 1);
  // The same at the other end: a `to` that is not the very end of its day
  // means that day is partial, so the last complete day is the one before.
  const endOfEndDay = addDays(startOfDay(end), 1);
  const lastFullDay =
    end >= new Date(endOfEndDay.getTime() - 1) ? startOfDay(end) : addDays(startOfDay(end), -1);

  // Nothing the roll-up can contribute: the window is inside a single day, or
  // the job has never run. `Z` so the day string is read as the UTC day it
  // names rather than as local midnight.
  const covered = coveredDay ? startOfDay(new Date(`${coveredDay}T00:00:00Z`)) : null;
  const snapshotTo = covered && covered < lastFullDay ? covered : lastFullDay;

  if (!covered || firstFullDay > snapshotTo) {
    return { snapshot: null, raw: [{ from: start, to: end }] };
  }

  const raw = [];
  // Head: the partial first day.
  if (start < firstFullDay) raw.push({ from: start, to: new Date(firstFullDay.getTime() - 1) });
  // Tail: everything after the last day the roll-up covers - the partial last
  // day, plus any day the job has not caught up with.
  const tailFrom = addDays(snapshotTo, 1);
  if (tailFrom <= end) raw.push({ from: tailFrom, to: end });

  return { snapshot: { fromDay: dateKey(firstFullDay), toDay: dateKey(snapshotTo) }, raw };
}

const zeroTotals = () => Object.fromEntries(METRICS.map((metric) => [metric, 0]));

const addTotals = (into, row) => {
  for (const metric of METRICS) into[metric] += Number(row?.[metric] ?? 0);
  return into;
};

/**
 * Engagement totals for a window, from the roll-up where it can and raw events
 * where it must.
 *
 * `scope` is the caller's own predicate against an `offers o` alias - exactly
 * what `offerScope` already builds - so the filters cannot drift apart.
 *
 * @param {{scope: {sql: string, params: unknown[]}, from: Date, to: Date}} input
 */
async function engagementTotals({ scope, from, to, coveredDay }) {
  const covered = coveredDay === undefined ? await coverageDay() : coveredDay;
  const plan = planWindow(from, to, covered);
  const totals = zeroTotals();

  if (plan.snapshot) {
    const rows = await rawQuery(
      `SELECT COALESCE(SUM(s.impressions), 0) AS impressions,
              COALESCE(SUM(s.views), 0)       AS views,
              COALESCE(SUM(s.clicks), 0)      AS clicks,
              COALESCE(SUM(s.shares), 0)      AS shares,
              COALESCE(SUM(s.saves), 0)       AS saves,
              COALESCE(SUM(s.claims), 0)      AS claims,
              COALESCE(SUM(s.redemptions), 0) AS redemptions
         FROM analytics_daily_snapshots s
         JOIN offers o ON o.id = s.offer_id
        WHERE s.offer_id <> 0 AND s.branch_id = 0
          AND s.snapshot_date BETWEEN ? AND ?${scope.sql}`,
      [plan.snapshot.fromDay, plan.snapshot.toDay, ...scope.params],
    );
    addTotals(totals, rows[0]);
  }

  for (const segment of plan.raw) {
    // eslint-disable-next-line no-await-in-loop -- at most two segments.
    const raw = await rawTotals(scope, segment.from, segment.to);
    addTotals(totals, raw);
  }

  return { ...totals, source: plan.snapshot ? 'rollup' : 'raw', coveredDay: covered, plan };
}

/** The same numbers, straight from the event tables, for one segment. */
async function rawTotals(scope, from, to) {
  const window = [from, to];
  const [events, saves, claims] = await Promise.all([
    rawQuery(
      `SELECT v.event_type, COUNT(*) AS count
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY v.event_type`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS count FROM favorites f JOIN offers o ON o.id = f.offer_id
        WHERE f.created_at BETWEEN ? AND ?${scope.sql}`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS claims, COALESCE(SUM(c.status = 'redeemed'), 0) AS redemptions
         FROM offer_claims c JOIN offers o ON o.id = c.offer_id
        WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}`,
      [...window, ...scope.params],
    ),
  ]);

  const byType = Object.fromEntries(events.map((row) => [row.event_type, Number(row.count)]));
  return {
    impressions: byType.impression ?? 0,
    views: byType.view ?? 0,
    clicks: byType.click ?? 0,
    shares: byType.share ?? 0,
    saves: Number(saves[0]?.count ?? 0),
    claims: Number(claims[0]?.claims ?? 0),
    redemptions: Number(claims[0]?.redemptions ?? 0),
  };
}

/**
 * The same split, one row per day, for the trend charts.
 *
 * Returned as a Map keyed by `YYYY-MM-DD` so a caller can fill its own gaps
 * with zeroes - which it has to do anyway, because a day with no events has no
 * row in either table.
 */
async function engagementTimeline({ scope, from, to, coveredDay }) {
  const covered = coveredDay === undefined ? await coverageDay() : coveredDay;
  const plan = planWindow(from, to, covered);
  const byDay = new Map();

  const put = (day, row) => {
    const key = dateKey(day);
    if (!byDay.has(key)) byDay.set(key, zeroTotals());
    addTotals(byDay.get(key), row);
  };

  if (plan.snapshot) {
    const rows = await rawQuery(
      `SELECT s.snapshot_date AS day,
              COALESCE(SUM(s.impressions), 0) AS impressions,
              COALESCE(SUM(s.views), 0)       AS views,
              COALESCE(SUM(s.clicks), 0)      AS clicks,
              COALESCE(SUM(s.shares), 0)      AS shares,
              COALESCE(SUM(s.saves), 0)       AS saves,
              COALESCE(SUM(s.claims), 0)      AS claims,
              COALESCE(SUM(s.redemptions), 0) AS redemptions
         FROM analytics_daily_snapshots s
         JOIN offers o ON o.id = s.offer_id
        WHERE s.offer_id <> 0 AND s.branch_id = 0
          AND s.snapshot_date BETWEEN ? AND ?${scope.sql}
        GROUP BY s.snapshot_date`,
      [plan.snapshot.fromDay, plan.snapshot.toDay, ...scope.params],
    );
    for (const row of rows) put(row.day, row);
  }

  for (const segment of plan.raw) {
    // eslint-disable-next-line no-await-in-loop -- at most two segments.
    const rows = await rawTimeline(scope, segment.from, segment.to);
    for (const row of rows) put(row.day, row);
  }

  return { byDay, source: plan.snapshot ? 'rollup' : 'raw', coveredDay: covered };
}

/** Per-day rows straight from the event tables, for one segment. */
async function rawTimeline(scope, from, to) {
  const window = [from, to];
  const [views, saves, claims] = await Promise.all([
    rawQuery(
      `SELECT DATE(v.created_at) AS day,
              SUM(v.event_type = 'impression') AS impressions,
              SUM(v.event_type = 'view')       AS views,
              SUM(v.event_type = 'click')      AS clicks,
              SUM(v.event_type = 'share')      AS shares
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY day`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT DATE(f.created_at) AS day, COUNT(*) AS saves
         FROM favorites f JOIN offers o ON o.id = f.offer_id
        WHERE f.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY day`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT DATE(c.claimed_at) AS day, COUNT(*) AS claims,
              COALESCE(SUM(c.status = 'redeemed'), 0) AS redemptions
         FROM offer_claims c JOIN offers o ON o.id = c.offer_id
        WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}
        GROUP BY day`,
      [...window, ...scope.params],
    ),
  ]);

  return [...views, ...saves, ...claims].map((row) => ({ ...row, day: row.day }));
}

/**
 * The same seven counters, broken down per offer.
 *
 * `offerPerformance` asked for these as **seven correlated scalar subqueries
 * per offer**, each one scanning `offer_views`, `favorites` or `offer_claims`
 * for that offer's window. The snapshot keeps per-offer rows, so the whole set
 * is one grouped read of a small table, plus the partial days at the window's
 * ends.
 *
 * Returns a Map keyed by offer id. An offer with no activity is simply absent -
 * callers that must list it anyway (every offer in scope, zeros included) start
 * from `offers` and default a miss to zero, which is what the original SQL did
 * by starting its FROM clause there.
 *
 * @returns {Promise<{byOffer: Map<number, object>, source: string}>}
 */
async function engagementByOffer({ scope, from, to, coveredDay }) {
  const covered = coveredDay === undefined ? await coverageDay() : coveredDay;
  const plan = planWindow(from, to, covered);
  const byOffer = new Map();

  const put = (offerId, row) => {
    const id = Number(offerId);
    if (!byOffer.has(id)) byOffer.set(id, zeroTotals());
    addTotals(byOffer.get(id), row);
  };

  if (plan.snapshot) {
    const rows = await rawQuery(
      `SELECT s.offer_id,
              COALESCE(SUM(s.impressions), 0) AS impressions,
              COALESCE(SUM(s.views), 0)       AS views,
              COALESCE(SUM(s.clicks), 0)      AS clicks,
              COALESCE(SUM(s.shares), 0)      AS shares,
              COALESCE(SUM(s.saves), 0)       AS saves,
              COALESCE(SUM(s.claims), 0)      AS claims,
              COALESCE(SUM(s.redemptions), 0) AS redemptions
         FROM analytics_daily_snapshots s
         JOIN offers o ON o.id = s.offer_id
        WHERE s.offer_id <> 0 AND s.branch_id = 0
          AND s.snapshot_date BETWEEN ? AND ?${scope.sql}
        GROUP BY s.offer_id`,
      [plan.snapshot.fromDay, plan.snapshot.toDay, ...scope.params],
    );
    for (const row of rows) put(row.offer_id, row);
  }

  for (const segment of plan.raw) {
    // eslint-disable-next-line no-await-in-loop -- at most two segments.
    const rows = await rawByOffer(scope, segment.from, segment.to);
    for (const row of rows) put(row.offer_id, row);
  }

  return { byOffer, source: plan.snapshot ? 'rollup' : 'raw', coveredDay: covered };
}

/** Per-offer counters straight from the event tables, for one segment. */
async function rawByOffer(scope, from, to) {
  const window = [from, to];
  const [views, saves, claims] = await Promise.all([
    rawQuery(
      `SELECT v.offer_id,
              SUM(v.event_type = 'impression') AS impressions,
              SUM(v.event_type = 'view')       AS views,
              SUM(v.event_type = 'click')      AS clicks,
              SUM(v.event_type = 'share')      AS shares
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY v.offer_id`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT f.offer_id, COUNT(*) AS saves
         FROM favorites f JOIN offers o ON o.id = f.offer_id
        WHERE f.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY f.offer_id`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT c.offer_id, COUNT(*) AS claims,
              COALESCE(SUM(c.status = 'redeemed'), 0) AS redemptions
         FROM offer_claims c JOIN offers o ON o.id = c.offer_id
        WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}
        GROUP BY c.offer_id`,
      [...window, ...scope.params],
    ),
  ]);
  return [...views, ...saves, ...claims];
}

/** Zeroes, for an offer the roll-up has never seen. */
const zeroFor = () => zeroTotals();

module.exports = {
  METRICS,
  engagementByOffer,
  zeroFor,
  coverageDay,
  planWindow,
  engagementTotals,
  engagementTimeline,
  dateKey,
};
