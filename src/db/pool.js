'use strict';

const mysql = require('mysql2/promise');
const env = require('../config/env');
const logger = require('../utils/logger');
const requestContext = require('../utils/requestContext');
const { internalCodeFor } = require('../config/errorCodes');

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  // Bounded on purpose; see config/env.js for why unlimited was the wrong
  // failure mode.
  queueLimit: env.db.queueLimit,
  charset: 'utf8mb4_unicode_ci',
  dateStrings: ['DATE'],
  timezone: 'Z',
  // Everything goes through placeholders; this keeps mysql2 from client-side
  // interpolating values and gives us server-side prepared statements.
  namedPlaceholders: false,
  decimalNumbers: true,
});

/**
 * Pin every connection's session time zone to UTC.
 *
 * `timezone: 'Z'` above is only half a convention: it tells the driver that the
 * DATETIME values it reads and writes are UTC. It says nothing to MySQL, whose
 * `NOW()` and `CURRENT_TIMESTAMP` follow the *session* time zone - `SYSTEM` by
 * default, i.e. whatever the database host is set to. On a host that is not UTC
 * the two halves disagree, and the damage is not limited to display:
 *
 *   - Columns written server-side (`claimed_at = NOW()`, the 88
 *     `CURRENT_TIMESTAMP` defaults) land in local time, are read back as UTC,
 *     and show up shifted by the host's offset.
 *   - Worse, the comparisons shift too. `start_date <= NOW()` compares a UTC
 *     column against a local clock, so a scheduled offer goes live - and an
 *     active one expires - by that same offset early.
 *
 * Setting it per connection rather than globally keeps the fix with the code
 * that depends on it, and works on a managed database we do not administer.
 */
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

/**
 * A sanitized identifier for a statement (§13).
 *
 * §13 asks for a "query name / operation" and a table, and is explicit that the
 * full SQL should be avoided where it carries user data. Every statement in
 * this codebase is parameterised, so the SQL text holds no values - but it is
 * still long, multi-line and useless as a grouping key. `SELECT_OFFERS` is what
 * makes "which query got slow this afternoon" a question a dashboard can
 * answer; the statement itself is in the source, where it belongs.
 */
function queryLabel(sql) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  const verb = /^(SELECT|INSERT|UPDATE|DELETE|REPLACE)/i.exec(flat)?.[1]?.toUpperCase() ?? 'QUERY';
  // The first table named after FROM / INTO / UPDATE - the statement's subject.
  // Subqueries name others; the outermost one is the one worth grouping on.
  const table = /(?:FROM|INTO|UPDATE)\s+`?([a-z_][a-z0-9_]*)`?/i.exec(flat)?.[1] ?? 'unknown';
  return { operation: `${verb}_${table.toUpperCase()}`, table };
}

/**
 * Times one statement and reports it if it crosses the §13 threshold.
 *
 * A slow query is a WARN, not an error: it returned the right answer, just too
 * late. The request id comes from the ambient context (§4), so a slow query and
 * the slow request that contains it line up on one value without the caller
 * passing anything.
 *
 * A *failed* statement is not logged here. It propagates to the error handler,
 * which has the HTTP context and logs it once with its §8 code - logging it at
 * both layers would double every database incident in the dashboard.
 */
async function timed(sql, run) {
  const startedAt = process.hrtime.bigint();
  try {
    return await run();
  } finally {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    if (durationMs >= env.logging.slowQueryMs) {
      const { operation, table } = queryLabel(sql);
      logger.warn(
        {
          event: 'SLOW_QUERY',
          request_id: requestContext.currentId(),
          operation,
          table,
          duration_ms: durationMs,
          threshold_ms: env.logging.slowQueryMs,
          dependency: 'DATABASE',
          category: 'DATABASE',
        },
        `${operation} took ${durationMs}ms`,
      );
    }
  }
}

/** Run a query and return the rows. */
async function query(sql, params = []) {
  const [rows] = await timed(sql, () => pool.execute(sql, params));
  return rows;
}

/** Run a query and return the first row (or null). */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Run an INSERT/UPDATE/DELETE and return the raw result header. */
async function execute(sql, params = []) {
  const [result] = await timed(sql, () => pool.execute(sql, params));
  return result;
}

/**
 * Some statements (dynamic LIMIT/OFFSET, multi-row IN lists) are easier to build
 * with inline values that mysql2 escapes for us. `pool.query` still escapes
 * every `?` placeholder, it just does not use the binary protocol.
 */
async function rawQuery(sql, params = []) {
  const [rows] = await timed(sql, () => pool.query(sql, params));
  return rows;
}

let transactionCounter = 0;

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * §14 wants the three transitions - started, committed, rolled back - for the
 * operations that matter (claims, redemptions, payments, subscriptions,
 * bookings). They are recorded here rather than at each of those call sites,
 * which is both less code and more reliable: a transaction that nobody
 * remembered to instrument is exactly the one that will roll back at 2am.
 *
 * Start and commit are DEBUG - in production the interesting line is the
 * rollback, and a WARN for every successful commit would bury it. A rollback is
 * WARN because it is usually deliberate (a business rule refused the write) and
 * only sometimes a fault; the error itself, if there is one, is logged by the
 * error handler with its code.
 */
async function transaction(fn) {
  const connection = await pool.getConnection();
  const transactionId = `TXN-${(transactionCounter = (transactionCounter + 1) % 1000000)
    .toString()
    .padStart(6, '0')}`;
  const requestId = requestContext.currentId();
  const startedAt = process.hrtime.bigint();
  const elapsed = () => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

  try {
    await connection.beginTransaction();
    logger.debug(
      { event: 'TRANSACTION_STARTED', request_id: requestId, transaction_id: transactionId },
      `${transactionId} started`,
    );

    const result = await fn(connection);
    await connection.commit();

    logger.debug(
      {
        event: 'TRANSACTION_COMMITTED',
        request_id: requestId,
        transaction_id: transactionId,
        duration_ms: elapsed(),
      },
      `${transactionId} committed`,
    );
    return result;
  } catch (error) {
    await connection.rollback();
    logger.warn(
      {
        event: 'TRANSACTION_ROLLED_BACK',
        request_id: requestId,
        transaction_id: transactionId,
        duration_ms: elapsed(),
        error_code: internalCodeFor(error, 'DB_TRANSACTION_FAILED'),
        category: 'DATABASE',
        err_message: error.message,
      },
      `${transactionId} rolled back`,
    );
    throw error;
  } finally {
    connection.release();
  }
}

async function healthCheck() {
  const rows = await rawQuery('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

module.exports = { pool, query, queryOne, execute, rawQuery, transaction, healthCheck, queryLabel };
