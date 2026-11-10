'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

/**
 * Who may ask where a place is.
 *
 * `/geo/search` and `/geo/reverse` were written for the merchant map picker and
 * required a token for the whole router. That is the wrong shape for the
 * customer app: `SelectLocationScreen` - reached from the home "Select
 * Location" chip, from "Choose Area" on Near Me, and from Profile - is
 * reachable by a guest, because "Continue as Guest" is a first-class button on
 * the welcome screen. A guest has no token, so this router answered 401 on
 * every one of those paths. Observed on a preview build against production:
 * "Could not search for that location right now", on a screen whose two
 * buttons both failed, leaving no way to use Near Me without granting the OS
 * location permission.
 *
 * The client's 401 handling makes it worse on paper - `client.ts` spends its
 * one silent refresh, gets nothing back for a guest, and reaches
 * `onSessionExpired`, which clears `isGuest` and would bounce the visitor to
 * the welcome screen. That was not what the emulator did: browsing continued
 * normally afterwards. So the ejection is left as unconfirmed rather than
 * asserted here - the 401 is the defect either way, and it is now gone.
 *
 * These run the real router over a real socket, because the defect was in
 * middleware order rather than in a handler - calling the handler directly
 * would have passed the whole time it was broken.
 *
 * The limiter is exercised too. It is the only thing now standing between an
 * anonymous caller and the Nominatim budget, which is what the token had been
 * doing by accident.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

process.env.LOG_LEVEL = 'silent';
// Not 'test': the limiter skips itself there, and its budget is under test.
process.env.NODE_ENV = 'development';

/** The one account that exists, for the signed-in half of the limiter test. */
const USER = {
  id: 7,
  name: 'Asha',
  email: 'asha@example.com',
  phone: null,
  status: 'active',
  email_verified: 1,
  avatar_url: null,
  pref_city: null,
  pref_latitude: null,
  pref_longitude: null,
};

// No network, and no database behind the error handler's failure log.
let searched = [];
let reversed = [];
stub('services/geocoding', {
  searchAddresses: async (q, options) => {
    searched.push({ q, options });
    return [{ label: 'Coimbatore, Tamil Nadu', latitude: 11.0168, longitude: 76.9558 }];
  },
  reverse: async (latitude, longitude) => {
    reversed.push({ latitude, longitude });
    return { label: 'Coimbatore', latitude, longitude };
  },
  isConfigured: () => true,
});
stub('db/pool', {
  // `optionalAuth` -> `resolveUser` reads the account a valid token names.
  queryOne: async (sql) => (sql.includes('FROM users WHERE id') ? USER : null),
  // `loadAccessContext` asks for roles and memberships; this account has none.
  query: async () => [],
  execute: async () => ({ affectedRows: 0 }),
  rawQuery: async () => [],
});

const express = require('express');
const geoRoutes = require(path.join(SRC, 'modules/geo/geo.routes'));
const errorHandler = require(path.join(SRC, 'middleware/errorHandler'));
const { signAccessToken } = require(path.join(SRC, 'utils/tokens'));

const app = express();
app.use('/geo', geoRoutes);
app.use(typeof errorHandler === 'function' ? errorHandler : errorHandler.errorHandler);

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

test.beforeEach(() => {
  searched = [];
  reversed = [];
});

const get = (url, headers = {}) => fetch(`${base}${url}`, { headers });

test('a guest can search for a place', async () => {
  const res = await get('/geo/search?q=Coimbatore');
  assert.equal(res.status, 200, 'a guest must not be turned away');

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data[0].label, 'Coimbatore, Tamil Nadu');
  assert.equal(searched.length, 1, 'the request reached the geocoder');
});

test('a guest can reverse-geocode a pin', async () => {
  const res = await get('/geo/reverse?latitude=11.0168&longitude=76.9558');
  assert.equal(res.status, 200);
  assert.equal(reversed.length, 1);
});

test('an expired or malformed token is treated as anonymous, not rejected', async () => {
  // `optionalAuth` swallows a bad token. The alternative - 401 - would strand
  // a customer whose session lapsed on a screen that needs no identity at all,
  // and on mobile a 401 here ends the session rather than just failing.
  const res = await get('/geo/search?q=Madurai', { authorization: 'Bearer not-a-real-token' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
});

test('validation still applies without a token', async () => {
  // Dropping `authenticate` must not drop the rest of the chain.
  const res = await get('/geo/search?q=ab');
  assert.equal(res.status, 422, 'two characters is below the minimum');
  assert.equal(searched.length, 0, 'nothing reached the geocoder');
  assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
});

/**
 * The budget, asserted from the headers rather than from a fixed number of
 * requests: every test above spends some of the same anonymous allowance, so
 * counting from zero here would make this depend on what ran before it.
 */
test('an anonymous caller gets a smaller Nominatim budget than a signed-in one', async () => {
  const first = await get('/geo/search?q=Coimbatore');
  assert.equal(Number(first.headers.get('ratelimit-limit')), 10, 'the anonymous allowance');

  // Spend whatever is left of it, then prove the next one is refused - and
  // refused in the shape the clients already handle, not as an unlabelled 429.
  const remaining = Number(first.headers.get('ratelimit-remaining'));
  for (let i = 0; i < remaining; i += 1) {
    assert.equal((await get('/geo/search?q=Coimbatore')).status, 200, `request ${i + 1} of the remainder`);
  }

  const refused = await get('/geo/search?q=Coimbatore');
  assert.equal(refused.status, 429, 'the allowance is finite');
  const body = await refused.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.match(body.error.message, /Too many location lookups/);

  // The signed-in caller is a different bucket with a larger allowance, which
  // is the whole point of keying on `user:<id>` where there is one: the IP that
  // just ran out of budget is still able to geocode for a merchant behind it.
  const authorized = await get('/geo/search?q=Coimbatore', {
    authorization: `Bearer ${signAccessToken({ id: USER.id, email: USER.email })}`,
  });
  assert.equal(authorized.status, 200, 'an exhausted IP must not block an account');
  assert.equal(Number(authorized.headers.get('ratelimit-limit')), 30, 'the signed-in allowance');
});
