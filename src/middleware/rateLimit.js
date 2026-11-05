'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const message = (text) => ({
  success: false,
  error: { code: 'RATE_LIMITED', message: text },
});

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  // Disabling limits in tests keeps the suite from flaking on repeated calls.
  skip: () => env.nodeEnv === 'test',
};

/** Broad limiter applied to the whole API surface. */
const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  // The payment webhook is exempt: its caller is Razorpay, whose retries and
  // catch-up bursts are not abuse, and dropping one means missing a payment.
  // Its HMAC signature is what gates it (§8.1).
  skip: (req) => base.skip() || req.path === '/payments/razorpay/webhook',
  message: message('Too many requests. Please slow down and try again shortly.'),
});

/** Tight limiter for credential endpoints (login, register, reset). */
const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  // Count failed attempts only, so a legitimate user is never locked out.
  skipSuccessfulRequests: true,
  message: message('Too many authentication attempts. Try again in 15 minutes.'),
});

/**
 * Refresh-token exchange (§9, §51).
 *
 * Separate from `authLimiter` because the two protect different things and a
 * shared counter would make each one weaker: a burst of failed logins must not
 * cost a legitimate user the refresh their app is about to need, and vice
 * versa.
 *
 * `skipSuccessfulRequests` is what makes the limit safe to set this low. A
 * working client refreshes once per access-token lifetime, and those calls
 * succeed and are never counted. What is counted is failures - a token that is
 * expired, revoked, replayed or guessed - and a client producing thirty of
 * those in fifteen minutes is not a client that is going to recover by trying
 * again. Keyed by IP: the caller has no valid session yet, so there is no user
 * to key by.
 */
const refreshLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  message: message('Too many refresh attempts. Please sign in again.'),
});

/** Limiter for endpoints that trigger outbound email. */
const emailLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: message('Too many email requests. Try again in an hour.'),
});

/**
 * Search and the discovery rails (§9 moderate limits, §56).
 *
 * A search is the most expensive read the public API serves - four LIKE-driven
 * listings across offers, services, shops and categories, each with distance
 * maths and a count - and it is reachable without a login, so §57 counts it
 * among the operations that need their own ceiling rather than the general
 * one. Set high enough that typing in a search box (which the client debounces)
 * never reaches it, and low enough that scraping the catalogue through it is
 * not practical.
 */
const searchLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip),
  message: message('Too many searches. Please wait a moment and try again.'),
});

/** Limiter for uploads. */
const uploadLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 100,
  message: message('Too many uploads. Try again shortly.'),
});

/**
 * Limiter for AI generation (§40). Each call costs a provider request, so this
 * sits well below the general API limit. The subscription quota is the real
 * budget; this only stops a stuck client from burning a month's allowance in a
 * few seconds.
 */
const aiLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 12,
  // Per user rather than per IP: a shop's staff often share an office address.
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip),
  message: message('You are generating a lot at once. Please wait a moment and try again.'),
});

/**
 * Claim verification (Claim/Redemption §28).
 *
 * The first of two layers, and the crude one: it caps how fast anyone can post
 * to the verify screen at all. The second layer lives in the claims service and
 * counts *failed* attempts per merchant user out of the database, which is what
 * actually distinguishes someone guessing codes from a queue on a Saturday.
 * This one only exists so a script cannot make thousands of attempts before
 * that check has had a chance to notice.
 *
 * Per user rather than per IP: a shop's tills share one connection, and a
 * merchant who moves between phones is still the same person (§17).
 */
const claimVerifyLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip),
  message: message('Too many unsuccessful attempts. Please try again later.'),
});

/**
 * Raising a support request.
 *
 * The endpoint is open to guests and sends mail, so it has the two properties
 * that make an endpoint worth flooding. Keyed by user where there is one and by
 * IP otherwise, and set at a number a frustrated person filing the same problem
 * three times will never reach - the limit is for a script, not for them.
 */
const supportLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip),
  message: message('You have raised several requests recently. Please wait a little before sending another.'),
});

/**
 * Limiter for seller self-registration (Self-Service Onboarding §19).
 *
 * Keyed by account rather than IP: a shared office or a mobile carrier NAT
 * puts many legitimate shopkeepers behind one address, and the thing worth
 * limiting is one account creating shops in a loop, not one building.
 * Generous enough that a merchant registering a second shop never notices.
 */
const onboardingLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : req.ip),
  message: message('Too many registration attempts. Please try again later.'),
});

module.exports = { apiLimiter, onboardingLimiter, authLimiter, refreshLimiter, emailLimiter, searchLimiter, uploadLimiter, aiLimiter, claimVerifyLimiter, supportLimiter };
