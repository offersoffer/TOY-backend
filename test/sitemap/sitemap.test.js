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
let rows = { shops: [], offers: [], services: [] };

require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: {
    query: async (sql) => {
      lastQueries.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM shops/.test(sql)) return rows.shops;
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
  rows = { shops: [], offers: [], services: [], ...next };
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
