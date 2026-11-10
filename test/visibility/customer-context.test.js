'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';

/**
 * `customerContext`'s queries have to be legal on a default-configured MySQL.
 *
 * The recent-terms query used to be `SELECT DISTINCT term ... ORDER BY id
 * DESC`, which MySQL rejects outright under ONLY_FULL_GROUP_BY - the default
 * since 8.0 - because `id` is not in the select list. It only ran at all on a
 * server with a laxer sql_mode, so `GET /api/visibility/feed` returned 500 for
 * every signed-in customer with search history on a stock install.
 *
 * These assert on the generated SQL: CI has no MySQL, so the database is
 * stubbed the same way `test/onboarding/submit-gate.test.js` does it.
 */

const SRC = path.join(__dirname, '../../src');
const resolve = (rel) => require.resolve(path.join(SRC, rel));
const stub = (rel, exports) => {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

let issued;
let searchRows;

stub('db/pool', {
  query: async (sql) => {
    issued.push(sql);
    if (sql.includes('search_history')) return searchRows;
    if (sql.includes('minimum_discount_percent')) return [{ minimum_discount_percent: null }];
    return [];
  },
  queryOne: async () => null,
  execute: async () => ({ affectedRows: 1 }),
});

const service = require(path.join(SRC, 'services/visibility/visibility.service'));

const CUSTOMER = { id: 42 };

test.beforeEach(() => {
  issued = [];
  searchRows = [{ term: 'School Shoes' }, { term: 'silk saree' }];
});

const searchSql = () => {
  const sql = issued.find((s) => s.includes('search_history'));
  assert.ok(sql, 'customerContext did not query search_history');
  return sql.replace(/\s+/g, ' ').trim();
};

/**
 * MySQL's actual rule, rather than a match on today's exact string: with
 * DISTINCT, every ORDER BY column must appear in the select list. Written as a
 * check over all of customerContext's SQL so a future query cannot
 * reintroduce the same shape somewhere else in the function.
 */
const distinctOrderByViolation = (raw) => {
  const sql = raw.replace(/\s+/g, ' ');
  if (!/SELECT\s+DISTINCT/i.test(sql)) return null;

  const selected = sql.slice(
    sql.search(/SELECT\s+DISTINCT/i) + sql.match(/SELECT\s+DISTINCT/i)[0].length,
    sql.search(/\sFROM\s/i),
  );
  const selectedNames = selected
    .split(',')
    .map((part) => part.trim().split(/\s+AS\s+|\s+/i).pop().replace(/`/g, '').toLowerCase());

  const orderBy = /ORDER\s+BY\s+(.*?)(?:\s+LIMIT\b|$)/i.exec(sql);
  if (!orderBy) return null;

  return (
    orderBy[1]
      .split(',')
      .map((part) => part.trim().replace(/\s+(ASC|DESC)$/i, '').replace(/`/g, '').toLowerCase())
      .find((col) => /^[a-z_][a-z0-9_.]*$/.test(col) && !selectedNames.includes(col.split('.').pop())) ?? null
  );
};

test('no DISTINCT query orders by a column it does not select', async () => {
  await service.customerContext(CUSTOMER);

  assert.ok(issued.length > 0, 'no queries were issued');
  for (const sql of issued) {
    assert.equal(
      distinctOrderByViolation(sql),
      null,
      `incompatible with DISTINCT under ONLY_FULL_GROUP_BY: ${sql.replace(/\s+/g, ' ').trim()}`,
    );
  }
});

test('recent terms are de-duplicated by GROUP BY, not DISTINCT', async () => {
  await service.customerContext(CUSTOMER);
  const sql = searchSql();

  assert.match(sql, /GROUP BY term/i);
  assert.doesNotMatch(sql, /SELECT\s+DISTINCT/i);
});

test('recent terms keep their most-recent-first ordering', async () => {
  await service.customerContext(CUSTOMER);
  const sql = searchSql();

  // The ordering column has to be aggregated to survive the GROUP BY, and it
  // still has to be descending: §4's recency signal is meaningless reversed.
  assert.match(sql, /ORDER BY MAX\(\s*id\s*\) DESC/i);
  assert.match(sql, /LIMIT 10/i);
});

test('recent terms are lowercased and emptied rows dropped, in query order', async () => {
  searchRows = [{ term: 'School Shoes' }, { term: '' }, { term: null }, { term: 'Silk Saree' }];

  const context = await service.customerContext(CUSTOMER);

  assert.deepEqual(context.recentTerms, ['school shoes', 'silk saree']);
});

test('a guest gets an empty context and touches the database not at all', async () => {
  const context = await service.customerContext(null);

  assert.deepEqual(context.recentTerms, []);
  assert.equal(context.preferredCategories.size, 0);
  assert.equal(context.followedShops.size, 0);
  assert.equal(issued.length, 0);
});
