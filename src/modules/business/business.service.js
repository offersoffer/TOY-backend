'use strict';

const { rawQuery } = require('../../db/pool');
const metrics = require('../../config/businessMetrics');
const { dayKeysBetween } = require('../../utils/dateRange');
const scope = require('./business.scope');

/**
 * Business Dashboard metrics (Business §5-§17, §28-§31).
 *
 * The platform owner's numbers, as distinct from the merchant analytics in
 * `analytics/premium.service.js`: those answer "how is my shop doing?" for one
 * merchant, these answer "how is the OffersOffer business doing?" across all of
 * them (§1: "This dashboard is separate from merchant dashboards").
 *
 * Every function takes the context the router builds:
 *
 *   { range: { from, to, previousFrom, previousTo, preset }, filters }
 *
 * There is no shop scope to resolve. Access is settled once, at the router, by
 * requiring Super Admin - so nothing here has to reason about ownership, and
 * nothing here may be mounted anywhere that has not made that check.
 *
 * Definitions live in `config/businessMetrics.js` rather than inline. When a
 * card and its definition disagree, the definition is the one that is wrong,
 * and there is exactly one place to fix it.
 */

const { num, percent, per, kpi, median, shopFilter, activeUserSource } = scope;

// ---------------------------------------------------------------------------
// §5, §6, §7 - active customers
// ---------------------------------------------------------------------------

/**
 * Unique active customers in a window, and the daily series behind it.
 *
 * One pass over the union rather than one query per day: the alternative is
 * thirty round trips for a thirty-day chart, and the aggregate has to agree
 * with the series anyway.
 */
async function activeUsers(from, to, filters) {
  const source = activeUserSource(from, to, filters);

  const [totals, daily] = await Promise.all([
    rawQuery(`SELECT COUNT(DISTINCT user_id) AS people FROM (${source.sql}) AS activity`, source.params),
    rawQuery(
      `SELECT day, COUNT(DISTINCT user_id) AS people
         FROM (${source.sql}) AS activity
        GROUP BY day ORDER BY day`,
      source.params,
    ),
  ]);

  const byDay = new Map(daily.map((row) => [String(row.day).slice(0, 10), num(row.people)]));
  // Quiet days do not appear in a GROUP BY, and a chart that skips them plots
  // its remaining points on a non-linear axis. Seed every day in the range.
  const series = dayKeysBetween(from, to).map((day) => ({ day, value: byDay.get(day) ?? 0 }));

  const mau = num(totals[0]?.people);
  const daysWithData = series.length || 1;
  const averageDau = Number((series.reduce((sum, point) => sum + point.value, 0) / daysWithData).toFixed(0));

  return {
    /** §6 - unique customers across the whole window. */
    mau,
    /** §5.1 - the most recent complete day in the window. */
    dau: series.length ? series[series.length - 1].value : 0,
    /** The mean day, which is what the stickiness ratio divides by (§7). */
    averageDau,
    series,
  };
}

/**
 * §5, §6, §7, §8, §9, §10 - the Customer Metrics page.
 */
async function customerMetrics(context) {
  const { from, to, previousFrom, previousTo } = context.range;
  const { filters } = context;

  const [current, previous, engagement, previousEngagement, newCustomers] = await Promise.all([
    activeUsers(from, to, filters),
    activeUsers(previousFrom, previousTo, filters),
    engagementTotals(from, to, filters),
    engagementTotals(previousFrom, previousTo, filters),
    newCustomerSeries(from, to),
  ]);

  const viewsPerUser = per(engagement.views, current.mau);
  const previousViewsPerUser = per(previousEngagement.views, previous.mau);
  const claimsPerUser = per(engagement.claims, current.mau);
  const previousClaimsPerUser = per(previousEngagement.claims, previous.mau);

  return {
    range: context.range,
    kpis: [
      kpi('dau', 'Daily active users', current.dau, previous.dau, {
        hint: 'Unique customers with a meaningful activity on the last day of the range.',
      }),
      kpi('mau', 'Monthly active users', current.mau, previous.mau, {
        hint: 'Unique customers with a meaningful activity anywhere in the range.',
      }),
      kpi(
        'stickiness',
        'DAU / MAU',
        percent(current.averageDau, current.mau) ?? 0,
        percent(previous.averageDau, previous.mau) ?? 0,
        {
          format: 'percent',
          // §7 leaves the numerator open. The average day is used rather than
          // the last one, because a single Sunday should not move an
          // engagement ratio by a third.
          hint: 'Average daily actives as a share of the period’s unique actives.',
        },
      ),
      kpi('viewsPerUser', 'Offers viewed / user', viewsPerUser ?? 0, previousViewsPerUser ?? 0, {
        format: 'decimal',
        hint: 'Offer detail views divided by unique active customers, same period for both.',
      }),
      kpi('claimsPerUser', 'Offers claimed / user', claimsPerUser ?? 0, previousClaimsPerUser ?? 0, {
        format: 'decimal',
        hint: 'Offer claims divided by unique active customers, same period for both.',
      }),
      kpi(
        'redemptionRate',
        'Coupon redemption rate',
        engagement.redemptionRate ?? 0,
        previousEngagement.redemptionRate ?? 0,
        {
          format: 'percent',
          hint: `Verified redemptions as a share of eligible claims. ${ELIGIBILITY_NOTE}`,
        },
      ),
      kpi('newCustomers', 'New customers', newCustomers.total, newCustomers.previousTotal, {
        hint: 'Customer accounts created in the period.',
      }),
    ],
    activity: {
      dau: current.dau,
      mau: current.mau,
      averageDau: current.averageDau,
      stickiness: percent(current.averageDau, current.mau),
      series: current.series,
    },
    engagement,
    signups: newCustomers.series,
    definitions: {
      activeUserEvents: metrics.ACTIVE_USER_EVENTS,
      excludedEvents: metrics.EXCLUDED_FROM_ACTIVITY,
      claimEligibility: ELIGIBILITY_NOTE,
    },
  };
}

const ELIGIBILITY_NOTE =
  'A claim is eligible once it has been redeemed, expired, cancelled or revoked. ' +
  'Claims still inside their validity window are counted separately as pending.';

/**
 * §8, §9, §10 - views, saves, claims, redemptions and the rate between them.
 */
async function engagementTotals(from, to, filters) {
  const viewScope = shopFilter(filters, 'o.shop_id');
  const claimScope = shopFilter(filters, 'c.shop_id');

  const [views, saves, claims] = await Promise.all([
    rawQuery(
      `SELECT COALESCE(SUM(v.event_type = 'view'), 0)       AS views,
              COALESCE(SUM(v.event_type = 'impression'), 0) AS impressions,
              COALESCE(SUM(v.event_type = 'click'), 0)      AS clicks,
              COALESCE(SUM(v.event_type = 'share'), 0)      AS shares
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.created_at BETWEEN ? AND ?${viewScope.sql}`,
      [from, to, ...viewScope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS saves FROM favorites f JOIN offers o ON o.id = f.offer_id
        WHERE f.created_at BETWEEN ? AND ?${viewScope.sql}`,
      [from, to, ...viewScope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS claims,
              COALESCE(SUM(${metrics.ELIGIBLE_CLAIM_SQL}), 0)        AS eligible,
              COALESCE(SUM(${metrics.PENDING_CLAIM_SQL}), 0)         AS pending,
              COALESCE(SUM(${metrics.VERIFIED_REDEMPTION_SQL}), 0)   AS redemptions
         FROM offer_claims c
        WHERE c.claimed_at BETWEEN ? AND ?${claimScope.sql}`,
      [from, to, ...claimScope.params],
    ),
  ]);

  const eligible = num(claims[0].eligible);
  const redemptions = num(claims[0].redemptions);

  return {
    impressions: num(views[0].impressions),
    views: num(views[0].views),
    clicks: num(views[0].clicks),
    shares: num(views[0].shares),
    saves: num(saves[0].saves),
    claims: num(claims[0].claims),
    eligibleClaims: eligible,
    pendingClaims: num(claims[0].pending),
    redemptions,
    redemptionRate: percent(redemptions, eligible),
  };
}

/** Customer sign-ups, which is growth rather than engagement. */
async function newCustomerSeries(from, to) {
  const span = to.getTime() - from.getTime();
  const previousFrom = new Date(from.getTime() - span - 1);

  const [rows, previous] = await Promise.all([
    rawQuery(
      `SELECT DATE(created_at) AS day, COUNT(*) AS people
         FROM users WHERE created_at BETWEEN ? AND ? GROUP BY day ORDER BY day`,
      [from, to],
    ),
    rawQuery('SELECT COUNT(*) AS people FROM users WHERE created_at BETWEEN ? AND ?', [
      previousFrom,
      new Date(from.getTime() - 1),
    ]),
  ]);

  const byDay = new Map(rows.map((row) => [String(row.day).slice(0, 10), num(row.people)]));
  const series = dayKeysBetween(from, to).map((day) => ({ day, value: byDay.get(day) ?? 0 }));

  return {
    total: series.reduce((sum, point) => sum + point.value, 0),
    previousTotal: num(previous[0]?.people),
    series,
  };
}

// ---------------------------------------------------------------------------
// §11 - §15 - merchants
// ---------------------------------------------------------------------------

/** §11.1 - how many merchants did something in the window. */
async function activeMerchantCount(from, to, filters) {
  const activity = metrics.activeMerchantClause(from, to);
  const filter = shopFilter(filters, 's.id');

  const rows = await rawQuery(
    `SELECT COUNT(*) AS merchants FROM shops s
      WHERE s.status = 'active' AND ${activity.sql}${filter.sql}`,
    [...activity.params, ...filter.params],
  );
  return num(rows[0].merchants);
}

/**
 * §11 - §15 - the Merchant Metrics page: how many merchants are active, and
 * what the platform delivers to each of them.
 */
async function merchantMetrics(context) {
  const { from, to, previousFrom, previousTo } = context.range;
  const { filters } = context;

  const [active, previousActive, totals, previousTotals, spread, breakdown, distribution] =
    await Promise.all([
      activeMerchantCount(from, to, filters),
      activeMerchantCount(previousFrom, previousTo, filters),
      merchantTotals(from, to, filters),
      merchantTotals(previousFrom, previousTo, filters),
      offersPerShopSpread(from, to, filters),
      activityBreakdown(from, to, filters),
      performanceDistribution(from, to, filters),
    ]);

  const ratio = (value, merchants) => per(value, merchants) ?? 0;

  return {
    range: context.range,
    kpis: [
      kpi('activeMerchants', 'Active merchants', active, previousActive, {
        hint: 'Merchants who did at least one of the tracked activities in the period.',
      }),
      kpi('offersPerShop', 'Offers / shop', ratio(totals.activeOffers, active), ratio(previousTotals.activeOffers, previousActive), {
        format: 'decimal',
        hint: 'Active offers divided by active merchants.',
      }),
      kpi('viewsPerShop', 'Offer views / shop', ratio(totals.views, active), ratio(previousTotals.views, previousActive), {
        format: 'decimal',
      }),
      kpi('claimsPerShop', 'Claims / shop', ratio(totals.claims, active), ratio(previousTotals.claims, previousActive), {
        format: 'decimal',
      }),
      kpi(
        'redemptionsPerShop',
        'Redemptions / shop',
        ratio(totals.redemptions, active),
        ratio(previousTotals.redemptions, previousActive),
        { format: 'decimal' },
      ),
    ],
    activeMerchants: active,
    totals,
    perShop: {
      offers: per(totals.activeOffers, active),
      // §12: "Recommended additional metric: Median Offers / Shop. This
      // prevents a few high-volume merchants from distorting the average."
      medianOffers: spread.median,
      maxOffers: spread.max,
      views: per(totals.views, active),
      claims: per(totals.claims, active),
      redemptions: per(totals.redemptions, active),
    },
    activityBreakdown: breakdown,
    distribution,
    definitions: {
      activities: metrics.ACTIVE_MERCHANT_ACTIVITIES.map((key) => ({
        key,
        label: metrics.MERCHANT_ACTIVITY_LABELS[key],
      })),
      note: 'A merchant is never counted as active merely because an account exists.',
    },
  };
}

/** Platform-wide listing and engagement totals, used for the per-shop ratios. */
async function merchantTotals(from, to, filters) {
  const offerScope = shopFilter(filters, 'o.shop_id');
  const claimScope = shopFilter(filters, 'c.shop_id');
  const serviceScope = shopFilter(filters, 'sv.shop_id');
  const listings = scope.listingTypes(filters);

  const [offers, views, claims, services] = await Promise.all([
    rawQuery(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(o.status = 'active'), 0) AS active
         FROM offers o WHERE 1 = 1${offerScope.sql}`,
      offerScope.params,
    ),
    rawQuery(
      `SELECT COALESCE(SUM(v.event_type = 'view'), 0) AS views
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.created_at BETWEEN ? AND ?${offerScope.sql}`,
      [from, to, ...offerScope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS claims,
              COALESCE(SUM(${metrics.VERIFIED_REDEMPTION_SQL}), 0) AS redemptions
         FROM offer_claims c WHERE c.claimed_at BETWEEN ? AND ?${claimScope.sql}`,
      [from, to, ...claimScope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS total, COALESCE(SUM(sv.status = 'active'), 0) AS active
         FROM services sv WHERE 1 = 1${serviceScope.sql}`,
      serviceScope.params,
    ),
  ]);

  return {
    totalOffers: listings.offers ? num(offers[0].total) : 0,
    activeOffers: listings.offers ? num(offers[0].active) : 0,
    totalServices: listings.services ? num(services[0].total) : 0,
    activeServices: listings.services ? num(services[0].active) : 0,
    views: num(views[0].views),
    claims: num(claims[0].claims),
    redemptions: num(claims[0].redemptions),
  };
}

/** §12's median, which needs the whole per-shop distribution, not a SUM. */
async function offersPerShopSpread(from, to, filters) {
  const activity = metrics.activeMerchantClause(from, to);
  const filter = shopFilter(filters, 's.id');

  const rows = await rawQuery(
    `SELECT (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS offers
       FROM shops s
      WHERE s.status = 'active' AND ${activity.sql}${filter.sql}`,
    [...activity.params, ...filter.params],
  );

  const counts = rows.map((row) => num(row.offers));
  return {
    median: median(counts),
    max: counts.length ? Math.max(...counts) : 0,
    shops: counts.length,
  };
}

/**
 * How many merchants each activity accounts for. Shown next to the active count
 * so §11.1's "the exact definition should be configurable" is inspectable
 * rather than a claim - a reader can see which signal is carrying the number.
 */
async function activityBreakdown(from, to, filters) {
  const filter = shopFilter(filters, 's.id');

  const results = await Promise.all(
    metrics.ACTIVE_MERCHANT_ACTIVITIES.map(async (key) => {
      const clause = metrics.activeMerchantClause(from, to, [key]);
      const rows = await rawQuery(
        `SELECT COUNT(*) AS merchants FROM shops s
          WHERE s.status = 'active' AND ${clause.sql}${filter.sql}`,
        [...clause.params, ...filter.params],
      );
      return { key, label: metrics.MERCHANT_ACTIVITY_LABELS[key], merchants: num(rows[0].merchants) };
    }),
  );

  return results.sort((a, b) => b.merchants - a.merchants);
}

/**
 * §29 - merchant performance concentration.
 *
 * Ranks merchants by offer views and reports what share of all views the top
 * decile, the middle 40% and the bottom half account for. §29 calls this
 * "concentration risk", and it is the one number on the dashboard that gets
 * worse as it goes up.
 */
async function performanceDistribution(from, to, filters) {
  const offerScope = shopFilter(filters, 'o.shop_id');

  const rows = await rawQuery(
    `SELECT o.shop_id AS shop_id, COUNT(*) AS views
       FROM offer_views v JOIN offers o ON o.id = v.offer_id
      WHERE v.event_type = 'view' AND v.created_at BETWEEN ? AND ?${offerScope.sql}
      GROUP BY o.shop_id
      ORDER BY views DESC`,
    [from, to, ...offerScope.params],
  );

  const views = rows.map((row) => num(row.views));
  const total = views.reduce((sum, value) => sum + value, 0);
  if (total === 0 || views.length === 0) {
    return { merchants: views.length, totalViews: 0, bands: [] };
  }

  const topCount = Math.max(1, Math.ceil(views.length * 0.1));
  const middleCount = Math.max(0, Math.ceil(views.length * 0.5) - topCount);

  const sumOf = (start, count) => views.slice(start, start + count).reduce((sum, value) => sum + value, 0);
  const top = sumOf(0, topCount);
  const middle = sumOf(topCount, middleCount);
  const bottom = total - top - middle;

  return {
    merchants: views.length,
    totalViews: total,
    bands: [
      { key: 'top10', label: 'Top 10% merchants', merchants: topCount, views: top, share: percent(top, total) },
      { key: 'middle40', label: 'Middle 40%', merchants: middleCount, views: middle, share: percent(middle, total) },
      {
        key: 'bottom50',
        label: 'Bottom 50%',
        merchants: views.length - topCount - middleCount,
        views: bottom,
        share: percent(bottom, total),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// §16, §17 - merchant retention
// ---------------------------------------------------------------------------

/**
 * Retention by signup cohort.
 *
 * A merchant is retained at offset N if they were active in the 30 days ending
 * N days after they joined - not "active at any point since", which rises with
 * the age of the cohort and would show retention improving as merchants leave.
 *
 * A cohort is only reported for an offset it has actually reached. A shop that
 * signed up three weeks ago cannot have a 30-day retention figure, and
 * counting it as churned would drag every recent cohort towards zero.
 */
async function retention(context) {
  const { filters } = context;
  const filter = shopFilter(filters, 's.id');
  const months = Number(context.cohortMonths ?? 12);

  const cohorts = await rawQuery(
    `SELECT DATE_FORMAT(s.created_at, '%Y-%m') AS cohort,
            MIN(s.created_at) AS started_at,
            COUNT(*) AS merchants
       FROM shops s
      WHERE s.created_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL ? MONTH)
        ${filter.sql}
      GROUP BY cohort
      ORDER BY cohort`,
    [months, ...filter.params],
  );

  const rows = await Promise.all(
    cohorts.map(async (cohort) => {
      const offsets = await Promise.all(
        metrics.RETENTION_OFFSETS.map(async (offset) => {
          const retained = await retainedAt(cohort.cohort, offset.days, filters);
          return { ...offset, ...retained };
        }),
      );

      return {
        cohort: cohort.cohort,
        merchants: num(cohort.merchants),
        offsets: offsets.map((offset) => ({
          key: offset.key,
          label: offset.label,
          days: offset.days,
          // `null` where the cohort has not yet lived long enough to answer.
          retained: offset.reached ? offset.retained : null,
          rate: offset.reached ? percent(offset.retained, num(cohort.merchants)) : null,
          reached: offset.reached,
        })),
      };
    }),
  );

  return {
    cohorts: rows,
    /** §17's chart: the average curve across every cohort that reached each point. */
    curve: cohortCurve(rows),
    definitions: {
      windowDays: metrics.RETENTION_WINDOW_DAYS,
      offsets: metrics.RETENTION_OFFSETS,
      rule:
        `A merchant counts as retained at offset N if they performed a tracked activity ` +
        `within the ${metrics.RETENTION_WINDOW_DAYS} days ending N days after signing up. ` +
        `Cohorts too young to have reached an offset are excluded from it rather than counted as churned.`,
      activities: metrics.ACTIVE_MERCHANT_ACTIVITIES,
    },
  };
}

/** How many of one cohort were still active `days` after joining. */
async function retainedAt(cohort, days, filters) {
  const filter = shopFilter(filters, 's.id');
  const window = metrics.RETENTION_WINDOW_DAYS;
  const activity = metrics.activeMerchantClause(
    // Placeholders; the real bounds are computed per shop by the SQL below.
    null,
    null,
  );

  // The window is relative to each shop's own signup date, so the bounds are
  // expressions rather than bound values. `activeMerchantClause` builds the
  // fragment with `?` placeholders for from/to, which are replaced here by the
  // per-row date arithmetic - the only place in this module where a bound
  // value is swapped for SQL, and it is a date expression built from
  // constants, never from input.
  const from = `DATE_SUB(DATE_ADD(s.created_at, INTERVAL ${Number(days)} DAY), INTERVAL ${Number(window)} DAY)`;
  const to = `DATE_ADD(s.created_at, INTERVAL ${Number(days)} DAY)`;
  const clause = activity.sql.replace(/BETWEEN \? AND \?/g, `BETWEEN ${from} AND ${to}`);

  const rows = await rawQuery(
    `SELECT COUNT(*) AS merchants,
            COALESCE(SUM(DATE_ADD(s.created_at, INTERVAL ? DAY) <= NOW()), 0) AS reached,
            COALESCE(SUM(DATE_ADD(s.created_at, INTERVAL ? DAY) <= NOW() AND ${clause}), 0) AS retained
       FROM shops s
      WHERE DATE_FORMAT(s.created_at, '%Y-%m') = ?${filter.sql}`,
    [days, days, cohort, ...filter.params],
  );

  return {
    // A cohort has "reached" an offset once every one of its members has: a
    // partially-reached cohort would mix answered and unanswerable merchants
    // in one rate.
    reached: num(rows[0].reached) === num(rows[0].merchants) && num(rows[0].merchants) > 0,
    retained: num(rows[0].retained),
  };
}

/** §17's visualization: month 0 is 100% by definition, then the decay. */
function cohortCurve(cohorts) {
  return metrics.COHORT_MONTHS.map((month) => {
    const days = month * 30;
    if (month === 0) return { month, label: 'Month 0', rate: 100, cohorts: cohorts.length };

    const contributing = cohorts
      .map((cohort) => cohort.offsets.find((offset) => offset.days === days))
      .filter((offset) => offset && offset.reached && offset.rate !== null);

    return {
      month,
      label: `Month ${month}`,
      rate: contributing.length
        ? Number((contributing.reduce((sum, offset) => sum + offset.rate, 0) / contributing.length).toFixed(1))
        : null,
      cohorts: contributing.length,
    };
  });
}

// ---------------------------------------------------------------------------
// §28 - customer -> merchant funnel
// ---------------------------------------------------------------------------

/**
 * The platform funnel: active users -> views -> saves -> claims -> redemptions.
 *
 * Each step's rate is against the step above it, and the whole thing is
 * measured over one window so the stages are comparable (§33).
 */
async function funnel(context) {
  const { from, to, previousFrom, previousTo } = context.range;
  const { filters } = context;

  const [users, previousUsers, engagement, previousEngagement] = await Promise.all([
    activeUsers(from, to, filters),
    activeUsers(previousFrom, previousTo, filters),
    engagementTotals(from, to, filters),
    engagementTotals(previousFrom, previousTo, filters),
  ]);

  const stage = (key, label, value, previousValue, previousStage) => ({
    key,
    label,
    value,
    previous: previousValue,
    /** Share of the stage above. Null on the first stage - nothing precedes it. */
    conversionFromPrevious: previousStage === undefined ? null : percent(value, previousStage),
  });

  const stages = [
    stage('activeUsers', 'Active users', users.mau, previousUsers.mau),
    stage('views', 'Offer views', engagement.views, previousEngagement.views, users.mau),
    stage('saves', 'Saves', engagement.saves, previousEngagement.saves, engagement.views),
    stage('claims', 'Claims', engagement.claims, previousEngagement.claims, engagement.saves),
    stage('redemptions', 'Redemptions', engagement.redemptions, previousEngagement.redemptions, engagement.claims),
  ];

  return {
    range: context.range,
    stages,
    /** End to end: what share of active customers ended up at a counter. */
    overallConversion: percent(engagement.redemptions, users.mau),
    redemptionRate: engagement.redemptionRate,
    eligibleClaims: engagement.eligibleClaims,
    pendingClaims: engagement.pendingClaims,
    definitions: { claimEligibility: ELIGIBILITY_NOTE },
  };
}

// ---------------------------------------------------------------------------
// §30, §31 - city and category breakdowns
// ---------------------------------------------------------------------------

/**
 * `shop_id -> city`, resolved from the shop's primary active branch.
 *
 * A derived table rather than a correlated subquery in the SELECT list,
 * because MySQL's `only_full_group_by` (correctly) refuses to group by an
 * expression it cannot prove is functionally dependent on the grouping
 * columns. Joining the mapping in first makes `city` an ordinary column, which
 * it can group by without complaint - and lets the per-shop lookup be
 * evaluated once per shop rather than once per row.
 */
const SHOP_CITY = `(SELECT s2.id AS shop_id,
                           COALESCE((SELECT b.city FROM shop_branches b
                                      WHERE b.shop_id = s2.id AND b.status = 'active'
                                      ORDER BY b.is_primary DESC, b.id LIMIT 1), 'Unknown') AS city
                      FROM shops s2)`;

/**
 * §30 - the same metrics, per city.
 *
 * A shop is attributed to the city of its primary active branch. A chain with
 * branches in two cities therefore lands in one of them rather than being
 * double-counted, which is what keeps the city rows summing to the platform
 * total. Merchants with no branch at all are grouped as "Unknown" rather than
 * dropped - silently losing them would make the rows stop adding up, which is
 * worse than an ugly label.
 */
async function cityBreakdown(context) {
  const { from, to } = context.range;
  const filter = shopFilter(context.filters, 's.id');
  const activity = metrics.activeMerchantClause(from, to);

  const rows = await rawQuery(
    `SELECT city, COUNT(*) AS merchants, COALESCE(SUM(is_active), 0) AS active_merchants
       FROM (
         SELECT COALESCE((SELECT b.city FROM shop_branches b
                            WHERE b.shop_id = s.id AND b.status = 'active'
                            ORDER BY b.is_primary DESC, b.id LIMIT 1), 'Unknown') AS city,
                (${activity.sql}) AS is_active
           FROM shops s
          WHERE s.status = 'active'${filter.sql}
       ) AS per_shop
      GROUP BY city
      ORDER BY active_merchants DESC, merchants DESC`,
    [...activity.params, ...filter.params],
  );

  // Per-city engagement in one grouped pass rather than a query per city.
  const [views, claims, users, revenue] = await Promise.all([
    cityEngagement(from, to, context.filters),
    cityClaims(from, to, context.filters),
    cityActiveUsers(from, to, context.filters),
    cityRevenue(context.filters),
  ]);

  return rows.map((row) => {
    const city = row.city;
    const engagement = views.get(city) ?? { views: 0, offers: 0 };
    const claimTotals = claims.get(city) ?? { claims: 0, redemptions: 0, eligible: 0 };

    return {
      city,
      merchants: num(row.merchants),
      activeMerchants: num(row.active_merchants),
      customers: users.get(city) ?? 0,
      offers: engagement.offers,
      views: engagement.views,
      claims: claimTotals.claims,
      redemptions: claimTotals.redemptions,
      redemptionRate: percent(claimTotals.redemptions, claimTotals.eligible),
      mrr: revenue.get(city) ?? 0,
    };
  });
}

/** `city -> { views, offers }`, attributed by the shop's primary branch. */
async function cityEngagement(from, to, filters) {
  const offerScope = shopFilter(filters, 'o.shop_id');

  const rows = await rawQuery(
    `SELECT sc.city AS city,
            COALESCE(SUM(v.event_type = 'view'), 0) AS views,
            COUNT(DISTINCT o.id) AS offers
       FROM offers o
       JOIN ${SHOP_CITY} AS sc ON sc.shop_id = o.shop_id
       LEFT JOIN offer_views v ON v.offer_id = o.id AND v.created_at BETWEEN ? AND ?
      WHERE 1 = 1${offerScope.sql}
      GROUP BY sc.city`,
    [from, to, ...offerScope.params],
  );

  return new Map(rows.map((row) => [row.city, { views: num(row.views), offers: num(row.offers) }]));
}

async function cityClaims(from, to, filters) {
  const claimScope = shopFilter(filters, 'c.shop_id');

  const rows = await rawQuery(
    `SELECT sc.city AS city,
            COUNT(*) AS claims,
            COALESCE(SUM(${metrics.ELIGIBLE_CLAIM_SQL}), 0)      AS eligible,
            COALESCE(SUM(${metrics.VERIFIED_REDEMPTION_SQL}), 0) AS redemptions
       FROM offer_claims c
       JOIN ${SHOP_CITY} AS sc ON sc.shop_id = c.shop_id
      WHERE c.claimed_at BETWEEN ? AND ?${claimScope.sql}
      GROUP BY sc.city`,
    [from, to, ...claimScope.params],
  );

  return new Map(
    rows.map((row) => [
      row.city,
      { claims: num(row.claims), eligible: num(row.eligible), redemptions: num(row.redemptions) },
    ]),
  );
}

/**
 * Distinct customers per city.
 *
 * Attributed by the shop they engaged with rather than by their own reported
 * location: a customer's device city is optional and often absent, while the
 * shop's is not. One customer active in two cities is counted in both, so
 * these will not sum to platform MAU - which is stated in the payload rather
 * than quietly ignored.
 */
async function cityActiveUsers(from, to, filters) {
  const claimScope = shopFilter(filters, 'c.shop_id');
  const viewScope = shopFilter(filters, 'o.shop_id');

  const rows = await rawQuery(
    `SELECT city, COUNT(DISTINCT user_id) AS people FROM (
        SELECT sc.city AS city, v.user_id AS user_id
          FROM offer_views v
          JOIN offers o ON o.id = v.offer_id
          JOIN ${SHOP_CITY} AS sc ON sc.shop_id = o.shop_id
         WHERE v.user_id IS NOT NULL AND v.event_type IN ('view','click','share')
           AND v.created_at BETWEEN ? AND ?${viewScope.sql}
        UNION ALL
        SELECT sc.city AS city, c.user_id AS user_id
          FROM offer_claims c
          JOIN ${SHOP_CITY} AS sc ON sc.shop_id = c.shop_id
         WHERE c.claimed_at BETWEEN ? AND ?${claimScope.sql}
      ) AS activity
      GROUP BY city`,
    [from, to, ...viewScope.params, from, to, ...claimScope.params],
  );

  return new Map(rows.map((row) => [row.city, num(row.people)]));
}

/** MRR per city, so §30's revenue column agrees with the Revenue page. */
async function cityRevenue(filters) {
  const filter = shopFilter(filters, 'sub.shop_id');
  const statuses = metrics.MRR_ACTIVE_STATUSES.map(() => '?').join(',');

  const rows = await rawQuery(
    `SELECT sc.city AS city,
            COALESCE(SUM(sub.price_amount / CASE sub.billing_cycle WHEN 'yearly' THEN 12 ELSE 1 END), 0) AS mrr
       FROM shop_subscriptions sub
       JOIN ${SHOP_CITY} AS sc ON sc.shop_id = sub.shop_id
      WHERE sub.plan <> 'FREE' AND sub.status IN (${statuses})
        AND sub.payment_status <> 'not_required'${filter.sql}
      GROUP BY sc.city`,
    [...metrics.MRR_ACTIVE_STATUSES, ...filter.params],
  );

  return new Map(rows.map((row) => [row.city, Math.round(num(row.mrr))]));
}

/**
 * §31 - the same shape, per category.
 *
 * Categories come from the listings rather than the shop, because §31's list
 * ("Clothing, Jewellery, Electronics, Food, Beauty, Services, Other") describes
 * what is being sold. A shop selling across three categories contributes to all
 * three, which is intended here and is why these rows are not expected to sum.
 */
async function categoryBreakdown(context) {
  const { from, to } = context.range;
  const { filters } = context;
  const offerScope = shopFilter(filters, 'o.shop_id');
  const claimScope = shopFilter(filters, 'c.shop_id');

  const [listings, claims] = await Promise.all([
    rawQuery(
      `SELECT COALESCE(cat.name, 'Uncategorised') AS category,
              cat.id AS category_id,
              COUNT(DISTINCT o.id)      AS offers,
              COUNT(DISTINCT o.shop_id) AS merchants,
              COALESCE(SUM(v.event_type = 'view'), 0) AS views
         FROM offers o
         LEFT JOIN categories cat ON cat.id = o.category_id
         LEFT JOIN offer_views v ON v.offer_id = o.id AND v.created_at BETWEEN ? AND ?
        WHERE 1 = 1${offerScope.sql}
        GROUP BY cat.id, cat.name
        ORDER BY views DESC`,
      [from, to, ...offerScope.params],
    ),
    rawQuery(
      `SELECT COALESCE(cat.name, 'Uncategorised') AS category,
              COUNT(*) AS claims,
              COALESCE(SUM(${metrics.ELIGIBLE_CLAIM_SQL}), 0)      AS eligible,
              COALESCE(SUM(${metrics.VERIFIED_REDEMPTION_SQL}), 0) AS redemptions
         FROM offer_claims c
         JOIN offers o ON o.id = c.offer_id
         LEFT JOIN categories cat ON cat.id = o.category_id
        WHERE c.claimed_at BETWEEN ? AND ?${claimScope.sql}
        GROUP BY cat.name`,
      [from, to, ...claimScope.params],
    ),
  ]);

  const byCategory = new Map(
    claims.map((row) => [
      row.category,
      { claims: num(row.claims), eligible: num(row.eligible), redemptions: num(row.redemptions) },
    ]),
  );

  return listings.map((row) => {
    const claimTotals = byCategory.get(row.category) ?? { claims: 0, eligible: 0, redemptions: 0 };
    return {
      categoryId: row.category_id === null ? null : Number(row.category_id),
      category: row.category,
      merchants: num(row.merchants),
      offers: num(row.offers),
      views: num(row.views),
      claims: claimTotals.claims,
      redemptions: claimTotals.redemptions,
      redemptionRate: percent(claimTotals.redemptions, claimTotals.eligible),
    };
  });
}

// ---------------------------------------------------------------------------
// §9 - offer performance across the platform
// ---------------------------------------------------------------------------

/** The offers driving the platform, ranked. Used by the Offer Performance tab. */
async function offerPerformance(context, { limit = 25, sort = 'views' } = {}) {
  const { from, to } = context.range;
  const offerScope = shopFilter(context.filters, 'o.shop_id');

  const orderBy = {
    views: 'views DESC',
    claims: 'claims DESC',
    redemptions: 'redemptions DESC',
    conversion: 'conversion DESC',
  }[sort] ?? 'views DESC';

  const rows = await rawQuery(
    `SELECT o.id, o.title, o.status, sh.name AS shop_name, sh.id AS shop_id,
            COALESCE(cat.name, 'Uncategorised') AS category,
            COALESCE(v.views, 0)   AS views,
            COALESCE(c.claims, 0)  AS claims,
            COALESCE(c.redemptions, 0) AS redemptions,
            CASE WHEN COALESCE(v.views, 0) > 0
                 THEN ROUND(COALESCE(c.claims, 0) / v.views * 100, 1) ELSE NULL END AS conversion
       FROM offers o
       JOIN shops sh ON sh.id = o.shop_id
       LEFT JOIN categories cat ON cat.id = o.category_id
       LEFT JOIN (SELECT offer_id, SUM(event_type = 'view') AS views
                    FROM offer_views WHERE created_at BETWEEN ? AND ?
                   GROUP BY offer_id) v ON v.offer_id = o.id
       LEFT JOIN (SELECT offer_id, COUNT(*) AS claims,
                         COALESCE(SUM(status = 'redeemed' AND redeemed_at IS NOT NULL), 0) AS redemptions
                    FROM offer_claims WHERE claimed_at BETWEEN ? AND ?
                   GROUP BY offer_id) c ON c.offer_id = o.id
      WHERE 1 = 1${offerScope.sql}
      ORDER BY ${orderBy}
      LIMIT ?`,
    [from, to, from, to, ...offerScope.params, limit],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    status: row.status,
    shopId: Number(row.shop_id),
    shopName: row.shop_name,
    category: row.category,
    views: num(row.views),
    claims: num(row.claims),
    redemptions: num(row.redemptions),
    claimRate: row.conversion === null ? null : Number(row.conversion),
    redemptionRate: percent(num(row.redemptions), num(row.claims)),
  }));
}

module.exports = {
  activeUsers,
  activeMerchantCount,
  engagementTotals,
  customerMetrics,
  merchantMetrics,
  performanceDistribution,
  retention,
  funnel,
  cityBreakdown,
  categoryBreakdown,
  offerPerformance,
  ELIGIBILITY_NOTE,
};
