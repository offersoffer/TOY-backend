'use strict';

const env = require('../../config/env');
const { query } = require('../../db/pool');
const { slugify } = require('../../utils/slug');
// Shared rather than copied: which branches an offer actually applies at is the
// subtlest predicate in the app, and a category/city page that disagrees with it
// is a page this sitemap would be advertising empty.
const { branchPredicate } = require('../offers/offer.service');

/**
 * The XML sitemap for the public site.
 *
 * Discovery pages are the reason this exists. A crawler that lands on
 * offersoffer.in finds the listing screens, but every shop, offer and service
 * page below them is reachable only by running the Angular router - the links
 * are rendered client-side, after an API call. A sitemap is how those addresses
 * get discovered without relying on the crawler executing our JavaScript first.
 *
 * Three rules it follows:
 *
 *   1. Only what a signed-out visitor can actually see. The predicates below
 *      are the same ones the public list endpoints use (offer.service.js and
 *      service.service.js): active row, active shop, inside its date window.
 *      Listing a page that answers 404 or "not available" to a crawler is worse
 *      than not listing it.
 *   2. Canonical addresses only. Shops are emitted by slug because that is what
 *      SeoService.shop() writes into <link rel="canonical">; emitting the id
 *      form would advertise an address that points elsewhere.
 *   3. No filter state. `/offers?categoryId=3&page=2` is the same page as
 *      `/offers/c/clothing` with different state, and the canonical tag already
 *      says so. A category listing is listed at its own route, never at the
 *      query form that filters into it.
 *
 * Note for whoever moves this to SSR: nothing here changes. The sitemap is
 * about which URLs exist, not how they are rendered.
 */

/** Google's per-sitemap ceiling. Past this a sitemap *index* is required. */
const MAX_URLS = 50000;

/**
 * How long a built sitemap is reused.
 *
 * Crawlers re-fetch this file often and each build is four table scans. An hour
 * of staleness costs nothing - Google does not recrawl a discovered URL within
 * the hour anyway - and it means a crawl spike cannot turn into database load.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Pages that exist whether or not any merchant has signed up.
 *
 * `/nearby` is deliberately absent: it renders from the visitor's coordinates,
 * which a crawler does not grant, so it would be indexed empty.
 */
const STATIC_PAGES = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/offers', changefreq: 'daily', priority: '0.9' },
  { path: '/services', changefreq: 'daily', priority: '0.9' },
  { path: '/shops', changefreq: 'daily', priority: '0.8' },
  { path: '/categories', changefreq: 'weekly', priority: '0.7' },
  { path: '/about', changefreq: 'monthly', priority: '0.5' },
  { path: '/contact', changefreq: 'monthly', priority: '0.4' },
  { path: '/support', changefreq: 'monthly', priority: '0.4' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
];

/**
 * The cities a category listing is crossed with.
 *
 * Cities are free text on a branch rather than rows of their own, so there is no
 * table to read this from: every city anyone has ever typed into a branch would
 * include the misspellings, and crossing 24 categories with all of them would be
 * mostly pages with nothing on them.
 *
 * This is the customer-facing shortlist, and it must stay character-identical to
 * SUGGESTED_CITIES in TOY-frontend/src/app/core/location.service.ts. The route
 * turns its slug back into a city name by matching that list, and the branch
 * filter compares the result to `shop_branches.city` - so a name that differs
 * here produces a URL whose own page finds nothing.
 */
const SUGGESTED_CITIES = [
  'Coimbatore',
  'Chennai',
  'Bengaluru',
  'Hyderabad',
  'Mumbai',
  'Delhi',
  'Kochi',
  'Madurai',
];

let cache = { xml: null, builtAt: 0 };

/** The five characters that are not legal as themselves in XML content. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** W3C datetime, which is what the sitemap schema wants for <lastmod>. */
function lastmodOf(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function urlEntry({ path, lastmod, changefreq, priority }) {
  const parts = [`    <loc>${escapeXml(`${env.appUrl}${path}`)}</loc>`];
  if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
  if (changefreq) parts.push(`    <changefreq>${changefreq}</changefreq>`);
  if (priority) parts.push(`    <priority>${priority}</priority>`);
  return `  <url>\n${parts.join('\n')}\n  </url>`;
}

/**
 * Active shops. `slug` is UNIQUE and NOT NULL, so there is no id fallback here -
 * a row without one cannot exist.
 */
function activeShops() {
  return query(
    `SELECT s.slug, s.updated_at
       FROM shops s
      WHERE s.status = 'active'
      ORDER BY s.updated_at DESC
      LIMIT ${MAX_URLS}`,
  );
}

/** Live offers: the public predicate from offer.service.js, verbatim. */
function liveOffers() {
  return query(
    `SELECT o.id, o.updated_at
       FROM offers o
       JOIN shops s ON s.id = o.shop_id
      WHERE o.status = 'active'
        AND s.status = 'active'
        AND o.start_date <= NOW()
        AND o.end_date   >= NOW()
      ORDER BY o.updated_at DESC
      LIMIT ${MAX_URLS}`,
  );
}

/**
 * Live services. Their date columns are nullable - a service with no end date
 * runs indefinitely - so the window is checked with IS NULL on both sides,
 * matching service.service.js.
 */
function liveServices() {
  return query(
    `SELECT sv.id, sv.updated_at
       FROM services sv
       JOIN shops s ON s.id = sv.shop_id
      WHERE sv.status = 'active'
        AND s.status = 'active'
        AND (sv.start_date IS NULL OR sv.start_date <= NOW())
        AND (sv.end_date   IS NULL OR sv.end_date   >= NOW())
      ORDER BY sv.updated_at DESC
      LIMIT ${MAX_URLS}`,
  );
}

/**
 * Category listings, which are now real pages.
 *
 * "Clothing offers in Coimbatore" is exactly the page that should rank, and it
 * used to exist only as `/offers?categoryId=3` - an address OfferListComponent
 * canonicalised back to plain `/offers`, because filter state is not identity.
 * Listing those URLs would have advertised addresses that disown themselves,
 * which Search Console reports as "Duplicate, Google chose a different
 * canonical", so they were left out.
 *
 * `/offers/c/:categorySlug` fixed that: the route canonicalises to itself, and
 * the query form canonicalises into it. So the listings belong here.
 *
 * Top-level only. A subcategory listing is a thinner slice of the same offers
 * and competes with its parent for the same query; the parent is the page worth
 * putting a crawler's budget on.
 */
function activeCategories() {
  return query(
    `SELECT c.slug, c.updated_at
       FROM categories c
      WHERE c.status = 'active'
        AND c.parent_id IS NULL
      ORDER BY c.name
      LIMIT ${MAX_URLS}`,
  );
}

/**
 * The category/city pages that have something on them.
 *
 * "Clothing offers in Coimbatore" is the query this whole exercise is aimed at,
 * and `/offers/c/clothing/coimbatore` is where it lands - but only some of the
 * 24x8 crossings have a live offer behind them, and the rest would be listing
 * empty pages, which is the one thing rule 1 above forbids.
 *
 * So the existence check is the page's own query, not an approximation of it:
 * the same live-offer predicate as liveOffers(), the same `c.slug` match the
 * route sends, and branchPredicate() for the city - shared with offer.service
 * rather than copied, because an offer is only "in" a city if it actually
 * applies at a branch there. An online-only offer applies at no branch at all,
 * so it never props up a city page.
 *
 * Busiest pairs first: this is the one query here that can return a few hundred
 * rows, and if anything is going to be cut by MAX_URLS it should be the pair
 * with a single offer on it.
 */
function activeCategoryCities() {
  const cities = SUGGESTED_CITIES.map(() => '?').join(', ');
  return query(
    `SELECT c.slug,
            b.city,
            MAX(o.updated_at)   AS updated_at,
            COUNT(DISTINCT o.id) AS offer_count
       FROM offers o
       JOIN shops s ON s.id = o.shop_id
       JOIN categories c ON c.id = o.category_id
       JOIN shop_branches b
         ON b.status = 'active'
        AND b.city IN (${cities})
        AND ${branchPredicate('b')}
      WHERE o.status = 'active'
        AND s.status = 'active'
        AND c.status = 'active'
        AND c.parent_id IS NULL
        AND o.start_date <= NOW()
        AND o.end_date   >= NOW()
      GROUP BY c.slug, b.city
      ORDER BY offer_count DESC
      LIMIT ${MAX_URLS}`,
    SUGGESTED_CITIES,
  );
}

async function build() {
  const [categories, categoryCities, shops, offers, services] = await Promise.all([
    activeCategories(),
    activeCategoryCities(),
    activeShops(),
    liveOffers(),
    liveServices(),
  ]);

  // Most important first, because MAX_URLS truncates from the end.
  const entries = [
    ...STATIC_PAGES,
    // Above the individual rows: there are a few dozen of these and they are
    // the long-tail queries the site is trying to win, so they must survive a
    // truncation that a catalogue of 50,000 offers could otherwise cause.
    ...categories.map((row) => ({
      path: `/offers/c/${encodeURIComponent(row.slug)}`,
      lastmod: lastmodOf(row.updated_at),
      // The category row barely changes, but the listing under it turns over
      // as offers start and end, which is what a crawler is being told about.
      changefreq: 'daily',
      priority: '0.8',
    })),
    // Just under the bare category: more specific, and the query it answers is
    // the one worth winning, but a visitor who wants the category at large is
    // better served by the page that is not pinned to one city.
    ...categoryCities.map((row) => ({
      path: `/offers/c/${encodeURIComponent(row.slug)}/${encodeURIComponent(slugify(row.city))}`,
      lastmod: lastmodOf(row.updated_at),
      changefreq: 'daily',
      priority: '0.7',
    })),
    ...shops.map((row) => ({
      path: `/shops/${encodeURIComponent(row.slug)}`,
      lastmod: lastmodOf(row.updated_at),
      changefreq: 'weekly',
      priority: '0.8',
    })),
    ...offers.map((row) => ({
      path: `/offers/${row.id}`,
      lastmod: lastmodOf(row.updated_at),
      // An offer's terms rarely change, but its page carries a countdown to
      // end_date, so the content a visitor sees does change daily.
      changefreq: 'daily',
      priority: '0.7',
    })),
    ...services.map((row) => ({
      path: `/services/${row.id}`,
      lastmod: lastmodOf(row.updated_at),
      changefreq: 'weekly',
      priority: '0.7',
    })),
  ].slice(0, MAX_URLS);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(urlEntry),
    '</urlset>',
    '',
  ].join('\n');
}

/** The built sitemap, rebuilt at most once per CACHE_TTL_MS. */
async function getSitemap() {
  const now = Date.now();
  if (cache.xml && now - cache.builtAt < CACHE_TTL_MS) return cache.xml;

  const xml = await build();
  cache = { xml, builtAt: now };
  return xml;
}

/** Drops the cached copy. Exists for the tests; nothing in the app calls it. */
function invalidate() {
  cache = { xml: null, builtAt: 0 };
}

module.exports = { getSitemap, invalidate, MAX_URLS, CACHE_TTL_MS };
