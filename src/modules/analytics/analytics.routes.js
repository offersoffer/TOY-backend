'use strict';

const express = require('express');
const { z } = require('zod');
const { queryOne, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');
const { requirePermission, requireGlobalPermission } = require('../../middleware/authorize');
const accessControl = require('../../services/accessControl');
const { ok } = require('../../utils/respond');
const { dayKeysBetween } = require('../../utils/dateRange');

const router = express.Router();

const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  // Custom range (§22). When both are given they win over `days`.
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/**
 * Resolves the time filter to an explicit window so every query in a response
 * covers exactly the same period. `days` is kept as the simple default.
 */
function resolveRange(query) {
  if (query.from && query.to) {
    const to = new Date(query.to);
    // An inclusive "to" date should cover the whole day the user picked.
    if (to.getHours() === 0 && to.getMinutes() === 0) to.setHours(23, 59, 59, 999);
    return { from: new Date(query.from), to, label: 'custom' };
  }
  const to = new Date();
  const from = new Date(to.getTime() - query.days * 86400000);
  return { from, to, label: `${query.days}d` };
}

const shopIdParam = z.object({ shopId: z.coerce.number().int().positive() });

/**
 * Resolves which shops the caller's analytics may cover.
 * Returns `null` for platform-wide access, otherwise a list of shop ids.
 * An Admin is always narrowed to their own shops (§37).
 */
function analyticsScope(user, requestedShopId) {
  const scope = accessControl.shopScopeFor(user, 'VIEW_ANALYTICS');

  if (requestedShopId) {
    if (scope !== null && !scope.includes(Number(requestedShopId))) {
      throw ApiError.forbidden('You can only view analytics for your own shop');
    }
    return [Number(requestedShopId)];
  }

  if (scope !== null && scope.length === 0) {
    throw ApiError.forbidden('You are not assigned to any shop');
  }
  return scope;
}

/** Builds `AND shop_id IN (...)` for a scope, or an empty string for global. */
function scopeClause(scope, column = 'o.shop_id') {
  if (scope === null) return { sql: '', params: [] };
  return { sql: ` AND ${column} IN (${scope.map(() => '?').join(',')})`, params: scope };
}

/**
 * The extra narrowing a branch-confined member gets, for a query with `offers`
 * aliased `o`.
 *
 * The unit is the *offer*, not the event. A branch admin's analytics cover the
 * offers that run at their branch - every shop-wide offer, plus the ones that
 * name them - because that is a question with a true answer. "Views at my
 * branch" mostly is not: a shop-wide offer seen in a feed was not seen at a
 * branch, and `offer_views.branch_id` is null for most of them, so filtering
 * on it would report a quiet branch rather than an unanswerable question.
 *
 * What that means for the numbers is said out loud in the response, via
 * `branchScope` - a shop-wide offer contributes its shop-wide counters, and a
 * dashboard that printed them as one branch's footfall would be lying.
 */
function branchOfferClause(user) {
  const scopes = accessControl.branchScopesFor(user, 'VIEW_ANALYTICS');
  if (scopes.size === 0) return { sql: '', params: [] };

  const shopIds = [...scopes.keys()];
  const parts = [`o.shop_id NOT IN (${shopIds.map(() => '?').join(',')})`];
  const params = [...shopIds];

  for (const [shopId, branchId] of scopes) {
    parts.push(`(o.shop_id = ? AND EXISTS (
        SELECT 1 FROM shop_branches ab
         WHERE ab.id = ? AND ab.shop_id = o.shop_id
           AND (o.applicability_type = 'shop_wide'
             OR (o.applicability_type = 'selected_branches'
                 AND EXISTS (SELECT 1 FROM offer_locations al
                              WHERE al.offer_id = o.id AND al.branch_id = ab.id)))))`);
    params.push(shopId, branchId);
  }

  return { sql: ` AND (${parts.join(' OR ')})`, params };
}

/**
 * The same confinement, for a query over `shop_branches` aliased `b`: a branch
 * admin is shown their own branch row and no sibling's.
 */
function branchRowClause(user, alias = 'b') {
  const scopes = accessControl.branchScopesFor(user, 'VIEW_ANALYTICS');
  if (scopes.size === 0) return { sql: '', params: [] };

  const shopIds = [...scopes.keys()];
  const parts = [`${alias}.shop_id NOT IN (${shopIds.map(() => '?').join(',')})`];
  const params = [...shopIds];

  for (const [shopId, branchId] of scopes) {
    parts.push(`(${alias}.shop_id = ? AND ${alias}.id = ?)`);
    params.push(shopId, branchId);
  }
  return { sql: ` AND (${parts.join(' OR ')})`, params };
}

/** Shop scope and branch confinement together, for the `offers o` queries. */
function offerScopeClause(user, scope) {
  const shop = scopeClause(scope);
  const branch = branchOfferClause(user);
  return { sql: shop.sql + branch.sql, params: [...shop.params, ...branch.params] };
}

/**
 * What the response says about its own scope, so a client can label figures
 * that cover one branch - and never present a shop-wide counter as a branch's.
 */
async function branchScopeOf(user) {
  const scopes = accessControl.branchScopesFor(user, 'VIEW_ANALYTICS');
  if (scopes.size === 0) return null;

  const ids = [...scopes.values()];
  const rows = await rawQuery(
    `SELECT id, branch_name FROM shop_branches WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  return {
    branches: rows.map((row) => ({ id: Number(row.id), name: row.branch_name })),
    /**
     * Which figures are the branch's own and which are the whole shop's. The
     * offer *set* is the branch's; the per-offer counters behind the
     * engagement totals are not, because a shop-wide offer has one view count
     * for the shop.
     */
    offerSet: 'branch',
    counters: 'shop',
    note:
      'Covers the offers that run at your branch. A shop-wide offer contributes '
      + 'the whole shop\'s views, clicks and saves, because those are not recorded per branch.',
  };
}

// ---- V3 --------------------------------------------------------------------
// Both sub-routers carry their own authentication: event ingest is open to
// signed-out customers, and the premium dashboards add a subscription gate on
// top of VIEW_ANALYTICS. Mounting them ahead of the guards below keeps those
// rules local to each router instead of inherited from this one.
router.use('/events', require('./events.routes'));
router.use('/premium', require('./premium.routes'));

router.use(authenticate);
router.use(requirePermission('VIEW_ANALYTICS'));

/** Headline counters for the Super Admin and Admin dashboards (§27, §41). */
router.get(
  '/overview',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const offerScope = offerScopeClause(req.user, scope);

    const offerCounts = await rawQuery(
      `SELECT status, COUNT(*) AS count FROM offers o
        WHERE 1 = 1${offerScope.sql} GROUP BY status`,
      offerScope.params,
    );
    const byStatus = Object.fromEntries(offerCounts.map((row) => [row.status, Number(row.count)]));

    const engagement = await rawQuery(
      `SELECT COALESCE(SUM(o.view_count), 0) AS views,
              COALESCE(SUM(o.click_count), 0) AS clicks,
              COALESCE(SUM(o.favorite_count), 0) AS favorites
         FROM offers o WHERE 1 = 1${offerScope.sql}`,
      offerScope.params,
    );

    const expiringSoon = await rawQuery(
      `SELECT COUNT(*) AS count FROM offers o
        WHERE o.status = 'active' AND o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)
          ${offerScope.sql}`,
      offerScope.params,
    );

    const claimTotals = await rawQuery(
      `SELECT COUNT(*) AS claims, SUM(c.status = 'redeemed') AS redemptions
         FROM offer_claims c JOIN offers o ON o.id = c.offer_id
        WHERE 1 = 1${offerScope.sql}`,
      offerScope.params,
    );

    const data = {
      scope: scope === null ? 'platform' : 'shop',
      shopIds: scope,
      offers: {
        total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
        draft: byStatus.draft ?? 0,
        scheduled: byStatus.scheduled ?? 0,
        active: byStatus.active ?? 0,
        expired: byStatus.expired ?? 0,
        deactivated: byStatus.deactivated ?? 0,
        expiringSoon: Number(expiringSoon[0].count),
      },
      engagement: {
        views: Number(engagement[0].views),
        clicks: Number(engagement[0].clicks),
        favorites: Number(engagement[0].favorites),
        claims: Number(claimTotals[0].claims),
        redemptions: Number(claimTotals[0].redemptions ?? 0),
      },
      branchScope: await branchScopeOf(req.user),
    };

    if (scope === null) {
      const [users, shops, branches, follows] = await Promise.all([
        queryOne(
          "SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM users",
        ),
        queryOne("SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM shops"),
        queryOne("SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM shop_branches"),
        queryOne('SELECT COUNT(*) AS total FROM followed_shops'),
      ]);
      // §23 asks for customers and admins separately: an "admin" is anyone who
      // belongs to a shop or holds a global role beyond CUSTOMER.
      const staff = await queryOne(
        `SELECT COUNT(DISTINCT u.id) AS total FROM users u
          WHERE u.status = 'active'
            AND (EXISTS (SELECT 1 FROM shop_members sm
                          WHERE sm.user_id = u.id AND sm.status = 'active')
              OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                          WHERE ur.user_id = u.id AND r.name <> 'CUSTOMER'))`,
      );

      data.platform = {
        totalUsers: Number(users.total),
        activeUsers: Number(users.active ?? 0),
        totalAdmins: Number(staff.total),
        totalCustomers: Math.max(Number(users.total) - Number(staff.total), 0),
        totalShops: Number(shops.total),
        activeShops: Number(shops.active ?? 0),
        totalBranches: Number(branches.total),
        activeBranches: Number(branches.active ?? 0),
        totalFollows: Number(follows.total),
      };
    } else {
      const [branches, members] = await Promise.all([
        rawQuery(
          `SELECT COUNT(*) AS total FROM shop_branches WHERE shop_id IN (${scope.map(() => '?').join(',')})`,
          scope,
        ),
        rawQuery(
          `SELECT COUNT(*) AS total FROM shop_members WHERE shop_id IN (${scope.map(() => '?').join(',')})`,
          scope,
        ),
      ]);
      data.shop = { branches: Number(branches[0].total), members: Number(members[0].total) };
    }

    ok(res, data);
  }),
);

/** Offer activity over time plus the best and soonest-to-expire offers. */
router.get(
  '/offers',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const offerScope = offerScopeClause(req.user, scope);
    const days = req.query.days;
    const limit = req.query.limit;

    const [created, events, topViewed, topPopular, expiring] = await Promise.all([
      rawQuery(
        `SELECT DATE(o.created_at) AS day, COUNT(*) AS count
           FROM offers o
          WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)${offerScope.sql}
          GROUP BY day ORDER BY day`,
        [days, ...offerScope.params],
      ),
      rawQuery(
        `SELECT DATE(v.created_at) AS day, v.event_type, COUNT(*) AS count
           FROM offer_views v JOIN offers o ON o.id = v.offer_id
          WHERE v.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)${offerScope.sql}
          GROUP BY day, v.event_type ORDER BY day`,
        [days, ...offerScope.params],
      ),
      rawQuery(
        `SELECT o.id, o.title, o.view_count, o.click_count, o.favorite_count, s.name AS shop_name
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE 1 = 1${offerScope.sql}
          ORDER BY o.view_count DESC LIMIT ${limit}`,
        offerScope.params,
      ),
      rawQuery(
        `SELECT o.id, o.title, o.view_count, o.click_count, o.favorite_count, s.name AS shop_name,
                (o.favorite_count * 3 + o.click_count * 2 + o.view_count) AS popularity
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE 1 = 1${offerScope.sql}
          ORDER BY popularity DESC LIMIT ${limit}`,
        offerScope.params,
      ),
      rawQuery(
        `SELECT o.id, o.title, o.end_date, s.name AS shop_name
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE o.status = 'active' AND o.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 14 DAY)
            ${offerScope.sql}
          ORDER BY o.end_date ASC LIMIT ${limit}`,
        offerScope.params,
      ),
    ]);

    // Seed every day in the window first. `GROUP BY day` only returns days that
    // have rows, so building the series from the result sets alone drops the
    // quiet days and leaves the chart plotting the survivors on an axis that
    // jumps - "last 30 days" would read as 26 evenly spaced bars.
    const timeline = new Map();
    for (const day of dayKeysBetween(new Date(Date.now() - days * 86400000), new Date())) {
      timeline.set(day, { day, created: 0, views: 0, clicks: 0, shares: 0, impressions: 0 });
    }
    for (const row of created) {
      const entry = timeline.get(String(row.day));
      if (entry) entry.created = Number(row.count);
    }
    for (const row of events) {
      const entry = timeline.get(String(row.day));
      if (entry) entry[`${row.event_type}s`] = Number(row.count);
    }

    ok(res, {
      timeline: [...timeline.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))),
      mostViewed: topViewed.map(mapOfferStat),
      mostPopular: topPopular.map(mapOfferStat),
      expiringSoon: expiring.map((row) => ({
        id: Number(row.id),
        title: row.title,
        shopName: row.shop_name,
        endDate: row.end_date,
      })),
    });
  }),
);

const mapOfferStat = (row) => ({
  id: Number(row.id),
  title: row.title,
  shopName: row.shop_name,
  views: Number(row.view_count),
  clicks: Number(row.click_count),
  favorites: Number(row.favorite_count),
});

/** Per-shop analytics, including performance by branch (§27). */
router.get(
  '/shops/:shopId',
  validate({ params: shopIdParam, query: rangeQuery }),
  asyncHandler(async (req, res) => {
    analyticsScope(req.user, req.params.shopId);
    const shopId = Number(req.params.shopId);

    const shop = await queryOne('SELECT id, name FROM shops WHERE id = ?', [shopId]);
    if (!shop) throw ApiError.notFound('Shop not found');

    // The offer queries below gain the confinement clause, and `offers` is
    // aliased `o` for that reason - the clause is written against that alias.
    const offerBranch = branchOfferClause(req.user);
    const branchRows = branchRowClause(req.user);

    const [statuses, engagement, branchPerformance, topOffers] = await Promise.all([
      rawQuery(
        `SELECT o.status, COUNT(*) AS count FROM offers o
          WHERE o.shop_id = ?${offerBranch.sql} GROUP BY o.status`,
        [shopId, ...offerBranch.params],
      ),
      queryOne(
        `SELECT COALESCE(SUM(o.view_count), 0) AS views, COALESCE(SUM(o.click_count), 0) AS clicks,
                COALESCE(SUM(o.favorite_count), 0) AS favorites
           FROM offers o WHERE o.shop_id = ?${offerBranch.sql}`,
        [shopId, ...offerBranch.params],
      ),
      rawQuery(
        `SELECT b.id, b.branch_name, b.city,
                (SELECT COUNT(*) FROM offers o
                  WHERE o.shop_id = b.shop_id AND o.status = 'active'
                    AND (o.applicability_type = 'shop_wide'
                      OR EXISTS (SELECT 1 FROM offer_locations ol
                                  WHERE ol.offer_id = o.id AND ol.branch_id = b.id))) AS active_offers,
                (SELECT COUNT(*) FROM offer_views v WHERE v.branch_id = b.id AND v.event_type = 'view') AS views
           FROM shop_branches b WHERE b.shop_id = ?${branchRows.sql}
          ORDER BY b.is_primary DESC, b.branch_name`,
        [shopId, ...branchRows.params],
      ),
      rawQuery(
        `SELECT o.id, o.title, o.view_count, o.click_count, o.favorite_count, s.name AS shop_name
           FROM offers o JOIN shops s ON s.id = o.shop_id
          WHERE o.shop_id = ?${offerBranch.sql} ORDER BY o.view_count DESC LIMIT 10`,
        [shopId, ...offerBranch.params],
      ),
    ]);

    const byStatus = Object.fromEntries(statuses.map((row) => [row.status, Number(row.count)]));
    ok(res, {
      shop: { id: Number(shop.id), name: shop.name },
      offers: {
        total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
        draft: byStatus.draft ?? 0,
        scheduled: byStatus.scheduled ?? 0,
        active: byStatus.active ?? 0,
        expired: byStatus.expired ?? 0,
        deactivated: byStatus.deactivated ?? 0,
      },
      engagement: {
        views: Number(engagement.views),
        clicks: Number(engagement.clicks),
        favorites: Number(engagement.favorites),
      },
      branches: branchPerformance.map((row) => ({
        id: Number(row.id),
        branchName: row.branch_name,
        city: row.city,
        activeOffers: Number(row.active_offers),
        views: Number(row.views),
      })),
      mostViewed: topOffers.map(mapOfferStat),
      branchScope: await branchScopeOf(req.user),
    });
  }),
);

/** Most popular categories. */
router.get(
  '/categories',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const offerScope = offerScopeClause(req.user, scope);

    const rows = await rawQuery(
      `SELECT c.id, c.name,
              COUNT(o.id) AS offer_count,
              COALESCE(SUM(o.view_count), 0) AS views,
              (SELECT COUNT(*) FROM followed_categories fc WHERE fc.category_id = c.id) AS followers
         FROM categories c
         LEFT JOIN offers o ON o.category_id = c.id${offerScope.sql}
        GROUP BY c.id, c.name
        ORDER BY offer_count DESC, views DESC
        LIMIT ${req.query.limit}`,
      offerScope.params,
    );

    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        offerCount: Number(row.offer_count),
        views: Number(row.views),
        followers: Number(row.followers),
      })),
    );
  }),
);

/** Most popular locations, by city. */
router.get(
  '/locations',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const shops = scopeClause(scope, 'b.shop_id');
    const branch = branchRowClause(req.user);
    const scoped = { sql: shops.sql + branch.sql, params: [...shops.params, ...branch.params] };

    const rows = await rawQuery(
      // Grouped by city alone. Branches of the same city do not always agree on
      // `state` (older rows leave it NULL), and grouping on the pair split one
      // city into two rows that each reported the city's whole offer count -
      // the subquery below has always keyed on city. MAX() skips NULLs, so the
      // state shown is a real one whenever any branch recorded it.
      `SELECT b.city, MAX(b.state) AS state,
              COUNT(DISTINCT b.id) AS branch_count,
              COUNT(DISTINCT b.shop_id) AS shop_count,
              (SELECT COUNT(DISTINCT o2.id)
                 FROM offers o2
                 JOIN shop_branches b2 ON b2.shop_id = o2.shop_id
                                      AND b2.city = b.city AND b2.status = 'active'
                WHERE o2.status = 'active') AS active_offers
         FROM shop_branches b
        WHERE b.city IS NOT NULL AND b.status = 'active'${scoped.sql}
        GROUP BY b.city
        ORDER BY active_offers DESC, branch_count DESC
        LIMIT ${req.query.limit}`,
      scoped.params,
    );

    ok(
      res,
      rows.map((row) => ({
        city: row.city,
        state: row.state,
        branchCount: Number(row.branch_count),
        shopCount: Number(row.shop_count),
        activeOffers: Number(row.active_offers),
      })),
    );
  }),
);

/** Most popular shops - platform-wide view for the Super Admin. */
router.get(
  '/shops',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const scoped = scopeClause(scope, 's.id');

    const rows = await rawQuery(
      `SELECT s.id, s.name, s.logo_url,
              (SELECT COUNT(*) FROM offers o WHERE o.shop_id = s.id AND o.status = 'active') AS active_offers,
              (SELECT COALESCE(SUM(o.view_count), 0) FROM offers o WHERE o.shop_id = s.id) AS views,
              (SELECT COUNT(*) FROM followed_shops fs WHERE fs.shop_id = s.id) AS followers
         FROM shops s
        WHERE s.status = 'active'${scoped.sql}
        ORDER BY followers DESC, views DESC
        LIMIT ${req.query.limit}`,
      scoped.params,
    );

    ok(
      res,
      rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        logoUrl: row.logo_url,
        activeOffers: Number(row.active_offers),
        views: Number(row.views),
        followers: Number(row.followers),
      })),
    );
  }),
);

/**
 * Offer funnel (§24): impressions -> views -> saves -> claims -> redemptions.
 *
 * Impressions, views and shares live in `offer_views`; saves come from
 * `favorites`; claims and redemptions from `offer_claims`. All five are counted
 * over the same window so the drop-off between stages is meaningful.
 */
router.get(
  '/funnel',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const scope = analyticsScope(req.user, req.query.shopId);
    const offerScope = offerScopeClause(req.user, scope);
    const { from, to } = resolveRange(req.query);
    const window = [from, to];

    const [events, saves, claims] = await Promise.all([
      rawQuery(
        `SELECT v.event_type, COUNT(*) AS count
           FROM offer_views v JOIN offers o ON o.id = v.offer_id
          WHERE v.created_at BETWEEN ? AND ?${offerScope.sql}
          GROUP BY v.event_type`,
        [...window, ...offerScope.params],
      ),
      rawQuery(
        `SELECT COUNT(*) AS count FROM favorites f JOIN offers o ON o.id = f.offer_id
          WHERE f.created_at BETWEEN ? AND ?${offerScope.sql}`,
        [...window, ...offerScope.params],
      ),
      rawQuery(
        `SELECT
            COUNT(*) AS claims,
            SUM(c.status = 'redeemed') AS redemptions
           FROM offer_claims c JOIN offers o ON o.id = c.offer_id
          WHERE c.claimed_at BETWEEN ? AND ?${offerScope.sql}`,
        [...window, ...offerScope.params],
      ),
    ]);

    const byType = Object.fromEntries(events.map((row) => [row.event_type, Number(row.count)]));
    const impressions = byType.impression ?? 0;
    const views = byType.view ?? 0;
    const savesCount = Number(saves[0].count);
    const claimsCount = Number(claims[0].claims);
    const redemptions = Number(claims[0].redemptions ?? 0);

    // Conversion is expressed against the previous stage, which is what shows
    // where customers actually drop out.
    const rate = (value, previous) =>
      previous > 0 ? Number(((value / previous) * 100).toFixed(1)) : null;

    ok(res, {
      range: { from, to },
      stages: [
        { key: 'impressions', label: 'Impressions', value: impressions, conversion: null },
        { key: 'views', label: 'Views', value: views, conversion: rate(views, impressions) },
        { key: 'saves', label: 'Saves', value: savesCount, conversion: rate(savesCount, views) },
        // Claims convert from views, not from saves: claiming an offer never
        // required saving it first, so dividing by saves reports rates above
        // 100% as soon as claims outnumber saves (V3 §10).
        { key: 'claims', label: 'Claims', value: claimsCount, conversion: rate(claimsCount, views) },
        {
          key: 'redemptions',
          label: 'Redemptions',
          value: redemptions,
          conversion: rate(redemptions, claimsCount),
        },
      ],
      totals: { impressions, views, saves: savesCount, claims: claimsCount, redemptions },
    });
  }),
);

/** Platform growth series for the Super Admin dashboard (§23). */
router.get(
  '/growth',
  requireGlobalPermission('VIEW_ANALYTICS'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    const window = [from, to];

    const series = async (table, column) =>
      rawQuery(
        `SELECT DATE(${column}) AS day, COUNT(*) AS count FROM ${table}
          WHERE ${column} BETWEEN ? AND ? GROUP BY day ORDER BY day`,
        window,
      );

    const [customers, shops, offers, claims] = await Promise.all([
      series('users', 'created_at'),
      series('shops', 'created_at'),
      series('offers', 'created_at'),
      series('offer_claims', 'claimed_at'),
    ]);

    const merge = (rows, key, into) => {
      for (const row of rows) {
        const day = String(row.day);
        into.set(day, { ...(into.get(day) ?? { day: row.day }), [key]: Number(row.count) });
      }
      return into;
    };

    const timeline = new Map();
    merge(customers, 'customers', timeline);
    merge(shops, 'shops', timeline);
    merge(offers, 'offers', timeline);
    merge(claims, 'claims', timeline);

    ok(res, {
      range: { from, to },
      timeline: [...timeline.values()]
        .map((entry) => ({ customers: 0, shops: 0, offers: 0, claims: 0, ...entry }))
        .sort((a, b) => String(a.day).localeCompare(String(b.day))),
    });
  }),
);

module.exports = router;
