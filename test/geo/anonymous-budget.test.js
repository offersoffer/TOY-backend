'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

/**
 * What now funds the Nominatim budget for anonymous callers.
 *
 * `/geo/*` used to require a token, and that token was quietly doing two jobs:
 * keeping guests out, and keeping the outbound call budget attributable to an
 * account. Opening the routes to guests (see `public-geocoding.test.js`) gives
 * up the second job, so the limiter has to do it alone - which makes its
 * anonymous allowance a thing worth pinning rather than a detail.
 *
 * This lives in its own file on purpose. `node --test` gives each file its own
 * process, and the limiter's counters are module state keyed by IP: sharing a
 * file with the other geo tests meant their requests were already counted
 * against this one, and the budget appeared four short.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

process.env.LOG_LEVEL = 'silent';
// Not 'test': the limiter skips itself there, and the limiter is the subject.
process.env.NODE_ENV = 'development';

stub('services/geocoding', {
  searchAddresses: async () => [],
  reverse: async () => null,
  isConfigured: () => true,
});
stub('db/pool', {
  query: async () => [],
  queryOne: async () => null,
  execute: async () => ({ affectedRows: 0 }),
  rawQuery: async () => [],
});

const express = require('express');
const geoRoutes = require(path.join(SRC, 'modules/geo/geo.routes'));
const { errorHandler } = require(path.join(SRC, 'middleware/errorHandler'));

const app = express();
app.use('/geo', geoRoutes);
app.use(errorHandler);

let server;
let base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((done) => server.close(done));
});

test('an anonymous caller is served ten lookups a minute, then refused', async () => {
  const codes = [];
  for (let i = 0; i < 11; i += 1) {
    codes.push((await fetch(`${base}/geo/search?q=Coimbatore`)).status);
  }

  assert.deepEqual(codes.slice(0, 10), Array(10).fill(200), 'the first ten are served');
  assert.equal(codes[10], 429, 'the eleventh is refused');
});

test('the refusal is the shape the clients already handle', async () => {
  // An unlabelled 429 would surface in the app as "something went wrong".
  const res = await fetch(`${base}/geo/search?q=Coimbatore`);
  assert.equal(res.status, 429);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.match(body.error.message, /Too many location lookups/);
});
