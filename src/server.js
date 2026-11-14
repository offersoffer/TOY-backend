'use strict';

const app = require('./app');
const cache = require('./services/cache');
const responseCache = require('./middleware/responseCache');
const env = require('./config/env');
const logger = require('./utils/logger');
const { pool, healthCheck } = require('./db/pool');
const jobs = require('./jobs');
const mailer = require('./utils/mailer');

/**
 * Process lifecycle logging (§7).
 *
 * §7 reserves FATAL for "application or infrastructure failure" and names two
 * of the cases handled here explicitly: database unavailable, and application
 * cannot start. Those are the lines that should page someone, and keeping them
 * at their own level is what lets an alert rule (§29) distinguish "one request
 * failed" from "the process is not running".
 */

async function main() {
  const connected = await healthCheck().catch((error) => {
    logger.fatal(
      {
        event: 'STARTUP_DATABASE_UNREACHABLE',
        error_code: 'DB_CONNECTION_FAILED',
        category: 'DATABASE',
        dependency: 'DATABASE',
        // Host and port, never the password - §12 and §37 both forbid it, and
        // the credential is never the thing that is wrong at this point anyway.
        db_host: env.db.host,
        db_port: env.db.port,
        err_message: error.message,
      },
      'Could not reach MySQL. Check .env and run `npm run db:migrate`.',
    );
    return false;
  });
  if (!connected) process.exit(1);

  /*
   * Load the cache's namespace counters before serving.
   *
   * The counters live in the cache and are mirrored in this process. A restart
   * that did not read them back would reset the mirror to zero and start
   * serving keys that an earlier invalidation had already retired - stale
   * discovery payloads, with nothing to say why.
   *
   * Best-effort and never fatal: a cache that cannot be reached at boot leaves
   * the counters at zero, which is safe precisely because nothing has been
   * written under them either.
   */
  await cache.warmNamespaces([responseCache.NAMESPACE]);

  const server = app.listen(env.port, () => {
    logger.info(
      {
        event: 'SERVER_STARTED',
        port: env.port,
        api_prefix: env.apiPrefix,
        database: env.db.database,
        log_level: env.logging.level,
        cache: cache.status().driver,
      },
      `OffersOffer API listening on http://localhost:${env.port}${env.apiPrefix}`,
    );
  });

  /**
   * §7, "application cannot start". A failed bind emits `error` on the server
   * rather than rejecting `listen`, so without this listener Node treats it as
   * an unhandled 'error' event and dies printing a raw stack - the one moment
   * the operator most needs a legible reason.
   */
  server.on('error', (error) => {
    logger.fatal(
      {
        event: 'SERVER_LISTEN_FAILED',
        error_code: 'INTERNAL_SERVER_ERROR',
        category: 'SYSTEM',
        port: env.port,
        err_code: error.code,
        err_message: error.message,
      },
      error.code === 'EADDRINUSE'
        ? `Port ${env.port} is already in use`
        : `Could not listen on port ${env.port}`,
    );
    process.exit(1);
  });

  jobs.start();

  // Surfaces a broken SMTP password at boot rather than at the first reset.
  await mailer.verifyTransport();

  const shutdown = async (signal) => {
    logger.info({ event: 'SERVER_SHUTDOWN_STARTED', signal }, `${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      logger.info({ event: 'SERVER_SHUTDOWN_COMPLETE', signal }, 'Shutdown complete');
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => {
      logger.warn({ event: 'SERVER_SHUTDOWN_FORCED', signal }, 'Shutdown timed out; exiting');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * The failures that would otherwise leave no usable trace.
 *
 * Registered at module load rather than at the end of `main`, because the
 * window they most need to cover is startup itself - `main` awaits the database
 * and the mail transport before it would have reached a registration at the
 * bottom, and a crash inside that window is exactly the "application cannot
 * start" case §7 wants a FATAL line for.
 *
 * Node prints an unhandled rejection to stderr in a format nothing can parse
 * and, since v15, exits on it. Catching them here means the last thing in the
 * log is a structured record of why the process died, rather than a bare stack
 * in a stream the aggregator was never reading.
 */
function installCrashHandlers() {
  process.on('unhandledRejection', (reason) => {
    logger.fatal(
      {
        event: 'UNHANDLED_REJECTION',
        error_code: 'INTERNAL_SERVER_ERROR',
        category: 'SYSTEM',
        err_message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      'Unhandled promise rejection',
    );
  });

  process.on('uncaughtException', (error) => {
    logger.fatal(
      {
        event: 'UNCAUGHT_EXCEPTION',
        error_code: 'INTERNAL_SERVER_ERROR',
        category: 'SYSTEM',
        err_message: error.message,
        stack: error.stack,
      },
      'Uncaught exception; exiting',
    );
    // The process state is no longer trustworthy after this, so it is not kept
    // alive. Exiting lets the supervisor restart it clean.
    process.exit(1);
  });
}

installCrashHandlers();

main().catch((error) => {
  logger.fatal(
    {
      event: 'STARTUP_FAILED',
      error_code: 'INTERNAL_SERVER_ERROR',
      category: 'SYSTEM',
      err_message: error.message,
      stack: error.stack,
    },
    'Failed to start',
  );
  process.exit(1);
});
