'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

const express = require('express');
const bcrypt = require('bcryptjs');

/**
 * `DELETE /users/me`, as tests (Play "Data deletion" policy).
 *
 * Deleting an account is the one irreversible thing a customer can do to their
 * own data, and the three refusals below are all that stand between a mistyped
 * password - or a merchant's slip - and a shop nobody can manage. So this
 * exercises the real router rather than a reimplementation of its rules: the
 * database, the auth middleware and the image store are stubbed in the require
 * cache, and everything above them is the code that ships.
 *
 * There is no live MySQL here on purpose. The cascade behaviour this route
 * leans on is declared in schema.sql and enforced by InnoDB, not by JavaScript,
 * so a test with a fake database can only pin what JavaScript decides: who is
 * refused, and that exactly one DELETE reaches the database when nobody is.
 */

const resolve = (relative) => require.resolve(path.join(__dirname, '../../src', relative));

/** Replaces a module with a stub before the router under test requires it. */
function stub(relative, exports) {
  const id = resolve(relative);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// ---- the fake database ----------------------------------------------------

const PASSWORD = 'CorrectHorse1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

/** Rewritten per test to describe the account under the microscope. */
let scenario;
/** Every statement the route ran, so the test can assert what did *not* happen. */
let statements;

const matches = (sql, ...fragments) => fragments.every((f) => sql.includes(f));

const fakePool = {
  queryOne: async (sql, params) => {
    statements.push(sql);
    if (matches(sql, 'FROM users WHERE id')) return scenario.user;
    if (matches(sql, 'user_roles', 'r.name = ?')) {
      return params[1] === 'SUPER_ADMIN' && scenario.superAdmin ? { 1: 1 } : null;
    }
    return null;
  },
  query: async (sql) => {
    statements.push(sql);
    if (matches(sql, 'shop_members', "r.name = 'ADMIN'")) return scenario.managedShops;
    return [];
  },
  execute: async (sql) => {
    statements.push(sql);
    return { affectedRows: 1 };
  },
  rawQuery: async () => [],
  transaction: async (fn) => fn({}),
};

stub('db/pool', fakePool);

// The route is mounted behind `router.use(authenticate)`, which would demand a
// real JWT. The identity is not what these tests are about.
stub('middleware/auth', {
  authenticate: (req, _res, next) => {
    req.user = { id: 42 };
    next();
  },
  optionalAuth: (req, _res, next) => next(),
});

let avatarsRemoved;
stub('services/storage', {
  remove: async (url) => {
    avatarsRemoved.push(url);
  },
});

const auditWrites = [];
stub('utils/audit', {
  record: async (_req, entry) => {
    auditWrites.push(entry);
  },
});

const usersRouter = require('../../src/modules/users/user.routes');
const { errorHandler } = require('../../src/middleware/errorHandler');

// ---- the server under test ------------------------------------------------

const app = express();
app.use(express.json());
app.use('/users', usersRouter);
app.use(errorHandler);

let baseUrl;
const server = http.createServer(app);

test.before(
  () =>
    new Promise((done) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
      });
    }),
);

test.after(() => new Promise((done) => server.close(done)));

test.beforeEach(() => {
  statements = [];
  avatarsRemoved = [];
  auditWrites.length = 0;
  scenario = {
    user: {
      id: 42,
      name: 'Asha',
      email: 'asha@example.com',
      password_hash: PASSWORD_HASH,
      avatar_url: null,
    },
    superAdmin: false,
    managedShops: [],
  };
});

const deleteMe = async (body) => {
  const res = await fetch(`${baseUrl}/users/me`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** Did the route actually remove the row? */
const deleted = () => statements.some((sql) => matches(sql, 'DELETE FROM users'));

// ---- the refusals ---------------------------------------------------------

test('a wrong password deletes nothing', async () => {
  const res = await deleteMe({ password: 'NotThePassword1' });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /password is incorrect/i);
  assert.equal(deleted(), false);
});

test('an omitted password is a validation error, not a deletion', async () => {
  const res = await deleteMe({});

  assert.equal(res.status, 422);
  assert.equal(deleted(), false);
});

test('a Super Admin cannot delete themselves from the app', async () => {
  scenario.superAdmin = true;

  const res = await deleteMe({ password: PASSWORD });

  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /administrator/i);
  assert.equal(deleted(), false);
});

test("a shop's admin is refused, and told which shop is in the way", async () => {
  scenario.managedShops = [{ id: 4, name: 'Bloom Cafe' }];

  const res = await deleteMe({ password: PASSWORD });

  assert.equal(res.status, 409);
  // The shop is named because "you manage a shop" is useless to somebody who
  // manages three and has forgotten the third.
  assert.match(res.body.error.message, /Bloom Cafe/);
  assert.deepEqual(res.body.error.details.shops, [{ id: 4, name: 'Bloom Cafe' }]);
  assert.equal(deleted(), false);
});

test('managing several shops names all of them', async () => {
  scenario.managedShops = [
    { id: 4, name: 'Bloom Cafe' },
    { id: 9, name: 'Zara' },
  ];

  const res = await deleteMe({ password: PASSWORD });

  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /Bloom Cafe, Zara/);
  assert.equal(deleted(), false);
});

// ---- the deletion ---------------------------------------------------------

test('a customer with the right password is deleted', async () => {
  const res = await deleteMe({ password: PASSWORD });

  assert.equal(res.status, 204);
  assert.equal(deleted(), true);
});

test('the audit entry is written before the row disappears, and keeps the email', async () => {
  await deleteMe({ password: PASSWORD });

  // `audit_logs.user_id` is SET NULL on delete, so the address recorded here is
  // the only thing that can later answer "was this account deleted, and when".
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].action, 'ACCOUNT_DELETED');
  assert.equal(auditWrites[0].oldValue.email, 'asha@example.com');
});

test('an avatar is removed from storage', async () => {
  scenario.user.avatar_url = 'https://media.offersoffer.in/avatars/42.webp';

  const res = await deleteMe({ password: PASSWORD });

  assert.equal(res.status, 204);
  assert.deepEqual(avatarsRemoved, ['https://media.offersoffer.in/avatars/42.webp']);
});

test('a storage outage does not block the deletion', async () => {
  scenario.user.avatar_url = 'https://media.offersoffer.in/avatars/42.webp';
  const id = resolve('services/storage');
  require.cache[id].exports.remove = async () => {
    throw new Error('S3 unreachable');
  };

  // The user's right to be deleted does not depend on the image store being up;
  // the orphaned object is a janitorial problem, logged and left.
  const res = await deleteMe({ password: PASSWORD });

  assert.equal(res.status, 204);
  assert.equal(deleted(), true);
});
