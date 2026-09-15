'use strict';

/**
 * Production configuration guard (Database §14, §15).
 *
 * §15's scenario, verbatim: a production API is started, it expects
 * `offers_production`, it is actually pointed at `offers_staging`, and the
 * result must be BLOCK STARTUP. That failure is silent by nature - the app
 * connects, the queries work, the endpoints answer, and the only symptom is
 * that real customers are reading and writing test data (or worse, that a
 * staging deploy is writing to production). By the time anyone notices, both
 * databases are wrong.
 *
 * So production states its expectations up front and refuses to run if they
 * are not met. Every rule here fails closed: a missing setting is a refusal,
 * not a default, because the whole class of bug this prevents comes from a
 * value being quietly inherited from somewhere it should not have been.
 *
 * ## Why there is no override flag
 *
 * An escape hatch would be used - by the deploy that is running late, on the
 * evening it matters most. If one of these rules is genuinely wrong for a
 * deployment, the rule should change here, in review, rather than be bypassed
 * by an environment variable nobody remembers setting.
 *
 * Nothing in this module runs outside production. Development and staging are
 * unaffected, and the checks are pure - they read configuration and never
 * touch the database, so they run before a connection is ever attempted.
 */

/** Names that are never a production database, whatever else is configured. */
const NON_PRODUCTION_NAME = /(^|[_-])(dev|development|stag|staging|test|qa|sandbox|demo|local|scratch)([_-]|$)/i;

/**
 * Collects every problem rather than throwing on the first.
 *
 * An operator fixing a production deploy should learn about all four missing
 * values in one attempt, not discover them one restart at a time.
 */
function check(env) {
  const problems = [];
  const { db, seed } = env;

  // §15: the expected database name, stated explicitly by whoever deployed.
  // Required rather than optional - an unset expectation cannot be violated,
  // which would make the guard silently inert exactly where it is needed.
  const expected = process.env.PRODUCTION_DB_NAME;
  if (!expected) {
    problems.push(
      'PRODUCTION_DB_NAME is not set. Production must state the database it expects, ' +
        'so that connecting to any other one is an error rather than a surprise.',
    );
  } else if (expected !== db.database) {
    problems.push(
      `Connected database is "${db.database}" but PRODUCTION_DB_NAME expects "${expected}". ` +
        'Refusing to run against a database this deployment does not own.',
    );
  }

  // A second, independent line of defence: even if someone sets
  // PRODUCTION_DB_NAME=offers_staging to satisfy the check above, the name
  // itself still says what it is.
  if (NON_PRODUCTION_NAME.test(db.database)) {
    problems.push(
      `Database name "${db.database}" looks like a development, staging or test database. ` +
        'Production must not run against it.',
    );
  }

  // §14: "Verify approved production host". Optional, because a deployment may
  // legitimately reach its database through a name this process cannot predict
  // (a socket path, a service DNS name, a rotating proxy endpoint).
  const allowedHosts = (process.env.PRODUCTION_DB_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  if (allowedHosts.length && !allowedHosts.includes(db.host)) {
    problems.push(
      `Database host "${db.host}" is not in PRODUCTION_DB_HOSTS (${allowedHosts.join(', ')}).`,
    );
  }

  // §10: a dedicated least-privilege user, never root.
  if (['root', 'admin'].includes(String(db.user).toLowerCase())) {
    problems.push(
      `Database user "${db.user}" is an administrative account. Production must use a ` +
        'dedicated least-privilege application user (§10).',
    );
  }

  // §11: production credentials must exist and be their own.
  if (!db.password) {
    problems.push('DB_PASSWORD is empty. Production database access must be authenticated (§11).');
  }

  // §6, §29: demo data must never be seeded into production. Checked here as
  // well as in the seed script, because this is the copy of the configuration
  // the running application booted with.
  if (seed.demoData) {
    problems.push(
      'SEED_DEMO_DATA is enabled. Production must contain only real data and approved ' +
        'system seed data (§6, §29). Set SEED_DEMO_DATA=false.',
    );
  }

  problems.push(...storageProblems(env.storage));

  return problems;
}

/**
 * §19: production images live in shared object storage, never on the disk of
 * one server - a disk dies with its server, and a second server cannot see it.
 */
function storageProblems(storage) {
  if (!storage) return [];
  if (storage.driver !== 's3') {
    return [
      `STORAGE_DRIVER is "${storage.driver}". Production must store images in S3 ` +
        '(STORAGE_DRIVER=s3), not on the local disk of one server (§19).',
    ];
  }

  const problems = [];
  const { bucket, publicUrl } = storage.s3 ?? {};
  if (!bucket) {
    problems.push('S3_BUCKET is not set. Production needs a bucket to store images in.');
  } else if (NON_PRODUCTION_NAME.test(bucket)) {
    problems.push(
      `S3 bucket "${bucket}" looks like a development, staging or test bucket. ` +
        'Production uploads must not share storage with any other environment (§19).',
    );
  }
  if (!publicUrl) {
    problems.push(
      'STORAGE_PUBLIC_URL is not set. It is the CDN address images are served from, and ' +
        'every stored image URL is built from it.',
    );
  } else if (!/^https:\/\/[^/]+/.test(publicUrl) || /localhost|127\.0\.0\.1/.test(publicUrl)) {
    problems.push(
      `STORAGE_PUBLIC_URL "${publicUrl}" must be a public https:// address. Image URLs ` +
        'are saved with it, so a wrong value is written into every record.',
    );
  }
  return problems;
}

/**
 * Throws if the production configuration is unsafe. No-op outside production.
 *
 * The message is deliberately long and specific. It is read once, by someone
 * under time pressure, who needs to know which setting to change - not that
 * "configuration is invalid".
 */
function assertProductionConfig(env) {
  if (!env.isProduction) return;

  const problems = check(env);
  if (!problems.length) return;

  throw new Error(
    ['', 'APPLICATION STARTUP FAILED', '', 'Production configuration is invalid:', '']
      .concat(problems.map((problem) => `  - ${problem}`))
      .concat(['', 'Refusing to start (Database §14, §15).', ''])
      .join('\n'),
  );
}

module.exports = { assertProductionConfig, check, NON_PRODUCTION_NAME };
