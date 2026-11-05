'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  businessDate,
  parseBusinessDate,
  boundaryInstant,
} = require('../../src/utils/businessDate');

/**
 * What a bare calendar day means.
 *
 * `z.coerce.date()` reads "2026-11-05" as UTC midnight, because that is what
 * ECMAScript says a date-only string is. For a platform whose merchants are
 * all in IST that put every such boundary 5.5 hours out, and for an *end*
 * boundary it was worse than that: an override granted "until the 5th" was
 * revoked at 05:30 on the 5th, before the shop opened.
 *
 * These pin the two halves of the fix - which instant bounds a day, and that
 * a client which already sent a real timestamp is left alone.
 */

const IST = 'Asia/Kolkata';

/** Renders an instant as wall-clock time in a zone, for readable assertions. */
const wallClock = (instant, timeZone = IST) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(instant);

test('a bare date starts when the merchant\'s day starts', () => {
  const parsed = businessDate('start').parse('2026-11-05');
  assert.equal(wallClock(parsed), '05/11/2026, 00:00:00');
  // The bug this replaces: UTC midnight, i.e. 05:30 that morning in IST.
  assert.notEqual(parsed.toISOString(), '2026-11-05T00:00:00.000Z');
  assert.equal(parsed.toISOString(), '2026-11-04T18:30:00.000Z');
});

test('a bare date as an end boundary covers the whole day', () => {
  const parsed = businessDate('end').parse('2026-11-05');
  assert.equal(wallClock(parsed), '05/11/2026, 23:59:59');
  // .000 rather than .999 so a DATETIME column, which has no fractional
  // seconds and rounds, stores this exact instant instead of next midnight.
  assert.equal(parsed.toISOString(), '2026-11-05T18:29:59.000Z');
});

test('an offer set for one day is a day long, not zero', () => {
  const start = businessDate('start').parse('2026-11-05');
  const end = businessDate('end').parse('2026-11-05');
  const hours = (end - start) / 3600000;
  assert.ok(hours > 23.9 && hours < 24, `expected ~24 hours, got ${hours}`);
});

test('a value that already carries a time is left exactly as it is', () => {
  // The offer form sends a full timestamp; it was never wrong and must not
  // start being rewritten now.
  for (const input of [
    '2026-11-05T14:30:00.000Z',
    '2026-11-05T14:30:00+05:30',
  ]) {
    assert.equal(
      businessDate('end').parse(input).toISOString(),
      new Date(input).toISOString(),
      `${input} should pass through untouched`,
    );
  }
});

test('a Date instance passes through untouched', () => {
  const given = new Date('2026-11-05T09:00:00.000Z');
  assert.equal(businessDate('end').parse(given).toISOString(), given.toISOString());
});

test('parseBusinessDate tells absent from unparseable', () => {
  assert.equal(parseBusinessDate(null), null);
  assert.equal(parseBusinessDate(''), null);
  assert.equal(parseBusinessDate('not a date'), null);
  assert.ok(parseBusinessDate('2026-11-05', 'end') instanceof Date);
});

test('the day boundary follows DST where a zone observes it', () => {
  // US clocks spring forward on 2026-03-08 and fall back on 2026-11-01, so a
  // fixed offset would put both of these an hour out. India has no DST, but a
  // helper that is wrong here is wrong invisibly.
  const springEnd = boundaryInstant('2026-03-08', 'end', 'America/New_York');
  assert.equal(wallClock(springEnd, 'America/New_York'), '08/03/2026, 23:59:59');

  const fallEnd = boundaryInstant('2026-11-01', 'end', 'America/New_York');
  assert.equal(wallClock(fallEnd, 'America/New_York'), '01/11/2026, 23:59:59');
});

test('an end boundary survives a DATETIME column without rounding up', () => {
  // MySQL DATETIME keeps whole seconds and rounds .5 upwards, so any
  // millisecond component here would be stored as the following midnight.
  assert.equal(businessDate('end').parse('2026-11-05').getUTCMilliseconds(), 0);
  assert.equal(businessDate('start').parse('2026-11-05').getUTCMilliseconds(), 0);
});

test('half-hour zones land on the right instant', () => {
  const start = boundaryInstant('2026-06-15', 'start', 'Australia/Adelaide');
  assert.equal(start.toISOString(), '2026-06-14T14:30:00.000Z');
});
