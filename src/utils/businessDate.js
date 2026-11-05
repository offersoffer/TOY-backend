'use strict';

const { z } = require('zod');
const env = require('../config/env');

/**
 * Date-only input, read as a day in the business time zone.
 *
 * `z.coerce.date()` hands `new Date("2026-11-05")` back, and the ECMAScript
 * rule for a date-only string is UTC midnight - so "expires 5 November" became
 * 05:30 on the 5th in Indian time. An override granted "until the 5th" was
 * revoked before the shop opened that morning, and nothing downstream could
 * tell, because `expires_at > NOW()` sees a perfectly ordinary timestamp.
 *
 * A date names a *day*, and which instant bounds that day depends on where the
 * merchant is. That is what this resolves:
 *
 *   start boundary -> 00:00:00.000 local
 *   end boundary   -> 23:59:59.999 local
 *
 * A value that already carries a time is left exactly as it is: a client that
 * sent a full timestamp has already answered the question this asks, and the
 * offer form does precisely that. So this changes only the inputs that were
 * previously wrong.
 *
 * `resolvePresetRange` in `dateRange.js` does the same snapping for analytics
 * windows, which is why the dashboards never had this bug.
 */

/** Matches a bare calendar day, the only shape that needs interpreting. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Offset of `timeZone` from UTC, in minutes, at the given instant.
 *
 * Derived from `Intl` rather than hard-coded so the value stays right for a
 * zone that observes DST. India does not, but the helper is not India-only and
 * a wrong answer here is invisible until it is expensive.
 */
function offsetMinutes(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);

  const field = (type) => Number(parts.find((part) => part.type === type).value);
  // `Date.UTC` of the local wall clock, minus the real instant, is the offset.
  const asUtc = Date.UTC(
    field('year'), field('month') - 1, field('day'),
    field('hour') % 24, field('minute'), field('second'),
  );
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000;
}

/**
 * The instant at which `day` starts or ends in `timeZone`.
 *
 * The offset is resolved twice because it has to be sampled at some instant,
 * and on a DST boundary the first guess can land on the wrong side of the
 * change. The second pass samples at the answer the first one produced.
 */
function boundaryInstant(day, boundary, timeZone) {
  const [year, month, date] = day.split('-').map(Number);
  // 23:59:59.000, not .999: DATETIME columns in this schema carry no
  // fractional seconds and MySQL *rounds* on the way in, so .999 is stored as
  // the next midnight - an expiry a second into the following day. The lost
  // millisecond means nothing to a day boundary; the rounding did.
  const wallClock = boundary === 'end'
    ? Date.UTC(year, month - 1, date, 23, 59, 59, 0)
    : Date.UTC(year, month - 1, date, 0, 0, 0, 0);

  let instant = new Date(wallClock);
  for (let pass = 0; pass < 2; pass += 1) {
    instant = new Date(wallClock - offsetMinutes(timeZone, instant) * 60000);
  }
  return instant;
}

/**
 * Parses a value that may be a bare calendar day, outside a zod schema.
 *
 * Returns `null` for anything unparseable, so a caller that is filling in a
 * default can tell "absent" from "wrong" without a try/catch.
 *
 * @param {'start'|'end'} boundary which edge of the day a date-only value means
 */
function parseBusinessDate(value, boundary = 'start') {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && DATE_ONLY.test(value.trim())) {
    return boundaryInstant(value.trim(), boundary, env.businessTimeZone);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * A zod date that understands what a bare calendar day means.
 *
 * @param {'start'|'end'} boundary which edge of the day a date-only value means
 */
function businessDate(boundary = 'start') {
  const timeZone = env.businessTimeZone;
  return z.preprocess((value) => {
    if (typeof value !== 'string' || !DATE_ONLY.test(value.trim())) return value;
    return boundaryInstant(value.trim(), boundary, timeZone);
  }, z.coerce.date());
}

module.exports = { businessDate, parseBusinessDate, boundaryInstant, offsetMinutes, DATE_ONLY };
