'use strict';

const express = require('express');

const sitemapService = require('./sitemap.service');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');

/**
 * `GET /sitemap.xml`, mounted at the site root rather than under the API prefix.
 *
 * It has to live at the root because that is the only place a crawler looks and
 * the only place robots.txt can usefully point. nginx proxies this one path
 * through to the API; everything else at the root is the Angular build.
 *
 * Unauthenticated and uncacheable by session, because a crawler has neither.
 */

const router = express.Router();

router.get(
  '/sitemap.xml',
  asyncHandler(async (_req, res) => {
    let xml;
    try {
      xml = await sitemapService.getSitemap();
    } catch (error) {
      // A database blip must not hand Google a 500 on the file it uses to find
      // every page on the site - repeated 5xx on a sitemap gets it dropped.
      // An empty-but-valid sitemap says "nothing new right now", which is the
      // truthful answer when we cannot read the catalogue, and the next fetch
      // recovers on its own.
      logger.error(
        { event: 'SITEMAP_BUILD_FAILED', category: 'DATABASE', err: error },
        'Falling back to an empty sitemap',
      );
      res.status(200).type('application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n',
      );
      return;
    }

    res
      .type('application/xml')
      // Matches the service's own rebuild interval, so an intermediary never
      // serves a copy older than the one we would have built anyway.
      .set('Cache-Control', 'public, max-age=3600')
      .send(xml);
  }),
);

module.exports = router;
