'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * What is now kept between calls to the geocoding provider, and - more
 * importantly - what is not.
 *
 * `GEOCODING_API_BASE` points at Nominatim's public instance, which the
 * project's own environment documentation describes as allowing "~1
 * request/second" and liable to "block heavy use". `/geo/search` is a public
 * route, and the mobile location picker calls it as a visitor types, so the
 * same few hundred city names were being bought from that budget over and over
 * - while `lookup`, the one path nobody types into interactively, had had an
 * in-process cache since it was written.
 *
 * The risk in fixing it is the opposite mistake. `searchAddresses` returns `[]`
 * for "no such place", for a timeout, for a queue that was too deep and for a
 * malformed response alike. Caching that uniformly would turn a minute of
 * provider trouble into a day of a city not existing, which is worse than the
 * problem being solved. So the tests that matter here are the negative ones.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

process.env.LOG_LEVEL = 'silent';
process.env.GEOCODING_ENABLED = 'true';
process.env.GEOCODING_MIN_INTERVAL_MS = '0';

stub('db/pool', { query: async () => [], execute: async () => ({}), rawQuery: async () => [] });

const cache = require(resolve('services/cache'));
const geocoding = require(resolve('services/geocoding'));

/** Every outbound provider call, and what each was answered with. */
let calls = [];
let responder = () => [];

const originalFetch = global.fetch;
global.fetch = async (url) => {
  const parsed = new URL(url);
  calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) });
  const outcome = responder(parsed);
  if (outcome instanceof Error) throw outcome;
  return {
    ok: true,
    status: 200,
    json: async () => outcome,
  };
};
test.after(() => {
  global.fetch = originalFetch;
});

const PLACE = [
  {
    lat: '11.0168',
    lon: '76.9558',
    display_name: 'Coimbatore, Tamil Nadu, India',
    address: { city: 'Coimbatore', state: 'Tamil Nadu', country: 'India', postcode: '641001' },
  },
];

const fresh = () => {
  // A real in-process cache, so `wrap` genuinely stores and reads back.
  cache._setDriverForTests(cache.memoryDriver(100));
  calls = [];
};

// ---------------------------------------------------------------------------
// The win
// ---------------------------------------------------------------------------

test('a successful search is bought once and reused', async () => {
  fresh();
  responder = () => PLACE;

  const first = await geocoding.searchAddresses('Coimbatore');
  const second = await geocoding.searchAddresses('Coimbatore');

  assert.equal(calls.length, 1, 'the provider should be called once');
  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
});

test('capitalisation does not buy the same place twice', async () => {
  fresh();
  responder = () => PLACE;

  await geocoding.searchAddresses('Coimbatore');
  await geocoding.searchAddresses('COIMBATORE');
  await geocoding.searchAddresses('coimbatore');

  assert.equal(calls.length, 1);
});

test('a different limit is a different question', async () => {
  fresh();
  responder = () => PLACE;
  await geocoding.searchAddresses('Coimbatore', { limit: 5 });
  await geocoding.searchAddresses('Coimbatore', { limit: 10 });
  assert.equal(calls.length, 2);
});

test('a genuine "no such place" is cached - it is a real answer', async () => {
  fresh();
  responder = () => [];
  const first = await geocoding.searchAddresses('zzzzqqqq');
  const second = await geocoding.searchAddresses('zzzzqqqq');
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(calls.length, 1, 'a confirmed absence need not be asked twice');
});

// ---------------------------------------------------------------------------
// The part that must not go wrong
// ---------------------------------------------------------------------------

test('a provider failure is NOT cached', async () => {
  fresh();
  responder = () => new Error('ETIMEDOUT');

  assert.deepEqual(await geocoding.searchAddresses('Coimbatore'), []);
  assert.deepEqual(await geocoding.searchAddresses('Coimbatore'), []);
  assert.equal(calls.length, 2, 'each attempt must reach the provider again');

  // And once it recovers, the real answer is served rather than the remembered
  // failure.
  responder = () => PLACE;
  const recovered = await geocoding.searchAddresses('Coimbatore');
  assert.equal(recovered.length, 1, 'the city exists again the moment the provider does');
});

test('a malformed response is NOT cached', async () => {
  fresh();
  responder = () => ({ unexpected: 'shape' });
  assert.deepEqual(await geocoding.searchAddresses('Coimbatore'), []);
  assert.deepEqual(await geocoding.searchAddresses('Coimbatore'), []);
  assert.equal(calls.length, 2);
});

test('a query below the minimum length never reaches the provider or the cache', async () => {
  fresh();
  responder = () => PLACE;
  assert.deepEqual(await geocoding.searchAddresses('co'), []);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Reverse lookups, where the key has to be coarsened to ever hit
// ---------------------------------------------------------------------------

test('two drags of the same pin share one reverse lookup', async () => {
  fresh();
  responder = () => PLACE[0];

  // Eleven metres apart or less: the same place as far as an address goes.
  await geocoding.reverse(11.016812, 76.955834);
  await geocoding.reverse(11.016799, 76.955841);

  assert.equal(calls.length, 1, 'rounding is what makes a reverse cache possible at all');
});

test('genuinely different coordinates are still asked about', async () => {
  fresh();
  responder = () => PLACE[0];
  await geocoding.reverse(11.0168, 76.9558);
  await geocoding.reverse(12.9911, 80.2178);
  assert.equal(calls.length, 2);
});

test('a failed reverse lookup is NOT cached', async () => {
  fresh();
  responder = () => new Error('ETIMEDOUT');
  assert.equal(await geocoding.reverse(11.0168, 76.9558), null);
  assert.equal(await geocoding.reverse(11.0168, 76.9558), null);
  assert.equal(calls.length, 2);
});

test('a provider error payload is NOT cached', async () => {
  fresh();
  responder = () => ({ error: 'Unable to geocode' });
  assert.equal(await geocoding.reverse(11.0168, 76.9558), null);
  assert.equal(await geocoding.reverse(11.0168, 76.9558), null);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// And none of it may depend on the cache working
// ---------------------------------------------------------------------------

test('with no cache at all, both paths still answer from the provider', async () => {
  cache._setDriverForTests(cache.noopDriver);
  calls = [];
  responder = () => PLACE;

  assert.equal((await geocoding.searchAddresses('Coimbatore')).length, 1);
  assert.equal((await geocoding.searchAddresses('Coimbatore')).length, 1);
  // Two calls, because nothing is stored - which is the pre-existing behaviour
  // and the thing a missing Redis must degrade to rather than break.
  assert.equal(calls.length, 2);
});
