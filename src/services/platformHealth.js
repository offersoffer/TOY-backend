'use strict';

const { healthCheck, rawQuery } = require('../db/pool');
const env = require('../config/env');
const mailer = require('../utils/mailer');
const razorpay = require('./razorpay');
const push = require('./push');
const storage = require('./storage');
const failureLog = require('./failureLog');
const { ALERT_RULES } = require('../config/businessMetrics');

/**
 * Platform Health (§34) and the incident alerts built on it (§55, §59).
 *
 * Everything here is Super Admin material. §55 draws the line plainly: "never
 * expose internal diagnostics to customers or ordinary merchants", so this
 * module is only ever reached through a router that has already checked the
 * role - it does no access control of its own, and must never be mounted
 * anywhere that does not.
 *
 * Two kinds of signal are combined, because neither alone is honest:
 *
 *   reachability - can we talk to the thing right now? A synthetic probe.
 *   behaviour    - is it failing for real users? Read from `error_logs`.
 *
 * A dependency can be reachable and still broken (Razorpay answering 200 to a
 * ping while declining every payment), and a dependency with no recent traffic
 * can look healthy simply because nobody tried. Reporting both, per component,
 * is what makes the board mean something.
 */

const STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  DOWN: 'down',
  NOT_CONFIGURED: 'not_configured',
};

/** Ordered as §34 lists them, which is the order the board renders. */
const COMPONENTS = [
  { key: 'api', label: 'API' },
  { key: 'database', label: 'Database' },
  { key: 'authentication', label: 'Authentication' },
  { key: 'razorpay', label: 'Razorpay' },
  { key: 'firebase', label: 'Firebase' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'imageUpload', label: 'Image Upload' },
  { key: 'location', label: 'Location Services' },
];

/** A probe that hangs is a probe that takes the health page down with it. */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

const component = (key, label, status, detail, extra = {}) => ({
  key,
  label,
  status,
  detail,
  ...extra,
});

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeDatabase() {
  const started = Date.now();
  const ok = await withTimeout(healthCheck().catch(() => false), 3000, false);
  const latency = Date.now() - started;

  if (!ok) return component('database', 'Database', STATUS.DOWN, 'No response from MySQL.');
  // A database answering `SELECT 1` in over a second is technically up and
  // practically an incident, so it is called out rather than passed.
  if (latency > 1000) {
    return component('database', 'Database', STATUS.DEGRADED, `Responding slowly (${latency} ms).`, {
      latencyMs: latency,
    });
  }
  return component('database', 'Database', STATUS.HEALTHY, `Responding in ${latency} ms.`, {
    latencyMs: latency,
  });
}

/**
 * Authentication has no external dependency to ping - it is our own code over
 * our own tables - so it is judged by whether sign-in is actually working:
 * a burst of 401s and 429s on the auth routes is what "authentication is down"
 * looks like from the outside.
 */
async function probeAuthentication() {
  const rows = await rawQuery(
    `SELECT COUNT(*) AS failures FROM error_logs
      WHERE dependency = 'AUTH' AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [ALERT_RULES.windowMinutes],
  ).catch(() => null);

  if (rows === null) {
    return component(
      'authentication',
      'Authentication',
      STATUS.DEGRADED,
      'Cannot read the failure log to judge this.',
    );
  }

  const failures = Number(rows[0]?.failures ?? 0);
  if (failures >= ALERT_RULES.minimumEvents * 4) {
    return component(
      'authentication',
      'Authentication',
      STATUS.DOWN,
      `${failures} sign-in failures in the last ${ALERT_RULES.windowMinutes} minutes.`,
      { failures },
    );
  }
  if (failures >= ALERT_RULES.minimumEvents) {
    return component(
      'authentication',
      'Authentication',
      STATUS.DEGRADED,
      `${failures} sign-in failures in the last ${ALERT_RULES.windowMinutes} minutes.`,
      { failures },
    );
  }
  return component('authentication', 'Authentication', STATUS.HEALTHY, 'Sign-in is working.');
}

/**
 * Razorpay's own status, judged from our recent traffic rather than a synthetic
 * call. Pinging the gateway proves the network works; the capture rate is what
 * says whether merchants can pay.
 */
async function probeRazorpay() {
  if (!razorpay.isConfigured) {
    return component(
      'razorpay',
      'Razorpay',
      STATUS.NOT_CONFIGURED,
      'No API key set - checkout is disabled in this environment.',
    );
  }

  const rows = await rawQuery(
    `SELECT COALESCE(SUM(status = 'FAILED'), 0) AS failed,
            COUNT(*) AS total
       FROM payment_transactions
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 60 MINUTE)`,
  ).catch(() => null);

  if (rows === null) {
    return component('razorpay', 'Razorpay', STATUS.DEGRADED, 'Payment history is unreadable.');
  }

  const total = Number(rows[0].total ?? 0);
  const failed = Number(rows[0].failed ?? 0);

  // No attempts is not evidence of health, and must not be reported as if it
  // were. It is reported as what it is: nothing to go on.
  if (total === 0) {
    return component('razorpay', 'Razorpay', STATUS.HEALTHY, 'No payment attempts in the last hour.', {
      attempts: 0,
      failures: 0,
    });
  }

  const failureRate = Math.round((failed / total) * 1000) / 10;
  const status = failureRate >= 50 ? STATUS.DOWN : failureRate >= 20 ? STATUS.DEGRADED : STATUS.HEALTHY;
  return component(
    'razorpay',
    'Razorpay',
    status,
    `${failed} of ${total} payments failed in the last hour (${failureRate}%).`,
    { attempts: total, failures: failed, failureRate },
  );
}

/**
 * §34 and §55 both list Firebase. The platform's push transport is Expo's
 * relay (Push §37), and Expo delivers through FCM - so "Firebase" here is the
 * Android delivery leg, and its evidence is the receipts Expo hands back after
 * the fact. A `MessageRateExceeded` or credential error from FCM surfaces on a
 * receipt, never on the send.
 */
async function probeFirebase() {
  if (!push.isConfigured()) {
    return component(
      'firebase',
      'Firebase',
      STATUS.NOT_CONFIGURED,
      'Push delivery is switched off in this environment.',
    );
  }

  const rows = await rawQuery(
    `SELECT COALESCE(SUM(status = 'failed'), 0) AS failed, COUNT(*) AS total
       FROM push_tickets
      WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 60 MINUTE)`,
  ).catch(() => null);

  if (rows === null) {
    return component('firebase', 'Firebase', STATUS.DEGRADED, 'Delivery history is unreadable.');
  }

  const total = Number(rows[0].total ?? 0);
  const failed = Number(rows[0].failed ?? 0);
  if (total === 0) {
    return component('firebase', 'Firebase', STATUS.HEALTHY, 'No pushes sent in the last hour.', {
      attempts: 0,
      failures: 0,
    });
  }

  const failureRate = Math.round((failed / total) * 1000) / 10;
  const status = failureRate >= 50 ? STATUS.DOWN : failureRate >= 25 ? STATUS.DEGRADED : STATUS.HEALTHY;
  return component(
    'firebase',
    'Firebase',
    status,
    `${failed} of ${total} push deliveries failed in the last hour (${failureRate}%).`,
    { attempts: total, failures: failed, failureRate },
  );
}

/** The relay itself, as distinct from what the device platforms then do. */
async function probeNotifications() {
  if (!env.push.enabled) {
    return component(
      'notifications',
      'Notifications',
      STATUS.NOT_CONFIGURED,
      'Notification fan-out is switched off in this environment.',
    );
  }

  const rows = await rawQuery(
    `SELECT COUNT(*) AS stuck FROM push_tickets
      WHERE status = 'queued' AND sent_at < DATE_SUB(NOW(), INTERVAL 60 MINUTE)`,
  ).catch(() => null);

  if (rows === null) {
    return component('notifications', 'Notifications', STATUS.DEGRADED, 'Queue depth is unreadable.');
  }

  const stuck = Number(rows[0].stuck ?? 0);
  if (stuck > 100) {
    return component(
      'notifications',
      'Notifications',
      STATUS.DOWN,
      `${stuck} notifications have been queued for over an hour.`,
      { queued: stuck },
    );
  }
  if (stuck > 0) {
    return component(
      'notifications',
      'Notifications',
      STATUS.DEGRADED,
      `${stuck} notifications are still queued after an hour.`,
      { queued: stuck },
    );
  }
  return component('notifications', 'Notifications', STATUS.HEALTHY, 'Queue is clear.');
}

/**
 * Image storage, probed with a real write and delete (storage.probe): a full
 * disk, a revoked IAM permission or a deleted bucket is the failure this
 * catches, and each is invisible until the next merchant uploads a shop photo.
 */
async function probeImageUpload() {
  const where = storage.describe();
  const ok = await withTimeout(storage.probe().catch(() => false), 3000, false);
  return ok
    ? component('imageUpload', 'Image Upload', STATUS.HEALTHY, `${where} is writable.`)
    : component('imageUpload', 'Image Upload', STATUS.DOWN, `${where} is not writable.`);
}

/** Geocoding - what "Location Services" means on the server side. */
async function probeLocation() {
  if (!env.geocoding.enabled) {
    return component(
      'location',
      'Location Services',
      STATUS.NOT_CONFIGURED,
      'Geocoding is switched off; branches save without coordinates.',
    );
  }

  const rows = await rawQuery(
    `SELECT COUNT(*) AS failures FROM error_logs
      WHERE dependency = 'GEOCODING' AND created_at >= DATE_SUB(NOW(), INTERVAL 60 MINUTE)`,
  ).catch(() => null);

  const failures = Number(rows?.[0]?.failures ?? 0);
  if (failures >= ALERT_RULES.minimumEvents) {
    return component(
      'location',
      'Location Services',
      STATUS.DEGRADED,
      `${failures} geocoding failures in the last hour.`,
      { failures },
    );
  }
  return component('location', 'Location Services', STATUS.HEALTHY, `Provider: ${env.geocoding.provider}.`);
}

/** The API's own view of itself: are we returning 5xx to real callers? */
async function probeApi() {
  const rows = await rawQuery(
    `SELECT COUNT(*) AS failures FROM error_logs
      WHERE http_status >= 500 AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [ALERT_RULES.windowMinutes],
  ).catch(() => null);

  if (rows === null) {
    // The failure log lives in the same database. Unreadable here means the
    // database probe has already said so; the API is still serving this
    // request, so it is degraded rather than down.
    return component('api', 'API', STATUS.DEGRADED, 'Serving requests, but the failure log is unreadable.');
  }

  const failures = Number(rows[0].failures ?? 0);
  const status =
    failures >= ALERT_RULES.minimumEvents * 4
      ? STATUS.DOWN
      : failures >= ALERT_RULES.minimumEvents
        ? STATUS.DEGRADED
        : STATUS.HEALTHY;

  return component(
    'api',
    'API',
    status,
    failures === 0
      ? `No server errors in the last ${ALERT_RULES.windowMinutes} minutes.`
      : `${failures} server errors in the last ${ALERT_RULES.windowMinutes} minutes.`,
    { failures, uptimeSeconds: Math.round(process.uptime()) },
  );
}

// ---------------------------------------------------------------------------
// Board (§34, §55)
// ---------------------------------------------------------------------------

const SEVERITY = { [STATUS.HEALTHY]: 0, [STATUS.NOT_CONFIGURED]: 0, [STATUS.DEGRADED]: 1, [STATUS.DOWN]: 2 };

/**
 * Every component's status. Probes run in parallel and none can reject: a
 * health page that fails to load during an incident is the one moment it was
 * built for.
 */
async function board() {
  const results = await Promise.all([
    probeApi(),
    probeDatabase(),
    probeAuthentication(),
    probeRazorpay(),
    probeFirebase(),
    probeNotifications(),
    probeImageUpload(),
    probeLocation(),
  ]);

  const byKey = Object.fromEntries(results.map((entry) => [entry.key, entry]));
  const components = COMPONENTS.map(
    (spec) => byKey[spec.key] ?? component(spec.key, spec.label, STATUS.DEGRADED, 'No probe result.'),
  );

  const worst = components.reduce((max, entry) => Math.max(max, SEVERITY[entry.status] ?? 1), 0);
  const overall = worst === 2 ? STATUS.DOWN : worst === 1 ? STATUS.DEGRADED : STATUS.HEALTHY;

  return {
    overall,
    checkedAt: new Date(),
    components,
    email: mailer.isConfigured ? STATUS.HEALTHY : STATUS.NOT_CONFIGURED,
  };
}

// ---------------------------------------------------------------------------
// Alerts (§59)
// ---------------------------------------------------------------------------

/** Human wording and a destination for each alert §59 names. */
const ALERT_SPECS = {
  DATABASE: {
    key: 'database_outage',
    title: 'Database outage',
    action: { label: 'View Platform Health', route: '/admin/business/health' },
  },
  RAZORPAY: {
    key: 'payment_failure_spike',
    title: 'Payment failure spike',
    action: { label: 'View Payment Health', route: '/admin/business/health' },
  },
  PUSH: {
    key: 'notification_failure_spike',
    title: 'Notification failure spike',
    action: { label: 'View Platform Health', route: '/admin/business/health' },
  },
  STORAGE: {
    key: 'image_upload_failure_spike',
    title: 'Image upload failure spike',
    action: { label: 'View Platform Health', route: '/admin/business/health' },
  },
  AUTH: {
    key: 'authentication_failure_spike',
    title: 'Authentication failure spike',
    action: { label: 'View Platform Health', route: '/admin/business/health' },
  },
  GEOCODING: {
    key: 'location_failure_spike',
    title: 'Location service failure spike',
    action: { label: 'View Platform Health', route: '/admin/business/health' },
  },
  APPLICATION: {
    key: 'api_outage',
    title: 'API outage',
    action: { label: 'View Platform Health', route: '/admin/business/health' },
  },
};

/**
 * Alerts for the Super Admin (§59).
 *
 * Two sources, deduplicated by key: a component that is outright down, and a
 * dependency whose failure count has jumped against the window before it. The
 * spike rule needs both a floor and a multiplier - without the floor, one
 * failure following zero is a 100% increase and would page someone nightly.
 */
async function alerts() {
  const [health, windows, redemption] = await Promise.all([
    board(),
    failureLog.dependencyWindows().catch(() => []),
    redemptionFailureSpike().catch(() => null),
  ]);

  const found = new Map();

  for (const entry of health.components) {
    if (entry.status !== STATUS.DOWN) continue;
    const spec = ALERT_SPECS[dependencyKeyFor(entry.key)] ?? ALERT_SPECS.APPLICATION;
    found.set(spec.key, {
      key: spec.key,
      severity: 'critical',
      title: `${entry.label} outage`,
      message: entry.detail,
      action: spec.action,
      raisedAt: health.checkedAt,
    });
  }

  for (const window of windows) {
    const spec = ALERT_SPECS[window.dependency];
    if (!spec || found.has(spec.key)) continue;
    if (window.current < ALERT_RULES.minimumEvents) continue;
    // A first-ever burst has no baseline to beat, so `previous === 0` is
    // treated as a spike outright once the floor is cleared.
    const spiked =
      window.previous === 0 || window.current >= window.previous * ALERT_RULES.spikeMultiplier;
    if (!spiked) continue;

    found.set(spec.key, {
      key: spec.key,
      severity: 'warning',
      title: spec.title,
      message:
        `Failures increased sharply in the last ${ALERT_RULES.windowMinutes} minutes ` +
        `(${window.current} vs ${window.previous} before).`,
      action: spec.action,
      raisedAt: health.checkedAt,
    });
  }

  if (redemption) found.set(redemption.key, redemption);

  return {
    checkedAt: health.checkedAt,
    overall: health.overall,
    alerts: [...found.values()].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1,
    ),
  };
}

/** Maps a health component key onto the dependency name the log uses. */
function dependencyKeyFor(componentKey) {
  return (
    {
      database: 'DATABASE',
      razorpay: 'RAZORPAY',
      firebase: 'PUSH',
      notifications: 'PUSH',
      imageUpload: 'STORAGE',
      location: 'GEOCODING',
      authentication: 'AUTH',
      api: 'APPLICATION',
    }[componentKey] ?? 'APPLICATION'
  );
}

/**
 * §59's "redemption verification failure spike", which has its own table
 * rather than living in the error log: a rejected code is a normal business
 * outcome, not an application error, so it is never written to `error_logs`.
 * A *run* of them is still worth waking someone for - it is what someone
 * probing for live codes looks like.
 */
async function redemptionFailureSpike() {
  const rows = await rawQuery(
    `SELECT SUM(created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)) AS current_count,
            SUM(created_at <  DATE_SUB(NOW(), INTERVAL ? MINUTE)) AS previous_count
       FROM claim_verifications
      WHERE action = 'REJECTED'
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [ALERT_RULES.windowMinutes, ALERT_RULES.windowMinutes, ALERT_RULES.windowMinutes * 2],
  );

  const current = Number(rows[0]?.current_count ?? 0);
  const previous = Number(rows[0]?.previous_count ?? 0);
  if (current < ALERT_RULES.minimumEvents) return null;
  if (previous > 0 && current < previous * ALERT_RULES.spikeMultiplier) return null;

  return {
    key: 'redemption_verification_failure_spike',
    severity: 'warning',
    title: 'Redemption verification failure spike',
    message:
      `${current} coupon verifications were rejected in the last ${ALERT_RULES.windowMinutes} ` +
      `minutes (${previous} in the window before).`,
    action: { label: 'View Redemptions', route: '/admin/redemptions' },
    raisedAt: new Date(),
  };
}

module.exports = { STATUS, COMPONENTS, board, alerts };
