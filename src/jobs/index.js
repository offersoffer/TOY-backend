'use strict';

const cron = require('node-cron');
const offerService = require('../modules/offers/offer.service');
const serviceService = require('../modules/services/service.service');
const serviceOfferService = require('../modules/services/serviceOffer.service');
const bannerService = require('../modules/banners/banner.service');
const notifications = require('../services/notifications');
const analyticsSnapshots = require('../services/analyticsSnapshots');
const authService = require('../modules/auth/auth.service');
const subscriptionService = require('../modules/subscriptions/subscription.service');
const featureOverrides = require('../modules/featureOverrides/featureOverride.service');
const claimService = require('../modules/claims/claim.service');
const failureLog = require('../services/failureLog');
const analyticsRetention = require('../services/analyticsRetention');
const featuredCampaigns = require('../services/visibility/campaign.service');
const visibilitySignals = require('../services/visibility/signals.service');
const visibilityAnalytics = require('../services/visibility/visibilityAnalytics.service');
const antiManipulation = require('../services/visibility/antiManipulation');
const visibilityEntitlements = require('../services/visibility/merchantEntitlement.service');
const idempotency = require('../middleware/idempotency');
const logger = require('../utils/logger');
const env = require('../config/env');
const { runJob } = require('./runner');

/**
 * Background maintenance. Everything here is idempotent, so running a job twice
 * (two app instances, a manual trigger) is harmless.
 */
const jobs = [
  {
    name: 'offer-lifecycle',
    // Every five minutes: scheduled -> active -> expired (§14).
    schedule: '*/5 * * * *',
    run: async () => {
      const { activated, expired } = await offerService.syncLifecycleStatuses();

      // Banners follow the same clock. Their customer-facing visibility is
      // computed live from the offer too, so a stale status can never leak an
      // expired offer onto the page - this just keeps the admin list honest.
      const banners = await bannerService.syncLifecycleStatuses();

      return {
        processed: activated + expired + banners.published + banners.expired,
        offers_activated: activated,
        offers_expired: expired,
        banners_published: banners.published,
        banners_expired: banners.expired,
      };
    },
  },
  {
    name: 'claim-expiry',
    // Claim/Redemption §12: a claim past its expiry becomes EXPIRED. The
    // redemption path never trusts this status - it compares timestamps on
    // every attempt - so a late sweep can only make a list look stale, never
    // let an expired code through.
    schedule: '*/5 * * * *',
    run: async () => ({ processed: await claimService.syncExpiredClaims() }),
  },
  {
    name: 'service-lifecycle',
    // Same clock as offer-lifecycle, for the parallel services domain (V4 §4, §14).
    schedule: '*/5 * * * *',
    run: async () => {
      const { activated, expired } = await serviceService.syncLifecycleStatuses();
      const offers = await serviceOfferService.syncLifecycleStatuses();
      return {
        processed: activated + expired + offers.activated + offers.expired,
        services_activated: activated,
        services_expired: expired,
        service_offers_activated: offers.activated,
        service_offers_expired: offers.expired,
      };
    },
  },
  {
    name: 'expiring-saved',
    // Once a day at 09:00: warn customers about saved offers ending soon, at
    // every configured threshold, for both products and services (§24-§26, §36).
    schedule: '0 9 * * *',
    run: async () => {
      const [offers, serviceOffers] = await Promise.all([
        notifications.notifyExpiringSaved('offer'),
        notifications.notifyExpiringSaved('service_offer'),
      ]);
      return {
        processed: offers + serviceOffers,
        offer_reminders: offers,
        service_offer_reminders: serviceOffers,
      };
    },
  },
  {
    name: 'push-receipts',
    // Every 15 minutes. A push ticket only says the relay accepted the
    // message; the receipt says what Google and Apple did with it, and is
    // where an uninstalled app finally surfaces as a dead token (Push §31).
    // Expo discards receipts after 24 hours, so this has to run often enough
    // to catch them - and is a no-op when there is nothing pending.
    schedule: '*/15 * * * *',
    run: async () => ({ processed: await notifications.syncPushReceipts() }),
  },
  {
    name: 'analytics-snapshots',
    // 00:20 daily: fold yesterday's events into the daily roll-ups the premium
    // dashboards read (V3 §29). Idempotent - it replaces the day it covers.
    schedule: '20 0 * * *',
    run: async () => {
      const { day, rows } = await analyticsSnapshots.rebuildDay();
      return { processed: rows, snapshot_day: day };
    },
  },
  {
    name: 'billing-lifecycle',
    // 02:00 daily. Closes grace windows on failed payments and applies
    // downgrades whose paid period has ended (§10, §11, §12). Merchant data is
    // never deleted - only the plan changes.
    schedule: '0 2 * * *',
    run: async () => ({ processed: await subscriptionService.sweepLapsed() }),
  },
  {
    name: 'override-expiry',
    // 02:10 daily (§11H). Bookkeeping rather than enforcement: an expired
    // override stops granting its feature the moment its date passes, because
    // the resolver filters on the date. This writes the EXPIRED audit event.
    schedule: '10 2 * * *',
    run: async () => ({ processed: await featureOverrides.expireLapsed() }),
  },
  {
    name: 'idempotency-sweep',
    // Every 5 minutes. Releases keys claimed by a request whose process died
    // before it could answer (§50) - without this, an interrupted payment
    // leaves its key stuck `in_progress` and the merchant unable to retry at
    // all, which is worse than the duplicate the key was preventing.
    schedule: '*/5 * * * *',
    run: async () => ({ processed: await idempotency.releaseStale(15) }),
  },

  // ---- Visibility & Promotion System ---------------------------------------
  {
    name: 'featured-campaign-schedule',
    // Every five minutes, on the same clock as the offer lifecycle. §8 asks
    // the system to activate and deactivate campaigns automatically; this is
    // that. It is bookkeeping rather than enforcement - every read path
    // re-derives the window from start_at/end_at (§24), so a late run can make
    // an admin list look stale but can never leave an ended campaign on the
    // home page.
    schedule: '*/5 * * * *',
    run: async () => {
      const { activated, completed } = await featuredCampaigns.sync();
      return { processed: activated + completed, campaigns_activated: activated, campaigns_completed: completed };
    },
  },
  {
    name: 'visibility-signals',
    // Hourly at :05. Rebuilds the precomputed listing quality and engagement
    // scores ranking reads (§33), after the anti-manipulation sweep has
    // flagged the events that should not count towards them (§25).
    //
    // The order inside the run matters: flag first, then score. Scoring first
    // would bake a day of fabricated engagement into the ranking and only
    // discount it an hour later.
    schedule: '5 * * * *',
    run: async () => {
      const flagged = await antiManipulation.flagExcessEvents();
      const suspended = await antiManipulation.suspendManipulatedListings();
      const lifted = await antiManipulation.lapseExpiredExclusions();
      const scored = await visibilitySignals.rebuild();
      return {
        processed: scored,
        events_flagged: flagged,
        listings_suspended: suspended,
        exclusions_lifted: lifted,
        listings_scored: scored,
      };
    },
  },
  {
    name: 'campaign-rollup',
    // 00:25 daily, just after the analytics snapshots. Folds yesterday's
    // visibility events into the per-campaign daily counters §17's card reads.
    // Yesterday *and* today: today's partial day is rebuilt so a merchant
    // checking a campaign mid-morning sees the morning, not zeros.
    schedule: '25 0 * * *',
    run: async () => {
      const yesterday = new Date(Date.now() - 86400000);
      const [past, current] = await Promise.all([
        visibilityAnalytics.rollupCampaignDay(yesterday),
        visibilityAnalytics.rollupCampaignDay(new Date()),
      ]);
      return { processed: past + current, rolled_yesterday: past, rolled_today: current };
    },
  },
  {
    name: 'visibility-entitlement-expiry',
    // 02:15 daily, alongside the feature-override sweep it mirrors. §23's
    // free-launch grants carry an expiry; this is what makes the admin list
    // agree with what the resolver has already stopped granting.
    schedule: '15 2 * * *',
    run: async () => ({ processed: await visibilityEntitlements.expireLapsed() }),
  },
  {
    name: 'prune',
    // Nightly cleanup of spent tokens and stale read notifications.
    schedule: '30 3 * * *',
    run: async () => {
      // The failure log joins the sweep (Business §56): it is diagnostic data
      // with a user id attached, so it is kept only as long as it is useful
      // for tracing a support ticket.
      const [tokens, notices, failures, keys] = await Promise.all([
        authService.pruneExpiredTokens(),
        notifications.pruneOld(),
        // §35: retention is configurable rather than a literal, because "how
        // long do we keep this?" is a policy question and policy changes.
        failureLog.pruneOlderThan(env.logging.retentionDays),
        // A settled key is only useful while a client might still retry with
        // it; two days is far beyond any timeout worth honouring.
        idempotency.pruneCompleted(48),
      ]);
      return {
        processed: tokens + notices + failures + keys,
        tokens_pruned: tokens,
        notifications_pruned: notices,
        failure_records_pruned: failures,
        idempotency_keys_pruned: keys,
        retention_days: env.logging.retentionDays,
      };
    },
  },
  {
    name: 'analytics-retention',
    /**
     * 04:15 daily, deliberately on its own and deliberately not inside
     * `prune`.
     *
     * Everything `prune` deletes is small and bounded. This deletes from the
     * three largest tables in the database, in batches, under a row budget, and
     * can take minutes rather than milliseconds. Running it alongside the light
     * sweeps would hide its duration inside theirs and put three delete storms
     * next to four small ones; a separate job gets its own timing, its own
     * failure, and its own line in the log.
     *
     * 04:15 also keeps it clear of `analytics-snapshots` at 00:20, which reads
     * yesterday's events to build the roll-ups. Rolling up first and deleting
     * later is the only order in which both are correct.
     */
    schedule: '15 4 * * *',
    run: async () => {
      const result = await analyticsRetention.run();
      return {
        processed: result.deleted,
        retention_days: result.retentionDays,
        partitions_added: result.partitions.added,
        partitions_dropped: result.partitions.dropped,
        per_table: result.perTable,
      };
    },
  },
];

function start() {
  for (const job of jobs) {
    // `runJob` owns the whole lifecycle including failure (§24), so nothing is
    // attached here - a `.catch` would only ever see an error it already logged.
    cron.schedule(job.schedule, () => void runJob(job));
  }
  logger.info(
    { event: 'JOBS_SCHEDULED', jobs: jobs.map((job) => job.name), count: jobs.length },
    `Scheduled ${jobs.length} background jobs`,
  );

  // Bring statuses up to date immediately rather than waiting for the first
  // tick. Run through the same wrapper so a failure at boot is as visible as
  // one at 03:00, and carries a job id somebody can search for.
  void runJob({
    name: 'initial-lifecycle-sync',
    run: async () => {
      const [offers, services, serviceOffers] = await Promise.all([
        offerService.syncLifecycleStatuses(),
        serviceService.syncLifecycleStatuses(),
        serviceOfferService.syncLifecycleStatuses(),
      ]);
      return {
        processed:
          offers.activated + offers.expired + services.activated + services.expired +
          serviceOffers.activated + serviceOffers.expired,
        offers_activated: offers.activated,
        offers_expired: offers.expired,
        services_activated: services.activated,
        services_expired: services.expired,
        service_offers_activated: serviceOffers.activated,
        service_offers_expired: serviceOffers.expired,
      };
    },
  });
}

module.exports = { start, jobs };
