'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * What the sitemap promises a crawler.
 *
 * The database is stubbed rather than seeded: every assertion here is about the
 * shape of the XML and which rows reach it, and none of that needs MySQL. The
 * stub is installed into the module cache before sitemap.service is loaded,
 * because the service destructures `query` at require time.
 */

const poolPath = require.resolve('../../src/db/pool');

let lastQueries = [];
let rows = { categories: [], categoryCities: [], shops: [], offers: [], services: [] };

require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: {
    query: async (sql) => {
      lastQueries.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM categories/.test(sql)) return rows.categories;
      if (/FROM shops/.test(sql)) return rows.shops;
      // Checked before the plain offers query: the category/city crossing reads
      // FROM offers as well, and is told apart by its GROUP BY.
      if (/GROUP BY c\.slug, b\.city/.test(sql)) return rows.categoryCities;
      if (/FROM offers/.test(sql)) return rows.offers;
      if (/FROM services/.test(sql)) return rows.services;
      throw new Error(`unexpected query: ${sql}`);
    },
  },
};

const env = require('../../src/config/env');
const sitemap = require('../../src/modules/sitemap/sitemap.service');

function reset(next = {}) {
  lastQueries = [];
  rows = { categories: [], categoryCities: [], shops: [], offers: [], services: [], ...next };
  sitemap.invalidate();
}

test('an empty catalogue still produces a valid sitemap of the static pages', async () => {
  reset();
  const xml = await sitemap.getSitemap();

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/</loc>`));
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers</loc>`));
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/privacy</loc>`));
  assert.match(xml, /<\/urlset>/);
});

test('/nearby is never listed: it renders from coordinates a crawler has not got', async () => {
  reset();
  const xml = await sitemap.getSitemap();
  assert.doesNotMatch(xml, /\/nearby</);
});

test('shops are emitted by slug, which is what the canonical tag uses', async () => {
  reset({ shops: [{ slug: 'raju-textiles', updated_at: new Date('2026-09-01T10:00:00Z') }] });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/shops/raju-textiles</loc>`));
  assert.match(xml, /<lastmod>2026-09-01T10:00:00\.000Z<\/lastmod>/);
});

test('category listings are emitted at their own route, not the query form', async () => {
  reset({ categories: [{ slug: 'clothing', updated_at: new Date('2026-09-02T10:00:00Z') }] });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/clothing</loc>`));
  assert.match(xml, /<lastmod>2026-09-02T10:00:00\.000Z<\/lastmod>/);
  // The query form canonicalises into the route above, so listing it too would
  // advertise a second address for one page - the thing this used to get wrong.
  assert.doesNotMatch(xml, /categoryId=/);
  assert.doesNotMatch(xml, /\/offers\?/);
});

test('only active top-level categories are asked for', async () => {
  reset();
  await sitemap.getSitemap();

  const categories = lastQueries.find((sql) => /FROM categories/.test(sql));
  assert.ok(categories, 'the category listings should be queried for');
  assert.match(categories, /c\.status = 'active'/);
  // A subcategory listing competes with its parent for the same query.
  assert.match(categories, /c\.parent_id IS NULL/);
});

test('a category listing survives truncation, because the long tail is the point', async () => {
  reset({
    categories: [{ slug: 'clothing', updated_at: null }],
    offers: Array.from({ length: sitemap.MAX_URLS + 500 }, (_, i) => ({ id: i + 1, updated_at: null })),
  });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/clothing</loc>`));
  assert.equal((xml.match(/<loc>/g) ?? []).length, sitemap.MAX_URLS);
});

test('a category slug is escaped in the path like any other', async () => {
  reset({ categories: [{ slug: 'toys&games', updated_at: null }] });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/toys%26games</loc>`));
  assert.doesNotMatch(xml, /<loc>[^<]*&(?!amp;|quot;|apos;|lt;|gt;)/);
});

test('a category is crossed with a city only where live offers back it', async () => {
  reset({
    categories: [{ slug: 'clothing', updated_at: null }],
    categoryCities: [
      { slug: 'clothing', city: 'Coimbatore', updated_at: new Date('2026-09-03T10:00:00Z'), offer_count: 4 },
    ],
  });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/clothing/coimbatore</loc>`));
  assert.match(xml, /<lastmod>2026-09-03T10:00:00\.000Z<\/lastmod>/);
  // The category at large is still its own page, and the stronger of the two.
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/clothing</loc>`));
});

test('a category with no offers in a city is not crossed with it', async () => {
  reset({ categories: [{ slug: 'clothing', updated_at: null }] });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/clothing</loc>`));
  // Listing every crossing would be listing empty pages, which is worse than
  // not listing them: the query returns the pairs that have something on them.
  assert.doesNotMatch(xml, /\/offers\/c\/clothing\/\w/);
});

test('the crossing asks only for live offers that apply at a branch in the city', async () => {
  reset();
  await sitemap.getSitemap();

  const crossing = lastQueries.find((sql) => /GROUP BY c\.slug, b\.city/.test(sql));
  assert.ok(crossing, 'the category/city crossing should be queried for');

  // The same live predicate the listing itself runs.
  assert.match(crossing, /o\.status = 'active'/);
  assert.match(crossing, /s\.status = 'active'/);
  assert.match(crossing, /o\.start_date <= NOW\(\)/);
  assert.match(crossing, /o\.end_date >= NOW\(\)/);
  assert.match(crossing, /c\.parent_id IS NULL/);

  // An offer only counts for a city if it actually applies at a branch there -
  // shop-wide, or on the branch list. An online-only offer applies at neither.
  assert.match(crossing, /applicability_type = 'shop_wide'/);
  assert.match(crossing, /applicability_type = 'selected_branches'/);
  // One row per offer, not one per branch the offer happens to reach.
  assert.match(crossing, /COUNT\(DISTINCT o\.id\)/);
});

test('the crossing is limited to the cities the app actually offers', async () => {
  reset();
  await sitemap.getSitemap();

  const crossing = lastQueries.find((sql) => /GROUP BY c\.slug, b\.city/.test(sql));
  // Eight placeholders, one per suggested city - not every string ever typed
  // into a branch. The names themselves are bound, not interpolated.
  assert.match(crossing, /b\.city IN \(\?, \?, \?, \?, \?, \?, \?, \?\)/);
});

test('a city becomes the slug the route turns back into its own name', async () => {
  reset({
    categoryCities: [
      { slug: 'clothing', city: 'Bengaluru', updated_at: null, offer_count: 1 },
      // Spacing and case are the branch row's, not the URL's.
      { slug: 'food', city: 'New Delhi', updated_at: null, offer_count: 1 },
    ],
  });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/clothing/bengaluru</loc>`));
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/c/food/new-delhi</loc>`));
});

test('offers and services are emitted by id', async () => {
  reset({
    offers: [{ id: 42, updated_at: new Date('2026-09-10T08:30:00Z') }],
    services: [{ id: 7, updated_at: new Date('2026-09-11T08:30:00Z') }],
  });
  const xml = await sitemap.getSitemap();

  assert.match(xml, new RegExp(`<loc>${env.appUrl}/offers/42</loc>`));
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/services/7</loc>`));
});

test('only live rows are asked for: active status, active shop, inside the date window', async () => {
  reset();
  await sitemap.getSitemap();

  const offers = lastQueries.find((sql) => /FROM offers/.test(sql));
  assert.match(offers, /o\.status = 'active'/);
  assert.match(offers, /s\.status = 'active'/);
  assert.match(offers, /o\.start_date <= NOW\(\)/);
  assert.match(offers, /o\.end_date >= NOW\(\)/);

  // A service with no end date runs indefinitely, so NULL must not exclude it.
  const services = lastQueries.find((sql) => /FROM services/.test(sql));
  assert.match(services, /sv\.end_date IS NULL OR sv\.end_date >= NOW\(\)/);
});

test('characters that are illegal in XML are escaped, not emitted raw', async () => {
  reset({ shops: [{ slug: 'tea&co', updated_at: null }] });
  const xml = await sitemap.getSitemap();

  // encodeURIComponent turns & into %26 in the path; nothing raw survives.
  assert.doesNotMatch(xml, /<loc>[^<]*&(?!amp;|quot;|apos;|lt;|gt;)/);
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/shops/tea%26co</loc>`));
});

test('a row with no updated_at is listed without a lastmod rather than an invalid one', async () => {
  reset({ offers: [{ id: 9, updated_at: null }] });
  const xml = await sitemap.getSitemap();

  const entry = xml.split('<url>').find((block) => block.includes('/offers/9'));
  assert.ok(entry, 'the offer should be listed');
  assert.doesNotMatch(entry, /<lastmod>/);
  assert.doesNotMatch(xml, /Invalid Date/);
});

test('the build is cached: a second call inside the TTL does not re-query', async () => {
  reset({ offers: [{ id: 1, updated_at: null }] });
  await sitemap.getSitemap();
  const afterFirst = lastQueries.length;

  await sitemap.getSitemap();
  assert.equal(lastQueries.length, afterFirst, 'the cached copy should have been reused');
});

test('the URL count stays inside Google per-sitemap ceiling', async () => {
  reset({
    offers: Array.from({ length: sitemap.MAX_URLS + 500 }, (_, i) => ({ id: i + 1, updated_at: null })),
  });
  const xml = await sitemap.getSitemap();

  const count = (xml.match(/<loc>/g) ?? []).length;
  assert.equal(count, sitemap.MAX_URLS);
  // Truncation drops from the end, so the static pages must survive it.
  assert.match(xml, new RegExp(`<loc>${env.appUrl}/</loc>`));
});
