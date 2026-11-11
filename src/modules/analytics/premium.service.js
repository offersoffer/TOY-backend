'use strict';

const { rawQuery } = require('../../db/pool');
const geo = require('../../utils/geo');
const { dayKeysBetween } = require('../../utils/dateRange');

/**
 * Premium analytics (V3 §8-§25).
 *
 * Every function takes a `context` built by `premium.routes.js`:
 *
 *   { shopIds, range: { from, to, previousFrom, previousTo }, filters }
 *
 * `shopIds` is always an explicit list - the route resolves it from the
 * caller's permissions and their subscription, so no query here has to think
 * about ownership. A null scope (platform-wide, Super Admin) is represented by
 * an empty filter rather than a missing one, so the SQL shape never changes.
 *
 * Numbers are computed from the raw event tables over an explicit window so a
 * dashboard and its export always agree. Where a metric is an estimate rather
 * than a measurement it is labelled as such in the response (§25).
 */

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** `AND <column> IN (?, ?)` for a shop scope; empty for platform-wide. */
function shopClause(shopIds, column = 'o.shop_id') {
  if (!shopIds || shopIds.length === 0) return { sql: '', params: [] };
  return { sql: ` AND ${column} IN (${shopIds.map(() => '?').join(',')})`, params: shopIds };
}

/**
 * The optional dashboard filters from §27, applied to an `offers o` alias.
 * Branch filtering follows the offer's applicability rules rather than a plain
 * column, so a shop-wide offer still counts towards every branch it reaches.
 */
/**
 * The branch predicate on its own, for the queries that want it without the
 * rest of §27's filters.
 *
 * An offer counts towards a branch when it *runs* there, so a shop-wide offer
 * counts towards every branch of its shop. That is the same rule the till
 * applies, and the reason this is not a plain `branch_id` column comparison.
 */
function branchFilter(filters = {}) {
  if (!filters.branchId) return { sql: '', params: [] };
  return {
    sql: `
      AND EXISTS (SELECT 1 FROM shop_branches fb
                   WHERE fb.id = ?
                     AND ((o.applicability_type = 'shop_wide' AND fb.shop_id = o.shop_id)
                       OR (o.applicability_type = 'selected_branches'
                           AND EXISTS (SELECT 1 FROM offer_locations fol
                                        WHERE fol.offer_id = o.id AND fol.branch_id = fb.id))))`,
    params: [filters.branchId],
  };
}

function offerFilters(filters = {}) {
  const sql = [];
  const params = [];

  if (filters.categoryId) {
    sql.push(' AND (o.category_id = ? OR o.subcategory_id = ?)');
    params.push(filters.categoryId, filters.categoryId);
  }
  if (filters.offerId) {
    sql.push(' AND o.id = ?');
    params.push(filters.offerId);
  }
  if (filters.offerType) {
    sql.push(' AND o.offer_type = ?');
    params.push(filters.offerType);
  }
  if (filters.discountType) {
    sql.push(' AND o.discount_type = ?');
    params.push(filters.discountType);
  }
  if (filters.status) {
    sql.push(' AND o.status = ?');
    params.push(filters.status);
  }
  const branch = branchFilter(filters);
  if (branch.sql) {
    sql.push(branch.sql);
    params.push(...branch.params);
  }
  if (filters.campaignId) {
    sql.push(' AND EXISTS (SELECT 1 FROM campaign_offers co WHERE co.offer_id = o.id AND co.campaign_id = ?)');
    params.push(filters.campaignId);
  }
  if (filters.city) {
    sql.push(`
      AND EXISTS (SELECT 1 FROM shop_branches cb
                   WHERE cb.shop_id = o.shop_id AND cb.status = 'active' AND cb.city = ?)`);
    params.push(filters.city);
  }

  return { sql: sql.join(''), params };
}

/** Combines the shop scope and the filters into one reusable predicate. */
function offerScope(context, column = 'o.shop_id') {
  const shop = shopClause(context.shopIds, column);
  const filters = offerFilters(context.filters);
  return { sql: shop.sql + filters.sql, params: [...shop.params, ...filters.params] };
}

/** Percentage of `previous`, to one decimal. Null when the base is zero. */
const rate = (value, previous) =>
  previous > 0 ? Number(((value / previous) * 100).toFixed(1)) : null;

/** Period-over-period change, to one decimal. Null when there is no baseline. */
const change = (current, previous) =>
  previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null;

const trendOf = (delta) => {
  if (delta === null) return 'flat';
  if (delta > 1) return 'up';
  if (delta < -1) return 'down';
  return 'flat';
};

const num = (value) => Number(value ?? 0);

/** Builds a KPI card in the shape §8 asks for. */
function kpi(key, label, current, previous, options = {}) {
  const delta = change(current, previous);
  return {
    key,
    label,
    value: current,
    previous,
    change: delta,
    trend: trendOf(delta),
    format: options.format ?? 'number',
    hint: options.hint ?? null,
  };
}

// ---------------------------------------------------------------------------
// §8 Executive overview
// ---------------------------------------------------------------------------

/** Engagement totals for one window, used for both the current and prior period. */
async function totalsFor(context, from, to) {
  const scope = offerScope(context);
  const window = [from, to];

  const [events, saves, claims, customers, activeOffers] = await Promise.all([
    rawQuery(
      `SELECT v.event_type, COUNT(*) AS count, COUNT(DISTINCT v.user_id) AS people
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
    rawQuery(
      `SELECT COUNT(*) AS reach,
              COALESCE(SUM(sc.first_seen_at BETWEEN ? AND ?), 0) AS new_customers
         FROM shop_customers sc
        WHERE sc.last_seen_at BETWEEN ? AND ?
          ${shopClause(context.shopIds, 'sc.shop_id').sql}`,
      [...window, ...window, ...shopClause(context.shopIds, 'sc.shop_id').params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS count FROM offers o
        WHERE o.status = 'active' AND o.start_date <= ? AND o.end_date >= ?${scope.sql}`,
      [to, from, ...scope.params],
    ),
  ]);

  const byType = Object.fromEntries(events.map((row) => [row.event_type, num(row.count)]));
  const reach = num(customers[0].reach);
  const newCustomers = num(customers[0].new_customers);

  return {
    impressions: byType.impression ?? 0,
    views: byType.view ?? 0,
    clicks: byType.click ?? 0,
    shares: byType.share ?? 0,
    saves: num(saves[0].count),
    claims: num(claims[0].claims),
    redemptions: num(claims[0].redemptions),
    reach,
    newCustomers,
    returningCustomers: Math.max(reach - newCustomers, 0),
    activeOffers: num(activeOffers[0].count),
  };
}

/** §8: KPI cards, the charts behind them, and the alert strip. */
async function executiveOverview(context) {
  const { from, to, previousFrom, previousTo } = context.range;

  const [current, previous, timeline, alerts] = await Promise.all([
    totalsFor(context, from, to),
    totalsFor(context, previousFrom, previousTo),
    overviewTimeline(context),
    overviewAlerts(context),
  ]);

  return {
    range: { from, to, previousFrom, previousTo },
    kpis: [
      kpi('views', 'Total offer views', current.views, previous.views),
      kpi('reach', 'Customer reach', current.reach, previous.reach, {
        hint: 'Distinct customers who engaged with your offers in the period.',
      }),
      kpi('saves', 'Offer saves', current.saves, previous.saves),
      kpi('claims', 'Offer claims', current.claims, previous.claims),
      kpi('redemptions', 'Redemptions', current.redemptions, previous.redemptions),
      kpi('newCustomers', 'New customers', current.newCustomers, previous.newCustomers),
      kpi('returningCustomers', 'Returning customers', current.returningCustomers, previous.returningCustomers),
      kpi('activeOffers', 'Active offers', current.activeOffers, previous.activeOffers),
    ],
    totals: current,
    previousTotals: previous,
    timeline,
    alerts,
  };
}

/** Daily series behind the overview charts: views, claims, redemptions, growth. */
async function overviewTimeline(context) {
  const scope = offerScope(context);
  const { from, to } = context.range;
  const window = [from, to];
  const shopOnly = shopClause(context.shopIds, 'sc.shop_id');

  const [views, claims, customers] = await Promise.all([
    rawQuery(
      `SELECT DATE(v.created_at) AS day,
              SUM(v.event_type = 'view')       AS views,
              SUM(v.event_type = 'impression') AS impressions
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY day ORDER BY day`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT DATE(c.claimed_at) AS day, COUNT(*) AS claims,
              COALESCE(SUM(c.status = 'redeemed'), 0) AS redemptions
         FROM offer_claims c JOIN offers o ON o.id = c.offer_id
        WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}
        GROUP BY day ORDER BY day`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT DATE(sc.first_seen_at) AS day, COUNT(*) AS new_customers
         FROM shop_customers sc
        WHERE sc.first_seen_at BETWEEN ? AND ?${shopOnly.sql}
        GROUP BY day ORDER BY day`,
      [...window, ...shopOnly.params],
    ),
  ]);

  const days = new Map();
  const touch = (day) => {
    const key = String(day);
    if (!days.has(key)) {
      days.set(key, { day: key, views: 0, impressions: 0, claims: 0, redemptions: 0, newCustomers: 0 });
    }
    return days.get(key);
  };

  // Seed the whole window before folding the rows in. Each `GROUP BY day` above
  // skips the days it found nothing on, so without this the chart would drop
  // its quiet days entirely and the header would count 25 of the 30 days asked
  // for rather than showing them flat.
  for (const day of dayKeysBetween(from, to)) touch(day);

  for (const row of views) {
    const entry = touch(row.day);
    entry.views = num(row.views);
    entry.impressions = num(row.impressions);
  }
  for (const row of claims) {
    const entry = touch(row.day);
    entry.claims = num(row.claims);
    entry.redemptions = num(row.redemptions);
  }
  for (const row of customers) {
    touch(row.day).newCustomers = num(row.new_customers);
  }

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * §8 alerts. Each one is derived from a measurement, and the wording stays
 * descriptive - no claim is made about why a number moved.
 */
async function overviewAlerts(context) {
  const scope = offerScope(context);
  const { from, to } = context.range;
  const alerts = [];

  const [endingToday, overperformer, topLocation, bestDay] = await Promise.all([
    rawQuery(
      `SELECT COUNT(*) AS count FROM offers o
        WHERE o.status = 'active' AND o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 1 DAY)
          ${scope.sql}`,
      scope.params,
    ),
    rawQuery(
      `SELECT o.id, o.title, COUNT(*) AS views
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.event_type = 'view' AND v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY o.id, o.title ORDER BY views DESC LIMIT 5`,
      [from, to, ...scope.params],
    ),
    rawQuery(
      `SELECT v.city, COUNT(*) AS views
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.city IS NOT NULL AND v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY v.city ORDER BY views DESC LIMIT 1`,
      [from, to, ...scope.params],
    ),
    rawQuery(
      `SELECT DAYNAME(v.created_at) AS day_name, COUNT(*) AS views
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.event_type = 'view' AND v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY day_name ORDER BY views DESC LIMIT 1`,
      [from, to, ...scope.params],
    ),
  ]);

  if (num(endingToday[0].count) > 0) {
    alerts.push({
      key: 'ending-today',
      icon: '⚠',
      tone: 'warning',
      message: `${num(endingToday[0].count)} offer${num(endingToday[0].count) === 1 ? ' is' : 's are'} ending within 24 hours.`,
    });
  }

  // "Above average" is measured against the mean of the offers in view, so the
  // claim is arithmetic rather than a guess.
  if (overperformer.length > 1) {
    const values = overperformer.map((row) => num(row.views));
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const best = overperformer[0];
    const above = average > 0 ? Math.round(((num(best.views) - average) / average) * 100) : 0;
    if (above >= 10) {
      alerts.push({
        key: 'top-offer',
        icon: '🔥',
        tone: 'success',
        message: `Your "${best.title}" offer is performing ${above}% above the average of your top offers.`,
        entityId: Number(best.id),
      });
    }
  }

  if (topLocation.length) {
    alerts.push({
      key: 'top-location',
      icon: '📍',
      tone: 'info',
      message: `Most customer activity is coming from ${topLocation[0].city}.`,
    });
  }

  if (bestDay.length) {
    alerts.push({
      key: 'best-day',
      icon: '💡',
      tone: 'info',
      message: `${bestDay[0].day_name} offers received the most views in this period.`,
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// §9 Offer performance
// ---------------------------------------------------------------------------

/**
 * The per-offer table from §9 plus the five conversion rates.
 *
 * Counts are windowed subqueries rather than joins so one offer cannot be
 * multiplied by another table's rows - the classic fan-out that inflates views
 * whenever an offer also has claims.
 */
async function offerPerformance(context, { limit = 50, sort = 'views' } = {}) {
  const scope = offerScope(context);
  const { from, to } = context.range;
  const window = [from, to];

  // Conversion is a ratio of two subquery aliases, so it is ordered in JS below
  // rather than pushed into SQL as a third pass over the event tables.
  const sortColumn =
    {
      views: 'views DESC',
      claims: 'claims DESC',
      redemptions: 'redemptions DESC',
      conversion: 'claims DESC',
      saves: 'saves DESC',
      newest: 'o.created_at DESC',
    }[sort] ?? 'views DESC';

  // Correlated scalar subqueries rather than joins onto the event tables: a
  // join would multiply each offer by its claims and inflate every view count.
  const rows = await rawQuery(
    `SELECT o.id, o.title, o.status, o.offer_type, o.discount_type, o.discount_value,
            o.start_date, o.end_date, s.name AS shop_name,
            c.name AS category_name,
            (SELECT COALESCE(SUM(v.event_type = 'impression'), 0) FROM offer_views v
              WHERE v.offer_id = o.id AND v.created_at BETWEEN ? AND ?) AS impressions,
            (SELECT COALESCE(SUM(v.event_type = 'view'), 0) FROM offer_views v
              WHERE v.offer_id = o.id AND v.created_at BETWEEN ? AND ?) AS views,
            (SELECT COALESCE(SUM(v.event_type = 'share'), 0) FROM offer_views v
              WHERE v.offer_id = o.id AND v.created_at BETWEEN ? AND ?) AS shares,
            (SELECT COALESCE(SUM(v.event_type = 'click'), 0) FROM offer_views v
              WHERE v.offer_id = o.id AND v.created_at BETWEEN ? AND ?) AS clicks,
            (SELECT COUNT(*) FROM favorites f
              WHERE f.offer_id = o.id AND f.created_at BETWEEN ? AND ?) AS saves,
            (SELECT COUNT(*) FROM offer_claims cc
              WHERE cc.offer_id = o.id AND cc.claimed_at BETWEEN ? AND ?) AS claims,
            (SELECT COALESCE(SUM(cc.status = 'redeemed'), 0) FROM offer_claims cc
              WHERE cc.offer_id = o.id AND cc.claimed_at BETWEEN ? AND ?) AS redemptions
       FROM offers o
       JOIN shops s ON s.id = o.shop_id
       LEFT JOIN categories c ON c.id = o.category_id
      WHERE 1 = 1${scope.sql}
      ORDER BY ${sortColumn}
      LIMIT ${Number(limit)}`,
    [
      ...window, ...window, ...window, ...window,
      ...window, ...window, ...window,
      ...scope.params,
    ],
  );

  const offers = rows.map((row) => {
    const views = num(row.views);
    const saves = num(row.saves);
    const claims = num(row.claims);
    const redemptions = num(row.redemptions);
    const impressions = num(row.impressions);

    return {
      id: Number(row.id),
      title: row.title,
      status: row.status,
      offerType: row.offer_type,
      discountType: row.discount_type,
      discountValue: row.discount_value === null ? null : Number(row.discount_value),
      category: row.category_name,
      shopName: row.shop_name,
      startDate: row.start_date,
      endDate: row.end_date,
      impressions,
      views,
      clicks: num(row.clicks),
      shares: num(row.shares),
      saves,
      claims,
      redemptions,
      rates: {
        impressionToView: rate(views, impressions),
        viewToSave: rate(saves, views),
        viewToClaim: rate(claims, views),
        claimToRedemption: rate(redemptions, claims),
        viewToRedemption: rate(redemptions, views),
        // Any interaction beyond a passive view, over views.
        engagement: rate(saves + claims + num(row.shares) + num(row.clicks), views),
      },
    };
  });

  if (sort === 'conversion') {
    offers.sort((a, b) => (b.rates.viewToClaim ?? -1) - (a.rates.viewToClaim ?? -1));
  }

  const sum = (key) => offers.reduce((total, offer) => total + offer[key], 0);
  const totals = {
    impressions: sum('impressions'),
    views: sum('views'),
    saves: sum('saves'),
    shares: sum('shares'),
    clicks: sum('clicks'),
    claims: sum('claims'),
    redemptions: sum('redemptions'),
  };

  return {
    range: { from, to },
    offers,
    totals,
    rates: {
      impressionToView: rate(totals.views, totals.impressions),
      viewToSave: rate(totals.saves, totals.views),
      viewToClaim: rate(totals.claims, totals.views),
      claimToRedemption: rate(totals.redemptions, totals.claims),
      viewToRedemption: rate(totals.redemptions, totals.views),
      engagement: rate(totals.saves + totals.claims + totals.shares + totals.clicks, totals.views),
    },
  };
}

// ---------------------------------------------------------------------------
// §10 Customer funnel
// ---------------------------------------------------------------------------

/** Impressions -> views -> saves -> claims -> redemptions, with drop-off. */
async function funnel(context) {
  const scope = offerScope(context);
  const { from, to } = context.range;
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

  const byType = Object.fromEntries(events.map((row) => [row.event_type, num(row.count)]));
  const stageValues = {
    impressions: byType.impression ?? 0,
    views: byType.view ?? 0,
    saves: num(saves[0].count),
    claims: num(claims[0].claims),
    redemptions: num(claims[0].redemptions),
  };

  /**
   * Each stage converts from the action that actually precedes it, not from
   * whichever stage sits above it in the drawing.
   *
   * Saving is not a step on the way to claiming - a customer can claim an offer
   * they never saved - so claims are measured against views, exactly as §10's
   * own worked example does ("View -> Claim 7.4%"). Dividing claims by saves
   * would report conversions above 100% the moment claims outnumber saves.
   */
  const STAGES = [
    { key: 'impressions', label: 'Impressions', from: null },
    { key: 'views', label: 'Views', from: 'impressions' },
    { key: 'saves', label: 'Saves', from: 'views' },
    { key: 'claims', label: 'Claims', from: 'views' },
    { key: 'redemptions', label: 'Redemptions', from: 'claims' },
  ];

  const stages = STAGES.map((stage) => {
    const value = stageValues[stage.key];
    const base = stage.from ? stageValues[stage.from] : null;
    return {
      key: stage.key,
      label: stage.label,
      value,
      from: stage.from,
      conversion: stage.from ? rate(value, base) : null,
      dropOff: stage.from ? Math.max(base - value, 0) : null,
      // Share of the very top of the funnel, which is what makes the shape read.
      shareOfTop:
        stageValues.impressions > 0
          ? rate(value, stageValues.impressions)
          : rate(value, stageValues.views),
    };
  });

  // The largest proportional loss between two adjacent stages.
  const biggestDrop = stages
    .filter((stage) => stage.conversion !== null)
    .sort((a, b) => a.conversion - b.conversion)[0] ?? null;

  return {
    range: { from, to },
    stages,
    totals: stageValues,
    rates: {
      impressionToView: rate(stageValues.views, stageValues.impressions),
      viewToSave: rate(stageValues.saves, stageValues.views),
      viewToClaim: rate(stageValues.claims, stageValues.views),
      claimToRedemption: rate(stageValues.redemptions, stageValues.claims),
      viewToRedemption: rate(stageValues.redemptions, stageValues.views),
    },
    biggestDropOff: biggestDrop
      ? { stage: biggestDrop.key, label: biggestDrop.label, conversion: biggestDrop.conversion }
      : null,
  };
}

// ---------------------------------------------------------------------------
// §11 Location intelligence
// ---------------------------------------------------------------------------

/**
 * Where the customers engaging with these offers are.
 *
 * Location comes from the event when the customer shared a position, and falls
 * back to the branch city otherwise, so a merchant without GPS-sharing
 * customers still sees a meaningful breakdown rather than an empty map.
 */
async function locationInsights(context, { position = null } = {}) {
  const scope = offerScope(context);
  const { from, to } = context.range;
  const window = [from, to];
  const branchScope = shopClause(context.shopIds, 'b.shop_id');

  const [byLocation, heatmap, branches, radius] = await Promise.all([
    rawQuery(
      `SELECT loc.city,
              SUM(loc.is_view)       AS views,
              SUM(loc.is_claim)      AS claims,
              SUM(loc.is_redemption) AS redemptions,
              COUNT(DISTINCT loc.user_id) AS customers
         FROM (
           SELECT COALESCE(v.city, br.city) AS city, v.user_id,
                  (v.event_type = 'view') AS is_view, 0 AS is_claim, 0 AS is_redemption
             FROM offer_views v
             JOIN offers o ON o.id = v.offer_id
             LEFT JOIN shop_branches br ON br.id = v.branch_id
            WHERE v.created_at BETWEEN ? AND ?${scope.sql}
           UNION ALL
           SELECT br.city, c.user_id, 0, 1, (c.status = 'redeemed')
             FROM offer_claims c
             JOIN offers o ON o.id = c.offer_id
             LEFT JOIN shop_branches br ON br.id = c.branch_id
            WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}
         ) loc
        WHERE loc.city IS NOT NULL
        GROUP BY loc.city
        ORDER BY views DESC, claims DESC
        LIMIT 25`,
      [...window, ...scope.params, ...window, ...scope.params],
    ),
    // Coordinates rounded to ~1 km cells so the heatmap aggregates rather than
    // plotting individual customers (§13: no personally identifiable data).
    rawQuery(
      `SELECT ROUND(v.latitude, 2) AS lat, ROUND(v.longitude, 2) AS lng, COUNT(*) AS weight
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.latitude IS NOT NULL AND v.longitude IS NOT NULL
          AND v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY lat, lng
        HAVING weight > 0
        ORDER BY weight DESC
        LIMIT 500`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT b.id, b.branch_name, b.city, b.latitude, b.longitude
         FROM shop_branches b
        WHERE b.status = 'active'${branchScope.sql}
        ORDER BY b.is_primary DESC, b.branch_name`,
      branchScope.params,
    ),
    position ? radiusAnalysis(context, position) : Promise.resolve(null),
  ]);

  const locations = byLocation.map((row) => ({
    city: row.city,
    views: num(row.views),
    claims: num(row.claims),
    redemptions: num(row.redemptions),
    customers: num(row.customers),
    conversion: rate(num(row.claims), num(row.views)),
  }));

  const byConversion = [...locations]
    .filter((entry) => entry.conversion !== null)
    .sort((a, b) => b.conversion - a.conversion);

  return {
    range: { from, to },
    locations,
    heatmap: heatmap.map((row) => ({
      latitude: Number(row.lat),
      longitude: Number(row.lng),
      weight: num(row.weight),
    })),
    branches: branches.map((row) => ({
      id: Number(row.id),
      branchName: row.branch_name,
      city: row.city,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
    })),
    radius,
    highlights: {
      mostActive: locations[0] ?? null,
      highestConverting: byConversion[0] ?? null,
    },
  };
}

/** Views and claims within 1/5/10/25 km of a position (§11). */
async function radiusAnalysis(context, position) {
  const scope = offerScope(context);
  const { from, to } = context.range;
  const distance = geo.distanceKmSql('v.latitude', 'v.longitude');
  const distanceParams = geo.distanceKmParams(position.latitude, position.longitude);

  const buckets = [1, 5, 10, 25];
  const rows = await rawQuery(
    `SELECT CASE
              WHEN d.km <= 1  THEN 1
              WHEN d.km <= 5  THEN 5
              WHEN d.km <= 10 THEN 10
              WHEN d.km <= 25 THEN 25
              ELSE 0 END AS bucket,
            COUNT(*) AS views, COUNT(DISTINCT d.user_id) AS customers
       FROM (
         SELECT ${distance} AS km, v.user_id
           FROM offer_views v JOIN offers o ON o.id = v.offer_id
          WHERE v.latitude IS NOT NULL AND v.longitude IS NOT NULL
            AND v.event_type = 'view' AND v.created_at BETWEEN ? AND ?${scope.sql}
       ) d
      WHERE d.km IS NOT NULL
      GROUP BY bucket`,
    [...distanceParams, from, to, ...scope.params],
  );

  const byBucket = Object.fromEntries(
    rows.map((row) => [Number(row.bucket), { views: num(row.views), customers: num(row.customers) }]),
  );

  // Bands are cumulative: "within 10 km" includes everything closer.
  let runningViews = 0;
  let runningCustomers = 0;
  return buckets.map((km) => {
    runningViews += byBucket[km]?.views ?? 0;
    runningCustomers += byBucket[km]?.customers ?? 0;
    return { withinKm: km, views: runningViews, customers: runningCustomers };
  });
}

// ---------------------------------------------------------------------------
// §12 Branch performance
// ---------------------------------------------------------------------------

/**
 * Per-branch comparison. An event is attributed to a branch when the customer
 * viewed the offer in that branch's context; shop-wide offers with no branch on
 * the event are reported separately rather than spread evenly, which would
 * invent numbers.
 */
async function branchPerformance(context) {
  const branchScope = shopClause(context.shopIds, 'b.shop_id');
  const { from, to } = context.range;
  const window = [from, to];

  // §27's `branchId` filter, which this dashboard is the one place that has to
  // apply to the rows themselves rather than to the offers behind them. It is
  // also what confines a branch admin here: `resolveContext` sets the filter
  // for them, so without this they would be shown every sibling branch's
  // takings beside their own.
  const only = context.filters?.branchId
    ? { sql: ' AND b.id = ?', params: [Number(context.filters.branchId)] }
    : { sql: '', params: [] };

  const rows = await rawQuery(
    `SELECT b.id, b.branch_name, b.city, b.is_primary,
            COALESCE(v.views, 0)         AS views,
            COALESCE(v.customers, 0)     AS customers,
            COALESCE(c.claims, 0)        AS claims,
            COALESCE(c.redemptions, 0)   AS redemptions,
            (SELECT COUNT(*) FROM offers o
              WHERE o.shop_id = b.shop_id AND o.status = 'active'
                AND (o.applicability_type = 'shop_wide'
                  OR EXISTS (SELECT 1 FROM offer_locations ol
                              WHERE ol.offer_id = o.id AND ol.branch_id = b.id))) AS active_offers
       FROM shop_branches b
       LEFT JOIN (
         SELECT v.branch_id, COUNT(*) AS views, COUNT(DISTINCT v.user_id) AS customers
           FROM offer_views v
          WHERE v.event_type = 'view' AND v.branch_id IS NOT NULL
            AND v.created_at BETWEEN ? AND ?
          GROUP BY v.branch_id
       ) v ON v.branch_id = b.id
       LEFT JOIN (
         SELECT c.branch_id, COUNT(*) AS claims,
                COALESCE(SUM(c.status = 'redeemed'), 0) AS redemptions
           FROM offer_claims c
          WHERE c.branch_id IS NOT NULL AND c.claimed_at BETWEEN ? AND ?
          GROUP BY c.branch_id
       ) c ON c.branch_id = b.id
      WHERE b.status = 'active'${branchScope.sql}${only.sql}
      ORDER BY views DESC, b.is_primary DESC`,
    [...window, ...window, ...branchScope.params, ...only.params],
  );

  // Top offer per branch, resolved in one pass rather than per row.
  const branchIds = rows.map((row) => Number(row.id));
  const topOffers = branchIds.length
    ? await rawQuery(
        `SELECT v.branch_id, o.id, o.title, COUNT(*) AS views
           FROM offer_views v JOIN offers o ON o.id = v.offer_id
          WHERE v.event_type = 'view' AND v.created_at BETWEEN ? AND ?
            AND v.branch_id IN (${branchIds.map(() => '?').join(',')})
          GROUP BY v.branch_id, o.id, o.title
          ORDER BY views DESC`,
        [...window, ...branchIds],
      )
    : [];

  const topByBranch = new Map();
  for (const row of topOffers) {
    const key = Number(row.branch_id);
    if (!topByBranch.has(key)) {
      topByBranch.set(key, { id: Number(row.id), title: row.title, views: num(row.views) });
    }
  }

  const branches = rows.map((row) => ({
    id: Number(row.id),
    branchName: row.branch_name,
    city: row.city,
    isPrimary: Boolean(row.is_primary),
    activeOffers: num(row.active_offers),
    views: num(row.views),
    customers: num(row.customers),
    claims: num(row.claims),
    redemptions: num(row.redemptions),
    conversion: rate(num(row.claims), num(row.views)),
    topOffer: topByBranch.get(Number(row.id)) ?? null,
  }));

  const best = (key) =>
    branches.filter((branch) => branch[key] !== null).sort((a, b) => b[key] - a[key])[0] ?? null;

  return {
    range: { from, to },
    branches,
    winners: {
      bestPerforming: best('views'),
      highestConversion: best('conversion'),
      mostViewed: best('views'),
      mostRedemptions: best('redemptions'),
    },
  };
}

// ---------------------------------------------------------------------------
// §13, §14, §23, §24 Customers
// ---------------------------------------------------------------------------

/** Reach, interests, segments and the new-vs-returning split. */
async function customerInsights(context) {
  const scope = offerScope(context);
  const shopScope = shopClause(context.shopIds, 'sc.shop_id');
  const { from, to } = context.range;
  const window = [from, to];

  const [totals, interests, frequency, segments] = await Promise.all([
    rawQuery(
      `SELECT COUNT(*) AS reach,
              COALESCE(SUM(sc.first_seen_at BETWEEN ? AND ?), 0) AS new_customers,
              COALESCE(SUM(sc.save_count > 0), 0)   AS saving_customers,
              COALESCE(SUM(sc.claim_count > 0), 0)  AS claiming_customers,
              COALESCE(SUM(sc.redeem_count > 0), 0) AS redeeming_customers
         FROM shop_customers sc
        WHERE sc.last_seen_at BETWEEN ? AND ?${shopScope.sql}`,
      [...window, ...window, ...shopScope.params],
    ),
    // Aggregated category interest only - never a per-customer profile (§13).
    rawQuery(
      `SELECT c.name AS category, COUNT(*) AS interactions
         FROM offer_views v
         JOIN offers o ON o.id = v.offer_id
         JOIN categories c ON c.id = o.category_id
        WHERE v.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY c.name ORDER BY interactions DESC LIMIT 8`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT CASE
                WHEN sc.visit_count = 1 THEN '1 visit'
                WHEN sc.visit_count = 2 THEN '2 visits'
                WHEN sc.visit_count = 3 THEN '3 visits'
                ELSE '4+ visits' END AS bucket,
              COUNT(*) AS customers
         FROM shop_customers sc
        WHERE 1 = 1${shopScope.sql}
        GROUP BY bucket`,
      shopScope.params,
    ),
    rawQuery(
      `SELECT
         COALESCE(SUM(sc.first_seen_at BETWEEN ? AND ?), 0)                     AS new_customer,
         COALESCE(SUM(sc.visit_count > 1), 0)                                   AS returning_customer,
         COALESCE(SUM(sc.visit_count >= 5), 0)                                  AS highly_engaged,
         COALESCE(SUM(sc.save_count >= 3), 0)                                   AS offer_saver,
         COALESCE(SUM(sc.claim_count >= 3), 0)                                  AS frequent_claimer,
         COALESCE(SUM(sc.redeem_count >= 3), 0)                                 AS frequent_redeemer
         FROM shop_customers sc
        WHERE 1 = 1${shopScope.sql}`,
      [...window, ...shopScope.params],
    ),
  ]);

  const reach = num(totals[0].reach);
  const newCustomers = num(totals[0].new_customers);
  const returning = Math.max(reach - newCustomers, 0);
  const interactionTotal = interests.reduce((sum, row) => sum + num(row.interactions), 0);
  const frequencyTotal = frequency.reduce((sum, row) => sum + num(row.customers), 0);

  const order = ['1 visit', '2 visits', '3 visits', '4+ visits'];
  const byBucket = Object.fromEntries(frequency.map((row) => [row.bucket, num(row.customers)]));

  return {
    range: { from, to },
    totals: {
      reach,
      newCustomers,
      returningCustomers: returning,
      savingCustomers: num(totals[0].saving_customers),
      claimingCustomers: num(totals[0].claiming_customers),
      redeemingCustomers: num(totals[0].redeeming_customers),
    },
    split: {
      newPercent: rate(newCustomers, reach),
      returningPercent: rate(returning, reach),
    },
    interests: interests.map((row) => ({
      category: row.category,
      interactions: num(row.interactions),
      percent: rate(num(row.interactions), interactionTotal),
    })),
    visitFrequency: order.map((bucket) => ({
      bucket,
      customers: byBucket[bucket] ?? 0,
      percent: rate(byBucket[bucket] ?? 0, frequencyTotal),
    })),
    segments: [
      { key: 'new', label: 'New customer', customers: num(segments[0].new_customer) },
      { key: 'returning', label: 'Returning customer', customers: num(segments[0].returning_customer) },
      { key: 'engaged', label: 'Highly engaged', customers: num(segments[0].highly_engaged) },
      { key: 'saver', label: 'Offer saver', customers: num(segments[0].offer_saver) },
      { key: 'claimer', label: 'Frequent claimer', customers: num(segments[0].frequent_claimer) },
      { key: 'redeemer', label: 'Frequent redeemer', customers: num(segments[0].frequent_redeemer) },
    ],
  };
}

/** §23: acquisition volumes, growth against the previous period, and the funnel. */
async function acquisition(context) {
  const { from, to, previousFrom, previousTo } = context.range;
  const shopScope = shopClause(context.shopIds, 'sc.shop_id');
  const scope = offerScope(context);

  const [current, previous, series, attributed] = await Promise.all([
    rawQuery(
      `SELECT COUNT(*) AS count FROM shop_customers sc
        WHERE sc.first_seen_at BETWEEN ? AND ?${shopScope.sql}`,
      [from, to, ...shopScope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS count FROM shop_customers sc
        WHERE sc.first_seen_at BETWEEN ? AND ?${shopScope.sql}`,
      [previousFrom, previousTo, ...shopScope.params],
    ),
    rawQuery(
      `SELECT DATE(sc.first_seen_at) AS day, COUNT(*) AS count
         FROM shop_customers sc
        WHERE sc.first_seen_at BETWEEN ? AND ?${shopScope.sql}
        GROUP BY day ORDER BY day`,
      [from, to, ...shopScope.params],
    ),
    // New customers who went on to each funnel stage, counted on people rather
    // than events so one enthusiastic customer cannot skew the shape.
    rawQuery(
      `SELECT
         COUNT(DISTINCT sc.user_id) AS reached,
         COUNT(DISTINCT CASE WHEN sc.save_count   > 0 THEN sc.user_id END) AS saved,
         COUNT(DISTINCT CASE WHEN sc.claim_count  > 0 THEN sc.user_id END) AS claimed,
         COUNT(DISTINCT CASE WHEN sc.redeem_count > 0 THEN sc.user_id END) AS redeemed
         FROM shop_customers sc
        WHERE sc.first_seen_at BETWEEN ? AND ?${shopScope.sql}`,
      [from, to, ...shopScope.params],
    ),
  ]);

  // Restricted to the customers acquired in this window, not everyone who
  // viewed something. This is an acquisition funnel: every stage has to be a
  // subset of the cohort at the top of it, or the conversions read above 100%.
  const viewed = await rawQuery(
    `SELECT COUNT(DISTINCT v.user_id) AS count
       FROM offer_views v
       JOIN offers o ON o.id = v.offer_id
       JOIN shop_customers sc ON sc.shop_id = o.shop_id AND sc.user_id = v.user_id
      WHERE v.user_id IS NOT NULL AND v.event_type = 'view'
        AND v.created_at BETWEEN ? AND ?
        AND sc.first_seen_at BETWEEN ? AND ?${scope.sql}`,
    [from, to, from, to, ...scope.params],
  );

  const newCustomers = num(current[0].count);
  const previousCustomers = num(previous[0].count);
  const reached = num(attributed[0].reached);

  return {
    range: { from, to, previousFrom, previousTo },
    newCustomers,
    previousNewCustomers: previousCustomers,
    growth: change(newCustomers, previousCustomers),
    trend: trendOf(change(newCustomers, previousCustomers)),
    timeline: series.map((row) => ({ day: String(row.day), customers: num(row.count) })),
    funnel: [
      { key: 'new', label: 'New customer', value: reached, conversion: null },
      { key: 'viewed', label: 'Viewed offer', value: num(viewed[0].count), conversion: rate(num(viewed[0].count), reached) },
      { key: 'saved', label: 'Saved', value: num(attributed[0].saved), conversion: rate(num(attributed[0].saved), reached) },
      { key: 'claimed', label: 'Claimed', value: num(attributed[0].claimed), conversion: rate(num(attributed[0].claimed), reached) },
      { key: 'redeemed', label: 'Redeemed', value: num(attributed[0].redeemed), conversion: rate(num(attributed[0].redeemed), reached) },
    ],
  };
}

/** §24: do customers come back? */
async function retention(context) {
  const shopScope = shopClause(context.shopIds, 'sc.shop_id');
  const { from, to } = context.range;

  const [totals, monthly] = await Promise.all([
    rawQuery(
      `SELECT COUNT(*) AS customers,
              COALESCE(SUM(sc.visit_count > 1), 0)   AS returning_customers,
              COALESCE(SUM(sc.claim_count > 1), 0)   AS repeat_claimers,
              COALESCE(SUM(sc.redeem_count > 1), 0)  AS repeat_redeemers,
              COALESCE(SUM(sc.claim_count > 0), 0)   AS claimers,
              COALESCE(SUM(sc.redeem_count > 0), 0)  AS redeemers,
              COALESCE(AVG(sc.visit_count), 0)       AS avg_visits
         FROM shop_customers sc
        WHERE 1 = 1${shopScope.sql}`,
      shopScope.params,
    ),
    rawQuery(
      `SELECT DATE_FORMAT(sc.last_seen_at, '%Y-%m') AS month,
              COUNT(*) AS active,
              COALESCE(SUM(sc.visit_count > 1), 0) AS returning_customers
         FROM shop_customers sc
        WHERE sc.last_seen_at BETWEEN ? AND ?${shopScope.sql}
        GROUP BY month ORDER BY month`,
      [from, to, ...shopScope.params],
    ),
  ]);

  const customers = num(totals[0].customers);

  return {
    range: { from, to },
    customers,
    returningRate: rate(num(totals[0].returning_customers), customers),
    repeatClaimRate: rate(num(totals[0].repeat_claimers), num(totals[0].claimers)),
    repeatRedemptionRate: rate(num(totals[0].repeat_redeemers), num(totals[0].redeemers)),
    averageVisitsPerCustomer: Number(Number(totals[0].avg_visits).toFixed(2)),
    timeline: monthly.map((row) => ({
      month: row.month,
      active: num(row.active),
      returning: num(row.returning_customers),
      returningRate: rate(num(row.returning_customers), num(row.active)),
    })),
  };
}

// ---------------------------------------------------------------------------
// §15 Campaign performance
// ---------------------------------------------------------------------------

/**
 * Banner and campaign metrics. Banners without a campaign are reported on their
 * own so a merchant who never created a campaign still sees their promotions.
 */
async function campaignPerformance(context) {
  const { from, to } = context.range;
  const window = [from, to];
  const shopScope = shopClause(context.shopIds, 'o.shop_id');
  const campaignScope = shopClause(context.shopIds, 'cp.shop_id');

  const [banners, campaigns] = await Promise.all([
    rawQuery(
      `SELECT b.id, b.title, b.status, b.campaign_id, cp.name AS campaign_name,
              o.id AS offer_id, o.title AS offer_title, s.name AS shop_name,
              COALESCE(be.impressions, 0) AS impressions,
              COALESCE(be.clicks, 0)      AS clicks,
              COALESCE(ov.views, 0)       AS offer_views,
              COALESCE(cl.claims, 0)      AS offer_claims,
              COALESCE(cl.redemptions, 0) AS offer_redemptions,
              COALESCE(be.reach, 0)       AS reach
         FROM banners b
         JOIN offers o ON o.id = b.offer_id
         JOIN shops s ON s.id = o.shop_id
         LEFT JOIN campaigns cp ON cp.id = b.campaign_id
         LEFT JOIN (
           SELECT e.banner_id,
                  COALESCE(SUM(e.event_type = 'impression'), 0) AS impressions,
                  COALESCE(SUM(e.event_type = 'click'), 0)      AS clicks,
                  COUNT(DISTINCT e.user_id)                     AS reach
             FROM banner_events e
            WHERE e.created_at BETWEEN ? AND ?
            GROUP BY e.banner_id
         ) be ON be.banner_id = b.id
         LEFT JOIN (
           SELECT v.offer_id, COUNT(*) AS views FROM offer_views v
            WHERE v.event_type = 'view' AND v.created_at BETWEEN ? AND ?
            GROUP BY v.offer_id
         ) ov ON ov.offer_id = o.id
         LEFT JOIN (
           SELECT c.offer_id, COUNT(*) AS claims,
                  COALESCE(SUM(c.status = 'redeemed'), 0) AS redemptions
             FROM offer_claims c WHERE c.claimed_at BETWEEN ? AND ?
            GROUP BY c.offer_id
         ) cl ON cl.offer_id = o.id
        WHERE 1 = 1${shopScope.sql}
        ORDER BY impressions DESC
        LIMIT 100`,
      [...window, ...window, ...window, ...shopScope.params],
    ),
    rawQuery(
      `SELECT cp.id, cp.name, cp.status, cp.start_date, cp.end_date,
              cp.cost, cp.avg_order_value, cp.avg_margin_percent
         FROM campaigns cp
        WHERE 1 = 1${campaignScope.sql}
        ORDER BY cp.start_date DESC
        LIMIT 50`,
      campaignScope.params,
    ),
  ]);

  const mapped = banners.map((row) => {
    const impressions = num(row.impressions);
    const clicks = num(row.clicks);
    return {
      id: Number(row.id),
      title: row.title,
      status: row.status,
      campaignId: row.campaign_id === null ? null : Number(row.campaign_id),
      campaignName: row.campaign_name,
      offerId: Number(row.offer_id),
      offerTitle: row.offer_title,
      shopName: row.shop_name,
      impressions,
      clicks,
      ctr: rate(clicks, impressions),
      reach: num(row.reach),
      offerViews: num(row.offer_views),
      offerClaims: num(row.offer_claims),
      offerRedemptions: num(row.offer_redemptions),
    };
  });

  // Campaign totals are the sum of their banners, so the two views reconcile.
  const byCampaign = new Map();
  for (const campaign of campaigns) {
    byCampaign.set(Number(campaign.id), {
      id: Number(campaign.id),
      name: campaign.name,
      status: campaign.status,
      startDate: campaign.start_date,
      endDate: campaign.end_date,
      cost: campaign.cost === null ? null : Number(campaign.cost),
      impressions: 0,
      clicks: 0,
      reach: 0,
      offerViews: 0,
      offerClaims: 0,
      offerRedemptions: 0,
      banners: 0,
    });
  }
  for (const banner of mapped) {
    if (banner.campaignId === null) continue;
    const campaign = byCampaign.get(banner.campaignId);
    if (!campaign) continue;
    campaign.impressions += banner.impressions;
    campaign.clicks += banner.clicks;
    campaign.reach += banner.reach;
    campaign.offerViews += banner.offerViews;
    campaign.offerClaims += banner.offerClaims;
    campaign.offerRedemptions += banner.offerRedemptions;
    campaign.banners += 1;
  }

  const campaignRows = [...byCampaign.values()].map((campaign) => ({
    ...campaign,
    ctr: rate(campaign.clicks, campaign.impressions),
  }));

  const pool = campaignRows.length ? campaignRows : mapped;
  const best = (key) =>
    pool.filter((row) => row[key] !== null).sort((a, b) => b[key] - a[key])[0] ?? null;

  return {
    range: { from, to },
    banners: mapped,
    campaigns: campaignRows,
    winners: {
      bestCampaign: best('impressions'),
      highestCtr: best('ctr'),
      highestClaims: best('offerClaims'),
      highestRedemptions: best('offerRedemptions'),
      highestReach: best('reach'),
    },
  };
}

// ---------------------------------------------------------------------------
// §16 Offer comparison
// ---------------------------------------------------------------------------

/** Side-by-side comparison of explicitly chosen offers. */
async function offerComparison(context, offerIds) {
  if (!offerIds.length) return { range: context.range, offers: [], best: null, metrics: [] };

  // Shop scope alone is not enough here: the offers are named by the caller,
  // so a branch admin could list ids belonging to a sibling branch. Only the
  // branch predicate is added - the rest of §27's filters are deliberately
  // left out, because the caller has already said which offers to compare.
  const shops = shopClause(context.shopIds);
  const branch = branchFilter(context.filters);
  const scope = { sql: shops.sql + branch.sql, params: [...shops.params, ...branch.params] };
  const { from, to } = context.range;
  const window = [from, to];

  const rows = await rawQuery(
    `SELECT o.id, o.title, o.offer_type, o.discount_type, o.discount_value, o.status,
            COALESCE(SUM(v.event_type = 'view'), 0)       AS views,
            COALESCE(SUM(v.event_type = 'impression'), 0) AS impressions,
            COALESCE(SUM(v.event_type = 'share'), 0)      AS shares,
            (SELECT COUNT(*) FROM favorites f
              WHERE f.offer_id = o.id AND f.created_at BETWEEN ? AND ?) AS saves,
            (SELECT COUNT(*) FROM offer_claims c
              WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS claims,
            (SELECT COALESCE(SUM(c.status = 'redeemed'), 0) FROM offer_claims c
              WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS redemptions
       FROM offers o
       LEFT JOIN offer_views v ON v.offer_id = o.id AND v.created_at BETWEEN ? AND ?
      WHERE o.id IN (${offerIds.map(() => '?').join(',')})${scope.sql}
      GROUP BY o.id, o.title, o.offer_type, o.discount_type, o.discount_value, o.status`,
    [...window, ...window, ...window, ...window, ...offerIds, ...scope.params],
  );

  const offers = rows.map((row) => {
    const views = num(row.views);
    const claims = num(row.claims);
    return {
      id: Number(row.id),
      title: row.title,
      offerType: row.offer_type,
      discountType: row.discount_type,
      discountValue: row.discount_value === null ? null : Number(row.discount_value),
      status: row.status,
      impressions: num(row.impressions),
      views,
      saves: num(row.saves),
      shares: num(row.shares),
      claims,
      redemptions: num(row.redemptions),
      conversion: rate(claims, views),
      redemptionRate: rate(num(row.redemptions), claims),
    };
  });

  // The winner per metric, so the UI can highlight the strongest cell in a row.
  const metricKeys = ['views', 'saves', 'shares', 'claims', 'redemptions', 'conversion', 'redemptionRate'];
  const metrics = metricKeys.map((key) => {
    const ranked = offers
      .filter((offer) => offer[key] !== null)
      .sort((a, b) => b[key] - a[key]);
    return { key, bestOfferId: ranked[0]?.id ?? null };
  });

  // "Best" leans on redemptions, then claims, then views - the further down the
  // funnel a metric sits, the more it says about real business value.
  const best =
    [...offers].sort(
      (a, b) =>
        b.redemptions - a.redemptions ||
        b.claims - a.claims ||
        (b.conversion ?? 0) - (a.conversion ?? 0) ||
        b.views - a.views,
    )[0] ?? null;

  return { range: { from, to }, offers, metrics, best };
}

// ---------------------------------------------------------------------------
// §17 Discount effectiveness
// ---------------------------------------------------------------------------

/**
 * Engagement grouped by discount band and offer type.
 *
 * The response deliberately carries `sampleSize` so the UI can stay quiet when
 * a band rests on one or two offers - §17 asks for correlation-aware wording,
 * not a causal claim.
 */
async function discountEffectiveness(context) {
  const scope = offerScope(context);
  const { from, to } = context.range;
  const window = [from, to];

  const [byBand, byType] = await Promise.all([
    rawQuery(
      `SELECT band, COUNT(*) AS offers, SUM(views) AS views, SUM(claims) AS claims,
              SUM(redemptions) AS redemptions
         FROM (
           SELECT o.id,
                  CASE
                    WHEN o.discount_value IS NULL THEN 'Not set'
                    WHEN o.discount_value < 10 THEN 'Under 10%'
                    WHEN o.discount_value < 20 THEN '10-19%'
                    WHEN o.discount_value < 30 THEN '20-29%'
                    WHEN o.discount_value < 40 THEN '30-39%'
                    WHEN o.discount_value < 50 THEN '40-49%'
                    ELSE '50%+' END AS band,
                  (SELECT COUNT(*) FROM offer_views v
                    WHERE v.offer_id = o.id AND v.event_type = 'view'
                      AND v.created_at BETWEEN ? AND ?) AS views,
                  (SELECT COUNT(*) FROM offer_claims c
                    WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS claims,
                  (SELECT COALESCE(SUM(c.status = 'redeemed'), 0) FROM offer_claims c
                    WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS redemptions
             FROM offers o
            WHERE o.discount_type = 'percentage'${scope.sql}
         ) banded
        GROUP BY band`,
      [...window, ...window, ...window, ...scope.params],
    ),
    rawQuery(
      `SELECT t.offer_type, COUNT(*) AS offers,
              SUM(t.views) AS views, SUM(t.claims) AS claims, SUM(t.redemptions) AS redemptions
         FROM (
           SELECT o.id, o.offer_type,
                  (SELECT COUNT(*) FROM offer_views v
                    WHERE v.offer_id = o.id AND v.event_type = 'view'
                      AND v.created_at BETWEEN ? AND ?) AS views,
                  (SELECT COUNT(*) FROM offer_claims c
                    WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS claims,
                  (SELECT COALESCE(SUM(c.status = 'redeemed'), 0) FROM offer_claims c
                    WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS redemptions
             FROM offers o
            WHERE 1 = 1${scope.sql}
         ) t
        GROUP BY t.offer_type
        ORDER BY claims DESC`,
      [...window, ...window, ...window, ...scope.params],
    ),
  ]);

  const bandOrder = ['Under 10%', '10-19%', '20-29%', '30-39%', '40-49%', '50%+', 'Not set'];

  const bands = byBand
    .map((row) => ({
      band: row.band,
      offers: num(row.offers),
      views: num(row.views),
      claims: num(row.claims),
      redemptions: num(row.redemptions),
      conversion: rate(num(row.claims), num(row.views)),
      sampleSize: num(row.offers),
    }))
    .sort((a, b) => bandOrder.indexOf(a.band) - bandOrder.indexOf(b.band));

  const offerTypeLabels = {
    percentage: 'Discount percentage',
    flat: 'Flat discount',
    buy_x_get_y: 'Buy X Get Y',
    price_drop: 'Price drop',
    up_to: 'Up to X%',
    other: 'Other',
  };

  const types = byType.map((row) => ({
    offerType: row.offer_type,
    label: offerTypeLabels[row.offer_type] ?? row.offer_type,
    offers: num(row.offers),
    views: num(row.views),
    claims: num(row.claims),
    redemptions: num(row.redemptions),
    conversion: rate(num(row.claims), num(row.views)),
    sampleSize: num(row.offers),
  }));

  // Only reportable when enough offers back it up; otherwise §17's "not enough
  // data" wording applies instead.
  const reliable = bands.filter((band) => band.sampleSize >= 3 && band.conversion !== null);
  const strongest = [...reliable].sort((a, b) => b.conversion - a.conversion)[0] ?? null;

  return {
    range: { from, to },
    bands,
    offerTypes: types,
    hasEnoughData: reliable.length >= 2,
    observation: strongest
      ? `Offers with a ${strongest.band} discount historically received a ${strongest.conversion}% view-to-claim rate, the highest of your discount bands.`
      : null,
  };
}

// ---------------------------------------------------------------------------
// §18 Best time to post
// ---------------------------------------------------------------------------

/**
 * Which weekday and hour historically saw the most engagement.
 *
 * Deliberately looks at 90 days rather than the dashboard window: a 7-day
 * filter cannot say anything useful about weekdays.
 */
async function bestTimeToPost(context, { days = 90 } = {}) {
  const scope = offerScope(context);
  const MIN_EVENTS = 50;

  const claimScope = shopClause(context.shopIds);

  const [byDay, viewsByHour, claimsByHour, offerCount] = await Promise.all([
    rawQuery(
      `SELECT DAYOFWEEK(v.created_at) AS day_index, DAYNAME(v.created_at) AS day_name,
              COUNT(*) AS views,
              COUNT(DISTINCT DATE(v.created_at)) AS days_observed
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.event_type = 'view'
          AND v.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${scope.sql}
        GROUP BY day_index, day_name ORDER BY day_index`,
      [days, ...scope.params],
    ),
    rawQuery(
      `SELECT HOUR(v.created_at) AS hour, COUNT(*) AS views
         FROM offer_views v JOIN offers o ON o.id = v.offer_id
        WHERE v.event_type = 'view'
          AND v.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${scope.sql}
        GROUP BY hour ORDER BY hour`,
      [days, ...scope.params],
    ),
    rawQuery(
      `SELECT HOUR(c.claimed_at) AS hour, COUNT(*) AS claims
         FROM offer_claims c JOIN offers o ON o.id = c.offer_id
        WHERE c.claimed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${claimScope.sql}
        GROUP BY hour ORDER BY hour`,
      [days, ...claimScope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS count FROM offers o
        WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${scope.sql}`,
      [days, ...scope.params],
    ),
  ]);

  const claimsByHourMap = new Map(claimsByHour.map((row) => [Number(row.hour), num(row.claims)]));

  const totalViews = byDay.reduce((sum, row) => sum + num(row.views), 0);
  const hasEnoughData = totalViews >= MIN_EVENTS && num(offerCount[0].count) >= 3;

  const maxDayViews = Math.max(1, ...byDay.map((row) => num(row.views)));
  const days_ = byDay.map((row) => {
    const views = num(row.views);
    const observed = Math.max(num(row.days_observed), 1);
    return {
      day: row.day_name,
      views,
      averageViews: Math.round(views / observed),
      // Five-star scale relative to the strongest day, which is how §18 shows it.
      rating: Math.max(1, Math.round((views / maxDayViews) * 5)),
    };
  });

  const hours = viewsByHour.map((row) => {
    const claims = claimsByHourMap.get(Number(row.hour)) ?? 0;
    return {
      hour: Number(row.hour),
      views: num(row.views),
      claims,
      conversion: rate(claims, num(row.views)),
    };
  });

  // Best window = the consecutive two-hour block with the most views.
  let bestWindow = null;
  for (let index = 0; index < hours.length - 1; index += 1) {
    const total = hours[index].views + hours[index + 1].views;
    if (!bestWindow || total > bestWindow.views) {
      bestWindow = { fromHour: hours[index].hour, toHour: hours[index + 1].hour + 1, views: total };
    }
  }

  const bestDay = [...days_].sort((a, b) => b.views - a.views)[0] ?? null;

  return {
    lookbackDays: days,
    hasEnoughData,
    message: hasEnoughData
      ? null
      : 'Not enough historical data yet. Continue publishing offers to unlock posting-time recommendations.',
    days: days_,
    hours,
    bestDay: hasEnoughData ? bestDay : null,
    bestWindow: hasEnoughData ? bestWindow : null,
    averages: hasEnoughData
      ? {
          views: Math.round(totalViews / Math.max(days_.length, 1)),
          claims: hours.reduce((sum, hour) => sum + hour.claims, 0),
          conversion: rate(
            hours.reduce((sum, hour) => sum + hour.claims, 0),
            totalViews,
          ),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// §19 Ending soon opportunities
// ---------------------------------------------------------------------------

/** Offers close to expiry, classified by how much engagement they still hold. */
async function endingSoonOpportunities(context, { withinHours = 72 } = {}) {
  const scope = offerScope(context);

  const rows = await rawQuery(
    `SELECT o.id, o.title, o.end_date, o.offer_text, s.name AS shop_name,
            o.view_count, o.favorite_count,
            (SELECT COUNT(*) FROM offer_views v
              WHERE v.offer_id = o.id AND v.event_type = 'view'
                AND v.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS recent_views,
            (SELECT COUNT(*) FROM favorites f WHERE f.offer_id = o.id) AS saves,
            (SELECT COUNT(*) FROM offer_claims c WHERE c.offer_id = o.id) AS claims,
            TIMESTAMPDIFF(HOUR, NOW(), o.end_date) AS hours_left
       FROM offers o JOIN shops s ON s.id = o.shop_id
      WHERE o.status = 'active'
        AND o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)${scope.sql}
      ORDER BY o.end_date ASC
      LIMIT 50`,
    [withinHours, ...scope.params],
  );

  // The median recent view count is the threshold for "high engagement", so the
  // classification adapts to the merchant's own scale rather than a magic number.
  const recentViews = rows.map((row) => num(row.recent_views)).sort((a, b) => a - b);
  const median = recentViews.length ? recentViews[Math.floor(recentViews.length / 2)] : 0;

  return {
    withinHours,
    offers: rows.map((row) => {
      const views = num(row.recent_views);
      const high = views >= Math.max(median, 1);
      const hoursLeft = num(row.hours_left);

      return {
        id: Number(row.id),
        title: row.title,
        offerText: row.offer_text,
        shopName: row.shop_name,
        endDate: row.end_date,
        hoursLeft,
        views: num(row.view_count),
        recentViews: views,
        saves: num(row.saves),
        claims: num(row.claims),
        classification: high ? 'high-priority' : 'needs-attention',
        recommendation: high
          ? 'Strong recent interest and close to expiry. Consider extending it or publishing a similar offer.'
          : 'Limited recent interest. Consider improving the offer before it expires.',
        actions: high ? ['extend', 'duplicate'] : ['edit', 'duplicate'],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// §20 Offer health score
// ---------------------------------------------------------------------------

/**
 * A 0-100 score per active offer, always returned with the factors behind it -
 * §20 requires the score to be explained rather than asserted.
 */
async function offerHealth(context, { limit = 25 } = {}) {
  const scope = offerScope(context);
  const { from, to } = context.range;
  const window = [from, to];

  const rows = await rawQuery(
    `SELECT o.id, o.title, o.status, o.end_date, o.created_at, o.discount_type, o.discount_value,
            (SELECT COUNT(*) FROM offer_views v
              WHERE v.offer_id = o.id AND v.event_type = 'view'
                AND v.created_at BETWEEN ? AND ?) AS views,
            (SELECT COUNT(*) FROM favorites f
              WHERE f.offer_id = o.id AND f.created_at BETWEEN ? AND ?) AS saves,
            (SELECT COUNT(*) FROM offer_claims c
              WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS claims,
            (SELECT COALESCE(SUM(c.status = 'redeemed'), 0) FROM offer_claims c
              WHERE c.offer_id = o.id AND c.claimed_at BETWEEN ? AND ?) AS redemptions,
            TIMESTAMPDIFF(DAY, NOW(), o.end_date) AS days_left,
            TIMESTAMPDIFF(DAY, o.created_at, NOW()) AS age_days
       FROM offers o
      WHERE o.status IN ('active', 'scheduled')${scope.sql}
      ORDER BY o.end_date ASC
      LIMIT ${Number(limit)}`,
    [...window, ...window, ...window, ...window, ...scope.params],
  );

  if (!rows.length) return { range: { from, to }, offers: [], hasEnoughData: false };

  const allViews = rows.map((row) => num(row.views));
  const bestViews = Math.max(1, ...allViews);

  const offers = rows.map((row) => {
    const views = num(row.views);
    const saves = num(row.saves);
    const claims = num(row.claims);
    const redemptions = num(row.redemptions);
    const daysLeft = num(row.days_left);
    const age = Math.max(num(row.age_days), 1);

    // Each factor scores 0-1 and carries its own weight; the weights are
    // declared inline so a score can always be traced back to its parts.
    const factors = [
      { key: 'views', label: 'Views', weight: 25, score: Math.min(views / bestViews, 1) },
      { key: 'saves', label: 'Saves', weight: 15, score: views > 0 ? Math.min(saves / views / 0.2, 1) : 0 },
      { key: 'claims', label: 'Claims', weight: 20, score: views > 0 ? Math.min(claims / views / 0.08, 1) : 0 },
      {
        key: 'redemptions',
        label: 'Redemption rate',
        weight: 20,
        score: claims > 0 ? Math.min(redemptions / claims / 0.5, 1) : 0,
      },
      {
        key: 'discount',
        label: 'Discount attractiveness',
        weight: 10,
        score:
          row.discount_type === 'percentage' && row.discount_value !== null
            ? Math.min(Number(row.discount_value) / 50, 1)
            : 0.5,
      },
      {
        key: 'freshness',
        label: 'Freshness',
        weight: 5,
        score: Math.max(0, 1 - age / 60),
      },
      {
        key: 'expiry',
        label: 'Time remaining',
        weight: 5,
        score: daysLeft <= 0 ? 0 : Math.min(daysLeft / 14, 1),
      },
    ];

    const score = Math.round(
      factors.reduce((total, factor) => total + factor.score * factor.weight, 0),
    );

    const level =
      score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Needs attention' : 'Poor';

    return {
      id: Number(row.id),
      title: row.title,
      status: row.status,
      endDate: row.end_date,
      score,
      level,
      views,
      saves,
      claims,
      redemptions,
      // The explanation §20 asks for: what carried the score and what dragged it.
      reasons: factors.map((factor) => ({
        label: factor.label,
        good: factor.score >= 0.6,
        detail:
          factor.score >= 0.6
            ? `Strong ${factor.label.toLowerCase()}`
            : `Low ${factor.label.toLowerCase()}`,
      })),
    };
  });

  return { range: { from, to }, offers, hasEnoughData: true };
}

// ---------------------------------------------------------------------------
// §21 Merchant recommendations
// ---------------------------------------------------------------------------

/**
 * Actionable suggestions, each backed by a number that is included in the
 * response. Nothing speculative is presented as fact (§21) - every item names
 * the measurement it came from.
 */
async function recommendations(context) {
  const items = [];

  const [effectiveness, timing, ending, healthy] = await Promise.all([
    discountEffectiveness(context),
    bestTimeToPost(context),
    endingSoonOpportunities(context, { withinHours: 48 }),
    offerHealth(context, { limit: 25 }),
  ]);

  // Which offer type outperformed the merchant's own average.
  const typesWithData = effectiveness.offerTypes.filter(
    (type) => type.sampleSize >= 2 && type.conversion !== null,
  );
  if (typesWithData.length >= 2) {
    const sorted = [...typesWithData].sort((a, b) => b.conversion - a.conversion);
    const best = sorted[0];
    const rest = sorted.slice(1);
    const restAverage =
      rest.reduce((sum, type) => sum + type.conversion, 0) / Math.max(rest.length, 1);
    if (restAverage > 0 && best.conversion > restAverage) {
      items.push({
        key: 'offer-type',
        kind: 'Recommendation',
        icon: '💡',
        title: `${best.label} offers convert better than your other formats`,
        body: `Your ${best.label.toLowerCase()} offers reached a ${best.conversion}% view-to-claim rate against ${restAverage.toFixed(1)}% across your other formats.`,
        action: 'Consider creating another offer in this format.',
        evidence: { metric: 'view-to-claim rate', value: best.conversion, comparedTo: Number(restAverage.toFixed(1)) },
      });
    }
  }

  if (timing.hasEnoughData && timing.bestDay) {
    items.push({
      key: 'timing',
      kind: 'Timing',
      icon: '💡',
      title: `${timing.bestDay.day} offers receive the most views`,
      body: `Over the last ${timing.lookbackDays} days, ${timing.bestDay.day} averaged ${timing.bestDay.averageViews} views per day - your strongest weekday.`,
      action: `Consider scheduling your next campaign for ${timing.bestDay.day}.`,
      evidence: { metric: 'average daily views', value: timing.bestDay.averageViews },
    });
  }

  const urgent = ending.offers.filter((offer) => offer.classification === 'high-priority');
  if (urgent.length) {
    items.push({
      key: 'ending-soon',
      kind: 'Opportunity',
      icon: '⏰',
      title: `${urgent.length} well-performing offer${urgent.length === 1 ? '' : 's'} ending within 48 hours`,
      body: `"${urgent[0].title}" has ${urgent[0].recentViews} views in the last 7 days and ends in ${urgent[0].hoursLeft} hours.`,
      action: 'Consider extending it or publishing a similar offer.',
      entityId: urgent[0].id,
      evidence: { metric: 'views in last 7 days', value: urgent[0].recentViews },
    });
  }

  const weak = healthy.offers.filter((offer) => offer.score < 40);
  if (weak.length) {
    items.push({
      key: 'weak-offers',
      kind: 'Opportunity',
      icon: '⚠',
      title: `${weak.length} live offer${weak.length === 1 ? ' is' : 's are'} scoring below 40 on offer health`,
      body: `"${weak[0].title}" scored ${weak[0].score}/100 in this period.`,
      action: 'Review the discount, imagery and validity window before it expires.',
      entityId: weak[0].id,
      evidence: { metric: 'offer health score', value: weak[0].score },
    });
  }

  return { range: context.range, items, hasEnoughData: items.length > 0 };
}

// ---------------------------------------------------------------------------
// §22 Category & market insights
// ---------------------------------------------------------------------------

/**
 * Aggregated category demand. Only totals across the platform are exposed -
 * never another merchant's figures (§22).
 */
async function categoryInsights(context) {
  const { from, to, previousFrom, previousTo } = context.range;
  const scope = offerScope(context);

  const [own, market, previousMarket, popularTypes] = await Promise.all([
    rawQuery(
      `SELECT c.id, c.name, COUNT(DISTINCT o.id) AS offers,
              COALESCE(SUM(o.view_count), 0) AS views
         FROM offers o JOIN categories c ON c.id = o.category_id
        WHERE 1 = 1${scope.sql}
        GROUP BY c.id, c.name ORDER BY offers DESC`,
      scope.params,
    ),
    rawQuery(
      `SELECT c.id, c.name, COUNT(*) AS interactions
         FROM offer_views v
         JOIN offers o ON o.id = v.offer_id
         JOIN categories c ON c.id = o.category_id
        WHERE v.created_at BETWEEN ? AND ?
        GROUP BY c.id, c.name`,
      [from, to],
    ),
    rawQuery(
      `SELECT c.id, COUNT(*) AS interactions
         FROM offer_views v
         JOIN offers o ON o.id = v.offer_id
         JOIN categories c ON c.id = o.category_id
        WHERE v.created_at BETWEEN ? AND ?
        GROUP BY c.id`,
      [previousFrom, previousTo],
    ),
    rawQuery(
      `SELECT o.offer_type, COUNT(*) AS offers,
              COALESCE(SUM(o.view_count), 0) AS views
         FROM offers o
        WHERE o.status = 'active'
        GROUP BY o.offer_type ORDER BY views DESC LIMIT 6`,
    ),
  ]);

  const previousById = new Map(previousMarket.map((row) => [Number(row.id), num(row.interactions)]));
  const ownIds = new Set(own.map((row) => Number(row.id)));

  const categories = market
    .filter((row) => ownIds.has(Number(row.id)))
    .map((row) => {
      const current = num(row.interactions);
      const previous = previousById.get(Number(row.id)) ?? 0;
      const delta = change(current, previous);
      return {
        id: Number(row.id),
        name: row.name,
        customerInterest: current,
        previousInterest: previous,
        change: delta,
        trend: trendOf(delta),
      };
    })
    .sort((a, b) => b.customerInterest - a.customerInterest);

  return {
    range: { from, to },
    categories,
    yourCategories: own.map((row) => ({
      id: Number(row.id),
      name: row.name,
      offers: num(row.offers),
      views: num(row.views),
    })),
    popularOfferTypes: popularTypes.map((row) => ({
      offerType: row.offer_type,
      offers: num(row.offers),
      views: num(row.views),
    })),
    hasEnoughData: categories.length > 0,
    // Aggregate-only, so the sentence never implies anything about a competitor.
    note: 'Category demand is aggregated across the platform. Individual merchant performance is never shown.',
  };
}

// ---------------------------------------------------------------------------
// §25 ROI / campaign value
// ---------------------------------------------------------------------------

/**
 * Estimated campaign value.
 *
 * Only campaigns where the merchant supplied a cost and an average order value
 * are calculated; the rest are returned as `needsInput` so the UI can ask for
 * the missing figures instead of inventing them. Every derived number is
 * flagged `estimated` (§25).
 */
async function roi(context) {
  const { from, to } = context.range;
  const window = [from, to];
  const campaignScope = shopClause(context.shopIds, 'cp.shop_id');

  const rows = await rawQuery(
    `SELECT cp.id, cp.name, cp.cost, cp.avg_order_value, cp.avg_margin_percent,
            cp.start_date, cp.end_date,
            COALESCE(agg.claims, 0)      AS claims,
            COALESCE(agg.redemptions, 0) AS redemptions
       FROM campaigns cp
       LEFT JOIN (
         SELECT co.campaign_id,
                COUNT(c.id) AS claims,
                COALESCE(SUM(c.status = 'redeemed'), 0) AS redemptions
           FROM campaign_offers co
           JOIN offer_claims c ON c.offer_id = co.offer_id
          WHERE c.claimed_at BETWEEN ? AND ?
          GROUP BY co.campaign_id
       ) agg ON agg.campaign_id = cp.id
      WHERE 1 = 1${campaignScope.sql}
      ORDER BY cp.start_date DESC
      LIMIT 50`,
    [...window, ...campaignScope.params],
  );

  const campaigns = [];
  const needsInput = [];

  for (const row of rows) {
    const cost = row.cost === null ? null : Number(row.cost);
    const orderValue = row.avg_order_value === null ? null : Number(row.avg_order_value);
    const margin = row.avg_margin_percent === null ? null : Number(row.avg_margin_percent);
    const redemptions = num(row.redemptions);

    const base = {
      id: Number(row.id),
      name: row.name,
      startDate: row.start_date,
      endDate: row.end_date,
      claims: num(row.claims),
      redemptions,
      cost,
      averageOrderValue: orderValue,
      averageMarginPercent: margin,
    };

    if (cost === null || orderValue === null || cost <= 0) {
      needsInput.push({ ...base, missing: [cost === null && 'cost', orderValue === null && 'averageOrderValue'].filter(Boolean) });
      continue;
    }

    // A redemption is treated as one order. That is the only measurable link
    // between the platform and a sale until real transaction data is integrated.
    const revenue = redemptions * orderValue;
    const grossProfit = margin === null ? null : revenue * (margin / 100);
    const basis = grossProfit ?? revenue;

    campaigns.push({
      ...base,
      estimatedOrders: redemptions,
      estimatedRevenue: Math.round(revenue),
      estimatedGrossProfit: grossProfit === null ? null : Math.round(grossProfit),
      estimatedRoi: Number((basis / cost).toFixed(2)),
      estimated: true,
    });
  }

  return {
    range: { from, to },
    campaigns,
    needsInput,
    hasEnoughData: campaigns.length > 0,
    disclaimer:
      'Revenue and ROI are estimated from redemptions and the figures you provided. They are not actual transaction data.',
  };
}

module.exports = {
  shopClause,
  offerScope,
  executiveOverview,
  offerPerformance,
  funnel,
  locationInsights,
  branchPerformance,
  customerInsights,
  acquisition,
  retention,
  campaignPerformance,
  offerComparison,
  discountEffectiveness,
  bestTimeToPost,
  endingSoonOpportunities,
  offerHealth,
  recommendations,
  categoryInsights,
  roi,
};
