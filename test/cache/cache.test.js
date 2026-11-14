'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * The cache's three promises: it never breaks a request, it never serves one
 * caller's data to another, and it never lets a cold key become a stampede.
 *
 * The first is why every test here drives a deliberately broken driver as well
 * as a working one. A cache is an optimisation; the moment it can fail a
 * request it is a liability, and "Redis was down" must look exactly like
 * "Redis was empty" from the outside.
 */

const SRC = path.join(__dirname, '../../src');
process.env.LOG_LEVEL = 'silent';

const cache = require(path.join(SRC, 'services/cache'));
const responseCache = require(path.join(SRC, 'middleware/responseCache'));
const cachePolicy = require(path.join(SRC, 'middleware/cachePolicy'));

/** A driver that records what it was asked to do. */
function recordingDriver() {
  const store = new Map();
  const calls = [];
  return {
    name: 'recording',
    calls,
    store,
    ready: () => true,
    get: async (key) => {
      calls.push(['get', key]);
      return store.has(key) ? store.get(key) : null;
    },
    set: async (key, value) => {
      calls.push(['set', key]);
      store.set(key, value);
    },
    del: async (key) => {
      store.delete(key);
    },
    incr: async (key) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      calls.push(['incr', key]);
      return next;
    },
    quit: async () => {},
  };
}

/** Every operation throws, as a Redis mid-failover does. */
const brokenDriver = {
  name: 'broken',
  ready: () => true,
  get: async () => {
    throw new Error('CONNECTION_BROKEN');
  },
  set: async () => {
    throw new Error('CONNECTION_BROKEN');
  },
  del: async () => {
    throw new Error('CONNECTION_BROKEN');
  },
  incr: async () => {
    throw new Error('CONNECTION_BROKEN');
  },
  quit: async () => {},
};

/** Never answers, as a Redis under memory pressure does. */
const hangingDriver = {
  name: 'hanging',
  ready: () => true,
  get: () => new Promise(() => {}),
  set: () => new Promise(() => {}),
  del: () => new Promise(() => {}),
  incr: () => new Promise(() => {}),
  quit: async () => {},
};

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------

test('with no cache configured, reads miss and writes are accepted', async () => {
  cache._setDriverForTests(cache.noopDriver);
  assert.equal(await cache.get('discovery', { a: 1 }), undefined);
  await cache.set('discovery', { a: 1 }, { ok: true }, 60);
  assert.equal(await cache.get('discovery', { a: 1 }), undefined);
});

test('a driver that throws on every call never throws into the caller', async () => {
  cache._setDriverForTests(brokenDriver);
  assert.equal(await cache.get('discovery', { a: 1 }), undefined);
  await cache.set('discovery', { a: 1 }, { ok: true }, 60);
  await cache.invalidate('discovery');
  // And `wrap` still returns the loader's value - the request is served.
  const value = await cache.wrap('discovery', { a: 1 }, 60, async () => ({ fresh: true }));
  assert.deepEqual(value, { fresh: true });
});

test('a driver that never answers does not hold the request open', async () => {
  cache._setDriverForTests(hangingDriver);
  const started = Date.now();
  const value = await cache.wrap('discovery', { a: 1 }, 60, async () => ({ fresh: true }));
  const elapsed = Date.now() - started;

  assert.deepEqual(value, { fresh: true });
  // Abandoned at the timeout rather than waiting on the cache. Allow headroom
  // for a loaded machine, but it must be bounded.
  assert.ok(elapsed < cache.OP_TIMEOUT_MS * 6, `took ${elapsed}ms`);
  assert.ok(cache.status().timeouts > 0, 'the timeout should be counted');
});

// ---------------------------------------------------------------------------
// Caching proper
// ---------------------------------------------------------------------------

test('a value survives a round trip and is reported as a hit', async () => {
  const driver = recordingDriver();
  cache._setDriverForTests(driver);

  await cache.set('discovery', { path: '/offers' }, { items: [1, 2] }, 60);
  assert.deepEqual(await cache.get('discovery', { path: '/offers' }), { items: [1, 2] });
  assert.equal(cache.status().hits, 1);
  assert.equal(cache.status().misses, 0);
});

test('query order does not create two keys for one request', () => {
  const a = responseCache.keyParts({ path: '/offers', query: { a: '1', b: '2' } });
  const b = responseCache.keyParts({ path: '/offers', query: { b: '2', a: '1' } });
  assert.deepEqual(a, b);
});

test('the key carries the app version, so a deploy cannot serve last release\'s shape', () => {
  cache._setDriverForTests(recordingDriver());
  const version = require(path.join(SRC, 'config/env')).logging.version;
  assert.ok(cache.keyFor('discovery', { a: 1 }).includes(`:${version}:`));
});

test('a corrupt entry is a miss rather than an error', async () => {
  const driver = recordingDriver();
  cache._setDriverForTests(driver);
  const key = cache.keyFor('discovery', { a: 1 });
  driver.store.set(key, '{not json');
  assert.equal(await cache.get('discovery', { a: 1 }), undefined);
});

test('the in-process driver honours its TTL', async () => {
  const memory = cache.memoryDriver(10);
  cache._setDriverForTests(memory);
  await cache.set('discovery', { a: 1 }, { ok: true }, 0.05);
  assert.deepEqual(await cache.get('discovery', { a: 1 }), { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await cache.get('discovery', { a: 1 }), undefined);
});

test('the in-process driver is bounded, so it cannot grow without limit', async () => {
  const memory = cache.memoryDriver(5);
  cache._setDriverForTests(memory);
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await cache.set('discovery', { i }, { i }, 60);
  }
  assert.ok(memory.size() <= 6, `held ${memory.size()} entries`);
});

// ---------------------------------------------------------------------------
// Invalidation by version bump
// ---------------------------------------------------------------------------

test('a namespace bump retires every existing key without enumerating them', async () => {
  const driver = recordingDriver();
  cache._setDriverForTests(driver);

  await cache.set('discovery', { path: '/offers' }, { items: [1] }, 60);
  assert.deepEqual(await cache.get('discovery', { path: '/offers' }), { items: [1] });

  await cache.invalidate('discovery');

  assert.equal(await cache.get('discovery', { path: '/offers' }), undefined);
  // One write, not a scan: no KEYS, no SCAN, no per-key deletes.
  assert.ok(driver.calls.some(([op]) => op === 'incr'));
  assert.ok(!driver.calls.some(([op]) => op === 'del'));
});

test('a bump the cache never received still stops this process serving stale keys', async () => {
  cache._setDriverForTests(brokenDriver);
  const before = cache.keyFor('discovery', { a: 1 });
  await cache.invalidate('discovery');
  assert.notEqual(cache.keyFor('discovery', { a: 1 }), before);
});

test('counters are reloaded at startup so a restart does not un-invalidate', async () => {
  const driver = recordingDriver();
  cache._setDriverForTests(driver);
  await cache.invalidate('discovery');
  const afterBump = cache.keyFor('discovery', { a: 1 });

  // Simulate a restart: same cache contents, fresh process state.
  cache._setDriverForTests(driver);
  assert.notEqual(cache.keyFor('discovery', { a: 1 }), afterBump, 'counter starts at zero');
  await cache.warmNamespaces(['discovery']);
  assert.equal(cache.keyFor('discovery', { a: 1 }), afterBump, 'counter is restored');
});

// ---------------------------------------------------------------------------
// Single flight
// ---------------------------------------------------------------------------

test('a cold key runs its loader once however many callers arrive', async () => {
  cache._setDriverForTests(recordingDriver());
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { loaded: loads };
  };

  const results = await Promise.all(
    Array.from({ length: 25 }, () => cache.wrap('discovery', { path: '/offers' }, 60, loader)),
  );

  assert.equal(loads, 1, 'the whole point');
  assert.ok(results.every((r) => r.loaded === 1));
  assert.ok(cache.status().singleFlightJoins >= 24);
});

test('a failed load is propagated and not remembered as a result', async () => {
  cache._setDriverForTests(recordingDriver());
  await assert.rejects(
    () => cache.wrap('discovery', { path: '/offers' }, 60, async () => {
      throw new Error('database down');
    }),
    /database down/,
  );
  // Nothing cached, so the next caller tries again rather than inheriting the
  // failure for the length of a TTL.
  const value = await cache.wrap('discovery', { path: '/offers' }, 60, async () => ({ ok: true }));
  assert.deepEqual(value, { ok: true });
});

test('a loader returning undefined opts out of being cached', async () => {
  const driver = recordingDriver();
  cache._setDriverForTests(driver);
  await cache.wrap('discovery', { path: '/offers' }, 60, async () => undefined);
  assert.ok(!driver.calls.some(([op]) => op === 'set'));
});

// ---------------------------------------------------------------------------
// The security boundary - the part that must never be wrong
// ---------------------------------------------------------------------------

test('a request carrying a bearer token is never cacheable', () => {
  assert.equal(
    responseCache.isCacheable({
      method: 'GET',
      path: '/offers',
      headers: { authorization: 'Bearer abc.def.ghi' },
    }),
    false,
  );
});

test('an anonymous GET on a public path is cacheable', () => {
  assert.equal(
    responseCache.isCacheable({ method: 'GET', path: '/offers', headers: {} }),
    true,
  );
  assert.equal(
    responseCache.isCacheable({ method: 'GET', path: '/discovery/nearby', headers: {} }),
    true,
  );
});

test('nothing but GET is cacheable', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(responseCache.isCacheable({ method, path: '/offers', headers: {} }), false);
  }
});

test('the cache defers to cachePolicy rather than deciding for itself', () => {
  // Every private path cachePolicy knows about must be uncacheable here too,
  // without this file keeping its own copy of the list.
  for (const path of [
    '/favorites',
    '/claims/123',
    '/analytics/overview',
    '/users/me',
    '/notifications',
    '/payments/config',
    '/subscriptions/current',
    '/audit-logs',
  ]) {
    assert.equal(cachePolicy.isPublicPath(path), false, `${path} should not be public`);
    assert.equal(
      responseCache.isCacheable({ method: 'GET', path, headers: {} }),
      false,
      `${path} should not be cacheable`,
    );
  }
});

test('writes that change public content invalidate; per-customer writes do not', () => {
  for (const path of ['/offers', '/offers/12', '/shops/4/branches', '/reviews/9', '/categories']) {
    assert.equal(cachePolicy.affectsPublicContent(path), true, path);
  }
  // These are the most frequent writes in the system. Invalidating on them
  // would keep the cache permanently cold for no benefit.
  for (const path of ['/favorites', '/claims', '/notifications/read', '/preferences', '/auth/login']) {
    assert.equal(cachePolicy.affectsPublicContent(path), false, path);
  }
});

test('a prefix match cannot be fooled by a lookalike path', () => {
  assert.equal(cachePolicy.affectsPublicContent('/offers-archive'), false);
  assert.equal(cachePolicy.affectsPublicContent('/shopsomething'), false);
  assert.equal(cachePolicy.affectsPublicContent('/shops'), true);
  assert.equal(cachePolicy.affectsPublicContent('/shops/'), true);
});
