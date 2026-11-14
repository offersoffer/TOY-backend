'use strict';

/**
 * Guest/authenticated cache separation (V3 Guest Browsing §26).
 *
 * Public discovery is the same for every visitor, so it can be cached hard by
 * the browser and by any shared cache in front of the API. Anything derived
 * from the caller's account must never be stored anywhere it could be replayed
 * to a different customer.
 *
 * Two rules do the work:
 *
 *   1. `Vary: Authorization` on every API response. The personalised fields on
 *      an otherwise public payload (`isFavorite`, `isFollowing`, `isSaved`)
 *      come from the bearer token, so a cache keyed on the URL alone would hand
 *      one customer another customer's flags.
 *   2. A response is only marked `public` when the request arrived without a
 *      token AND the path is on the public-discovery list. Everything else -
 *      any authenticated request, any write, any user-scoped path - is
 *      `private, no-store`.
 *
 * The token check is on the raw header rather than `req.user`, because this
 * runs before the route's own `optionalAuth`.
 */

const env = require('../config/env');

/** Paths that serve identical content to every anonymous visitor (§25). */
const PUBLIC_PATTERNS = [
  /^\/offers(\/\d+)?$/,
  /^\/offers\/\d+\/reviews$/,
  /^\/services(\/\d+)?$/,
  /^\/shops(\/[^/]+)?$/,
  /^\/shops\/[^/]+\/branches$/,
  /^\/categories(\/\d+)?$/,
  /^\/discovery\/(featured|ending-soon|nearby|offers|recommended)$/,
  /^\/search$/,
];

/**
 * User-scoped paths. These are already behind `authenticate`, so the token
 * check alone would cover them - listing them keeps the boundary explicit and
 * keeps the header correct if one of them ever gains an anonymous mode.
 */
const PRIVATE_PATTERNS = [
  /^\/auth\//,
  /^\/users\//,
  /^\/profile/,
  /^\/favorites/,
  /^\/saved-services/,
  /^\/following/,
  /^\/claims/,
  /^\/service-offer-claims/,
  /^\/notifications/,
  /^\/preferences/,
  /^\/analytics/,
  /^\/service-analytics/,
  /^\/subscriptions/,
  /^\/payments/,
  /^\/audit-logs/,
];

/**
 * Prefixes whose **writes** change what the public discovery responses say.
 *
 * Kept here, beside `PUBLIC_PATTERNS`, because the two are one decision read
 * from opposite ends: this list is what has to be retired from the cache when
 * it changes, and that list is what gets cached in the first place. Splitting
 * them across files is how a new public route ends up cached and never
 * invalidated.
 *
 * Deliberately **not** here: `/favorites`, `/following`, `/claims`,
 * `/notifications`, `/preferences` and the rest of the per-customer writes.
 * They are by far the most frequent writes in the system and none of them
 * changes a byte of an anonymous response, so invalidating on them would keep
 * the cache permanently cold for no benefit.
 */
const PUBLIC_CONTENT_WRITE_PREFIXES = [
  '/offers',
  '/services',
  '/shops',
  '/categories',
  '/banners',
  '/campaigns',
  '/featured-campaigns',
  '/visibility',
  '/reviews',
  '/onboarding',
];

/** Whether a write to this path can change a public discovery response. */
const affectsPublicContent = (path) =>
  PUBLIC_CONTENT_WRITE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

const isPublicPath = (path) =>
  PUBLIC_PATTERNS.some((pattern) => pattern.test(path)) &&
  !PRIVATE_PATTERNS.some((pattern) => pattern.test(path));

function cachePolicy(req, res, next) {
  // Personalisation is keyed on the token, so every response - cacheable or
  // not - has to declare that it varies by it.
  res.setHeader('Vary', 'Authorization');

  const anonymous = !(req.headers.authorization || '').startsWith('Bearer ');
  const cacheable = req.method === 'GET' && anonymous && isPublicPath(req.path);

  if (cacheable) {
    const { publicMaxAgeSeconds, sharedMaxAgeSeconds } = env.cache;
    res.setHeader(
      'Cache-Control',
      `public, max-age=${publicMaxAgeSeconds}, s-maxage=${sharedMaxAgeSeconds}, stale-while-revalidate=${sharedMaxAgeSeconds}`,
    );
  } else {
    // §26: "Never allow cached user-specific responses to be exposed to another
    // customer." `no-store` is deliberate rather than `no-cache` - it also
    // stops a shared proxy writing the body to disk.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
  }

  next();
}

module.exports = cachePolicy;
module.exports.isPublicPath = isPublicPath;
module.exports.affectsPublicContent = affectsPublicContent;
module.exports.PUBLIC_CONTENT_WRITE_PREFIXES = PUBLIC_CONTENT_WRITE_PREFIXES;
