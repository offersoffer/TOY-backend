'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * How a dashboard window is split between the daily roll-up and the raw events.
 *
 * `analytics_daily_snapshots` rows cover calendar days. Dashboard windows do
 * not - `resolveRange` builds `to = now` and `from = now - N days`, so both
 * ends land mid-day. Every way of getting this wrong produces a number that is
 * wrong by up to two days of traffic and looks entirely plausible, which is
 * why the arithmetic is tested on its own rather than only through a query.
 *
 * The invariant that matters most is the last test in this file: the segments
 * must **exactly tile** the window - no gap, so nothing is lost, and no
 * overlap, so nothing is counted twice.
 */

const SRC = path.join(__dirname, '../../src');
const stub = (rel, exports) => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
process.env.LOG_LEVEL = 'silent';
stub('db/pool', { rawQuery: async () => [], execute: async () => ({ affectedRows: 0 }) });

const rollup = require(path.join(SRC, 'services/analyticsRollup'));

/*
 * Every instant here is UTC, matching the module under test.
 *
 * `db/pool.js` pins each connection's session time zone to `+00:00`, so
 * `DATE(created_at)` groups by UTC days and the reader's day boundaries have
 * to be UTC too. Writing these as bare local timestamps is what produced the
 * first version of this module's results: boundaries 5.5 hours out in
 * Asia/Kolkata, a gap at one end of the window and an overlap at the other.
 */
const at = (iso) => new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
const DAY = 86400000;

test('a mid-day window keeps both partial days in raw and the rest in the roll-up', () => {
  const plan = rollup.planWindow(
    at('2026-11-01T14:30:00'),
    at('2026-11-10T09:15:00'),
    '2026-11-30', // roll-up well ahead of the window
  );

  // 1 Nov is partial, 10 Nov is partial, so the roll-up owns 2-9 Nov.
  assert.deepEqual(plan.snapshot, { fromDay: '2026-11-02', toDay: '2026-11-09' });
  assert.equal(plan.raw.length, 2);
  assert.equal(plan.raw[0].from.toISOString(), at('2026-11-01T14:30:00').toISOString());
  assert.equal(plan.raw[1].to.toISOString(), at('2026-11-10T09:15:00').toISOString());
});

test('a window starting exactly at midnight gives the roll-up that whole day', () => {
  const plan = rollup.planWindow(at('2026-11-01T00:00:00'), at('2026-11-10T09:15:00'), '2026-11-30');
  assert.equal(plan.snapshot.fromDay, '2026-11-01');
  // No head segment: there is no partial first day to read from raw.
  assert.equal(plan.raw.length, 1);
  assert.equal(plan.raw[0].from.getUTCDate(), 10);
});

test('a window ending at the very end of a day gives the roll-up that day too', () => {
  const plan = rollup.planWindow(
    at('2026-11-01T00:00:00'),
    at('2026-11-10T23:59:59.999'),
    '2026-11-30',
  );
  assert.deepEqual(plan.snapshot, { fromDay: '2026-11-01', toDay: '2026-11-10' });
  assert.equal(plan.raw.length, 0, 'nothing is partial, so nothing needs raw');
});

test('the roll-up being behind moves the boundary, it does not lose the days', () => {
  // The job last covered 5 Nov; the window runs to the 10th.
  const plan = rollup.planWindow(
    at('2026-11-01T00:00:00'),
    at('2026-11-10T09:15:00'),
    '2026-11-05',
  );
  assert.deepEqual(plan.snapshot, { fromDay: '2026-11-01', toDay: '2026-11-05' });
  assert.equal(plan.raw.length, 1);
  // Raw picks up from the 6th, not from the 10th.
  assert.equal(rollup.dateKey(plan.raw[0].from), '2026-11-06');
  assert.equal(plan.raw[0].to.toISOString(), at('2026-11-10T09:15:00').toISOString());
});

test('a roll-up that has never run reads everything from raw', () => {
  const plan = rollup.planWindow(at('2026-11-01T00:00:00'), at('2026-11-10T09:15:00'), null);
  assert.equal(plan.snapshot, null);
  assert.equal(plan.raw.length, 1);
  assert.equal(plan.raw[0].from.toISOString(), at('2026-11-01T00:00:00').toISOString());
  assert.equal(plan.raw[0].to.toISOString(), at('2026-11-10T09:15:00').toISOString());
});

test('a roll-up older than the window reads everything from raw', () => {
  const plan = rollup.planWindow(
    at('2026-11-01T14:00:00'),
    at('2026-11-10T09:00:00'),
    '2026-10-15',
  );
  assert.equal(plan.snapshot, null);
  assert.equal(plan.raw.length, 1);
});

test('a window inside a single day is all raw - there is no whole day in it', () => {
  const plan = rollup.planWindow(
    at('2026-11-05T08:00:00'),
    at('2026-11-05T17:00:00'),
    '2026-11-30',
  );
  assert.equal(plan.snapshot, null);
  assert.equal(plan.raw.length, 1);
});

test('two adjacent days with partial ends have no whole day either', () => {
  const plan = rollup.planWindow(
    at('2026-11-05T08:00:00'),
    at('2026-11-06T17:00:00'),
    '2026-11-30',
  );
  // 5 Nov partial, 6 Nov partial: firstFullDay is the 6th, lastFullDay the 5th.
  assert.equal(plan.snapshot, null);
  assert.equal(plan.raw.length, 1);
});

test('a degenerate window is passed through rather than inverted', () => {
  const plan = rollup.planWindow(at('2026-11-10T00:00:00'), at('2026-11-01T00:00:00'), '2026-11-30');
  assert.equal(plan.snapshot, null);
  assert.equal(plan.raw.length, 1);
});

test('the roll-up is never asked for the shop-level row or a branch row', () => {
  // Those exist for other purposes; summing them next to the per-offer rows
  // would double-count. Asserted against the SQL the module actually issues.
  const source = require('node:fs').readFileSync(
    path.join(SRC, 'services/analyticsRollup.js'),
    'utf8',
  );
  const selects = source.match(/FROM analytics_daily_snapshots s[\s\S]*?WHERE[^`]*/g) ?? [];
  assert.ok(selects.length >= 2, 'both totals and timeline should read the snapshot');
  assert.ok(selects.every((s) => s.includes('s.offer_id <> 0')));
  assert.ok(selects.every((s) => s.includes('s.branch_id = 0')));
});

// ---------------------------------------------------------------------------
// The invariant: the plan must exactly tile the window.
// ---------------------------------------------------------------------------

test('the segments exactly tile the window, for every shape of window', () => {
  const windows = [
    ['2026-11-01T14:30:00', '2026-11-10T09:15:00'],
    ['2026-11-01T00:00:00', '2026-11-10T23:59:59.999'],
    ['2026-11-05T08:00:00', '2026-11-05T17:00:00'],
    ['2026-01-31T23:00:00', '2026-03-01T01:00:00'], // across a month end
    ['2026-02-27T12:00:00', '2026-03-02T12:00:00'], // across February
    ['2026-12-30T12:00:00', '2027-01-02T12:00:00'], // across a year end
    ['2026-11-09T23:59:59', '2026-11-10T00:00:01'], // a two-second window
  ];
  const watermarks = [null, '2026-11-05', '2026-11-30', '2027-12-31', '2020-01-01'];

  for (const [fromIso, toIso] of windows) {
    for (const watermark of watermarks) {
      const from = at(fromIso);
      const to = at(toIso);
      const plan = rollup.planWindow(from, to, watermark);
      const label = `${fromIso} -> ${toIso} @ ${watermark}`;

      // Collect every covered interval as [startMs, endMs], snapshot days
      // expanded to the whole days they stand for.
      const covered = plan.raw.map((r) => [r.from.getTime(), r.to.getTime()]);
      if (plan.snapshot) {
        const dayStart = new Date(`${plan.snapshot.fromDay}T00:00:00Z`).getTime();
        const dayEnd = new Date(`${plan.snapshot.toDay}T00:00:00Z`).getTime() + DAY - 1;
        covered.push([dayStart, dayEnd]);
      }
      covered.sort((a, b) => a[0] - b[0]);

      if (to <= from) continue; // degenerate windows are passed through

      // No overlap: each segment starts after the previous one ended.
      for (let i = 1; i < covered.length; i += 1) {
        assert.ok(
          covered[i][0] > covered[i - 1][1],
          `overlap between segments for ${label}: ${JSON.stringify(covered)}`,
        );
        // No gap either: contiguous to the millisecond.
        assert.equal(
          covered[i][0] - covered[i - 1][1],
          1,
          `gap between segments for ${label}: ${JSON.stringify(covered)}`,
        );
      }

      // And together they cover exactly the window.
      assert.equal(covered[0][0], from.getTime(), `window start not covered for ${label}`);
      assert.equal(
        covered[covered.length - 1][1],
        to.getTime(),
        `window end not covered for ${label}`,
      );
    }
  }
});
