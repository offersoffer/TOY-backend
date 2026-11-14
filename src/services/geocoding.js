'use strict';

const env = require('../config/env');
const sharedCache = require('./cache');

/**
 * Address -> coordinates (§17).
 *
 * Radius search, "near me" and every distance figure in the app run off
 * `shop_branches.latitude/longitude`, but a merchant filling in a shop form
 * cannot produce a lat/long by hand. This module turns the address they *can*
 * type into coordinates so the fields never have to be asked for.
 *
 * Like `push.js` and `razorpay.js` this is a transport and nothing else: it
 * knows how to ask a geocoder, not when a branch should be geocoded. And like
 * them, every export is safe to call when the geocoder is switched off, slow,
 * or simply has no match - the caller gets `null` and the branch saves without
 * coordinates rather than the whole save failing.
 */

const NOMINATIM = 'nominatim';

/** Results are stable for a given address, so repeat saves cost nothing. */
const cache = new Map();

const isConfigured = () => env.geocoding.enabled && env.geocoding.provider === NOMINATIM;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Nominatim is rate limited to one request a second and the cascade below can
 * issue several per save, so calls are serialised behind this promise chain
 * with a fixed gap. It is deliberately process-local: a second instance is a
 * second budget, which is what the published usage policy assumes anyway.
 *
 * Serialising means a save can end up waiting behind other people's, so the
 * queue is bounded twice over: nothing joins it once `maxQueueDepth` lookups
 * are already pending, and anything whose caller has run out of budget by the
 * time its turn arrives is dropped rather than sent. Both make the geocoder
 * give up and the branch save without coordinates - never the other way round.
 */
let queue = Promise.resolve();
let queueDepth = 0;
let lastRequestAt = 0;

const SKIPPED = Symbol('geocoding-skipped');

function schedule(task, deadline) {
  if (queueDepth >= env.geocoding.maxQueueDepth) return Promise.resolve(SKIPPED);

  queueDepth += 1;
  const run = queue.then(async () => {
    try {
      const wait = env.geocoding.minIntervalMs - (Date.now() - lastRequestAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (Date.now() > deadline) return SKIPPED;
      lastRequestAt = Date.now();
      return await task();
    } finally {
      queueDepth -= 1;
    }
  });
  // Keep the chain alive even when a link rejects, or one failure would
  // poison every later lookup.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * The queries to try, most precise first.
 *
 * A door number is rarely in the map data - "5/283 Maninagar, Achampathu,
 * Madurai" finds nothing while "Achampathu, Madurai" is a direct hit - so each
 * step drops the leading line of the street address, then falls back to the
 * pincode and finally to the city. Something on the map beats nothing: an
 * approximate pin still puts the shop in the right radius, and the merchant can
 * refine it by hand afterwards.
 */
function candidates({ address, city, state, country, pincode }) {
  const tail = [clean(city), clean(state), clean(country)].filter(Boolean);
  if (tail.length === 0) return [];

  const lines = clean(address)
    .split(/[,\n]/)
    .map((line) => line.trim())
    .filter(Boolean);

  const queries = [];
  for (let index = 0; index < lines.length; index += 1) {
    queries.push({
      // The pincode is only trustworthy alongside the full address; on its own
      // it often names a neighbouring locality and would beat a better match.
      query: [...lines.slice(index), ...tail, ...(index === 0 ? [clean(pincode)] : [])]
        .filter(Boolean)
        .join(', '),
      precision: index === 0 ? 'exact' : 'approximate',
    });
  }

  if (clean(pincode)) {
    queries.push({ query: [clean(pincode), ...tail].join(', '), precision: 'approximate' });
  }
  queries.push({ query: tail.join(', '), precision: 'city' });

  const seen = new Set();
  return queries
    .filter((entry) => entry.query && !seen.has(entry.query) && seen.add(entry.query))
    .slice(0, env.geocoding.maxQueries);
}

/**
 * One call to the geocoder, normalised to `null` on anything unusable.
 *
 * Every outbound request goes through here so the timeout, the identifying
 * User-Agent that Nominatim's usage policy demands, and the "a bad answer is
 * the same as no answer" rule are stated once rather than per endpoint.
 */
async function request(pathname, params) {
  const url = new URL(pathname, env.geocoding.apiBase);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.geocoding.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      // Nominatim's usage policy requires an identifying User-Agent and will
      // block requests that do not carry one.
      headers: { accept: 'application/json', 'user-agent': env.geocoding.userAgent },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A Nominatim hit as the shop form needs it (§24, §26).
 *
 * The structured `address` is what lets the map picker fill City, State and
 * Pincode from a search result instead of asking the merchant to retype what
 * they already found on the map. Nominatim names the city differently
 * depending on how big it is - Coimbatore is a `city`, a panchayat is a
 * `village` - so the first of those that is present wins.
 */
function toPlace(hit) {
  if (!hit) return null;
  const latitude = Number(hit.lat);
  const longitude = Number(hit.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const parts = hit.address ?? {};
  const line = [parts.house_number, parts.road].filter(Boolean).join(' ');
  const area =
    parts.neighbourhood || parts.suburb || parts.quarter || parts.hamlet ||
    parts.village || parts.city_district || null;

  return {
    latitude,
    longitude,
    label: hit.display_name ?? null,
    placeId: hit.place_id === undefined ? null : String(hit.place_id),
    address: {
      addressLine1: line || area || null,
      area,
      // `state_district` sits second on purpose. In Indian OSM data a city
      // address often carries no `city` at all - "RS Puram, Coimbatore" comes
      // back as town "Perur", district "Coimbatore" - and the district is the
      // name a merchant would actually write on their sign. The finer
      // panchayat or ward name is not lost; it lands in `area` above.
      city:
        parts.city || parts.state_district || parts.town || parts.municipality ||
        parts.village || parts.county || null,
      state: parts.state || null,
      country: parts.country || null,
      pincode: parts.postcode || null,
    },
  };
}

async function search(query) {
  const results = await request('/search', {
    q: query,
    format: 'jsonv2',
    addressdetails: 1,
    limit: 1,
  });
  return toPlace(Array.isArray(results) ? results[0] : null);
}

/**
 * Coordinates for an address, or `null` when none could be found.
 *
 * Never throws: a geocoder outage must not stop a merchant saving their shop.
 */
async function lookup(parts) {
  if (!isConfigured()) return null;

  const queries = candidates(parts || {});
  if (queries.length === 0) return null;

  const cacheKey = queries.map((entry) => entry.query).join(' | ');
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const deadline = Date.now() + env.geocoding.totalBudgetMs;
  let match = null;

  let skipped = false;
  for (const entry of queries) {
    if (Date.now() > deadline) break;
    try {
      const hit = await schedule(() => search(entry.query), deadline);
      if (hit === SKIPPED) {
        skipped = true;
        break;
      }
      if (hit) {
        match = { ...hit, precision: entry.precision, query: entry.query };
        break;
      }
    } catch {
      // Timeout, abort or a network failure - try the next, coarser query.
    }
  }

  // A miss is worth remembering; giving up early is not - the same address
  // asked again when the queue is quiet should get a real answer.
  if (skipped && !match) return null;

  if (cache.size >= env.geocoding.cacheSize) cache.clear();
  cache.set(cacheKey, match);
  return match;
}

/**
 * Address -> a short list of candidate places, for the map picker's search box
 * (§6 Method 1).
 *
 * Unlike `lookup` this is driven by a person watching a screen: they typed a
 * query and are choosing between answers, so several hits are returned rather
 * than one, and no coarsening cascade is run - a search that finds nothing
 * should say so and let them type something better.
 */
async function searchAddresses(queryText, { limit = 5 } = {}) {
  if (!isConfigured()) return [];
  const text = clean(queryText);
  if (text.length < 3) return [];

  /*
   * Cached, because this is the hottest path into a provider that allows about
   * one request a second.
   *
   * `/geo/search` is public and the mobile location picker calls it as the
   * customer types, so "Coimbatore" is looked up by every new user in the
   * city. The `lookup` cascade above has had an in-process Map since it was
   * written; this and `reverse` had nothing, which left the one-per-second
   * budget being spent on the same few hundred place names for ever.
   *
   * Keyed on the lower-cased text so capitalisation does not split the key.
   * Returning `undefined` from the loader is how the cache facade is told not
   * to store an answer - see the failure branches below.
   */
  const cached = await sharedCache.wrap(
    'geocode',
    { op: 'search', q: text.toLowerCase(), limit },
    env.geocoding.resultTtlSeconds,
    async () => {
      const deadline = Date.now() + env.geocoding.requestTimeoutMs + env.geocoding.minIntervalMs;
      try {
        const results = await schedule(
          () => request('/search', { q: text, format: 'jsonv2', addressdetails: 1, limit }),
          deadline,
        );
        // A skipped request means the queue was too deep, not that the place
        // does not exist. Not an answer, so not cached.
        if (results === SKIPPED) return undefined;
        if (!Array.isArray(results)) return undefined;
        return results.map(toPlace).filter(Boolean);
      } catch {
        // The picker still works without search: the merchant can drag the
        // pin. A provider failure is emphatically not a cacheable "no match" -
        // storing it would turn a minute of trouble into a day of a city not
        // existing.
        return undefined;
      }
    },
  );

  return cached ?? [];
}

/**
 * Coordinates -> address (§10). Called when a merchant drops or drags the pin,
 * so the address fields describe the place they actually chose rather than the
 * one they originally typed.
 *
 * A null answer is not a failure the merchant needs to see - the pin they
 * placed is still the location being saved; only the address text is missing.
 */
async function reverse(latitude, longitude) {
  if (!isConfigured()) return null;

  // Rounded before it becomes a key: a pin drag produces a new coordinate
  // every few pixels, so the raw value would never be asked for twice.
  const places = env.geocoding.reversePrecision;
  const key = {
    op: 'reverse',
    lat: Number(latitude).toFixed(places),
    lon: Number(longitude).toFixed(places),
  };

  const cached = await sharedCache.wrap(
    'geocode',
    key,
    env.geocoding.resultTtlSeconds,
    async () => {
      const deadline = Date.now() + env.geocoding.requestTimeoutMs + env.geocoding.minIntervalMs;
      try {
        const hit = await schedule(
          () => request('/reverse', { lat: latitude, lon: longitude, format: 'jsonv2', addressdetails: 1 }),
          deadline,
        );
        // Skipped or errored is not an answer about this coordinate.
        if (hit === SKIPPED || !hit || hit.error) return undefined;
        return toPlace(hit);
      } catch {
        return undefined;
      }
    },
  );

  return cached ?? null;
}

module.exports = { isConfigured, lookup, searchAddresses, reverse };
