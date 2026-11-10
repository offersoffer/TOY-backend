'use strict';

const { query } = require('../../db/pool');
const vis = require('../../config/visibility');
const config = require('./config');
const ranking = require('./ranking.service');
const fairness = require('./fairness');
const featuredPlacements = require('./featuredPlacement.service');
const analytics = require('./visibilityAnalytics.service');

/**
 * VisibilityService (§30).
 *
 * The orchestrator §14's flow describes:
 *
 *     customer location -> nearby listings -> filter active -> distance
 *       -> relevance -> subscription priority -> fairness & rotation -> results
 *
 * `ranking.service` does the scoring, `fairness` does the reordering,
 * `featuredPlacement.service` does the promotional rail. This module is what
 * puts them in the right order and hands back one answer - so a new surface is
 * a set of parameters rather than a fifth reimplementation of the same
 * sequence, and so nobody has to remember that frequency comes before rotation.
 *
 * ## Featured and organic are assembled separately, always
 *
 * §20: "Featured placement must not artificially change or falsify organic
 * analytics." Featured items are resolved from the slot, organic from the
 * scorer, and the two are concatenated rather than interleaved and scored
 * together. A promoted listing therefore cannot inflate its own organic
 * position, and its impressions are written with a `placement_type` that keeps
 * them out of every organic figure.
 */

/**
 * The customer's ranking context: interests, follows and recent behaviour.
 *
 * Signed-in customers get their stated preferences (§4's "Customer
 * Preference"); guests get only what the request itself carries. §4 asks for
 * exactly that split, and it is why nothing here is persisted for a guest.
 */
async function customerContext(user) {
  if (!user) return { preferredCategories: new Set(), followedShops: new Set(), recentTerms: [] };

  const [categories, shops, profile, searches] = await Promise.all([
    query(
      `SELECT category_id FROM customer_category_preferences WHERE user_id = ?
        UNION SELECT category_id FROM followed_categories WHERE user_id = ?`,
      [user.id, user.id],
    ),
    query('SELECT shop_id FROM followed_shops WHERE user_id = ?', [user.id]),
    query('SELECT minimum_discount_percent FROM users WHERE id = ?', [user.id]),
    query(
      // GROUP BY rather than DISTINCT: the ordering column has to be an
      // aggregate for MySQL to allow it alongside de-duplication, and under
      // ONLY_FULL_GROUP_BY (the default since 8.0) `DISTINCT term ORDER BY id`
      // is an error rather than a warning. MAX(id) keeps "most recent first"
      // over the de-duplicated terms.
      `SELECT term FROM search_history WHERE user_id = ?
        GROUP BY term
        ORDER BY MAX(id) DESC
        LIMIT 10`,
      [user.id],
    ),
  ]);

  return {
    preferredCategories: new Set(categories.map((row) => Number(row.category_id))),
    followedShops: new Set(shops.map((row) => Number(row.shop_id))),
    minimumDiscountPercent: profile[0]?.minimum_discount_percent ?? null,
    recentTerms: searches.map((row) => String(row.term ?? '').toLowerCase()).filter(Boolean),
  };
}

/** The API shape for one ranked listing. */
function mapListing(entry, { includeScore = false } = {}) {
  const row = entry.row;
  const item = {
    id: Number(row.id),
    listingType: row.listing_type,
    serviceId: row.service_id === null ? null : Number(row.service_id),
    title: row.title,
    offerText: row.offer_text,
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : Number(row.discount_value),
    originalPrice: row.original_price === null ? null : Number(row.original_price),
    finalPrice: row.final_price === null ? null : Number(row.final_price),
    startDate: row.start_date,
    endDate: row.end_date,
    imageUrl: row.image_url ?? null,
    distanceKm:
      row.distance_km === null || row.distance_km === undefined
        ? null
        : Number(Number(row.distance_km).toFixed(2)),
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    isSaved: Boolean(row.is_saved),
    featured: false,
    // Carried for impression attribution (§16), not for display: the nearest
    // applicable branch and its city.
    branchId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    branchCity: row.branch_city ?? null,
    shop: {
      id: Number(row.shop_id),
      name: row.shop_name,
      slug: row.shop_slug,
      logoUrl: row.shop_logo_url,
    },
    category: row.category_id
      ? { id: Number(row.category_id), name: row.category_name, slug: row.category_slug }
      : null,
  };

  // The score breakdown is never sent to customers - it is merchant- and
  // admin-facing explanation (§27), and publishing the exact weighting to
  // every anonymous caller is an invitation to game it (§25).
  if (includeScore) {
    item.ranking = {
      score: Number(entry.score.toFixed(4)),
      factors: Object.fromEntries(
        Object.entries(entry.factors).map(([key, value]) => [key, Number(value.toFixed(4))]),
      ),
      contributions: entry.contributions,
      fatigued: Boolean(entry.fatigued),
    };
  }

  return item;
}

/**
 * The full pipeline for one surface.
 *
 * `params` carries the query; `options` carries who is asking and from where.
 * The order of operations below is the contract - see `fairness` for why it is
 * frequency, then rotation, then diversity.
 */
async function discover(params, user, options = {}) {
  const { rules, frequencyLimits } = await config.get();
  const surface = params.surface ?? vis.SURFACES.HOME;
  const limit = params.limit ?? 20;
  const page = params.page ?? 1;
  const offset = (page - 1) * limit;

  const context = options.context ?? (await customerContext(user));
  const ranked = await ranking.rank({ ...params, surface, limit: limit * page }, user, context);

  // §18 needs to know what this customer has already been shown. Skipped
  // entirely when there is no identity to cap by - a guest with no session
  // header simply has no fatigue history, which is a cleaner outcome than
  // capping by IP and silencing a whole office at once.
  const identity = options.identity ?? {};
  const limits = fairness.limitsFor(frequencyLimits, null);
  const counts = await fairness.impressionCounts(
    identity,
    limits,
    ranked.scored.map((entry) => entry.row),
  );

  const withFrequency = fairness.applyFrequency(ranked.scored, limits, counts, rules);

  const exposure = await fairness.recentExposure(
    withFrequency.map((entry) => entry.row),
    rules,
  );
  const rotated = fairness.applyRotation(withFrequency, rules, exposure);
  const diversified = fairness.applyDiversity(rotated, rules);

  const pageItems = diversified.slice(offset, offset + limit);

  return {
    surface,
    items: pageItems.map((entry) => mapListing(entry, { includeScore: options.includeScore })),
    scored: pageItems,
    pagination: { page, limit, total: ranked.total },
    frequencyCounts: counts,
    context,
  };
}

/**
 * A discovery surface with its Featured rail on top (§6, §11, §29).
 *
 * §29's example response is exactly this shape: a FEATURED block, then a NEAR
 * YOU block of organic results. They are returned as separate arrays rather
 * than one merged list, so a client cannot accidentally render a promotion as
 * an organic result and §11's "clearly distinguishable" stays true by
 * construction rather than by styling.
 */
async function discoverWithFeatured(params, user, options = {}) {
  const placementType = params.placementType ?? null;
  const organic = await discover(params, user, options);

  if (!placementType) return { ...organic, featured: [] };

  const featured = await featuredPlacements.serve(
    placementType,
    {
      categoryId: params.categoryId ? Number(params.categoryId) : null,
      city: params.city ?? null,
      latitude: params.latitude,
      longitude: params.longitude,
      frequencyCounts: organic.frequencyCounts,
    },
    { limit: params.featuredLimit ?? 5 },
  );

  featuredPlacements.markServed(featured);

  return { ...organic, featured };
}

/**
 * Writes the impressions for a served response (§32).
 *
 * Called after the response has been decided, never before: the customer's
 * results must not wait on analytics. Featured and organic are recorded in the
 * same call but land with different event types and a `placement_type` that
 * separates them forever (§20).
 */
function trackServed({ organic = [], featured = [] }, context) {
  if (featured.length) analytics.recordImpressions(featured, context);
  if (organic.length) analytics.recordImpressions(organic, context);
}

module.exports = {
  customerContext,
  discover,
  discoverWithFeatured,
  mapListing,
  trackServed,
};
