'use strict';

const cache = require('../services/cache');
const cachePolicy = require('./cachePolicy');
const env = require('../config/env');

/**
 * Server-side caching of public discovery responses.
 *
 * ## It reuses the existing boundary rather than inventing one
 *
 * `cachePolicy` already decides which responses are identical for every
 * anonymous visitor, and it was written for a security property: §26's "never
 * allow cached user-specific responses to be exposed to another customer".
 * This middleware caches exactly what that middleware is willing to mark
 * `public`, by calling the same `isPublicPath` and applying the same
 * no-bearer-token test.
 *
 * That is deliberate. A cache with its own notion of "public" is a cache that
 * will eventually disagree with the one the headers promise, and the way that
 * failure presents is one merchant's or one customer's data served to
 * somebody else. There is one list, in one file, and both read it.
 *
 * ## What is never cached
 *
 * - anything with an `Authorization` header, so no personalised field
 *   (`isFavorite`, `isFollowing`, `isSaved`) can ever be stored;
 * - anything but `GET`;
 * - any path not on the public-discovery list;
 * - any response that is not a `200`, so an error is never remembered and a
 *   404 never becomes sticky;
 * - any response that set a cookie, which would otherwise be replayed to a
 *   different visitor.
 *
 * ## Invalidation
 *
 * Keys live in the `discovery` namespace, which the write paths retire with a
 * single counter bump. The TTL is the backstop, not the mechanism.
 */

/** One namespace for everything public; one bump clears the lot. */
const NAMESPACE = 'discovery';

/**
 * The parts of a request that change an anonymous response.
 *
 * The query string is sorted so `?a=1&b=2` and `?b=2&a=1` are one key rather
 * than two. Everything that varies a discovery response - coordinates, radius,
 * page, sort, filters - arrives as a query parameter, so the path and the
 * sorted query are the whole of it.
 */
function keyParts(req) {
  const query = Object.entries(req.query)
    .map(([name, value]) => [name, Array.isArray(value) ? [...value].sort() : value])
    .sort(([a], [b]) => a.localeCompare(b));
  return { path: req.path, query };
}

const isCacheable = (req) =>
  req.method === 'GET' &&
  !(req.headers.authorization || '').startsWith('Bearer ') &&
  cachePolicy.isPublicPath(req.path);

/**
 * Retires the discovery namespace after a write that changed public content.
 *
 * Done centrally rather than in each service. A dozen `cache.invalidate` calls
 * scattered through the write paths is a dozen chances to add the thirteenth
 * route and forget - and the failure mode is a merchant publishing an offer
 * that customers cannot see for a minute, which they will report as the app
 * being broken.
 *
 * Hooked on `res.on('finish')` and gated on the status code, so a rejected or
 * failed write does not clear a cache that is still correct. The bump is not
 * awaited: the merchant's response has already been sent, and a lost bump
 * falls back to the TTL.
 */
function invalidateOnWrite(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!cachePolicy.affectsPublicContent(req.path)) return next();

  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      void cache.invalidate(NAMESPACE);
    }
  });
  return next();
}

function responseCache(req, res, next) {
  if (!isCacheable(req)) return invalidateOnWrite(req, res, next);

  const parts = keyParts(req);

  // `res.json` is replaced rather than wrapping `res.send`, because every
  // route here answers through `utils/respond`, which calls `res.json`. One
  // interception point, and a body that is already a plain object - no
  // re-parsing of a serialised buffer.
  const sendJson = res.json.bind(res);

  cache
    .get(NAMESPACE, parts)
    .then((hit) => {
      if (hit !== undefined) {
        res.setHeader('X-Cache', 'HIT');
        return sendJson(hit);
      }

      res.setHeader('X-Cache', 'MISS');
      res.json = (body) => {
        // Only a plain success is worth remembering. A cookie means the
        // response was not as anonymous as the path suggested, so it is left
        // uncached rather than replayed to the next visitor.
        const storable =
          res.statusCode === 200 && !res.getHeader('Set-Cookie') && body && typeof body === 'object';
        if (storable) {
          // Not awaited: the visitor's response does not wait on the cache,
          // and a failed write is a miss next time rather than an error now.
          void cache.set(NAMESPACE, parts, body, env.cache.responseTtlSeconds);
        }
        return sendJson(body);
      };
      return next();
    })
    .catch(() => {
      // `cache.get` is already fail-open; this is the belt to that braces.
      res.setHeader('X-Cache', 'MISS');
      next();
    });
}

module.exports = responseCache;
module.exports.invalidateOnWrite = invalidateOnWrite;
module.exports.NAMESPACE = NAMESPACE;
module.exports.keyParts = keyParts;
module.exports.isCacheable = isCacheable;
