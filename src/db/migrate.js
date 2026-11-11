'use strict';

/**
 * Applies `schema.sql` to the configured database, creating the database first
 * if it does not exist.
 *
 *   node src/db/migrate.js           # create/upgrade
 *   node src/db/migrate.js --fresh   # drop the database first
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const env = require('../config/env');
const featureCatalogue = require('../config/featureCatalogue');
const visibility = require('../config/visibility');
const permissions = require('../config/permissions');

const FRESH = process.argv.includes('--fresh');

/** Split a .sql file into statements, ignoring `--` comments. */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so columns
 * added to schema.sql after the first deploy need an explicit ALTER. Each patch
 * is checked against information_schema first, making this safe to re-run.
 */
const COLUMN_PATCHES = [
  {
    table: 'roles',
    column: 'scope',
    sql: "ALTER TABLE roles ADD COLUMN scope ENUM('global','shop') NOT NULL DEFAULT 'shop' AFTER description",
    // Existing installs pre-date scoping; keep the built-ins behaving correctly.
    after: [
      "UPDATE roles SET scope = 'global' WHERE name IN ('SUPER_ADMIN', 'CUSTOMER')",
      "UPDATE roles SET scope = 'shop' WHERE name = 'ADMIN'",
    ],
  },

  // ---- V3 -----------------------------------------------------------------
  // Location on the raw offer event, for the location intelligence dashboard.
  {
    table: 'offer_views',
    column: 'city',
    sql: 'ALTER TABLE offer_views ADD COLUMN city VARCHAR(120) DEFAULT NULL AFTER ip_address',
    after: [
      'ALTER TABLE offer_views ADD COLUMN latitude DECIMAL(10,7) DEFAULT NULL AFTER city',
      'ALTER TABLE offer_views ADD COLUMN longitude DECIMAL(10,7) DEFAULT NULL AFTER latitude',
      'ALTER TABLE offer_views ADD KEY idx_ov_city (city)',
      'ALTER TABLE offer_views ADD KEY idx_ov_offer_type_time (offer_id, event_type, created_at)',
    ],
  },
  {
    table: 'banners',
    column: 'campaign_id',
    sql: 'ALTER TABLE banners ADD COLUMN campaign_id BIGINT UNSIGNED DEFAULT NULL AFTER click_count',
  },

  // ---- V2 personalization ---------------------------------------------------
  // Lives on users (like pref_city/pref_latitude/pref_longitude above) so it
  // rides along on /auth/me, login and register for free — the mobile app's
  // boot-time onboarding check needs it with no extra request.
  {
    table: 'users',
    column: 'preferences_completed',
    sql: 'ALTER TABLE users ADD COLUMN preferences_completed TINYINT(1) NOT NULL DEFAULT 0 AFTER pref_longitude',
    after: [
      'ALTER TABLE users ADD COLUMN minimum_discount_percent TINYINT UNSIGNED DEFAULT NULL AFTER preferences_completed',
    ],
  },

  // ---- V4 (Services) -------------------------------------------------------
  {
    table: 'analytics_events',
    column: 'service_id',
    sql: 'ALTER TABLE analytics_events ADD COLUMN service_id BIGINT UNSIGNED DEFAULT NULL AFTER offer_id',
    after: ['ALTER TABLE analytics_events ADD KEY idx_ae_service (service_id, created_at)'],
  },
  {
    table: 'notification_preferences',
    column: 'saved_service_offer_expiring',
    sql: "ALTER TABLE notification_preferences ADD COLUMN saved_service_offer_expiring TINYINT(1) NOT NULL DEFAULT 1 AFTER favorite_expiring",
  },

  // ---- Push notifications --------------------------------------------------
  // `push_devices` and `push_tickets` are new tables, so schema.sql creates
  // them on any install; only the columns bolted onto the two pre-existing
  // notification tables need patching here.
  {
    table: 'notification_preferences',
    column: 'push_enabled',
    sql: 'ALTER TABLE notification_preferences ADD COLUMN push_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER offer_updates',
    after: [
      'ALTER TABLE notification_preferences ADD COLUMN claim_updates TINYINT(1) NOT NULL DEFAULT 1 AFTER push_enabled',
      'ALTER TABLE notification_preferences ADD COLUMN redemption_updates TINYINT(1) NOT NULL DEFAULT 1 AFTER claim_updates',
      'ALTER TABLE notification_preferences ADD COLUMN booking_updates TINYINT(1) NOT NULL DEFAULT 1 AFTER redemption_updates',
    ],
  },
  {
    table: 'notifications',
    column: 'deep_link',
    sql: 'ALTER TABLE notifications ADD COLUMN deep_link VARCHAR(255) DEFAULT NULL AFTER entity_id',
    after: [
      `ALTER TABLE notifications ADD COLUMN push_state
         ENUM('none','queued','sent','delivered','failed','cancelled','expired')
         NOT NULL DEFAULT 'none' AFTER deep_link`,
      'ALTER TABLE notifications ADD COLUMN opened_at DATETIME DEFAULT NULL AFTER is_read',
    ],
  },

  // ---- V3 Razorpay payments -----------------------------------------------
  // Gateway bookkeeping on the existing one-row-per-shop subscription.
  {
    table: 'shop_subscriptions',
    column: 'gateway_customer_id',
    sql: 'ALTER TABLE shop_subscriptions ADD COLUMN gateway VARCHAR(40) DEFAULT NULL AFTER provider_ref',
    after: [
      'ALTER TABLE shop_subscriptions ADD COLUMN gateway_customer_id VARCHAR(120) DEFAULT NULL AFTER gateway',
      'ALTER TABLE shop_subscriptions ADD COLUMN gateway_subscription_id VARCHAR(120) DEFAULT NULL AFTER gateway_customer_id',
      'ALTER TABLE shop_subscriptions ADD COLUMN gateway_plan_id VARCHAR(120) DEFAULT NULL AFTER gateway_subscription_id',
      'ALTER TABLE shop_subscriptions ADD COLUMN current_period_start DATETIME DEFAULT NULL AFTER gateway_plan_id',
      'ALTER TABLE shop_subscriptions ADD COLUMN current_period_end DATETIME DEFAULT NULL AFTER current_period_start',
      'ALTER TABLE shop_subscriptions ADD COLUMN cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0 AFTER current_period_end',
      "ALTER TABLE shop_subscriptions ADD COLUMN pending_plan ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL AFTER cancel_at_period_end",
      'ALTER TABLE shop_subscriptions ADD COLUMN grace_until DATETIME DEFAULT NULL AFTER cancel_at_period_end',
      'ALTER TABLE shop_subscriptions ADD COLUMN autopay_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER grace_until',
      'ALTER TABLE shop_subscriptions ADD COLUMN payment_method VARCHAR(40) DEFAULT NULL AFTER autopay_enabled',
      'ALTER TABLE shop_subscriptions ADD COLUMN last_payment_at DATETIME DEFAULT NULL AFTER payment_method',
      'ALTER TABLE shop_subscriptions ADD COLUMN last_failure_reason VARCHAR(255) DEFAULT NULL AFTER last_payment_at',
      'ALTER TABLE shop_subscriptions ADD KEY idx_subscription_gateway (gateway_subscription_id)',
    ],
  },

  {
    table: 'shop_subscriptions',
    column: 'checkout_plan',
    sql: "ALTER TABLE shop_subscriptions ADD COLUMN checkout_plan ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL AFTER pending_plan",
  },

  // ---- V3 shop location & profile -----------------------------------------
  // §24's richer location model, plus the confirmation flag §8 requires before
  // a shop may be published. Existing branches keep their coordinates; what
  // they gain is a record of where those coordinates came from.
  {
    table: 'shop_branches',
    column: 'location_source',
    sql: `ALTER TABLE shop_branches ADD COLUMN location_source
            ENUM('ADDRESS_SEARCH','MAP_PIN','CURRENT_LOCATION','MANUAL')
            DEFAULT NULL AFTER longitude`,
    after: [
      'ALTER TABLE shop_branches ADD COLUMN address_line_2 VARCHAR(255) DEFAULT NULL AFTER address',
      'ALTER TABLE shop_branches ADD COLUMN area VARCHAR(160) DEFAULT NULL AFTER address_line_2',
      'ALTER TABLE shop_branches ADD COLUMN location_accuracy DECIMAL(8,2) DEFAULT NULL AFTER location_source',
      'ALTER TABLE shop_branches ADD COLUMN location_confirmed_at DATETIME DEFAULT NULL AFTER location_accuracy',
      'ALTER TABLE shop_branches ADD COLUMN place_id VARCHAR(120) DEFAULT NULL AFTER location_confirmed_at',
      'ALTER TABLE shop_branches ADD COLUMN opening_hours JSON DEFAULT NULL AFTER place_id',
      // Branches that predate this were geocoded from their address on save,
      // which is exactly what ADDRESS_SEARCH means. Saying so keeps them out
      // of "this shop has never confirmed a location" without pretending a
      // merchant confirmed a pin they were never shown.
      "UPDATE shop_branches SET location_source = 'ADDRESS_SEARCH' WHERE latitude IS NOT NULL AND location_source IS NULL",
    ],
  },
  {
    table: 'shops',
    column: 'opening_hours',
    sql: 'ALTER TABLE shops ADD COLUMN opening_hours JSON DEFAULT NULL AFTER social_links',
  },

  // ---- Persistent login: refresh_tokens becomes the device-session table ----
  {
    table: 'refresh_tokens',
    column: 'family_id',
    sql: 'ALTER TABLE refresh_tokens ADD COLUMN family_id CHAR(32) DEFAULT NULL AFTER token_hash',
    after: [
      `ALTER TABLE refresh_tokens ADD COLUMN revoked_reason
         ENUM('rotated','logout','logout_others','reuse_detected','password_changed','revoked','account_disabled')
         DEFAULT NULL AFTER revoked_at`,
      `ALTER TABLE refresh_tokens ADD COLUMN device_type
         ENUM('mobile','tablet','desktop','web','unknown') NOT NULL DEFAULT 'unknown' AFTER revoked_reason`,
      'ALTER TABLE refresh_tokens ADD COLUMN device_name VARCHAR(120) DEFAULT NULL AFTER device_type',
      'ALTER TABLE refresh_tokens ADD COLUMN platform VARCHAR(40) DEFAULT NULL AFTER device_name',
      'ALTER TABLE refresh_tokens ADD COLUMN last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER ip_address',
      'ALTER TABLE refresh_tokens ADD KEY idx_refresh_family (family_id)',
      // Pre-existing tokens have no family; give each its own so rotation
      // and "log out this device" behave for sessions that predate this.
      'UPDATE refresh_tokens SET family_id = REPLACE(UUID(), \'-\', \'\') WHERE family_id IS NULL',
    ],
  },

  // ---- V3 claim codes & redemption ----------------------------------------
  // Claim rules on the offer (§17). Every existing offer keeps the behaviour it
  // already had - one claim per customer, one redemption - because that is what
  // the defaults spell out.
  {
    table: 'offers',
    column: 'claim_limit_per_customer',
    sql: `ALTER TABLE offers ADD COLUMN claim_limit_per_customer INT UNSIGNED NOT NULL DEFAULT 1
            AFTER applicability_type`,
    after: [
      'ALTER TABLE offers ADD COLUMN total_claim_limit INT UNSIGNED DEFAULT NULL AFTER claim_limit_per_customer',
      'ALTER TABLE offers ADD COLUMN claim_validity_hours INT UNSIGNED DEFAULT NULL AFTER total_claim_limit',
      `ALTER TABLE offers ADD COLUMN max_redemptions_per_claim INT UNSIGNED NOT NULL DEFAULT 1
         AFTER claim_validity_hours`,
    ],
  },
  // The claim itself grows the fields §30/§31 ask for. `expires_at` is declared
  // NOT NULL in schema.sql but has to be added nullable here and back-filled
  // first, because existing rows have nothing to put in it until the offer's
  // end date is copied across.
  {
    table: 'offer_claims',
    column: 'expires_at',
    sql: 'ALTER TABLE offer_claims ADD COLUMN expires_at DATETIME NULL AFTER claimed_at',
    after: [
      `UPDATE offer_claims c JOIN offers o ON o.id = c.offer_id
          SET c.expires_at = o.end_date WHERE c.expires_at IS NULL`,
      'ALTER TABLE offer_claims MODIFY COLUMN expires_at DATETIME NOT NULL',
      'ALTER TABLE offer_claims ADD COLUMN shop_id BIGINT UNSIGNED NULL AFTER user_id',
      'UPDATE offer_claims c JOIN offers o ON o.id = c.offer_id SET c.shop_id = o.shop_id WHERE c.shop_id IS NULL',
      'ALTER TABLE offer_claims MODIFY COLUMN shop_id BIGINT UNSIGNED NOT NULL',
      `ALTER TABLE offer_claims ADD CONSTRAINT fk_claim_shop FOREIGN KEY (shop_id)
         REFERENCES shops (id) ON DELETE CASCADE`,
      'ALTER TABLE offer_claims ADD COLUMN claim_seq INT UNSIGNED NOT NULL DEFAULT 1 AFTER code',
      `ALTER TABLE offer_claims ADD COLUMN verification_method ENUM('QR_SCAN','CODE_ENTRY')
         DEFAULT NULL AFTER redeemed_by`,
      `ALTER TABLE offer_claims ADD COLUMN redemption_count INT UNSIGNED NOT NULL DEFAULT 0
         AFTER verification_method`,
      // Rows redeemed before this column existed have exactly one redemption.
      "UPDATE offer_claims SET redemption_count = 1 WHERE status = 'redeemed'",
      'ALTER TABLE offer_claims ADD COLUMN revoked_at DATETIME DEFAULT NULL AFTER redemption_count',
      'ALTER TABLE offer_claims ADD COLUMN revoked_by BIGINT UNSIGNED DEFAULT NULL AFTER revoked_at',
      'ALTER TABLE offer_claims ADD COLUMN revoke_reason VARCHAR(255) DEFAULT NULL AFTER revoked_by',
      `ALTER TABLE offer_claims ADD CONSTRAINT fk_claim_revoked_by FOREIGN KEY (revoked_by)
         REFERENCES users (id) ON DELETE SET NULL`,
      `ALTER TABLE offer_claims ADD COLUMN created_at DATETIME NOT NULL
         DEFAULT CURRENT_TIMESTAMP AFTER revoke_reason`,
      `ALTER TABLE offer_claims ADD COLUMN updated_at DATETIME NOT NULL
         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at`,
      'ALTER TABLE offer_claims ADD KEY idx_claim_shop_status (shop_id, status, claimed_at)',
      'ALTER TABLE offer_claims ADD KEY idx_claim_redeemed (shop_id, redeemed_at)',
      'ALTER TABLE offer_claims ADD KEY idx_claim_expiry (status, expires_at)',
    ],
  },

  // ---- V3 claim codes: the service-offer half (§22) -----------------------
  // Service offers get the same four claim rules, with the same defaults, so
  // existing ones keep behaving exactly as they did.
  {
    table: 'service_offers',
    column: 'claim_limit_per_customer',
    sql: `ALTER TABLE service_offers ADD COLUMN claim_limit_per_customer INT UNSIGNED NOT NULL DEFAULT 1
            AFTER status`,
    after: [
      'ALTER TABLE service_offers ADD COLUMN total_claim_limit INT UNSIGNED DEFAULT NULL AFTER claim_limit_per_customer',
      'ALTER TABLE service_offers ADD COLUMN claim_validity_hours INT UNSIGNED DEFAULT NULL AFTER total_claim_limit',
      `ALTER TABLE service_offers ADD COLUMN max_redemptions_per_claim INT UNSIGNED NOT NULL DEFAULT 1
         AFTER claim_validity_hours`,
    ],
  },
  // The service claim grows into the same shape as `offer_claims`. Same
  // nullable-then-backfill dance for the two NOT NULL columns.
  {
    table: 'service_offer_claims',
    column: 'expires_at',
    sql: 'ALTER TABLE service_offer_claims ADD COLUMN expires_at DATETIME NULL AFTER claimed_at',
    after: [
      `UPDATE service_offer_claims c JOIN service_offers so ON so.id = c.service_offer_id
          SET c.expires_at = so.end_date WHERE c.expires_at IS NULL`,
      'ALTER TABLE service_offer_claims MODIFY COLUMN expires_at DATETIME NOT NULL',
      'ALTER TABLE service_offer_claims ADD COLUMN shop_id BIGINT UNSIGNED NULL AFTER user_id',
      `UPDATE service_offer_claims c JOIN service_offers so ON so.id = c.service_offer_id
          SET c.shop_id = so.shop_id WHERE c.shop_id IS NULL`,
      'ALTER TABLE service_offer_claims MODIFY COLUMN shop_id BIGINT UNSIGNED NOT NULL',
      `ALTER TABLE service_offer_claims ADD CONSTRAINT fk_soc_shop FOREIGN KEY (shop_id)
         REFERENCES shops (id) ON DELETE CASCADE`,
      'ALTER TABLE service_offer_claims ADD COLUMN claim_seq INT UNSIGNED NOT NULL DEFAULT 1 AFTER code',
      `ALTER TABLE service_offer_claims ADD COLUMN verification_method ENUM('QR_SCAN','CODE_ENTRY')
         DEFAULT NULL AFTER redeemed_by`,
      `ALTER TABLE service_offer_claims ADD COLUMN redemption_count INT UNSIGNED NOT NULL DEFAULT 0
         AFTER verification_method`,
      "UPDATE service_offer_claims SET redemption_count = 1 WHERE status = 'redeemed'",
      'ALTER TABLE service_offer_claims ADD COLUMN revoked_at DATETIME DEFAULT NULL AFTER redemption_count',
      'ALTER TABLE service_offer_claims ADD COLUMN revoked_by BIGINT UNSIGNED DEFAULT NULL AFTER revoked_at',
      'ALTER TABLE service_offer_claims ADD COLUMN revoke_reason VARCHAR(255) DEFAULT NULL AFTER revoked_by',
      `ALTER TABLE service_offer_claims ADD CONSTRAINT fk_soc_revoked_by FOREIGN KEY (revoked_by)
         REFERENCES users (id) ON DELETE SET NULL`,
      `ALTER TABLE service_offer_claims ADD COLUMN created_at DATETIME NOT NULL
         DEFAULT CURRENT_TIMESTAMP AFTER revoke_reason`,
      `ALTER TABLE service_offer_claims ADD COLUMN updated_at DATETIME NOT NULL
         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at`,
      'ALTER TABLE service_offer_claims ADD KEY idx_service_claim_shop_status (shop_id, status, claimed_at)',
      'ALTER TABLE service_offer_claims ADD KEY idx_service_claim_redeemed (shop_id, redeemed_at)',
      'ALTER TABLE service_offer_claims ADD KEY idx_service_claim_expiry (status, expires_at)',
    ],
  },
  // The verification log learns to point at either kind of claim.
  {
    table: 'claim_verifications',
    column: 'service_claim_id',
    sql: `ALTER TABLE claim_verifications ADD COLUMN service_claim_id BIGINT UNSIGNED DEFAULT NULL
            AFTER claim_id`,
    after: [
      `ALTER TABLE claim_verifications ADD COLUMN claim_kind ENUM('offer','service_offer')
         NOT NULL DEFAULT 'offer' AFTER id`,
      'ALTER TABLE claim_verifications ADD COLUMN service_offer_id BIGINT UNSIGNED DEFAULT NULL AFTER offer_id',
      'ALTER TABLE claim_verifications ADD KEY idx_cv_service_claim (service_claim_id, created_at)',
    ],
  },

  // ---- V5: Business Dashboard ---------------------------------------------
  // Merchant acquisition channel, which the retention cohort chart and the
  // dashboard filters both slice by (Business §17, §32).
  {
    table: 'shops',
    column: 'acquisition_channel',
    sql: 'ALTER TABLE shops ADD COLUMN acquisition_channel VARCHAR(60) DEFAULT NULL AFTER status',
    after: ['ALTER TABLE shops ADD KEY idx_shops_channel (acquisition_channel)'],
  },
  // ---- Logging: stable error codes and categories (Logging §8, §9) --------
  // Existing installs recorded only `error_type` (the driver/class name), which
  // changes when the implementation does. These two columns are the stable
  // vocabulary the monitoring dashboard filters on (§28) and groups by (§30).
  // Backfilled as NULL: a historical row's code cannot be reconstructed, and
  // guessing one would put fabricated values in front of an investigation.
  {
    table: 'error_logs',
    column: 'error_code',
    sql: 'ALTER TABLE error_logs ADD COLUMN error_code VARCHAR(60) DEFAULT NULL AFTER error_type',
    after: [
      'ALTER TABLE error_logs ADD COLUMN category VARCHAR(40) DEFAULT NULL AFTER error_code',
      'ALTER TABLE error_logs ADD KEY idx_error_code_time (error_code, created_at)',
      'ALTER TABLE error_logs ADD KEY idx_error_category_time (category, created_at)',
    ],
  },

  // ---- Self-service seller onboarding -------------------------------------
  //
  // Six nullable additions to `shops`. Nullable is the whole point: §15 forbids
  // backfilling existing shops as pending, so every shop that already exists
  // keeps NULL in all of these and carries on behaving exactly as before.
  {
    table: 'shops',
    column: 'registration_source',
    sql: `ALTER TABLE shops ADD COLUMN registration_source
            ENUM('ADMIN_CREATED','SELF_REGISTERED','EXISTING_SHOP_CLAIM')
            DEFAULT NULL AFTER acquisition_channel`,
    after: ['CREATE INDEX idx_shops_reg_source ON shops (registration_source)'],
    // Deliberately no UPDATE stamping existing rows as ADMIN_CREATED. It would
    // be a guess: these shops pre-date the column and nothing recorded how
    // they arrived, and §3 says the value is for reporting - a fabricated one
    // is worse than an honest NULL.
  },
  {
    table: 'shops',
    column: 'verification_status',
    sql: `ALTER TABLE shops ADD COLUMN verification_status
            ENUM('DRAFT','PENDING_VERIFICATION','ADDITIONAL_INFO_REQUIRED',
                 'VERIFIED','REJECTED','SUSPENDED')
            DEFAULT NULL AFTER registration_source`,
  },
  {
    table: 'shops',
    column: 'verification_submitted_at',
    sql: `ALTER TABLE shops ADD COLUMN verification_submitted_at DATETIME
            DEFAULT NULL AFTER verification_status`,
    // The review-queue index spans both columns, so it is created here rather
    // than with `verification_status`: patches run in array order, and at that
    // point this column does not exist yet.
    after: [
      `CREATE INDEX idx_shops_verification
         ON shops (verification_status, verification_submitted_at)`,
    ],
  },
  {
    table: 'shops',
    column: 'verification_decided_at',
    sql: `ALTER TABLE shops ADD COLUMN verification_decided_at DATETIME
            DEFAULT NULL AFTER verification_submitted_at`,
  },
  {
    table: 'shops',
    column: 'verification_reviewer_id',
    sql: `ALTER TABLE shops ADD COLUMN verification_reviewer_id BIGINT UNSIGNED
            DEFAULT NULL AFTER verification_decided_at`,
    after: [
      `ALTER TABLE shops ADD CONSTRAINT fk_shops_reviewer
         FOREIGN KEY (verification_reviewer_id) REFERENCES users (id) ON DELETE SET NULL`,
    ],
  },
  {
    table: 'shops',
    column: 'verification_reason',
    sql: `ALTER TABLE shops ADD COLUMN verification_reason TEXT
            DEFAULT NULL AFTER verification_reviewer_id`,
  },
  {
    table: 'shops',
    column: 'verification_details',
    sql: `ALTER TABLE shops ADD COLUMN verification_details JSON
            DEFAULT NULL AFTER verification_reason`,
  },

  // Who a customer reaches at a particular branch. Both stay nullable: the
  // readiness rule in `services/branchReadiness.js` decides when their absence
  // matters, and it only ever blocks *new* publishing, so backfilling these
  // would be inventing contact details nobody gave us.
  // Confinement to a branch, stated rather than inferred. Defaulting to 0 is
  // the whole point: `branch_id` has meant "works here" for longer than it has
  // meant anything about permissions, and reading existing rows as confined
  // would strip shop-wide powers from every member attached to a branch.
  {
    table: 'shop_members',
    column: 'is_branch_restricted',
    sql: `ALTER TABLE shop_members ADD COLUMN is_branch_restricted TINYINT(1) NOT NULL DEFAULT 0
            AFTER branch_id`,
  },

  {
    table: 'shop_branches',
    column: 'contact_person_name',
    sql: `ALTER TABLE shop_branches ADD COLUMN contact_person_name VARCHAR(160)
            DEFAULT NULL AFTER contact_number`,
    after: [
      `ALTER TABLE shop_branches ADD COLUMN contact_person_email VARCHAR(190)
         DEFAULT NULL AFTER contact_person_name`,
    ],
  },
];

/**
 * Patches that are not "add a missing column" - each carries its own check so
 * re-running the migration is still a no-op.
 */
const STATEMENT_PATCHES = [
  {
    name: 'permission catalog matches src/config/permissions.js',
    // Must stay first: every grant patch below joins `permissions` by name, and
    // a name the catalog is missing does more than skip its own grant. The
    // grant's `check` joins that same absent row, matches nothing, concludes
    // there is nothing to do - and the migration reports success while the
    // screen still answers 403. The visibility patch further down creates four
    // rows for exactly this reason; §25's claim permissions fell into the same
    // hole with no such rescue, which is why no shop Admin on a database seeded
    // before §25 could open Verify Claim or Redemptions.
    //
    // Reconciling the whole catalog here closes the hole for every grant that
    // follows, instead of one name list at a time. It grants nobody anything on
    // its own: a row in `permissions` only takes effect once a role points at
    // it, and the role presets stay deliberate - which is why this does not
    // reconcile ADMIN, whose grants an operator may have revoked on purpose.
    check: async (connection) => {
      const wanted = Object.keys(permissions.PERMISSIONS);
      const [rows] = await connection.query('SELECT name FROM permissions WHERE name IN (?)', [
        wanted,
      ]);
      return rows.length < wanted.length;
    },
    run: async (connection) => {
      for (const [name, entry] of Object.entries(permissions.PERMISSIONS)) {
        await connection.query(
          `INSERT INTO permissions (name, description, category) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE description = VALUES(description), category = VALUES(category)`,
          [name, entry.description, entry.category],
        );
      }
      // Super Admin holds every permission by definition (§4) - `SYSTEM_ROLES`
      // spells its preset as the full list - and nothing grants one added after
      // the role row was seeded.
      await connection.query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r JOIN permissions p ON p.name IN (?)
          WHERE r.name = 'SUPER_ADMIN'`,
        [permissions.SYSTEM_ROLES.SUPER_ADMIN.permissions],
      );
    },
  },
  {
    name: "offer_views.event_type += 'impression'",
    // V2 tracks impressions to close the top of the funnel (§24).
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'offer_views' AND COLUMN_NAME = 'event_type'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('impression');
    },
    sql: `ALTER TABLE offer_views
            MODIFY COLUMN event_type ENUM('view','click','share','impression')
            NOT NULL DEFAULT 'view'`,
  },
  {
    name: 'banners.campaign_id -> campaigns FK',
    // The column is declared inline on `banners`, which MySQL creates before
    // `campaigns` exists, so the constraint has to be attached afterwards.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'banners'
            AND CONSTRAINT_NAME = 'fk_banner_campaign' LIMIT 1`,
        [dbName],
      );
      return rows.length === 0;
    },
    sql: `ALTER TABLE banners
            ADD CONSTRAINT fk_banner_campaign FOREIGN KEY (campaign_id)
            REFERENCES campaigns (id) ON DELETE SET NULL`,
  },
  {
    name: 'shop_claim_requests.uq_claim_open covers live claims only',
    /*
      The index shipped keyed on (shop_id, requester_id, status), with a
      comment claiming decided rows fell out of it. They do not - MySQL
      exempts only NULLs from a UNIQUE key, and `status` is never NULL - so a
      claimant was capped at one WITHDRAWN and one REJECTED row per shop for
      life. Withdrawing a second request, or a reviewer rejecting a second
      attempt, failed on a duplicate key.

      `claim_open` is NULL unless the claim is PENDING, which confines the key
      to live claims and leaves any number of decided ones. Rewritten in one
      ALTER so the table is never briefly unconstrained, and generated from
      `status` rather than `shop_id` because a STORED column may not derive
      from a column an FK references with a referential action.
    */
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shop_claim_requests'
            AND INDEX_NAME = 'uq_claim_open' AND COLUMN_NAME = 'status' LIMIT 1`,
        [dbName],
      );
      return rows.length > 0;
    },
    sql: `ALTER TABLE shop_claim_requests
            DROP INDEX uq_claim_open,
            ADD COLUMN claim_open TINYINT UNSIGNED
              AS (IF(status = 'PENDING', 1, NULL)) STORED,
            ADD UNIQUE KEY uq_claim_open (shop_id, requester_id, claim_open)`,
  },
  {
    name: 'every shop has a subscription row',
    // Entitlement checks assume the row exists; back-fill Free for shops that
    // pre-date V3 so nothing has to special-case a missing subscription.
    check: async (connection) => {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS missing FROM shops s
          WHERE NOT EXISTS (SELECT 1 FROM shop_subscriptions sub WHERE sub.shop_id = s.id)`,
      );
      return Number(rows[0].missing) > 0;
    },
    sql: `INSERT INTO shop_subscriptions (shop_id, plan, status, price_amount, payment_status)
          SELECT s.id, 'FREE', 'active', 0.00, 'not_required' FROM shops s
           WHERE NOT EXISTS (SELECT 1 FROM shop_subscriptions sub WHERE sub.shop_id = s.id)`,
  },
  {
    name: "shop_subscriptions.status += 'created','paused'",
    // Razorpay distinguishes a subscription that exists but has never been
    // paid ('created') from one halted mid-life ('paused') (§9).
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shop_subscriptions' AND COLUMN_NAME = 'status'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('paused');
    },
    sql: `ALTER TABLE shop_subscriptions
            MODIFY COLUMN status ENUM('created','active','past_due','paused','cancelled','expired')
            NOT NULL DEFAULT 'active'`,
  },
  {
    name: 'subscription_events.action += payment lifecycle',
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_events' AND COLUMN_NAME = 'action'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('payment_failed');
    },
    sql: `ALTER TABLE subscription_events
            MODIFY COLUMN action ENUM('created','upgraded','downgraded','renewed','cancelled',
                                      'reactivated','payment_failed','past_due','expired','grace_started')
            NOT NULL`,
  },
  {
    name: 'feature_catalogue is in sync with config/featureCatalogue.js',
    // The catalogue is declared in code (§11J) and mirrored into the table so
    // override rows can be validated with a join. Re-running only ever
    // upserts, so a key removed from code stays in the table for history.
    check: async (connection) => {
      const [rows] = await connection.query('SELECT COUNT(*) AS n FROM feature_catalogue');
      return Number(rows[0].n) !== featureCatalogue.CATALOGUE.length;
    },
    run: async (connection) => {
      for (const entry of featureCatalogue.CATALOGUE) {
        await connection.query(
          `INSERT INTO feature_catalogue (feature_key, name, description, category, is_active)
           VALUES (?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
                                   category = VALUES(category), is_active = 1`,
          [entry.featureKey, entry.name, entry.description, entry.category],
        );
      }
    },
  },
  {
    name: 'push_tickets.device_id detaches instead of cascading',
    // The first cut of this table cascaded, so signing out - which unregisters
    // the device - deleted the delivery history of every push already sent to
    // it. Rebuilt as SET NULL so the ticket outlives the device.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'push_tickets'
            AND CONSTRAINT_NAME = 'fk_pt_device' AND DELETE_RULE = 'CASCADE' LIMIT 1`,
        [dbName],
      );
      return rows.length > 0;
    },
    run: async (connection) => {
      await connection.query('ALTER TABLE push_tickets DROP FOREIGN KEY fk_pt_device');
      await connection.query('ALTER TABLE push_tickets MODIFY device_id BIGINT UNSIGNED DEFAULT NULL');
      await connection.query(
        `ALTER TABLE push_tickets ADD CONSTRAINT fk_pt_device FOREIGN KEY (device_id)
           REFERENCES push_devices (id) ON DELETE SET NULL`,
      );
    },
  },
  {
    name: "shop Admins may edit their own shop profile",
    // V3 shop-location §5/§14/§19: the merchant owns their address, map pin
    // and shop picture. Installs that predate this gave EDIT_SHOP to Super
    // Admins alone, which left shopkeepers unable to fix their own location.
    // Scoped by `requireShopScope`, so this is still only their own shops.
    check: async (connection) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM roles r
           JOIN permissions p ON p.name = 'EDIT_SHOP'
          WHERE r.name = 'ADMIN'
            AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                             WHERE rp.role_id = r.id AND rp.permission_id = p.id)
          LIMIT 1`,
      );
      return rows.length > 0;
    },
    sql: `INSERT IGNORE INTO role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM roles r JOIN permissions p ON p.name = 'EDIT_SHOP'
           WHERE r.name = 'ADMIN'`,
  },
  {
    name: 'analytics_events.service_id -> services FK',
    // `services` is created later in schema.sql than `analytics_events`, so on
    // a fresh install the constraint has to be attached after both exist.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'analytics_events'
            AND CONSTRAINT_NAME = 'fk_ae_service' LIMIT 1`,
        [dbName],
      );
      return rows.length === 0;
    },
    sql: `ALTER TABLE analytics_events
            ADD CONSTRAINT fk_ae_service FOREIGN KEY (service_id)
            REFERENCES services (id) ON DELETE CASCADE`,
  },

  // ---- V3 claim codes & redemption ----------------------------------------
  {
    name: "offer_claims.status += 'revoked'",
    // §12: a claim invalidated by an authorised action is not the same thing
    // as one the customer cancelled, and a dispute needs to tell them apart.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'offer_claims' AND COLUMN_NAME = 'status'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('revoked');
    },
    sql: `ALTER TABLE offer_claims
            MODIFY COLUMN status ENUM('claimed','redeemed','expired','cancelled','revoked')
            NOT NULL DEFAULT 'claimed'`,
  },
  {
    name: 'offer_claims unique key admits more than one claim per customer',
    // The original key was (user_id, offer_id), which hard-coded "one claim per
    // customer per offer" into the schema. §17 makes that a per-offer setting,
    // so the sequence number joins the key: the limit is now enforced in code
    // and this still stops two concurrent requests from both issuing a code.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'offer_claims'
            AND INDEX_NAME = 'uq_claim_user_offer' LIMIT 1`,
        [dbName],
      );
      return rows.length > 0;
    },
    run: async (connection) => {
      await connection.query(
        `ALTER TABLE offer_claims ADD UNIQUE KEY uq_claim_user_offer_seq (user_id, offer_id, claim_seq)`,
      );
      await connection.query('ALTER TABLE offer_claims DROP INDEX uq_claim_user_offer');
    },
  },
  {
    name: 'REDEEM_CLAIM is renamed to REDEEM_OFFER',
    // §25 names the permission REDEEM_OFFER. Renaming the row rather than
    // inserting a second one is what keeps every existing grant intact:
    // role_permissions points at the id, which does not move.
    check: async (connection) => {
      const [rows] = await connection.query(
        "SELECT 1 FROM permissions WHERE name = 'REDEEM_CLAIM' LIMIT 1",
      );
      return rows.length > 0;
    },
    run: async (connection) => {
      // A REDEEM_OFFER row can only already exist if the seeder ran first, in
      // which case the grants live on that one and the old row is dead weight.
      const [existing] = await connection.query(
        "SELECT id FROM permissions WHERE name = 'REDEEM_OFFER' LIMIT 1",
      );
      if (existing.length) {
        await connection.query(
          `INSERT IGNORE INTO role_permissions (role_id, permission_id)
             SELECT rp.role_id, ? FROM role_permissions rp
              JOIN permissions p ON p.id = rp.permission_id AND p.name = 'REDEEM_CLAIM'`,
          [existing[0].id],
        );
        await connection.query("DELETE FROM permissions WHERE name = 'REDEEM_CLAIM'");
        return;
      }
      await connection.query(
        "UPDATE permissions SET name = 'REDEEM_OFFER' WHERE name = 'REDEEM_CLAIM'",
      );
    },
  },
  {
    name: 'shop Admins may verify claims and read their redemption history',
    // §25 splits what used to be one blunt "can redeem" grant into scanning,
    // redeeming, listing and exporting. An Admin who could already redeem must
    // keep being able to reach the screen that redeems - so the new companion
    // permissions follow REDEEM_OFFER onto the role rather than waiting for a
    // Super Admin to notice.
    check: async (connection) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM roles r
           JOIN permissions p ON p.name IN ('VIEW_CLAIMS','VERIFY_CLAIM','VIEW_REDEMPTION_HISTORY',
                                          'EXPORT_REDEMPTION_REPORT')
          WHERE r.name = 'ADMIN'
            AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                             WHERE rp.role_id = r.id AND rp.permission_id = p.id)
          LIMIT 1`,
      );
      return rows.length > 0;
    },
    sql: `INSERT IGNORE INTO role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM roles r
            JOIN permissions p ON p.name IN ('VIEW_CLAIMS','VERIFY_CLAIM','VIEW_REDEMPTION_HISTORY',
                                             'EXPORT_REDEMPTION_REPORT')
           WHERE r.name = 'ADMIN'`,
  },
  {
    name: "service_offer_claims.status += 'revoked'",
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'service_offer_claims' AND COLUMN_NAME = 'status'`,
        [dbName],
      );
      return rows.length > 0 && !rows[0].t.includes('revoked');
    },
    sql: `ALTER TABLE service_offer_claims
            MODIFY COLUMN status ENUM('claimed','redeemed','expired','cancelled','revoked')
            NOT NULL DEFAULT 'claimed'`,
  },
  {
    name: 'service_offer_claims unique key admits more than one claim per customer',
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'service_offer_claims'
            AND INDEX_NAME = 'uq_service_claim_user_offer' LIMIT 1`,
        [dbName],
      );
      return rows.length > 0;
    },
    run: async (connection) => {
      await connection.query(
        `ALTER TABLE service_offer_claims
           ADD UNIQUE KEY uq_service_claim_user_offer_seq (user_id, service_offer_id, claim_seq)`,
      );
      await connection.query('ALTER TABLE service_offer_claims DROP INDEX uq_service_claim_user_offer');
    },
  },

  // ---- Visibility & Promotion System --------------------------------------
  {
    name: 'ranking_weights seeded from config/visibility.js',
    // §4 requires the weights to be configurable from the backend, which means
    // they have to exist as rows before anyone can configure them. Seeded from
    // the coded defaults, and only ever *inserted* - a re-run must never
    // silently undo a Super Admin's tuning, which is exactly what an upsert
    // here would do on every deploy.
    check: async (connection) => {
      const [rows] = await connection.query('SELECT COUNT(*) AS n FROM ranking_weights');
      const expected = visibility.SURFACE_KEYS.length * visibility.FACTOR_KEYS.length;
      return Number(rows[0].n) < expected;
    },
    run: async (connection) => {
      for (const surface of visibility.SURFACE_KEYS) {
        for (const factor of visibility.FACTOR_KEYS) {
          await connection.query(
            `INSERT IGNORE INTO ranking_weights (surface, factor, weight, is_active)
             VALUES (?, ?, ?, 1)`,
            [surface, factor, visibility.DEFAULT_WEIGHTS[surface][factor]],
          );
        }
      }
    },
  },
  {
    name: 'visibility_rules seeded from config/visibility.js',
    check: async (connection) => {
      const [rows] = await connection.query('SELECT COUNT(*) AS n FROM visibility_rules');
      return Number(rows[0].n) < Object.keys(visibility.DEFAULT_RULES).length;
    },
    run: async (connection) => {
      for (const [key, value] of Object.entries(visibility.DEFAULT_RULES)) {
        // Scalars go in `value_number` so the hot read path never parses JSON
        // to get a number back; objects and booleans go in `value_json`.
        const isNumber = typeof value === 'number';
        await connection.query(
          `INSERT IGNORE INTO visibility_rules (rule_key, value_number, value_json, is_active)
           VALUES (?, ?, ?, 1)`,
          [key, isNumber ? value : null, isNumber ? null : JSON.stringify(value)],
        );
      }
    },
  },
  {
    name: 'featured_slots seeded from config/visibility.js',
    // §11's placement types, as slots a campaign can actually be booked into.
    check: async (connection) => {
      const [rows] = await connection.query('SELECT COUNT(*) AS n FROM featured_slots');
      return Number(rows[0].n) < visibility.DEFAULT_SLOTS.length;
    },
    run: async (connection) => {
      for (const slot of visibility.DEFAULT_SLOTS) {
        await connection.query(
          `INSERT IGNORE INTO featured_slots
             (code, placement_type, name, description, capacity, min_plan_rank, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')`,
          [slot.code, slot.placementType, slot.name, slot.description, slot.capacity, slot.minPlanRank],
        );
      }
    },
  },
  {
    name: 'frequency_limits seeded from config/visibility.js',
    // §18's caps. Present from the first request rather than from the first
    // time someone opens the admin screen: an uncapped launch is exactly the
    // customer fatigue §18 exists to prevent.
    check: async (connection) => {
      const [rows] = await connection.query('SELECT COUNT(*) AS n FROM frequency_limits');
      return Number(rows[0].n) < visibility.DEFAULT_FREQUENCY_LIMITS.length;
    },
    run: async (connection) => {
      for (const limit of visibility.DEFAULT_FREQUENCY_LIMITS) {
        await connection.query(
          `INSERT IGNORE INTO frequency_limits
             (scope, placement_type, applies_to, max_impressions, window_minutes, status)
           VALUES (?, ?, ?, ?, ?, 'active')`,
          [limit.scope, limit.placementType, limit.appliesTo, limit.maxImpressions, limit.windowMinutes],
        );
      }
    },
  },
  {
    name: 'visibility permissions exist and Super Admin holds them',
    // The grant patch below joins `permissions` by name, and the whole
    // permission system resolves through that table - so without these rows the
    // grant silently matches nothing and every Super Admin visibility screen
    // answers 403 on an install that ran the migration but not the seeder.
    //
    // That is the normal deployment path: `db:seed` also inserts demo shops and
    // offers, which nobody wants to run against production data. So the rows a
    // *release* needs are created here, and the seeder keeps owning demo
    // content. Found by end-to-end testing against a restored database, where
    // the migration reported complete success and the admin screens still 403'd.
    check: async (connection) => {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS missing FROM (
           SELECT 'MANAGE_VISIBILITY' AS name UNION ALL SELECT 'MANAGE_FEATURED_CAMPAIGNS'
           UNION ALL SELECT 'APPROVE_FEATURED_CAMPAIGN' UNION ALL SELECT 'VIEW_VISIBILITY_ANALYTICS'
         ) wanted
          WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.name = wanted.name)`,
      );
      return Number(rows[0].missing) > 0;
    },
    run: async (connection) => {
      for (const name of [
        'MANAGE_VISIBILITY',
        'MANAGE_FEATURED_CAMPAIGNS',
        'APPROVE_FEATURED_CAMPAIGN',
        'VIEW_VISIBILITY_ANALYTICS',
      ]) {
        const entry = permissions.PERMISSIONS[name];
        await connection.query(
          `INSERT INTO permissions (name, description, category) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE description = VALUES(description), category = VALUES(category)`,
          [name, entry.description, entry.category],
        );
      }
      // Super Admin holds every permission by definition (§4), and a permission
      // added after the role was seeded is not granted retroactively by anything
      // else.
      await connection.query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r
           JOIN permissions p ON p.name IN ('MANAGE_VISIBILITY','MANAGE_FEATURED_CAMPAIGNS',
                                            'APPROVE_FEATURED_CAMPAIGN','VIEW_VISIBILITY_ANALYTICS')
          WHERE r.name = 'SUPER_ADMIN'`,
      );
    },
  },
  {
    name: 'shop Admins may manage featured campaigns and read visibility analytics',
    // The merchant's half of §22. Deliberately not MANAGE_VISIBILITY or
    // APPROVE_FEATURED_CAMPAIGN: §24 says an Admin cannot set their own ranking
    // score, and a merchant who could approve their own campaign onto the home
    // page would have routed around the approval step in one request.
    //
    // `seedRoles` grants these on a fresh install; this is for the installs
    // that already exist and will not re-run the seeder.
    check: async (connection) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM roles r
           JOIN permissions p ON p.name IN ('MANAGE_FEATURED_CAMPAIGNS','VIEW_VISIBILITY_ANALYTICS')
          WHERE r.name = 'ADMIN'
            AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                             WHERE rp.role_id = r.id AND rp.permission_id = p.id)
          LIMIT 1`,
      );
      return rows.length > 0;
    },
    sql: `INSERT IGNORE INTO role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM roles r
            JOIN permissions p ON p.name IN ('MANAGE_FEATURED_CAMPAIGNS','VIEW_VISIBILITY_ANALYTICS')
           WHERE r.name = 'ADMIN'`,
  },

  {
    name: 'the seller-registration reviewer permission exists and Super Admin holds it',
    // Onboarding §14. Same reasoning as the visibility grant above: the
    // permission system resolves through the `permissions` table by name, so
    // without this row the review routes answer 403 on any install that ran
    // the migration but not the seeder - which is every existing deployment.
    check: async (connection) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM permissions WHERE name = 'REVIEW_SELLER_REGISTRATIONS' LIMIT 1`,
      );
      return rows.length === 0;
    },
    run: async (connection) => {
      const entry = permissions.PERMISSIONS.REVIEW_SELLER_REGISTRATIONS;
      await connection.query(
        `INSERT INTO permissions (name, description, category) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE description = VALUES(description), category = VALUES(category)`,
        ['REVIEW_SELLER_REGISTRATIONS', entry.description, entry.category],
      );
      // Super Admin holds every permission by definition, and one added after
      // the role was seeded is not granted retroactively by anything else.
      // Deliberately not granted to ADMIN: a shop-scoped reviewer could
      // approve their own registration (§14).
      await connection.query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r
           JOIN permissions p ON p.name = 'REVIEW_SELLER_REGISTRATIONS'
          WHERE r.name = 'SUPER_ADMIN'`,
      );
    },
  },

  {
    name: 'claim_verifications.service_claim_id -> service_offer_claims FK',
    // `service_offer_claims` is created later in schema.sql than
    // `claim_verifications`, so on a fresh install this has to come after both.
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'claim_verifications'
            AND CONSTRAINT_NAME = 'fk_cv_service_claim' LIMIT 1`,
        [dbName],
      );
      return rows.length === 0;
    },
    sql: `ALTER TABLE claim_verifications
            ADD CONSTRAINT fk_cv_service_claim FOREIGN KEY (service_claim_id)
            REFERENCES service_offer_claims (id) ON DELETE SET NULL`,
  },
  {
    name: 'claim_verifications.service_offer_id -> service_offers FK',
    check: async (connection, dbName) => {
      const [rows] = await connection.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'claim_verifications'
            AND CONSTRAINT_NAME = 'fk_cv_service_offer' LIMIT 1`,
        [dbName],
      );
      return rows.length === 0;
    },
    sql: `ALTER TABLE claim_verifications
            ADD CONSTRAINT fk_cv_service_offer FOREIGN KEY (service_offer_id)
            REFERENCES service_offers (id) ON DELETE SET NULL`,
  },
];

async function applyPatches(connection, dbName) {
  const applied = [];
  for (const patch of COLUMN_PATCHES) {
    const [rows] = await connection.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [dbName, patch.table, patch.column],
    );
    if (rows.length) continue;

    await connection.query(patch.sql);
    for (const followUp of patch.after ?? []) await connection.query(followUp);
    applied.push(`${patch.table}.${patch.column}`);
  }

  for (const patch of STATEMENT_PATCHES) {
    if (!(await patch.check(connection, dbName))) continue;
    // A patch is either one statement or a function, for the few that need
    // to loop over data declared in code.
    if (patch.run) await patch.run(connection);
    else await connection.query(patch.sql);
    applied.push(patch.name);
  }

  return applied;
}

async function main() {
  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: false,
  });

  const dbName = env.db.database;
  if (FRESH) {
    console.log(`Dropping database \`${dbName}\` ...`);
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  }

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await connection.query(`USE \`${dbName}\``);

  const sql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = splitStatements(sql);

  for (const statement of statements) {
    await connection.query(statement);
  }
  console.log(`Applied ${statements.length} statements to \`${dbName}\`.`);

  const patched = await applyPatches(connection, dbName);
  if (patched.length) console.log(`Patched existing tables: ${patched.join(', ')}.`);

  await connection.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
