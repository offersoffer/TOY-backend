'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const env = require('../../config/env');
const geocoding = require('../../services/geocoding');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { optionalAuth } = require('../../middleware/auth');
const { ok } = require('../../utils/respond');

/**
 * Geocoding for the map picker (V3 §5, §6, §26) and for the customer app's
 * location picker (Guest Browsing §20).
 *
 * The clients never talk to Nominatim directly. Three reasons, in order of how
 * much they matter:
 *
 *   1. Its usage policy is a per-application budget with an identifying
 *      User-Agent, which a browser cannot honestly send and a phone app would
 *      multiply by its install count.
 *   2. `services/geocoding.js` already serialises every outbound call at one a
 *      second; routing merchant searches through the same queue is what keeps
 *      the whole application inside that budget.
 *   3. Web and mobile then geocode identically, which §23 requires of the
 *      location model and is just as true of how coordinates are found.
 *
 * Nothing here writes. The merchant's chosen pin only becomes real when they
 * save the shop or branch, and a customer's chosen area is only ever stored on
 * their own device.
 *
 * So both routes are open to anonymous callers. They were authenticated while
 * the merchant map picker was the only caller, but the customer app reaches
 * this from "Choose Area", which a guest can be standing on with no account at
 * all - and a guest who has declined OS location has no other way to say where
 * they are. Requiring a token there did not protect anything: the answers come
 * from a public geocoder and depend on nothing about who is asking. What does
 * need protecting is the outbound budget, which is what the limiter below is
 * for.
 */

const router = express.Router();

/**
 * Tighter than the general API limiter because each call leaves this server.
 *
 * Keyed per user where there is one, because a shop's staff often share one
 * office address and would otherwise exhaust each other's budget. Anonymous
 * callers fall back to the IP, and get a smaller allowance: a signed-in
 * merchant placing a pin types and retries, while a customer is choosing one
 * area, and an IP is a weaker identity than an account - it can be a whole
 * office behind NAT, so the budget behind it should not be a per-person one.
 */
const geoLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (req.user?.id ? 30 : 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.nodeEnv === 'test',
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip),
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many location lookups. Wait a moment and try again.' },
  },
});

const searchQuery = z.object({
  q: z.string().trim().min(3, 'Type at least three characters').max(200),
  limit: z.coerce.number().int().min(1).max(10).optional().default(5),
});

const reverseQuery = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

/**
 * `optionalAuth`, not `authenticate`.
 *
 * This router was written for the merchant map picker, where there is always a
 * token, so it required one. `SelectLocationScreen` in the customer app now
 * geocodes through `/search` as well - it is reached from the home "Select
 * Location" chip, from "Choose Area" on Near Me, and from Profile - and that
 * screen is reachable by a guest, because "Continue as Guest" is a first-class
 * button on the welcome screen. A token requirement here would have answered
 * 401 on every one of those paths, and not merely failed the search: the mobile
 * client retries a 401 once, finds no refresh token, and ends the session, so
 * the guest would have been thrown back to the welcome screen for typing a city
 * name.
 *
 * Nothing here writes, nothing here is per-user, and the responses are public
 * geography, so there is nothing for a token to protect. What the token was
 * really doing was funding the Nominatim budget per account, and the limiter
 * above keeps doing that by IP for anonymous callers.
 */
router.use(optionalAuth, geoLimiter);

/** §6 Method 1: the merchant types an address and picks from the answers. */
router.get(
  '/search',
  validate({ query: searchQuery }),
  asyncHandler(async (req, res) => {
    const results = await geocoding.searchAddresses(req.query.q, { limit: req.query.limit });
    // An empty list is a legitimate answer - "nothing found, drag the pin
    // instead" - and is not distinguished from the geocoder being switched
    // off, because the merchant's next move is the same either way.
    ok(res, results, { configured: geocoding.isConfigured() });
  }),
);

/** §6 Methods 2 and 3: the pin moved, so the address fields should follow. */
router.get(
  '/reverse',
  validate({ query: reverseQuery }),
  asyncHandler(async (req, res) => {
    const place = await geocoding.reverse(req.query.latitude, req.query.longitude);
    ok(res, place, { configured: geocoding.isConfigured() });
  }),
);

module.exports = router;
