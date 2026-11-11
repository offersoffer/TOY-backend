'use strict';

const { rawQuery } = require('../../db/pool');

/**
 * Service analytics (V4 §20-§21). Every function takes a `context` built by
 * `serviceAnalytics.routes.js`: `{ shopIds, range: { from, to }, filters }`.
 *
 * Services have no dedicated raw-event table (§7 architecture decision), so
 * every metric here reads `analytics_events` filtered by `service_id`,
 * mirroring how `premium.service.js` reads `offer_views`/`offer_claims` for
 * offers - same shape, different source table.
 */

function shopClause(shopIds, column = 'sv.shop_id') {
  if (!shopIds || shopIds.length === 0) return { sql: '', params: [] };
  return { sql: ` AND ${column} IN (${shopIds.map(() => '?').join(',')})`, params: shopIds };
}

function serviceFilters(filters = {}) {
  const sql = [];
  const params = [];
  if (filters.categoryId) {
    sql.push(' AND (sv.category_id = ? OR sv.subcategory_id = ?)');
    params.push(filters.categoryId, filters.categoryId);
  }
  if (filters.serviceId) {
    sql.push(' AND sv.id = ?');
    params.push(filters.serviceId);
  }
  if (filters.branchId) {
    sql.push(`
      AND EXISTS (SELECT 1 FROM shop_branches fb
                   WHERE fb.id = ?
                     AND ((sv.applicability_type = 'shop_wide' AND fb.shop_id = sv.shop_id)
                       OR (sv.applicability_type = 'selected_branches'
                           AND EXISTS (SELECT 1 FROM service_locations fsl
                                        WHERE fsl.service_id = sv.id AND fsl.branch_id = fb.id))))`);
    params.push(filters.branchId);
  }
  if (filters.city) {
    sql.push(`
      AND EXISTS (SELECT 1 FROM shop_branches cb
                   WHERE cb.shop_id = sv.shop_id AND cb.status = 'active' AND cb.city = ?)`);
    params.push(filters.city);
  }
  return { sql: sql.join(''), params };
}

function serviceScope(context, column = 'sv.shop_id') {
  const shop = shopClause(context.shopIds, column);
  const filters = serviceFilters(context.filters);
  return { sql: shop.sql + filters.sql, params: [...shop.params, ...filters.params] };
}

const num = (value) => Number(value ?? 0);
const rate = (value, base) => (base > 0 ? Number(((value / base) * 100).toFixed(1)) : null);
const change = (current, previous) =>
  previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null;
const trendOf = (delta) => {
  if (delta === null) return 'flat';
  if (delta > 1) return 'up';
  if (delta < -1) return 'down';
  return 'flat';
};

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
  };
}

// ---------------------------------------------------------------------------
// §20 Basic overview
// ---------------------------------------------------------------------------

async function totalsFor(context, from, to) {
  const scope = serviceScope(context);
  const window = [from, to];

  const [events, bookings, claims, listings] = await Promise.all([
    rawQuery(
      `SELECT e.event_type, COUNT(*) AS count, COUNT(DISTINCT e.user_id) AS people
         FROM analytics_events e JOIN services sv ON sv.id = e.service_id
        WHERE e.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY e.event_type`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS count FROM service_bookings b JOIN services sv ON sv.id = b.service_id
        WHERE b.created_at BETWEEN ? AND ?${scope.sql}`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT c.status, COUNT(*) AS count
         FROM service_offer_claims c
         JOIN service_offers so ON so.id = c.service_offer_id
         JOIN services sv ON sv.id = so.service_id
        WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}
        GROUP BY c.status`,
      [...window, ...scope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS total, SUM(sv.status = 'active') AS active
         FROM services sv WHERE 1 = 1${scope.sql}`,
      scope.params,
    ),
  ]);

  const byType = Object.fromEntries(events.map((row) => [row.event_type, num(row.count)]));
  const claimsByStatus = Object.fromEntries(claims.map((row) => [row.status, num(row.count)]));
  const views = byType.SERVICE_VIEW ?? 0;
  const saves = byType.SERVICE_SAVE ?? 0;
  const enquiries = byType.SERVICE_ENQUIRE ?? 0;
  const claimedCount = Object.values(claimsByStatus).reduce((sum, value) => sum + value, 0);
  const redemptions = claimsByStatus.redeemed ?? 0;

  return {
    totalServices: num(listings[0]?.total),
    activeServices: num(listings[0]?.active),
    views,
    uniqueVisitors: events.reduce((max, row) => Math.max(max, num(row.people)), 0),
    saves,
    enquiries,
    bookings: num(bookings[0]?.count),
    claims: claimedCount,
    redemptions,
    conversion: rate(claimedCount, views),
  };
}

async function overview(context) {
  const { range } = context;
  const [current, previous] = await Promise.all([
    totalsFor(context, range.from, range.to),
    totalsFor(context, range.previousFrom, range.previousTo),
  ]);

  return {
    range: { from: range.from, to: range.to, preset: range.preset },
    kpis: [
      kpi('views', 'Service views', current.views, previous.views),
      kpi('uniqueVisitors', 'Unique visitors', current.uniqueVisitors, previous.uniqueVisitors),
      kpi('saves', 'Saves', current.saves, previous.saves),
      kpi('enquiries', 'Enquiries', current.enquiries, previous.enquiries),
      kpi('bookings', 'Bookings', current.bookings, previous.bookings),
      kpi('claims', 'Claims', current.claims, previous.claims),
      kpi('redemptions', 'Redemptions', current.redemptions, previous.redemptions),
      kpi('conversion', 'Conversion', current.conversion ?? 0, previous.conversion ?? 0, { format: 'percent' }),
    ],
    totalServices: current.totalServices,
    activeServices: current.activeServices,
  };
}

// ---------------------------------------------------------------------------
// §21 Service performance
// ---------------------------------------------------------------------------

async function servicePerformance(context) {
  const scope = serviceScope(context);
  const { from, to } = context.range;

  const rows = await rawQuery(
    `SELECT sv.id, sv.name,
            SUM(e.event_type = 'SERVICE_VIEW') AS views,
            SUM(e.event_type = 'SERVICE_SAVE') AS saves,
            (SELECT COUNT(*) FROM service_bookings b WHERE b.service_id = sv.id AND b.created_at BETWEEN ? AND ?) AS bookings,
            (SELECT COUNT(*) FROM service_offer_claims c
               JOIN service_offers so ON so.id = c.service_offer_id
              WHERE so.service_id = sv.id AND c.claimed_at BETWEEN ? AND ?) AS claims
       FROM services sv
       LEFT JOIN analytics_events e ON e.service_id = sv.id AND e.created_at BETWEEN ? AND ?
      WHERE 1 = 1${scope.sql}
      GROUP BY sv.id, sv.name`,
    [from, to, from, to, from, to, ...scope.params],
  );

  const mapped = rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    views: num(row.views),
    saves: num(row.saves),
    bookings: num(row.bookings),
    claims: num(row.claims),
    conversion: rate(num(row.claims), num(row.views)),
  }));

  const best = (key) => [...mapped].sort((a, b) => b[key] - a[key])[0] ?? null;

  return {
    bestService: best('views'),
    mostViewedService: best('views'),
    mostSavedService: best('saves'),
    mostBookedService: best('bookings'),
    mostClaimedService: best('claims'),
    bestConvertingService: [...mapped].sort((a, b) => (b.conversion ?? 0) - (a.conversion ?? 0))[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// §21 Service funnel (no impression tracking for services yet, so the funnel
// starts at View - see §7 architecture note on the raw-event table decision)
// ---------------------------------------------------------------------------

async function funnel(context) {
  const scope = serviceScope(context);
  const { from, to } = context.range;

  const [events, bookings, claims] = await Promise.all([
    rawQuery(
      `SELECT e.event_type, COUNT(*) AS count
         FROM analytics_events e JOIN services sv ON sv.id = e.service_id
        WHERE e.created_at BETWEEN ? AND ?${scope.sql}
        GROUP BY e.event_type`,
      [from, to, ...scope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS count FROM service_bookings b JOIN services sv ON sv.id = b.service_id
        WHERE b.created_at BETWEEN ? AND ?${scope.sql}`,
      [from, to, ...scope.params],
    ),
    rawQuery(
      `SELECT SUM(c.status IN ('claimed','redeemed')) AS claimed, SUM(c.status = 'redeemed') AS redeemed
         FROM service_offer_claims c
         JOIN service_offers so ON so.id = c.service_offer_id
         JOIN services sv ON sv.id = so.service_id
        WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}`,
      [from, to, ...scope.params],
    ),
  ]);

  const byType = Object.fromEntries(events.map((row) => [row.event_type, num(row.count)]));
  const stages = [
    { key: 'view', label: 'Service view', value: byType.SERVICE_VIEW ?? 0 },
    { key: 'save', label: 'Save', value: byType.SERVICE_SAVE ?? 0 },
    {
      key: 'enquiry_booking',
      label: 'Enquiry / Booking',
      value: (byType.SERVICE_ENQUIRE ?? 0) + num(bookings[0]?.count),
    },
    { key: 'claim', label: 'Claim', value: num(claims[0]?.claimed) },
    { key: 'redemption', label: 'Redemption / Completion', value: num(claims[0]?.redeemed) },
  ];

  return stages.map((stage, index) => ({
    ...stage,
    conversionFromPrevious: index === 0 ? null : rate(stage.value, stages[index - 1].value),
  }));
}

// ---------------------------------------------------------------------------
// §21 Service offer performance: normal vs promotional
// ---------------------------------------------------------------------------

async function offerPerformance(context) {
  const scope = serviceScope(context);
  const { from, to } = context.range;

  const [promoted, all] = await Promise.all([
    rawQuery(
      `SELECT COUNT(DISTINCT e.id) AS views
         FROM analytics_events e
         JOIN services sv ON sv.id = e.service_id
         JOIN service_offers so ON so.service_id = sv.id
              AND so.status = 'active' AND e.created_at BETWEEN so.start_date AND so.end_date
        WHERE e.event_type = 'SERVICE_VIEW' AND e.created_at BETWEEN ? AND ?${scope.sql}`,
      [from, to, ...scope.params],
    ),
    rawQuery(
      `SELECT COUNT(*) AS views FROM analytics_events e JOIN services sv ON sv.id = e.service_id
        WHERE e.event_type = 'SERVICE_VIEW' AND e.created_at BETWEEN ? AND ?${scope.sql}`,
      [from, to, ...scope.params],
    ),
  ]);

  const promotionalViews = num(promoted[0]?.views);
  const totalViews = num(all[0]?.views);

  return {
    promotional: { views: promotionalViews },
    normal: { views: Math.max(totalViews - promotionalViews, 0) },
  };
}

// ---------------------------------------------------------------------------
// §21 Branch analytics
// ---------------------------------------------------------------------------

async function branchPerformance(context) {
  const scope = serviceScope(context);
  const { from, to } = context.range;

  // The one dashboard where `branchId` has to narrow the rows rather than the
  // services behind them - and so the one place a branch admin would
  // otherwise be shown every sibling branch beside their own.
  const only = context.filters?.branchId
    ? { sql: ' AND b.id = ?', params: [Number(context.filters.branchId)] }
    : { sql: '', params: [] };

  const rows = await rawQuery(
    `SELECT b.id, b.branch_name, b.city,
            (SELECT COUNT(*) FROM analytics_events e JOIN services sv2 ON sv2.id = e.service_id
              WHERE e.branch_id = b.id AND e.event_type = 'SERVICE_VIEW'
                AND e.created_at BETWEEN ? AND ?) AS views,
            (SELECT COUNT(*) FROM service_bookings sb WHERE sb.branch_id = b.id AND sb.created_at BETWEEN ? AND ?) AS bookings,
            (SELECT COUNT(*) FROM service_offer_claims c WHERE c.branch_id = b.id AND c.claimed_at BETWEEN ? AND ?) AS claims
       FROM shop_branches b
       JOIN services sv ON sv.shop_id = b.shop_id
      WHERE b.status = 'active'${scope.sql}${only.sql}
      GROUP BY b.id, b.branch_name, b.city`,
    [from, to, from, to, from, to, ...scope.params, ...only.params],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    branchName: row.branch_name,
    city: row.city,
    views: num(row.views),
    bookings: num(row.bookings),
    claims: num(row.claims),
  }));
}

// ---------------------------------------------------------------------------
// §21 Location analytics
// ---------------------------------------------------------------------------

async function locationInsights(context) {
  const scope = serviceScope(context);
  const { from, to } = context.range;

  const rows = await rawQuery(
    `SELECT e.city,
            SUM(e.event_type = 'SERVICE_VIEW') AS views,
            (SELECT COUNT(*) FROM service_bookings sb JOIN services sv2 ON sv2.id = sb.service_id
              WHERE sb.created_at BETWEEN ? AND ?${scope.sql.replace(/sv\./g, 'sv2.')}) AS bookings
       FROM analytics_events e JOIN services sv ON sv.id = e.service_id
      WHERE e.city IS NOT NULL AND e.created_at BETWEEN ? AND ?${scope.sql}
      GROUP BY e.city
      ORDER BY views DESC
      LIMIT 20`,
    [from, to, ...scope.params, from, to, ...scope.params],
  );

  return rows.map((row) => ({
    city: row.city,
    views: num(row.views),
    bookings: num(row.bookings),
  }));
}

// ---------------------------------------------------------------------------
// §21 Customer trends
// ---------------------------------------------------------------------------

async function customerTrends(context) {
  const scope = serviceScope(context);
  const { range } = context;

  const [current, previous, repeats] = await Promise.all([
    rawQuery(
      `SELECT COUNT(DISTINCT e.user_id) AS customers
         FROM analytics_events e JOIN services sv ON sv.id = e.service_id
        WHERE e.user_id IS NOT NULL AND e.created_at BETWEEN ? AND ?${scope.sql}`,
      [range.from, range.to, ...scope.params],
    ),
    rawQuery(
      `SELECT COUNT(DISTINCT e.user_id) AS customers
         FROM analytics_events e JOIN services sv ON sv.id = e.service_id
        WHERE e.user_id IS NOT NULL AND e.created_at BETWEEN ? AND ?${scope.sql}`,
      [range.previousFrom, range.previousTo, ...scope.params],
    ),
    rawQuery(
      `SELECT
         (SELECT COUNT(*) FROM (
            SELECT b.user_id FROM service_bookings b JOIN services sv ON sv.id = b.service_id
             WHERE b.created_at BETWEEN ? AND ?${scope.sql}
             GROUP BY b.user_id HAVING COUNT(*) > 1
          ) rb) AS repeat_bookers,
         (SELECT COUNT(*) FROM (
            SELECT c.user_id FROM service_offer_claims c
              JOIN service_offers so ON so.id = c.service_offer_id JOIN services sv ON sv.id = so.service_id
             WHERE c.claimed_at BETWEEN ? AND ?${scope.sql}
             GROUP BY c.user_id HAVING COUNT(*) > 1
          ) rc) AS repeat_claimers`,
      [range.from, range.to, ...scope.params, range.from, range.to, ...scope.params],
    ),
  ]);

  const currentCustomers = num(current[0]?.customers);
  const previousCustomers = num(previous[0]?.customers);

  return {
    newCustomers: currentCustomers,
    customerGrowth: change(currentCustomers, previousCustomers),
    repeatBookings: num(repeats[0]?.repeat_bookers),
    repeatClaims: num(repeats[0]?.repeat_claimers),
  };
}

// ---------------------------------------------------------------------------
// §21 Service comparison
// ---------------------------------------------------------------------------

async function serviceComparison(context, serviceIds) {
  const scope = serviceScope(context);
  const { from, to } = context.range;
  const placeholders = serviceIds.map(() => '?').join(',');

  const rows = await rawQuery(
    `SELECT sv.id, sv.name,
            SUM(e.event_type = 'SERVICE_VIEW') AS views,
            SUM(e.event_type = 'SERVICE_SAVE') AS saves,
            SUM(e.event_type = 'SERVICE_ENQUIRE') AS enquiries,
            (SELECT COUNT(*) FROM service_bookings b WHERE b.service_id = sv.id AND b.created_at BETWEEN ? AND ?) AS bookings,
            (SELECT COUNT(*) FROM service_offer_claims c JOIN service_offers so ON so.id = c.service_offer_id
              WHERE so.service_id = sv.id AND c.claimed_at BETWEEN ? AND ?) AS claims,
            (SELECT COUNT(*) FROM service_offer_claims c JOIN service_offers so ON so.id = c.service_offer_id
              WHERE so.service_id = sv.id AND c.status = 'redeemed' AND c.claimed_at BETWEEN ? AND ?) AS redemptions
       FROM services sv
       LEFT JOIN analytics_events e ON e.service_id = sv.id AND e.created_at BETWEEN ? AND ?
      WHERE sv.id IN (${placeholders})${scope.sql}
      GROUP BY sv.id, sv.name`,
    [from, to, from, to, from, to, from, to, ...serviceIds, ...scope.params],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    views: num(row.views),
    saves: num(row.saves),
    enquiries: num(row.enquiries),
    bookings: num(row.bookings),
    claims: num(row.claims),
    redemptions: num(row.redemptions),
    conversion: rate(num(row.claims), num(row.views)),
  }));
}

// ---------------------------------------------------------------------------
// §21 Category insights
// ---------------------------------------------------------------------------

async function categoryInsights(context) {
  const scope = serviceScope(context);
  const { from, to } = context.range;

  const rows = await rawQuery(
    `SELECT c.id, c.name,
            COUNT(DISTINCT sv.id) AS serviceCount,
            SUM(e.event_type = 'SERVICE_VIEW') AS views,
            SUM(e.event_type = 'SERVICE_SAVE') AS saves
       FROM categories c
       JOIN services sv ON sv.category_id = c.id
       LEFT JOIN analytics_events e ON e.service_id = sv.id AND e.created_at BETWEEN ? AND ?
      WHERE 1 = 1${scope.sql}
      GROUP BY c.id, c.name
      ORDER BY views DESC`,
    [from, to, ...scope.params],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    serviceCount: num(row.serviceCount),
    views: num(row.views),
    saves: num(row.saves),
  }));
}

module.exports = {
  overview,
  servicePerformance,
  funnel,
  offerPerformance,
  branchPerformance,
  locationInsights,
  customerTrends,
  serviceComparison,
  categoryInsights,
};
