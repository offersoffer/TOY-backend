'use strict';

const crypto = require('node:crypto');
const logger = require('../utils/logger');
const env = require('../config/env');

/**
 * The cache facade: one interface, three drivers, and a hard rule that a cache
 * failure is never a request failure.
 *
 * ## Why this exists
 *
 * Nothing sat between the API and MySQL. `CACHE_PUBLIC_MAX_AGE` and
 * `CACHE_SHARED_MAX_AGE` only ever emitted `Cache-Control` headers, and
 * CloudFront fronts the image bucket rather than `/api`, so every feed render,
 * search and category browse reached the database - against a connection pool
 * that defaults to ten connections with an unbounded queue. That is the shape
 * that turns a traffic spike into rising latency on every endpoint at once.
 *
 * ## Fail-open, always
 *
 * Every operation is wrapped and time-boxed. A Redis that is down, full, slow
 * or mid-failover makes this a no-op that logs; it never throws into a request
 * and never holds one open. The read path treats "cache said no" and "cache
 * said nothing" as the same answer, because they are.
 *
 * ## Invalidation is a version bump, not a key sweep
 *
 * Deleting "everything about offers" by enumerating keys means `KEYS` or
 * `SCAN`, which is O(keyspace) and - for `KEYS` - blocks the single Redis
 * thread for the duration. Instead each namespace carries a counter in its
 * key, so bumping the counter makes every old key unreachable in one O(1)
 * write and lets them expire on their own. Invalidation is therefore cheap
 * enough to do on every write, rather than something to be clever about.
 *
 * ## Single flight
 *
 * On a cold key, a hundred concurrent requests would otherwise run a hundred
 * identical queries - the stampede that makes a cache a liability exactly when
 * it is needed. `wrap` keeps one in-flight promise per key per process and
 * hands every caller the same one.
 */

/** Operations are abandoned past this, so a slow cache cannot slow a request. */
const OP_TIMEOUT_MS = 150;

const stats = { hits: 0, misses: 0, sets: 0, errors: 0, timeouts: 0, singleFlightJoins: 0 };

/** In-flight loads, keyed by cache key. Process-local by nature. */
const inFlight = new Map();

/** Namespace counters, cached in-process and refreshed on bump. */
const namespaceVersions = new Map();

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/**
 * Does nothing, successfully.
 *
 * The default when nothing is configured, so neither development nor the test
 * suite needs a Redis, and a misconfigured production degrades to the
 * behaviour it had before this module existed rather than to an outage.
 */
const noopDriver = {
  name: 'none',
  ready: () => false,
  get: async () => null,
  set: async () => {},
  del: async () => {},
  incr: async () => 1,
  quit: async () => {},
};

/**
 * A bounded in-process map.
 *
 * Honest about what it is: per-process and unshared, so two API processes see
 * two different caches. That is fine for this deployment, which runs exactly
 * one, and the TTLs bound the staleness if a second ever appears - but it is
 * the reason `REDIS_URL` is the right answer the moment the API is scaled out,
 * and why the driver name is reported on `/health`.
 */
function memoryDriver(maxEntries = 5000) {
  const store = new Map();

  const evictIfNeeded = () => {
    // Insertion-ordered Map, so the first key is the oldest written: a simple
    // FIFO rather than a true LRU. Enough to bound memory on a 2 GB box
    // without the bookkeeping a real LRU needs on every read.
    while (store.size > maxEntries) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  };

  return {
    name: 'memory',
    ready: () => true,
    get: async (key) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key, value, ttlSeconds) => {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      evictIfNeeded();
    },
    del: async (key) => {
      store.delete(key);
    },
    incr: async (key) => {
      const current = Number((await store.get(key)?.value) ?? 0);
      const next = current + 1;
      store.set(key, { value: String(next), expiresAt: Date.now() + 86400 * 1000 });
      return next;
    },
    quit: async () => store.clear(),
    size: () => store.size,
  };
}

/** Redis, configured so that an unreachable server fails fast instead of queueing. */
function redisDriver(url) {
  // Required lazily: a missing module should degrade like a missing server, not
  // stop the process from booting.
  // eslint-disable-next-line global-require, import/no-unresolved
  const Redis = require('ioredis');

  const client = new Redis(url, {
    lazyConnect: false,
    // The default queues commands while disconnected and replays them on
    // reconnect. For a cache that is exactly wrong: a command that cannot run
    // now is worthless later, and queueing turns a Redis outage into growing
    // memory and latency in the API process.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    // Spread reconnection attempts rather than hammering a server that is
    // already struggling, and cap the wait.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  let ready = false;
  client.on('ready', () => {
    ready = true;
    logger.info({ event: 'CACHE_CONNECTED', category: 'CACHE', driver: 'redis' }, 'Cache connected');
  });
  client.on('end', () => {
    ready = false;
  });
  client.on('error', (error) => {
    ready = false;
    stats.errors += 1;
    // Rate-limited by Redis's own reconnect backoff; logged at warn because
    // the API is still serving, just without a cache.
    logger.warn(
      { event: 'CACHE_ERROR', category: 'CACHE', err_message: error.message },
      'Cache unavailable; serving from the database',
    );
  });

  return {
    name: 'redis',
    ready: () => ready,
    get: (key) => client.get(key),
    set: (key, value, ttlSeconds) => client.set(key, value, 'EX', ttlSeconds),
    del: (key) => client.del(key),
    incr: (key) => client.incr(key),
    quit: () => client.quit(),
  };
}

function buildDriver() {
  const { driver, redisUrl } = env.cache;
  if (driver === 'none') return noopDriver;
  if (driver === 'redis' || (driver === 'auto' && redisUrl)) {
    if (!redisUrl) {
      logger.warn(
        { event: 'CACHE_MISCONFIGURED', category: 'CACHE' },
        'CACHE_DRIVER=redis but REDIS_URL is unset; caching is disabled',
      );
      return noopDriver;
    }
    try {
      return redisDriver(redisUrl);
    } catch (error) {
      logger.warn(
        { event: 'CACHE_DRIVER_FAILED', category: 'CACHE', err_message: error.message },
        'Redis client could not be created; falling back to an in-process cache',
      );
      return memoryDriver(env.cache.memoryMaxEntries);
    }
  }
  if (driver === 'memory') return memoryDriver(env.cache.memoryMaxEntries);
  // 'auto' with no Redis URL.
  return noopDriver;
}

let activeDriver = buildDriver();

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Races an operation against the timeout so a hung cache cannot hold a request. */
async function guarded(label, operation, fallback = null) {
  if (!activeDriver.ready()) return fallback;

  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cache timeout')), OP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error.message === 'cache timeout') stats.timeouts += 1;
    else stats.errors += 1;
    logger.debug(
      { event: 'CACHE_OP_FAILED', category: 'CACHE', op: label, err_message: error.message },
      'Cache operation failed; continuing without it',
    );
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * `oo:<app version>:<namespace>:v<counter>:<digest>`.
 *
 * The app version is in the key so a deploy cannot serve a payload shaped by
 * the previous release - cheaper and more certain than remembering to flush.
 * The namespace counter is what `invalidate` bumps.
 *
 * The parts are hashed rather than concatenated so a key cannot grow without
 * bound, and so no part of it can inject a `:` and collide with another key's
 * structure.
 */
function keyFor(namespace, parts) {
  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify(parts))
    .digest('base64url')
    .slice(0, 27);
  const version = namespaceVersions.get(namespace) ?? 0;
  return `oo:${env.logging.version}:${namespace}:v${version}:${digest}`;
}

const namespaceCounterKey = (namespace) => `oo:${env.logging.version}:nsver:${namespace}`;

/**
 * Loads each namespace's counter once at startup.
 *
 * Without this a restart would reset the in-process counters to 0 and start
 * serving keys that an earlier bump had retired. Best-effort: if the cache is
 * unreachable the counters stay at 0, which is safe because nothing has been
 * written under them either.
 */
async function warmNamespaces(namespaces) {
  for (const namespace of namespaces) {
    // eslint-disable-next-line no-await-in-loop -- a handful of keys at boot.
    const stored = await guarded('nsver', () => activeDriver.get(namespaceCounterKey(namespace)));
    if (stored !== null && stored !== undefined) namespaceVersions.set(namespace, Number(stored) || 0);
  }
}

/**
 * Retires every key in a namespace, in one write.
 *
 * Called from the write paths. Deliberately not awaited by its callers' happy
 * path: a merchant's save must not fail because a cache counter could not be
 * incremented, and the TTL is the backstop if the bump is lost.
 */
async function invalidate(namespace) {
  const next = await guarded('incr', () => activeDriver.incr(namespaceCounterKey(namespace)), null);
  if (next === null) {
    // The bump did not reach the cache. Move the local counter anyway so this
    // process stops reading its own stale keys; other processes fall back to
    // the TTL.
    namespaceVersions.set(namespace, (namespaceVersions.get(namespace) ?? 0) + 1);
    return;
  }
  namespaceVersions.set(namespace, Number(next) || 0);
}

// ---------------------------------------------------------------------------
// Read/write
// ---------------------------------------------------------------------------

async function get(namespace, parts) {
  const raw = await guarded('get', () => activeDriver.get(keyFor(namespace, parts)));
  if (raw === null || raw === undefined) {
    stats.misses += 1;
    return undefined;
  }
  try {
    stats.hits += 1;
    return JSON.parse(raw);
  } catch {
    // A corrupt or half-written entry is a miss, not an error worth surfacing.
    stats.errors += 1;
    return undefined;
  }
}

async function set(namespace, parts, value, ttlSeconds) {
  stats.sets += 1;
  await guarded('set', () =>
    activeDriver.set(keyFor(namespace, parts), JSON.stringify(value), ttlSeconds),
  );
}

/**
 * Cache-aside with single flight.
 *
 * `loader` runs at most once per key per process at a time. Its rejection is
 * propagated to every joined caller and nothing is cached, so a failed load is
 * not remembered as a result.
 */
async function wrap(namespace, parts, ttlSeconds, loader) {
  const cached = await get(namespace, parts);
  if (cached !== undefined) return cached;

  const key = keyFor(namespace, parts);
  const existing = inFlight.get(key);
  if (existing) {
    stats.singleFlightJoins += 1;
    return existing;
  }

  const promise = (async () => {
    const value = await loader();
    // Only a real value is stored. `undefined` means "nothing to cache" and is
    // how a caller opts out per call.
    if (value !== undefined) await set(namespace, parts, value, ttlSeconds);
    return value;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

/** For `/health` and the logs: what the cache is and how it is doing. */
const status = () => ({
  driver: activeDriver.name,
  ready: activeDriver.ready(),
  ...stats,
  hitRate:
    stats.hits + stats.misses > 0
      ? Number(((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1))
      : null,
});

/** Test seam: swap the driver and clear process-local state. */
function _setDriverForTests(driver) {
  activeDriver = driver ?? noopDriver;
  inFlight.clear();
  namespaceVersions.clear();
  for (const key of Object.keys(stats)) stats[key] = 0;
}

module.exports = {
  get,
  set,
  wrap,
  invalidate,
  warmNamespaces,
  status,
  keyFor,
  OP_TIMEOUT_MS,
  memoryDriver,
  noopDriver,
  _setDriverForTests,
  close: () => activeDriver.quit(),
};
