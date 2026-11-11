-- =====================================================================
--  OffersOffer - MySQL schema
--  Requirements reference: section 30 (Database Structure)
--  Engine: InnoDB / utf8mb4. Target: MySQL 8.0+
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120)    NOT NULL,
  email           VARCHAR(190)    NOT NULL,
  password_hash   VARCHAR(255)    NOT NULL,
  phone           VARCHAR(30)             DEFAULT NULL,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  email_verified  TINYINT(1)      NOT NULL DEFAULT 0,
  avatar_url      VARCHAR(500)            DEFAULT NULL,
  -- preferred location used for "offers near me" when GPS is not shared
  pref_city       VARCHAR(120)            DEFAULT NULL,
  pref_latitude   DECIMAL(10,7)           DEFAULT NULL,
  pref_longitude  DECIMAL(10,7)           DEFAULT NULL,
  last_login_at   DATETIME                DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL,
  description VARCHAR(255)            DEFAULT NULL,
  -- 'global' roles grant their permissions application-wide.
  -- 'shop' roles only ever grant them for the shops the user is a member of,
  -- which is what makes an Admin an admin *of a particular shop* (§3.2).
  scope       ENUM('global','shop') NOT NULL DEFAULT 'shop',
  -- system roles cannot be deleted or renamed (SUPER_ADMIN, ADMIN, CUSTOMER)
  is_system   TINYINT(1)      NOT NULL DEFAULT 0,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL,
  description VARCHAR(255)            DEFAULT NULL,
  category    VARCHAR(60)             DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_id       BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_role_permission (role_id, permission_id),
  KEY idx_rp_permission (permission_id),
  CONSTRAINT fk_rp_role       FOREIGN KEY (role_id)       REFERENCES roles (id)       ON DELETE CASCADE,
  CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Global (application-wide) role assignments.
-- Shop-scoped roles live on shop_members.role_id instead.
CREATE TABLE IF NOT EXISTS user_roles (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_role (user_id, role_id),
  KEY idx_ur_role (role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Auth tokens
-- ---------------------------------------------------------------------
-- One row per issued refresh token. This is the `user_sessions` table of
-- the persistent-login spec (§27): a "session" is a family of refresh
-- tokens sharing `family_id`, rotated on every use (§29), so the newest
-- live row in a family *is* that device's session.
--
-- Raw tokens are never stored, only their SHA-256 digest (§27).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  token_hash     CHAR(64)        NOT NULL,
  -- Shared by every rotation of one device's session. Presenting a token
  -- that was already rotated away is a reuse signal, and the whole family
  -- is revoked in response (§29).
  family_id      CHAR(32)                DEFAULT NULL,
  expires_at     DATETIME        NOT NULL,
  revoked_at     DATETIME                DEFAULT NULL,
  revoked_reason ENUM('rotated','logout','logout_others','reuse_detected',
                      'password_changed','revoked','account_disabled')
                 DEFAULT NULL,
  device_type    ENUM('mobile','tablet','desktop','web','unknown') NOT NULL DEFAULT 'unknown',
  device_name    VARCHAR(120)            DEFAULT NULL,
  platform       VARCHAR(40)             DEFAULT NULL,
  user_agent     VARCHAR(255)            DEFAULT NULL,
  ip_address     VARCHAR(64)             DEFAULT NULL,
  last_used_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id),
  KEY idx_refresh_family (family_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Password reset + email verification share one table, separated by purpose.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  purpose    ENUM('password_reset','email_verification') NOT NULL,
  token_hash CHAR(64)        NOT NULL,
  expires_at DATETIME        NOT NULL,
  used_at    DATETIME                DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_token_hash (token_hash),
  KEY idx_auth_token_user (user_id, purpose),
  CONSTRAINT fk_auth_token_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120)    NOT NULL,
  slug        VARCHAR(140)    NOT NULL,
  description VARCHAR(500)            DEFAULT NULL,
  icon        VARCHAR(80)             DEFAULT NULL,
  image_url   VARCHAR(500)            DEFAULT NULL,
  parent_id   BIGINT UNSIGNED         DEFAULT NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_slug (slug),
  KEY idx_categories_parent (parent_id),
  KEY idx_categories_status (status),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shops (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(160)    NOT NULL,
  slug           VARCHAR(180)    NOT NULL,
  description    TEXT                    DEFAULT NULL,
  logo_url       VARCHAR(500)            DEFAULT NULL,
  cover_url      VARCHAR(500)            DEFAULT NULL,
  contact_number VARCHAR(30)             DEFAULT NULL,
  email          VARCHAR(190)            DEFAULT NULL,
  website_url    VARCHAR(500)            DEFAULT NULL,
  social_links   JSON                    DEFAULT NULL,
  -- Optional on every plan, Free included (§3). Shape is
  -- { mon: [{open, close}], ... }; the API validates it, MySQL only stores it.
  opening_hours  JSON                    DEFAULT NULL,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  -- How this merchant came to the platform (Business Dashboard §17, §32).
  -- Free text rather than an enum: the channels a sales team invents outlive
  -- any list we could fix here, and nothing branches on the value - it is only
  -- ever grouped by. NULL means nobody recorded it.
  acquisition_channel VARCHAR(60)        DEFAULT NULL,
  -- Which code path created this shop (Self-Service Onboarding §3). Kept apart
  -- from `acquisition_channel` on purpose: that one is sales attribution and
  -- free text ("trade show, Chennai"), this one is a closed set describing how
  -- the record came to exist, and reporting needs to ask the two questions
  -- separately. §3 is explicit that it is for reporting and audit and must
  -- never grant permission, so nothing may branch on it for authorization.
  -- NULL means the shop pre-dates this column.
  registration_source ENUM('ADMIN_CREATED','SELF_REGISTERED','EXISTING_SHOP_CLAIM')
                                         DEFAULT NULL,
  -- The review lifecycle (§11), deliberately NOT folded into `status`.
  --
  -- `status` is the operational question - is this shop live - and the whole
  -- application already reads it, public discovery included. Widening that
  -- enum would change the meaning of every existing query. This column answers
  -- the separate question of where the shop is in review, which is why §11
  -- insists VERIFIED and ACTIVE are not the same thing: a shop can pass review
  -- and still be switched off.
  --
  -- NULL means "never went through review", which is every shop that existed
  -- before this feature. §15 forbids backfilling those as pending, so NULL is
  -- treated as approved-by-provenance and must stay the default.
  verification_status ENUM('DRAFT','PENDING_VERIFICATION','ADDITIONAL_INFO_REQUIRED',
                           'VERIFIED','REJECTED','SUSPENDED') DEFAULT NULL,
  verification_submitted_at DATETIME     DEFAULT NULL,
  verification_decided_at   DATETIME     DEFAULT NULL,
  verification_reviewer_id  BIGINT UNSIGNED DEFAULT NULL,
  -- Mandatory for REJECTED and ADDITIONAL_INFO_REQUIRED (§14), and shown to
  -- the seller verbatim, so it is their explanation rather than an admin note.
  verification_reason       TEXT         DEFAULT NULL,
  -- §8's text evidence: GSTIN, a Google Business link, a registration number.
  -- JSON because §8 is explicit that none of it is universally required and
  -- an admin may ask for something nobody anticipated - a column per field
  -- would make each new question a migration. Follows `social_links` and
  -- `opening_hours`, which are stored the same way for the same reason.
  -- Private: never included in any public shop response (§8, §19).
  verification_details JSON              DEFAULT NULL,
  created_by     BIGINT UNSIGNED         DEFAULT NULL,
  updated_by     BIGINT UNSIGNED         DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shops_slug (slug),
  KEY idx_shops_channel (acquisition_channel),
  KEY idx_shops_status (status),
  KEY idx_shops_name (name),
  -- The admin review queue (§14) filters on exactly this pair.
  KEY idx_shops_verification (verification_status, verification_submitted_at),
  KEY idx_shops_reg_source (registration_source),
  CONSTRAINT fk_shops_reviewer FOREIGN KEY (verification_reviewer_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_shops_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_shops_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_categories (
  shop_id     BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (shop_id, category_id),
  KEY idx_sc_category (category_id),
  CONSTRAINT fk_sc_shop     FOREIGN KEY (shop_id)     REFERENCES shops (id)      ON DELETE CASCADE,
  CONSTRAINT fk_sc_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_branches (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  branch_name    VARCHAR(160)    NOT NULL,
  -- `address` stays the single free-text line the whole app already reads and
  -- prints; `address_line_2` and `area` are the extra structure V3 §24 asks
  -- for, kept separate rather than folded in so nothing downstream changes.
  address        VARCHAR(500)            DEFAULT NULL,
  address_line_2 VARCHAR(255)            DEFAULT NULL,
  area           VARCHAR(160)            DEFAULT NULL,
  city           VARCHAR(120)            DEFAULT NULL,
  state          VARCHAR(120)            DEFAULT NULL,
  country        VARCHAR(120)            DEFAULT NULL,
  pincode        VARCHAR(20)             DEFAULT NULL,
  latitude       DECIMAL(10,7)           DEFAULT NULL,
  longitude      DECIMAL(10,7)           DEFAULT NULL,
  -- Where the pin came from (§24). A merchant who dragged it or stood in the
  -- shop is a better authority than the geocoder, and this is what says so.
  location_source  ENUM('ADDRESS_SEARCH','MAP_PIN','CURRENT_LOCATION','MANUAL')
                                         DEFAULT NULL,
  -- Metres of GPS uncertainty, when the device reported any (§25).
  location_accuracy DECIMAL(8,2)         DEFAULT NULL,
  -- The merchant ticked "this is my shop" on the map (§8). Publishing needs it.
  location_confirmed_at DATETIME         DEFAULT NULL,
  place_id       VARCHAR(120)            DEFAULT NULL,
  opening_hours  JSON                    DEFAULT NULL,
  contact_number VARCHAR(30)             DEFAULT NULL,
  -- Who a customer reaches at THIS branch, published on the branch listing.
  --
  -- Deliberately not the same thing as the branch's administrator. The admin
  -- is a `shop_members` row with a login and permissions; this is a name and
  -- an address printed for customers, and the two are often different people -
  -- the counter supervisor administers, the manager is who you ask for.
  contact_person_name  VARCHAR(160)      DEFAULT NULL,
  contact_person_email VARCHAR(190)      DEFAULT NULL,
  is_primary     TINYINT(1)      NOT NULL DEFAULT 0,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_branch_shop (shop_id),
  KEY idx_branch_city (city),
  KEY idx_branch_pincode (pincode),
  -- bounding-box prefilter for radius search rides on this index
  KEY idx_branch_geo (latitude, longitude),
  CONSTRAINT fk_branch_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A user may belong to several shops, so membership is its own relation (§18).
CREATE TABLE IF NOT EXISTS shop_members (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id     BIGINT UNSIGNED NOT NULL,
  branch_id   BIGINT UNSIGNED         DEFAULT NULL,
  -- Whether `branch_id` *confines* this member, or merely says where they work.
  --
  -- The two are not the same and the difference is not cosmetic. A branch has
  -- always scoped redemption - a member attached to one may only redeem claims
  -- at that counter - but a "Store Manager, Coimbatore" who also runs the
  -- shop's offers is attached without being confined. Inferring confinement
  -- from a non-null `branch_id` would have taken shop-wide powers away from
  -- every such member the day it shipped, so confinement is stated.
  --
  -- 0 for every row that existed before this column, which is what keeps that
  -- from happening. A branch admin created on purpose gets 1.
  is_branch_restricted TINYINT(1) NOT NULL DEFAULT 0,
  user_id     BIGINT UNSIGNED NOT NULL,
  role_id     BIGINT UNSIGNED         DEFAULT NULL,
  designation VARCHAR(120)            DEFAULT NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shop_member (shop_id, user_id),
  KEY idx_member_user (user_id),
  KEY idx_member_branch (branch_id),
  CONSTRAINT fk_member_shop   FOREIGN KEY (shop_id)   REFERENCES shops (id)         ON DELETE CASCADE,
  CONSTRAINT fk_member_branch FOREIGN KEY (branch_id) REFERENCES shop_branches (id) ON DELETE SET NULL,
  CONSTRAINT fk_member_user   FOREIGN KEY (user_id)   REFERENCES users (id)         ON DELETE CASCADE,
  CONSTRAINT fk_member_role   FOREIGN KEY (role_id)   REFERENCES roles (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Self-service seller onboarding (§8, §16)
-- ---------------------------------------------------------------------

-- Evidence a merchant offered to support their registration.
--
-- Stores a storage KEY, never a URL. §8 requires this material to be
-- unreachable from public shop APIs, and `storage.put()` only writes to the
-- public prefix and hands back a CloudFront URL - saving one of those here
-- would publish a GST certificate at a guessable address. Downloads go
-- through an authenticated route that resolves the key, so the only way to
-- read a document is to be its merchant or a reviewer.
CREATE TABLE IF NOT EXISTS shop_verification_documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id       BIGINT UNSIGNED NOT NULL,
  -- Free text rather than an enum: §8 lets an admin ask for evidence nobody
  -- anticipated, and a closed list would make that a migration.
  kind          VARCHAR(60)     NOT NULL,
  storage_key   VARCHAR(500)    NOT NULL,
  original_name VARCHAR(255)            DEFAULT NULL,
  content_type  VARCHAR(100)            DEFAULT NULL,
  bytes         INT UNSIGNED            DEFAULT NULL,
  uploaded_by   BIGINT UNSIGNED         DEFAULT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_svd_shop (shop_id, created_at),
  CONSTRAINT fk_svd_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_svd_user FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "This shop is mine, please give me access" (§16).
--
-- Deliberately separate from `shop_members`: a claim is a request about a
-- membership that does not exist yet, and §16 is explicit that it must grant
-- nothing until approved. Writing a pending row into shop_members - even an
-- inactive one - would put the answer in the table the authorization checks
-- read, which is exactly the mistake that turns a request into a back door.
CREATE TABLE IF NOT EXISTS shop_claim_requests (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id       BIGINT UNSIGNED NOT NULL,
  requester_id  BIGINT UNSIGNED NOT NULL,
  -- Why they say the shop is theirs, and whatever they offered to show it.
  reason        TEXT            NOT NULL,
  contact_phone VARCHAR(30)             DEFAULT NULL,
  status        ENUM('PENDING','APPROVED','REJECTED','WITHDRAWN')
                                NOT NULL DEFAULT 'PENDING',
  reviewer_id   BIGINT UNSIGNED         DEFAULT NULL,
  -- Mandatory on rejection (§14) and shown to the requester.
  decision_reason TEXT                  DEFAULT NULL,
  decided_at    DATETIME                DEFAULT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- 1 while the claim is live, NULL once it is decided. The only reason this
  -- exists is the unique key below; MySQL exempts NULLs from a UNIQUE index
  -- and has no partial indexes to say so directly.
  --
  -- Generated from `status` rather than from `shop_id`, which would read more
  -- naturally: a STORED column may not be derived from a column that an FK
  -- references with a referential action, and `fk_claim_req_shop` is ON
  -- DELETE CASCADE.
  claim_open    TINYINT UNSIGNED AS (IF(status = 'PENDING', 1, NULL)) STORED,
  PRIMARY KEY (id),
  -- One live claim per person per shop. A second request while the first is
  -- undecided is a retry, not a new claim, and this is what makes the submit
  -- endpoint idempotent under a double-tap (§19).
  --
  -- `claim_open` rather than `status` as the third column. With `status` the
  -- key also held decided rows unique, which capped a claimant at one
  -- WITHDRAWN and one REJECTED row per shop for life - withdrawing a second
  -- request, or a reviewer rejecting a second attempt, died on a duplicate
  -- key. Still leads with shop_id, so both foreign keys below use it.
  UNIQUE KEY uq_claim_open (shop_id, requester_id, claim_open),
  KEY idx_claim_queue (status, created_at),
  KEY idx_claim_requester (requester_id),
  CONSTRAINT fk_claim_req_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_claim_req_user FOREIGN KEY (requester_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_claim_req_reviewer FOREIGN KEY (reviewer_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS offers (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id           BIGINT UNSIGNED NOT NULL,
  category_id       BIGINT UNSIGNED         DEFAULT NULL,
  subcategory_id    BIGINT UNSIGNED         DEFAULT NULL,
  title             VARCHAR(200)    NOT NULL,
  product_name      VARCHAR(200)            DEFAULT NULL,
  description       TEXT                    DEFAULT NULL,
  -- headline shown on the card, e.g. "Buy 3 Get 3 Free", "Up to 70% OFF"
  offer_text        VARCHAR(200)            DEFAULT NULL,
  offer_type        ENUM('percentage','flat','buy_x_get_y','price_drop','up_to','other') NOT NULL DEFAULT 'percentage',
  discount_type     ENUM('percentage','flat','none') NOT NULL DEFAULT 'percentage',
  discount_value    DECIMAL(10,2)           DEFAULT NULL,
  original_price    DECIMAL(12,2)           DEFAULT NULL,
  discounted_price  DECIMAL(12,2)           DEFAULT NULL,
  buy_quantity      INT UNSIGNED            DEFAULT NULL,
  get_quantity      INT UNSIGNED            DEFAULT NULL,
  min_purchase      DECIMAL(12,2)           DEFAULT NULL,
  terms_conditions  TEXT                    DEFAULT NULL,
  eligibility       TEXT                    DEFAULT NULL,
  usage_restrictions TEXT                   DEFAULT NULL,
  applicable_products VARCHAR(500)          DEFAULT NULL,
  is_recurring      TINYINT(1)      NOT NULL DEFAULT 0,
  recurrence_type   ENUM('daily','weekly','monthly') DEFAULT NULL,
  start_date        DATETIME        NOT NULL,
  end_date          DATETIME        NOT NULL,
  status            ENUM('draft','scheduled','active','expired','deactivated') NOT NULL DEFAULT 'draft',
  -- how the offer maps to physical locations (§8.3)
  applicability_type ENUM('shop_wide','selected_branches','online') NOT NULL DEFAULT 'shop_wide',
  -- Claim rules (Claim/Redemption §17). The backend is the only enforcer of
  -- these: a client that hides the Claim button is a courtesy, not a limit.
  -- How many codes one customer may hold for this offer. 1 is the usual rule.
  claim_limit_per_customer  INT UNSIGNED    NOT NULL DEFAULT 1,
  -- Ceiling across every customer, for a genuinely limited promotion.
  total_claim_limit         INT UNSIGNED            DEFAULT NULL,
  -- How long a code stays live once issued. NULL means "until the offer ends",
  -- which is the right default: a code that outlives its offer is worthless.
  claim_validity_hours      INT UNSIGNED            DEFAULT NULL,
  -- §15: one code, one redemption, unless the offer explicitly says otherwise.
  max_redemptions_per_claim INT UNSIGNED    NOT NULL DEFAULT 1,
  view_count        INT UNSIGNED    NOT NULL DEFAULT 0,
  click_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  favorite_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  created_by        BIGINT UNSIGNED         DEFAULT NULL,
  updated_by        BIGINT UNSIGNED         DEFAULT NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_offers_shop (shop_id),
  KEY idx_offers_category (category_id),
  KEY idx_offers_status_end (status, end_date),
  KEY idx_offers_status_start (status, start_date),
  KEY idx_offers_created (created_at),
  KEY idx_offers_discount (discount_value),
  KEY idx_offers_views (view_count),
  FULLTEXT KEY ft_offers_search (title, product_name, description, offer_text),
  CONSTRAINT fk_offers_shop        FOREIGN KEY (shop_id)        REFERENCES shops (id)      ON DELETE CASCADE,
  CONSTRAINT fk_offers_category    FOREIGN KEY (category_id)    REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_offers_subcategory FOREIGN KEY (subcategory_id) REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_offers_created_by  FOREIGN KEY (created_by)     REFERENCES users (id)      ON DELETE SET NULL,
  CONSTRAINT fk_offers_updated_by  FOREIGN KEY (updated_by)     REFERENCES users (id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS offer_locations (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id  BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_offer_branch (offer_id, branch_id),
  KEY idx_ol_branch (branch_id),
  CONSTRAINT fk_ol_offer  FOREIGN KEY (offer_id)  REFERENCES offers (id)        ON DELETE CASCADE,
  CONSTRAINT fk_ol_branch FOREIGN KEY (branch_id) REFERENCES shop_branches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS offer_images (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id      BIGINT UNSIGNED NOT NULL,
  image_url     VARCHAR(500)    NOT NULL,
  thumbnail_url VARCHAR(500)            DEFAULT NULL,
  display_order INT             NOT NULL DEFAULT 0,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oi_offer (offer_id, display_order),
  CONSTRAINT fk_oi_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Customer engagement
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  offer_id   BIGINT UNSIGNED NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_favorite (user_id, offer_id),
  KEY idx_fav_offer (offer_id),
  CONSTRAINT fk_fav_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE CASCADE,
  CONSTRAINT fk_fav_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS followed_shops (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  shop_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_follow_shop (user_id, shop_id),
  KEY idx_fs_shop (shop_id),
  CONSTRAINT fk_fs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fs_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS followed_categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_follow_category (user_id, category_id),
  KEY idx_fc_category (category_id),
  CONSTRAINT fk_fc_user     FOREIGN KEY (user_id)     REFERENCES users (id)      ON DELETE CASCADE,
  CONSTRAINT fk_fc_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Customer personalization (V2 §23) — explicit onboarding preferences.
-- Distinct from followed_shops/followed_categories above: those are
-- notification opt-ins the customer can toggle from anywhere, these are
-- the weighted taste profile collected once at onboarding (categories
-- require a minimum of 5, enforced at the application layer) and reused
-- as recommendation-scoring signals. Favorite shops intentionally reuse
-- followed_shops rather than a parallel table — see preferences module.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_category_preferences (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ccp_user_category (user_id, category_id),
  KEY idx_ccp_category (category_id),
  CONSTRAINT fk_ccp_user     FOREIGN KEY (user_id)     REFERENCES users (id)      ON DELETE CASCADE,
  CONSTRAINT fk_ccp_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- offer_type here is an app-level vocabulary (PERCENTAGE_DISCOUNT, CASHBACK,
-- APP_EXCLUSIVE, ...) distinct from offers.offer_type's ENUM, which doesn't
-- cover deal shapes like cashback/combo/clearance. VARCHAR, not a FK/ENUM,
-- for the same "add a value without a migration" reason as analytics_events.
CREATE TABLE IF NOT EXISTS customer_preferred_offer_types (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  offer_type VARCHAR(40)     NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cpot_user_type (user_id, offer_type),
  CONSTRAINT fk_cpot_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  offer_id   BIGINT UNSIGNED         DEFAULT NULL,
  shop_id    BIGINT UNSIGNED         DEFAULT NULL,
  rating     TINYINT UNSIGNED NOT NULL,
  comment    TEXT                    DEFAULT NULL,
  status     ENUM('pending','approved','rejected') NOT NULL DEFAULT 'approved',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_user_offer (user_id, offer_id),
  KEY idx_review_offer (offer_id, status),
  KEY idx_review_shop (shop_id, status),
  CONSTRAINT fk_review_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE CASCADE,
  CONSTRAINT fk_review_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id)  ON DELETE CASCADE,
  CONSTRAINT ck_review_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Analytics raw events
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_views (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED         DEFAULT NULL,
  branch_id  BIGINT UNSIGNED         DEFAULT NULL,
  event_type ENUM('view','click','share','impression') NOT NULL DEFAULT 'view',
  ip_address VARCHAR(64)             DEFAULT NULL,
  -- V3: coarse location of the customer at the time of the event, which is what
  -- the location intelligence dashboard (§11) aggregates.
  city       VARCHAR(120)            DEFAULT NULL,
  latitude   DECIMAL(10,7)           DEFAULT NULL,
  longitude  DECIMAL(10,7)           DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ov_offer (offer_id, event_type),
  KEY idx_ov_created (created_at),
  -- Dashboards always slice by offer + type + window together.
  KEY idx_ov_offer_type_time (offer_id, event_type, created_at),
  KEY idx_ov_city (city),
  KEY idx_ov_user (user_id),
  CONSTRAINT fk_ov_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_ov_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        VARCHAR(60)     NOT NULL,
  title       VARCHAR(200)    NOT NULL,
  message     VARCHAR(1000)           DEFAULT NULL,
  entity_type VARCHAR(60)             DEFAULT NULL,
  entity_id   BIGINT UNSIGNED         DEFAULT NULL,
  -- Where tapping this notification lands (Push §26). Stored rather than
  -- re-derived on the client so the destination a customer taps months later
  -- is the one that was decided when the notification was created.
  deep_link   VARCHAR(255)            DEFAULT NULL,
  -- Rolled up from `push_tickets` (Push §31). 'none' means in-app only: the
  -- recipient had no registered device, or push was switched off.
  push_state  ENUM('none','queued','sent','delivered','failed','cancelled','expired')
              NOT NULL DEFAULT 'none',
  is_read     TINYINT(1)      NOT NULL DEFAULT 0,
  -- OPENED in the lifecycle: the customer actually tapped through, which is a
  -- stronger signal than merely having read the row in the feed.
  opened_at   DATETIME                DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_user (user_id, is_read, created_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id              BIGINT UNSIGNED NOT NULL,
  email_enabled        TINYINT(1) NOT NULL DEFAULT 1,
  followed_shop_offers TINYINT(1) NOT NULL DEFAULT 1,
  followed_category_offers TINYINT(1) NOT NULL DEFAULT 1,
  nearby_offers        TINYINT(1) NOT NULL DEFAULT 1,
  favorite_expiring    TINYINT(1) NOT NULL DEFAULT 1,
  saved_service_offer_expiring TINYINT(1) NOT NULL DEFAULT 1,
  offer_updates        TINYINT(1) NOT NULL DEFAULT 1,
  -- Master switch for push, alongside the existing one for email. Off does not
  -- silence the in-app feed - the notification is still created and still
  -- appears in the notification centre, it just is not pushed to a device.
  push_enabled         TINYINT(1) NOT NULL DEFAULT 1,
  -- Transactional confirmations (Push §16-§18). Default on; a customer who
  -- claimed an offer expects the code to arrive.
  claim_updates        TINYINT(1) NOT NULL DEFAULT 1,
  redemption_updates   TINYINT(1) NOT NULL DEFAULT 1,
  booking_updates      TINYINT(1) NOT NULL DEFAULT 1,
  admin_announcements  TINYINT(1) NOT NULL DEFAULT 1,
  updated_at           DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_np_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Push delivery (Push §37). The in-app feed above is the record of truth;
-- these two tables are only about getting that same record onto a phone.
-- ---------------------------------------------------------------------

-- One row per device that can receive a push. A device is identified by its
-- transport token rather than by its owner: reinstalling issues a new token,
-- and a phone that signs in as a second user must not inherit the first
-- account's notifications - so the token is unique and simply carries
-- whichever user registered it last.
CREATE TABLE IF NOT EXISTS push_devices (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  -- Expo tokens are ExponentPushToken[...]; sized for the longer raw FCM and
  -- APNs tokens a future transport would put here instead.
  token         VARCHAR(255)    NOT NULL,
  transport     ENUM('expo','fcm','apns') NOT NULL DEFAULT 'expo',
  platform      VARCHAR(40)             DEFAULT NULL,
  device_name   VARCHAR(120)            DEFAULT NULL,
  -- Deactivated rather than deleted when the transport reports the token is
  -- dead, so a reinstall that re-registers reuses one stable row.
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  failure_count INT UNSIGNED    NOT NULL DEFAULT 0,
  last_seen_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_token (token),
  KEY idx_push_user (user_id, is_active),
  CONSTRAINT fk_pd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (notification, device) handed to the transport. A single
-- notification fans out to every device its owner has, and each copy can
-- succeed or fail on its own - which is why delivery state lives here and not
-- as one column on `notifications`. Feeds the SENT -> DELIVERED / FAILED half
-- of the lifecycle (Push §31) and the per-campaign counts (Push §32).
CREATE TABLE IF NOT EXISTS push_tickets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  notification_id BIGINT UNSIGNED NOT NULL,
  -- Nullable, and detached rather than deleted when its device goes: signing
  -- out unregisters the device, and that must not erase the delivery record
  -- of pushes already sent to it - nor orphan a ticket still waiting on a
  -- receipt. The row outlives the device; only the ability to retire that
  -- device from a late failure is lost, which is moot once it is gone.
  device_id       BIGINT UNSIGNED         DEFAULT NULL,
  -- Expo's receipt id. Null when the send itself failed outright, in which
  -- case there is nothing to look up later.
  ticket_id       VARCHAR(64)             DEFAULT NULL,
  status          ENUM('queued','sent','delivered','failed') NOT NULL DEFAULT 'queued',
  error_code      VARCHAR(60)             DEFAULT NULL,
  sent_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set once the receipt has been read, so the sweep never re-checks a ticket.
  checked_at      DATETIME                DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_pt_pending (status, checked_at, sent_at),
  KEY idx_pt_notification (notification_id),
  UNIQUE KEY uq_pt_ticket (ticket_id),
  CONSTRAINT fk_pt_notification FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE,
  CONSTRAINT fk_pt_device FOREIGN KEY (device_id) REFERENCES push_devices (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED         DEFAULT NULL,
  action      VARCHAR(80)     NOT NULL,
  entity_type VARCHAR(60)     NOT NULL,
  entity_id   BIGINT UNSIGNED         DEFAULT NULL,
  old_value   JSON                    DEFAULT NULL,
  new_value   JSON                    DEFAULT NULL,
  ip_address  VARCHAR(64)             DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V2 additions
-- =====================================================================

-- ---------------------------------------------------------------------
-- Featured banners (§13). Every banner promotes one specific offer, so
-- offer_id is NOT NULL: a banner without a destination has no purpose.
-- ON DELETE CASCADE means deleting an offer takes its banners with it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banners (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title            VARCHAR(200)    NOT NULL,
  subtitle         VARCHAR(300)            DEFAULT NULL,
  description      TEXT                    DEFAULT NULL,
  image_url        VARCHAR(500)            DEFAULT NULL,
  mobile_image_url VARCHAR(500)            DEFAULT NULL,
  desktop_image_url VARCHAR(500)           DEFAULT NULL,
  offer_id         BIGINT UNSIGNED NOT NULL,
  button_text      VARCHAR(60)     NOT NULL DEFAULT 'View Offer',
  start_date       DATETIME        NOT NULL,
  end_date         DATETIME        NOT NULL,
  status           ENUM('draft','scheduled','published','expired','deactivated')
                                   NOT NULL DEFAULT 'draft',
  display_order    INT             NOT NULL DEFAULT 0,
  impression_count INT UNSIGNED    NOT NULL DEFAULT 0,
  click_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  -- V3: optional campaign grouping for the campaign performance dashboard (§15).
  -- The FK is added by the migration patch so this file stays re-runnable.
  campaign_id      BIGINT UNSIGNED         DEFAULT NULL,
  created_by       BIGINT UNSIGNED         DEFAULT NULL,
  updated_by       BIGINT UNSIGNED         DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_banner_offer (offer_id),
  -- The customer query filters on status + window and orders by display_order.
  KEY idx_banner_live (status, start_date, end_date, display_order),
  CONSTRAINT fk_banner_offer      FOREIGN KEY (offer_id)   REFERENCES offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_banner_created_by FOREIGN KEY (created_by) REFERENCES users (id)  ON DELETE SET NULL,
  CONSTRAINT fk_banner_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS banner_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  banner_id  BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED         DEFAULT NULL,
  event_type ENUM('impression','click') NOT NULL,
  ip_address VARCHAR(64)             DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_be_banner (banner_id, event_type),
  KEY idx_be_created (created_at),
  CONSTRAINT fk_be_banner FOREIGN KEY (banner_id) REFERENCES banners (id) ON DELETE CASCADE,
  CONSTRAINT fk_be_user   FOREIGN KEY (user_id)   REFERENCES users (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Claims and redemptions (§22-§24). A claim is the customer reserving an
-- offer; redemption is staff marking it used, which is what closes the
-- funnel. The code is what a QR scan resolves to.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_claims (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  -- Denormalised from the offer so shop-scoped lookups - the merchant's own
  -- claim list, the Super Admin search - hit an index instead of a join.
  shop_id      BIGINT UNSIGNED NOT NULL,
  -- Where the code was redeemed, filled in at redemption time. Which branches
  -- *may* redeem it is the offer's business (`offer_locations`), not the claim's.
  branch_id    BIGINT UNSIGNED         DEFAULT NULL,
  code         VARCHAR(24)     NOT NULL,
  -- Nth code this customer holds for this offer, 1-based. Only exists to give
  -- the unique key below something to be unique on once an offer allows more
  -- than one claim per customer; never shown to anyone.
  claim_seq    INT UNSIGNED    NOT NULL DEFAULT 1,
  status       ENUM('claimed','redeemed','expired','cancelled','revoked') NOT NULL DEFAULT 'claimed',
  claimed_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- §31. Always set: a code with no stated end is a code nobody can refuse.
  expires_at   DATETIME        NOT NULL,
  redeemed_at  DATETIME                DEFAULT NULL,
  redeemed_by  BIGINT UNSIGNED         DEFAULT NULL,
  -- How the merchant found the claim they redeemed (§30).
  verification_method ENUM('QR_SCAN','CODE_ENTRY') DEFAULT NULL,
  -- Count rather than a flag, because §15 allows an offer to permit several.
  redemption_count INT UNSIGNED   NOT NULL DEFAULT 0,
  revoked_at   DATETIME                DEFAULT NULL,
  revoked_by   BIGINT UNSIGNED         DEFAULT NULL,
  revoke_reason VARCHAR(255)           DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_claim_code (code),
  -- The per-customer claim limit is checked in application code, but two
  -- simultaneous requests would both pass that check. This key is what
  -- actually stops them: the loser gets a duplicate-key error, not a
  -- second code.
  UNIQUE KEY uq_claim_user_offer_seq (user_id, offer_id, claim_seq),
  KEY idx_claim_offer (offer_id, status),
  KEY idx_claim_shop_status (shop_id, status, claimed_at),
  KEY idx_claim_redeemed (shop_id, redeemed_at),
  KEY idx_claim_claimed (claimed_at),
  KEY idx_claim_expiry (status, expires_at),
  CONSTRAINT fk_claim_offer       FOREIGN KEY (offer_id)    REFERENCES offers (id)        ON DELETE CASCADE,
  CONSTRAINT fk_claim_user        FOREIGN KEY (user_id)     REFERENCES users (id)         ON DELETE CASCADE,
  CONSTRAINT fk_claim_shop        FOREIGN KEY (shop_id)     REFERENCES shops (id)         ON DELETE CASCADE,
  CONSTRAINT fk_claim_branch      FOREIGN KEY (branch_id)   REFERENCES shop_branches (id) ON DELETE SET NULL,
  CONSTRAINT fk_claim_redeemed_by FOREIGN KEY (redeemed_by) REFERENCES users (id)         ON DELETE SET NULL,
  CONSTRAINT fk_claim_revoked_by  FOREIGN KEY (revoked_by)  REFERENCES users (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every time a merchant points the scanner at something (§30). This is both
-- the audit trail and the evidence the rate limiter (§28) counts, which is why
-- failures are recorded as carefully as successes: a run of REJECTED rows
-- against invented codes is exactly what someone probing for a live code looks
-- like, and it leaves no other trace.
CREATE TABLE IF NOT EXISTS claim_verifications (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Which kind of claim was presented. A shopkeeper cannot tell them apart and
  -- is not asked to; this is what lets the log say which table was hit.
  claim_kind    ENUM('offer','service_offer') NOT NULL DEFAULT 'offer',
  -- Exactly one of these is set, and neither is when the code matched nothing -
  -- which is the attempt most worth keeping. Two columns rather than one
  -- polymorphic id so both keep a real foreign key.
  claim_id      BIGINT UNSIGNED         DEFAULT NULL,
  service_claim_id BIGINT UNSIGNED      DEFAULT NULL,
  offer_id      BIGINT UNSIGNED         DEFAULT NULL,
  service_offer_id BIGINT UNSIGNED      DEFAULT NULL,
  shop_id       BIGINT UNSIGNED         DEFAULT NULL,
  branch_id     BIGINT UNSIGNED         DEFAULT NULL,
  customer_id   BIGINT UNSIGNED         DEFAULT NULL,
  -- The merchant user who scanned or typed.
  verified_by   BIGINT UNSIGNED         DEFAULT NULL,
  code_attempted VARCHAR(24)            DEFAULT NULL,
  method        ENUM('QR_SCAN','CODE_ENTRY') NOT NULL DEFAULT 'CODE_ENTRY',
  action        ENUM('VERIFIED','REDEEMED','REJECTED','REVOKED') NOT NULL,
  -- Machine-readable why, e.g. NOT_FOUND, EXPIRED, ALREADY_REDEEMED. The
  -- merchant is told far less than this (§13) - it is here for disputes.
  reason        VARCHAR(60)             DEFAULT NULL,
  ip_address    VARCHAR(45)             DEFAULT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cv_claim (claim_id, created_at),
  KEY idx_cv_service_claim (service_claim_id, created_at),
  KEY idx_cv_shop (shop_id, created_at),
  -- The rate limiter's read path: this user's recent failures.
  KEY idx_cv_actor (verified_by, action, created_at),
  -- `service_offer_claims` is created further down this file, so its two
  -- constraints are attached by a migration patch rather than inline.
  CONSTRAINT fk_cv_claim    FOREIGN KEY (claim_id)    REFERENCES offer_claims (id)  ON DELETE SET NULL,
  CONSTRAINT fk_cv_offer    FOREIGN KEY (offer_id)    REFERENCES offers (id)        ON DELETE SET NULL,
  CONSTRAINT fk_cv_shop     FOREIGN KEY (shop_id)     REFERENCES shops (id)         ON DELETE SET NULL,
  CONSTRAINT fk_cv_branch   FOREIGN KEY (branch_id)   REFERENCES shop_branches (id) ON DELETE SET NULL,
  CONSTRAINT fk_cv_customer FOREIGN KEY (customer_id) REFERENCES users (id)         ON DELETE SET NULL,
  CONSTRAINT fk_cv_actor    FOREIGN KEY (verified_by) REFERENCES users (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Search terms, used only as a mild recommendation signal (§20).
CREATE TABLE IF NOT EXISTS search_history (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  term       VARCHAR(120)    NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_search_user (user_id, created_at),
  CONSTRAINT fk_search_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V3 additions - subscriptions, campaigns and the analytics warehouse
-- =====================================================================

-- ---------------------------------------------------------------------
-- One subscription row per shop (§2, §38). The plan is the single source
-- of truth for feature entitlements; everything else here is billing
-- bookkeeping that a payment provider can later drive.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_subscriptions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  plan           ENUM('FREE','BUSINESS','PREMIUM') NOT NULL DEFAULT 'FREE',
  -- 'created' is a paid plan chosen but not yet paid for; 'paused' is a
  -- Razorpay-side halt. Entitlements only follow 'active' (§9).
  status         ENUM('created','active','past_due','paused','cancelled','expired')
                 NOT NULL DEFAULT 'active',
  billing_cycle  ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  price_amount   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  currency       CHAR(3)         NOT NULL DEFAULT 'INR',
  payment_status ENUM('not_required','pending','paid','failed') NOT NULL DEFAULT 'not_required',
  started_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renews_at      DATETIME                DEFAULT NULL,
  cancelled_at   DATETIME                DEFAULT NULL,
  provider       VARCHAR(40)             DEFAULT NULL,
  provider_ref   VARCHAR(120)            DEFAULT NULL,
  -- ---- Gateway bookkeeping (Razorpay §6, §17) ----
  -- Identifiers only. No card, UPI or banking credential is ever stored.
  gateway               VARCHAR(40)      DEFAULT NULL,
  gateway_customer_id   VARCHAR(120)     DEFAULT NULL,
  gateway_subscription_id VARCHAR(120)   DEFAULT NULL,
  gateway_plan_id       VARCHAR(120)     DEFAULT NULL,
  current_period_start  DATETIME         DEFAULT NULL,
  current_period_end    DATETIME         DEFAULT NULL,
  -- Set when the merchant cancels or downgrades: benefits run to the end of
  -- the paid period before `pending_plan` takes effect (§12, §13).
  cancel_at_period_end  TINYINT(1)       NOT NULL DEFAULT 0,
  pending_plan          ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL,
  -- The plan a checkout is in flight for. Parked here rather than written
  -- to `plan`, so starting a purchase never disturbs the plan the merchant
  -- has already paid for (§7, §12). Applied by `activate()` on payment.
  checkout_plan         ENUM('FREE','BUSINESS','PREMIUM') DEFAULT NULL,
  -- How long a failed renewal keeps its features before downgrade (§10).
  grace_until           DATETIME         DEFAULT NULL,
  -- True once a UPI AutoPay / card mandate is authorised (§5).
  autopay_enabled       TINYINT(1)       NOT NULL DEFAULT 0,
  payment_method        VARCHAR(40)      DEFAULT NULL,
  last_payment_at       DATETIME         DEFAULT NULL,
  last_failure_reason   VARCHAR(255)     DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- A shop has exactly one subscription; upgrades mutate this row.
  UNIQUE KEY uq_subscription_shop (shop_id),
  KEY idx_subscription_plan (plan, status),
  KEY idx_subscription_gateway (gateway_subscription_id),
  CONSTRAINT fk_subscription_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plan change history. Kept separate from audit_logs so billing can be
-- reconstructed without trawling the generic trail.
CREATE TABLE IF NOT EXISTS subscription_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id    BIGINT UNSIGNED NOT NULL,
  from_plan  ENUM('FREE','BUSINESS','PREMIUM')         DEFAULT NULL,
  to_plan    ENUM('FREE','BUSINESS','PREMIUM') NOT NULL,
  action     ENUM('created','upgraded','downgraded','renewed','cancelled','reactivated',
                  'payment_failed','past_due','expired','grace_started') NOT NULL,
  amount     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  actor_id   BIGINT UNSIGNED         DEFAULT NULL,
  note       VARCHAR(255)            DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sub_event_shop (shop_id, created_at),
  CONSTRAINT fk_sub_event_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_sub_event_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-period usage counters (§38). `period` is the billing month (YYYY-MM),
-- which is what makes the Free plan's "one offer per month" cheap to enforce.
CREATE TABLE IF NOT EXISTS subscription_usage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id           BIGINT UNSIGNED NOT NULL,
  period            CHAR(7)         NOT NULL,
  offers_published  INT UNSIGNED    NOT NULL DEFAULT 0,
  banners_published INT UNSIGNED    NOT NULL DEFAULT 0,
  exports_generated INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_shop_period (shop_id, period),
  CONSTRAINT fk_usage_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Campaigns (§15, §25). A campaign groups banners and offers so their
-- combined performance - and optionally ROI - can be reported on.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id            BIGINT UNSIGNED NOT NULL,
  name               VARCHAR(160)    NOT NULL,
  description        VARCHAR(500)            DEFAULT NULL,
  start_date         DATETIME        NOT NULL,
  end_date           DATETIME        NOT NULL,
  -- Optional merchant inputs behind the ROI dashboard. NULL means "not
  -- provided", which is what keeps ROI hidden rather than guessed (§25).
  cost               DECIMAL(12,2)           DEFAULT NULL,
  avg_order_value    DECIMAL(12,2)           DEFAULT NULL,
  avg_margin_percent DECIMAL(5,2)            DEFAULT NULL,
  status             ENUM('draft','running','completed','archived') NOT NULL DEFAULT 'running',
  created_by         BIGINT UNSIGNED         DEFAULT NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campaign_shop (shop_id, status),
  CONSTRAINT fk_campaign_shop    FOREIGN KEY (shop_id)    REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_campaign_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_offers (
  campaign_id BIGINT UNSIGNED NOT NULL,
  offer_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (campaign_id, offer_id),
  KEY idx_co_offer (offer_id),
  CONSTRAINT fk_co_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_co_offer    FOREIGN KEY (offer_id)    REFERENCES offers (id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Generic analytics event stream (§28). Offer and banner events keep their
-- dedicated tables - this covers the discovery/customer events that have no
-- home, and carries the coarse location every location dashboard needs.
--
-- Only the fields the dashboards actually aggregate are stored; nothing here
-- identifies a customer beyond the user id already present elsewhere (§13).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type  VARCHAR(40)     NOT NULL,
  shop_id     BIGINT UNSIGNED         DEFAULT NULL,
  offer_id    BIGINT UNSIGNED         DEFAULT NULL,
  banner_id   BIGINT UNSIGNED         DEFAULT NULL,
  branch_id   BIGINT UNSIGNED         DEFAULT NULL,
  category_id BIGINT UNSIGNED         DEFAULT NULL,
  user_id     BIGINT UNSIGNED         DEFAULT NULL,
  city        VARCHAR(120)            DEFAULT NULL,
  pincode     VARCHAR(20)             DEFAULT NULL,
  latitude    DECIMAL(10,7)           DEFAULT NULL,
  longitude   DECIMAL(10,7)           DEFAULT NULL,
  term        VARCHAR(160)            DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The shape every dashboard query uses: one shop, one event type, a window.
  KEY idx_ae_shop_type_time (shop_id, event_type, created_at),
  KEY idx_ae_type_time (event_type, created_at),
  KEY idx_ae_offer (offer_id, created_at),
  KEY idx_ae_user (user_id, created_at),
  KEY idx_ae_city (city),
  CONSTRAINT fk_ae_shop   FOREIGN KEY (shop_id)   REFERENCES shops (id)         ON DELETE CASCADE,
  CONSTRAINT fk_ae_offer  FOREIGN KEY (offer_id)  REFERENCES offers (id)        ON DELETE CASCADE,
  CONSTRAINT fk_ae_banner FOREIGN KEY (banner_id) REFERENCES banners (id)       ON DELETE CASCADE,
  CONSTRAINT fk_ae_branch FOREIGN KEY (branch_id) REFERENCES shop_branches (id) ON DELETE SET NULL,
  CONSTRAINT fk_ae_user   FOREIGN KEY (user_id)   REFERENCES users (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Pre-aggregated daily rollups (§29). Dashboards read these instead of
-- scanning the raw event tables for every KPI card.
--
-- offer_id / branch_id use 0 rather than NULL for the "all" rollup so the
-- unique key actually de-duplicates (NULLs never collide in MySQL).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_daily_snapshots (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id             BIGINT UNSIGNED NOT NULL,
  snapshot_date       DATE            NOT NULL,
  offer_id            BIGINT UNSIGNED NOT NULL DEFAULT 0,
  branch_id           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  impressions         INT UNSIGNED    NOT NULL DEFAULT 0,
  views               INT UNSIGNED    NOT NULL DEFAULT 0,
  saves               INT UNSIGNED    NOT NULL DEFAULT 0,
  shares              INT UNSIGNED    NOT NULL DEFAULT 0,
  clicks              INT UNSIGNED    NOT NULL DEFAULT 0,
  claims              INT UNSIGNED    NOT NULL DEFAULT 0,
  redemptions         INT UNSIGNED    NOT NULL DEFAULT 0,
  unique_customers    INT UNSIGNED    NOT NULL DEFAULT 0,
  new_customers       INT UNSIGNED    NOT NULL DEFAULT 0,
  returning_customers INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_snapshot (shop_id, snapshot_date, offer_id, branch_id),
  KEY idx_snapshot_date (snapshot_date),
  CONSTRAINT fk_snapshot_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- First time a customer engaged with a shop, which is what makes
-- "new vs returning" (§14) answerable without scanning every event.
CREATE TABLE IF NOT EXISTS shop_customers (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  first_seen_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  visit_count    INT UNSIGNED    NOT NULL DEFAULT 1,
  save_count     INT UNSIGNED    NOT NULL DEFAULT 0,
  claim_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  redeem_count   INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shop_customer (shop_id, user_id),
  KEY idx_sc_first_seen (shop_id, first_seen_at),
  CONSTRAINT fk_shopcust_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_shopcust_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V4 additions - Services (a parallel listing type to offers) and
--  configurable saved-offer expiry notifications
-- =====================================================================

-- ---------------------------------------------------------------------
-- Services mirror the offers table's conventions (shop/category/branch/
-- image ownership, status lifecycle, denormalized counters) but carry
-- service-specific fields (pricing model, duration, availability,
-- booking) instead of discount fields. Categories are shared with
-- offers - no separate service_categories table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id               BIGINT UNSIGNED NOT NULL,
  category_id           BIGINT UNSIGNED         DEFAULT NULL,
  subcategory_id        BIGINT UNSIGNED         DEFAULT NULL,
  name                  VARCHAR(200)    NOT NULL,
  description           TEXT                    DEFAULT NULL,
  pricing_type          ENUM('fixed','starting_from','price_on_enquiry') NOT NULL DEFAULT 'fixed',
  price                 DECIMAL(12,2)           DEFAULT NULL,
  duration_minutes      INT UNSIGNED            DEFAULT NULL,
  duration_label        VARCHAR(60)             DEFAULT NULL,
  -- CSV of 3-letter day codes, e.g. 'mon,tue,wed'.
  available_days        VARCHAR(120)            DEFAULT NULL,
  available_time_start  TIME                    DEFAULT NULL,
  available_time_end    TIME                    DEFAULT NULL,
  home_service          TINYINT(1)      NOT NULL DEFAULT 0,
  walk_in_available     TINYINT(1)      NOT NULL DEFAULT 0,
  appointment_required  TINYINT(1)      NOT NULL DEFAULT 0,
  booking_type          ENUM('walk_in','appointment','both','enquiry_only') NOT NULL DEFAULT 'walk_in',
  service_area          VARCHAR(255)            DEFAULT NULL,
  terms_conditions      TEXT                    DEFAULT NULL,
  applicability_type    ENUM('shop_wide','selected_branches','online') NOT NULL DEFAULT 'shop_wide',
  status                ENUM('draft','scheduled','active','paused','expired','deactivated') NOT NULL DEFAULT 'draft',
  start_date            DATETIME                DEFAULT NULL,
  end_date              DATETIME                DEFAULT NULL,
  view_count            INT UNSIGNED    NOT NULL DEFAULT 0,
  click_count           INT UNSIGNED    NOT NULL DEFAULT 0,
  save_count            INT UNSIGNED    NOT NULL DEFAULT 0,
  created_by            BIGINT UNSIGNED         DEFAULT NULL,
  updated_by            BIGINT UNSIGNED         DEFAULT NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_services_shop (shop_id),
  KEY idx_services_category (category_id),
  KEY idx_services_status_end (status, end_date),
  KEY idx_services_status_start (status, start_date),
  KEY idx_services_created (created_at),
  FULLTEXT KEY ft_services_search (name, description),
  CONSTRAINT fk_services_shop        FOREIGN KEY (shop_id)        REFERENCES shops (id)      ON DELETE CASCADE,
  CONSTRAINT fk_services_category    FOREIGN KEY (category_id)    REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_services_subcategory FOREIGN KEY (subcategory_id) REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_services_created_by  FOREIGN KEY (created_by)     REFERENCES users (id)      ON DELETE SET NULL,
  CONSTRAINT fk_services_updated_by  FOREIGN KEY (updated_by)     REFERENCES users (id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_locations (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_branch (service_id, branch_id),
  KEY idx_sl_branch (branch_id),
  CONSTRAINT fk_sl_service FOREIGN KEY (service_id) REFERENCES services (id)      ON DELETE CASCADE,
  CONSTRAINT fk_sl_branch  FOREIGN KEY (branch_id)  REFERENCES shop_branches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_images (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id    BIGINT UNSIGNED NOT NULL,
  image_url     VARCHAR(500)    NOT NULL,
  thumbnail_url VARCHAR(500)            DEFAULT NULL,
  display_order INT             NOT NULL DEFAULT 0,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_si_service (service_id, display_order),
  CONSTRAINT fk_si_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The promotional layer on a service (§6: "an Offer belongs to a Listing").
-- One service can carry many offers over time; this is never merged back
-- into the services row.
CREATE TABLE IF NOT EXISTS service_offers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id       BIGINT UNSIGNED NOT NULL,
  -- Denormalized so shop-scope checks/joins don't always need `services`.
  shop_id          BIGINT UNSIGNED NOT NULL,
  offer_text       VARCHAR(200)            DEFAULT NULL,
  offer_type       ENUM('percentage','flat','price_drop','other') NOT NULL DEFAULT 'percentage',
  discount_type    ENUM('percentage','flat','none') NOT NULL DEFAULT 'percentage',
  discount_value   DECIMAL(10,2)           DEFAULT NULL,
  original_price   DECIMAL(12,2)           DEFAULT NULL,
  offer_price      DECIMAL(12,2)           DEFAULT NULL,
  terms_conditions TEXT                    DEFAULT NULL,
  is_recurring     TINYINT(1)      NOT NULL DEFAULT 0,
  recurrence_type  ENUM('daily','weekly','monthly') DEFAULT NULL,
  start_date       DATETIME        NOT NULL,
  end_date         DATETIME        NOT NULL,
  status           ENUM('draft','scheduled','active','expired','deactivated') NOT NULL DEFAULT 'draft',
  -- Claim rules, identical in meaning to the ones on `offers` (§17, §22): a
  -- service offer is claimed and redeemed by exactly the same mechanism.
  claim_limit_per_customer  INT UNSIGNED   NOT NULL DEFAULT 1,
  total_claim_limit         INT UNSIGNED           DEFAULT NULL,
  claim_validity_hours      INT UNSIGNED           DEFAULT NULL,
  max_redemptions_per_claim INT UNSIGNED   NOT NULL DEFAULT 1,
  view_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  claim_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  created_by       BIGINT UNSIGNED         DEFAULT NULL,
  updated_by       BIGINT UNSIGNED         DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_so_service (service_id),
  KEY idx_so_shop (shop_id),
  KEY idx_so_status_end (status, end_date),
  CONSTRAINT fk_so_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_so_shop    FOREIGN KEY (shop_id)    REFERENCES shops (id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Column-for-column the same shape as `offer_claims`, because §22 makes it the
-- same workflow: the shopkeeper scanning a code has no idea whether it belongs
-- to a shirt or to an AC service, and nothing about the counter differs.
CREATE TABLE IF NOT EXISTS service_offer_claims (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_offer_id BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  shop_id          BIGINT UNSIGNED NOT NULL,
  branch_id        BIGINT UNSIGNED         DEFAULT NULL,
  code             VARCHAR(24)     NOT NULL,
  claim_seq        INT UNSIGNED    NOT NULL DEFAULT 1,
  status           ENUM('claimed','redeemed','expired','cancelled','revoked') NOT NULL DEFAULT 'claimed',
  claimed_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at       DATETIME        NOT NULL,
  redeemed_at      DATETIME                DEFAULT NULL,
  redeemed_by      BIGINT UNSIGNED         DEFAULT NULL,
  verification_method ENUM('QR_SCAN','CODE_ENTRY') DEFAULT NULL,
  redemption_count INT UNSIGNED    NOT NULL DEFAULT 0,
  revoked_at       DATETIME                DEFAULT NULL,
  revoked_by       BIGINT UNSIGNED         DEFAULT NULL,
  revoke_reason    VARCHAR(255)            DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_claim_code (code),
  UNIQUE KEY uq_service_claim_user_offer_seq (user_id, service_offer_id, claim_seq),
  KEY idx_service_claim_offer (service_offer_id, status),
  KEY idx_service_claim_shop_status (shop_id, status, claimed_at),
  KEY idx_service_claim_redeemed (shop_id, redeemed_at),
  KEY idx_service_claim_claimed (claimed_at),
  KEY idx_service_claim_expiry (status, expires_at),
  CONSTRAINT fk_soc_offer       FOREIGN KEY (service_offer_id) REFERENCES service_offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_soc_user        FOREIGN KEY (user_id)          REFERENCES users (id)          ON DELETE CASCADE,
  CONSTRAINT fk_soc_shop        FOREIGN KEY (shop_id)          REFERENCES shops (id)          ON DELETE CASCADE,
  CONSTRAINT fk_soc_branch      FOREIGN KEY (branch_id)        REFERENCES shop_branches (id)  ON DELETE SET NULL,
  CONSTRAINT fk_soc_redeemed_by FOREIGN KEY (redeemed_by)      REFERENCES users (id)          ON DELETE SET NULL,
  CONSTRAINT fk_soc_revoked_by  FOREIGN KEY (revoked_by)       REFERENCES users (id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "Saved offers" for services, mirroring `favorites`.
CREATE TABLE IF NOT EXISTS saved_services (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saved_service (user_id, service_id),
  KEY idx_ss_service (service_id),
  CONSTRAINT fk_ss_user    FOREIGN KEY (user_id)    REFERENCES users (id)    ON DELETE CASCADE,
  CONSTRAINT fk_ss_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Minimal booking-request entity backing MANAGE_SERVICE_BOOKING and the
-- SERVICE_BOOK/SERVICE_CANCEL analytics events.
CREATE TABLE IF NOT EXISTS service_bookings (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id       BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  branch_id        BIGINT UNSIGNED         DEFAULT NULL,
  service_offer_id BIGINT UNSIGNED         DEFAULT NULL,
  requested_at     DATETIME                DEFAULT NULL,
  status           ENUM('requested','confirmed','completed','cancelled') NOT NULL DEFAULT 'requested',
  notes            VARCHAR(500)            DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sb_service (service_id, status),
  KEY idx_sb_user (user_id),
  CONSTRAINT fk_sb_service FOREIGN KEY (service_id)      REFERENCES services (id)       ON DELETE CASCADE,
  CONSTRAINT fk_sb_user    FOREIGN KEY (user_id)          REFERENCES users (id)          ON DELETE CASCADE,
  CONSTRAINT fk_sb_branch  FOREIGN KEY (branch_id)        REFERENCES shop_branches (id)  ON DELETE SET NULL,
  CONSTRAINT fk_sb_offer   FOREIGN KEY (service_offer_id) REFERENCES service_offers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Configurable saved-offer expiry reminders (§24-§26). Thresholds are
-- shared across product offers and service offers - "do not implement
-- separate expiry logic" applies across listing types too, not just
-- across web/mobile.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_thresholds (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  hours_before INT UNSIGNED    NOT NULL,
  label        VARCHAR(60)             DEFAULT NULL,
  is_active    TINYINT(1)      NOT NULL DEFAULT 1,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_threshold_hours (hours_before)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dedup ledger: one row per (user, notification type, entity, threshold)
-- that has already fired, kept separate from the user-facing
-- `notifications` table so its `type` values stay stable and readable.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  type            VARCHAR(60)     NOT NULL,
  entity_type     VARCHAR(60)     NOT NULL,
  entity_id       BIGINT UNSIGNED NOT NULL,
  threshold_hours INT UNSIGNED    NOT NULL,
  sent_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notif_delivery (user_id, type, entity_type, entity_id, threshold_hours),
  KEY idx_nd_entity (entity_type, entity_id),
  CONSTRAINT fk_nd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V3 Payments (Razorpay) - "Razorpay Payments & Persistent Login" §17
-- =====================================================================

-- ---------------------------------------------------------------------
-- Every payment attempt the gateway told us about (§17). One row per
-- Razorpay payment; `gateway_payment_id` is unique so a webhook replay
-- updates the existing row rather than inserting a duplicate.
--
-- Nothing here can identify a card: only gateway references, the last
-- four digits Razorpay itself echoes back, and the method name (§6).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id            BIGINT UNSIGNED NOT NULL,
  subscription_id    BIGINT UNSIGNED         DEFAULT NULL,
  gateway            VARCHAR(40)     NOT NULL DEFAULT 'razorpay',
  gateway_order_id   VARCHAR(120)            DEFAULT NULL,
  gateway_payment_id VARCHAR(120)            DEFAULT NULL,
  gateway_invoice_id VARCHAR(120)            DEFAULT NULL,
  plan               ENUM('FREE','BUSINESS','PREMIUM') NOT NULL DEFAULT 'FREE',
  amount             DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  amount_refunded    DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  currency           CHAR(3)         NOT NULL DEFAULT 'INR',
  -- 'upi', 'card', 'netbanking', 'wallet' ... whatever Razorpay reports.
  payment_method     VARCHAR(40)             DEFAULT NULL,
  -- Safe-to-store descriptors Razorpay echoes back; never the full number.
  method_detail      VARCHAR(120)            DEFAULT NULL,
  status             ENUM('CREATED','PENDING','AUTHORIZED','CAPTURED','FAILED',
                          'REFUNDED','PARTIALLY_REFUNDED','CANCELLED')
                     NOT NULL DEFAULT 'CREATED',
  failure_reason     VARCHAR(255)            DEFAULT NULL,
  paid_at            DATETIME                DEFAULT NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_gateway_payment (gateway_payment_id),
  KEY idx_payment_shop (shop_id, created_at),
  KEY idx_payment_order (gateway_order_id),
  KEY idx_payment_status (status),
  CONSTRAINT fk_payment_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Raw webhook ledger (§8, §17). The unique key on (gateway, event_id) is
-- what makes processing idempotent: a redelivered event collides on
-- insert, so the handler can tell "seen before" from "new" atomically
-- rather than by reading first and racing itself.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_webhooks (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gateway      VARCHAR(40)     NOT NULL DEFAULT 'razorpay',
  event_id     VARCHAR(160)    NOT NULL,
  event_type   VARCHAR(80)     NOT NULL,
  payload      JSON            NOT NULL,
  processed    TINYINT(1)      NOT NULL DEFAULT 0,
  processed_at DATETIME                DEFAULT NULL,
  error        VARCHAR(500)            DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_event (gateway, event_id),
  KEY idx_webhook_type (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Issued invoices (§16). Generated from a captured payment, so an
-- invoice only ever exists for money that actually arrived.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id        BIGINT UNSIGNED NOT NULL,
  transaction_id BIGINT UNSIGNED         DEFAULT NULL,
  number         VARCHAR(40)     NOT NULL,
  plan           ENUM('FREE','BUSINESS','PREMIUM') NOT NULL,
  period_start   DATETIME                DEFAULT NULL,
  period_end     DATETIME                DEFAULT NULL,
  -- Amount excluding tax, the tax charged, and what the merchant paid.
  subtotal       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  tax_amount     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  total          DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  currency       CHAR(3)         NOT NULL DEFAULT 'INR',
  status         ENUM('issued','paid','void','refunded') NOT NULL DEFAULT 'paid',
  billing_name   VARCHAR(190)            DEFAULT NULL,
  billing_address VARCHAR(500)           DEFAULT NULL,
  issued_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_number (number),
  KEY idx_invoice_shop (shop_id, issued_at),
  CONSTRAINT fk_invoice_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_txn  FOREIGN KEY (transaction_id)
    REFERENCES payment_transactions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  Super Admin feature overrides (§11A-§11L)
-- =====================================================================

-- Controlled catalogue (§11J). An override may only name a key that
-- exists and is active here, which is what stops a typo or an invented
-- feature name from being inserted and then silently never matching.
CREATE TABLE IF NOT EXISTS feature_catalogue (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  feature_key VARCHAR(60)     NOT NULL,
  name        VARCHAR(120)    NOT NULL,
  description VARCHAR(255)            DEFAULT NULL,
  category    VARCHAR(60)     NOT NULL DEFAULT 'General',
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_feature_key (feature_key),
  KEY idx_feature_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (shop, feature) grant (§11J). Scoped to the shop rather
-- than the admin user: entitlements are consumed per shop everywhere
-- else, and a shop's staff must all see the same feature set.
-- `admin_user_id` records which merchant account the grant was made for.
CREATE TABLE IF NOT EXISTS feature_overrides (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id       BIGINT UNSIGNED NOT NULL,
  admin_user_id BIGINT UNSIGNED         DEFAULT NULL,
  feature_key   VARCHAR(60)     NOT NULL,
  status        ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  starts_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME                DEFAULT NULL,
  is_permanent  TINYINT(1)      NOT NULL DEFAULT 0,
  reason        VARCHAR(500)            DEFAULT NULL,
  granted_by    BIGINT UNSIGNED         DEFAULT NULL,
  revoked_by    BIGINT UNSIGNED         DEFAULT NULL,
  revoked_at    DATETIME                DEFAULT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- A shop has at most one override row per feature; re-granting a
  -- revoked feature reactivates this row so its history stays in one place.
  UNIQUE KEY uq_override_shop_feature (shop_id, feature_key),
  KEY idx_override_status (status, expires_at),
  KEY idx_override_feature (feature_key, status),
  CONSTRAINT fk_override_shop    FOREIGN KEY (shop_id)       REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_override_admin   FOREIGN KEY (admin_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_override_granter FOREIGN KEY (granted_by)    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_override_revoker FOREIGN KEY (revoked_by)    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only history of every override action (§11I). Separate from
-- audit_logs so "who gave ABC Stores Advanced Analytics, and when did it
-- lapse" is one query rather than a search through the generic trail.
CREATE TABLE IF NOT EXISTS feature_override_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  override_id    BIGINT UNSIGNED         DEFAULT NULL,
  shop_id        BIGINT UNSIGNED NOT NULL,
  admin_user_id  BIGINT UNSIGNED         DEFAULT NULL,
  feature_key    VARCHAR(60)     NOT NULL,
  action         ENUM('GRANTED','REVOKED','EXTENDED','EXPIRED','MODIFIED') NOT NULL,
  previous_state JSON                    DEFAULT NULL,
  new_state      JSON                    DEFAULT NULL,
  starts_at      DATETIME                DEFAULT NULL,
  expires_at     DATETIME                DEFAULT NULL,
  reason         VARCHAR(500)            DEFAULT NULL,
  actor_id       BIGINT UNSIGNED         DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_override_event_shop (shop_id, created_at),
  KEY idx_override_event_override (override_id, created_at),
  CONSTRAINT fk_override_event_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_override_event_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  Premium AI (TOY.md): what each plan unlocks, and what has been used
-- =====================================================================
--
-- `subscription_plans` is deliberately *not* the record of which plan a shop
-- is on - `shop_subscriptions` above is, and it carries the billing state
-- Razorpay drives. This table says what a plan *code* unlocks in the AI layer.
-- The two are joined on `code` rather than by foreign key, so a Super Admin can
-- retune AI limits without touching a subscription row or a payment, and a plan
-- change made through billing needs nothing synced over here.
--
-- Limit columns: NULL means unlimited, 0 means the feature is off for the plan
-- even if the matching *_enabled flag is somehow set.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscription_plans (
  id                         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                       VARCHAR(40)     NOT NULL,
  name                       VARCHAR(120)    NOT NULL,
  description                VARCHAR(500)            DEFAULT NULL,
  price_monthly              DECIMAL(10,2)   NOT NULL DEFAULT 0,
  currency                   CHAR(3)         NOT NULL DEFAULT 'INR',

  ai_assistant_enabled       TINYINT(1)      NOT NULL DEFAULT 0,
  ai_content_enabled         TINYINT(1)      NOT NULL DEFAULT 0,
  ai_optimizer_enabled       TINYINT(1)      NOT NULL DEFAULT 0,

  -- Premium-only context the assistant may reason from (§11, §12, §13).
  historical_insights        TINYINT(1)      NOT NULL DEFAULT 0,
  location_insights          TINYINT(1)      NOT NULL DEFAULT 0,
  timing_insights            TINYINT(1)      NOT NULL DEFAULT 0,
  social_caption_enabled     TINYINT(1)      NOT NULL DEFAULT 0,

  ai_assistant_monthly_limit INT UNSIGNED            DEFAULT 0,
  ai_content_monthly_limit   INT UNSIGNED            DEFAULT 0,
  ai_optimizer_monthly_limit INT UNSIGNED            DEFAULT 0,

  display_order              INT             NOT NULL DEFAULT 0,
  is_system                  TINYINT(1)      NOT NULL DEFAULT 0,
  status                     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at                 DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_code (code),
  KEY idx_plan_status (status, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per successful AI generation, which is what the monthly quota counts.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id           BIGINT UNSIGNED NOT NULL,
  user_id           BIGINT UNSIGNED         DEFAULT NULL,
  feature           VARCHAR(40)     NOT NULL,
  plan_code         VARCHAR(40)             DEFAULT NULL,
  provider          VARCHAR(40)             DEFAULT NULL,
  model             VARCHAR(80)             DEFAULT NULL,
  prompt_tokens     INT UNSIGNED    NOT NULL DEFAULT 0,
  completion_tokens INT UNSIGNED    NOT NULL DEFAULT 0,
  total_tokens      INT UNSIGNED    NOT NULL DEFAULT 0,
  status            ENUM('success','failure') NOT NULL DEFAULT 'success',
  error_code        VARCHAR(60)             DEFAULT NULL,
  duration_ms       INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The monthly quota check reads exactly this key.
  KEY idx_ai_usage_quota (shop_id, feature, status, created_at),
  KEY idx_ai_usage_user (user_id, created_at),
  CONSTRAINT fk_ai_usage_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The generated artefacts themselves, kept so a merchant can revisit them.
CREATE TABLE IF NOT EXISTS ai_generations (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id          BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED         DEFAULT NULL,
  feature          VARCHAR(40)     NOT NULL,
  offer_id         BIGINT UNSIGNED         DEFAULT NULL,
  request_summary  VARCHAR(500)            DEFAULT NULL,
  result_summary   VARCHAR(500)            DEFAULT NULL,
  request_payload  JSON                    DEFAULT NULL,
  result_payload   JSON                    DEFAULT NULL,
  outcome          ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_gen_shop (shop_id, created_at),
  KEY idx_ai_gen_offer (offer_id),
  CONSTRAINT fk_ai_gen_shop  FOREIGN KEY (shop_id)  REFERENCES shops (id)  ON DELETE CASCADE,
  CONSTRAINT fk_ai_gen_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE SET NULL,
  CONSTRAINT fk_ai_gen_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  V5 additions - Business Dashboard & graceful failure
--  ("Business Dashboard & Graceful Failure Requirements" §34-§59)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internal failure log (§56).
--
-- What a customer is shown for a failure is deliberately vague (§37, §38);
-- this is where the detail that was withheld from them actually lands, so
-- support can answer "what happened to request REQ-82917?" without shell
-- access to a log file.
--
-- Deliberately absent: request bodies, headers, tokens, email addresses and
-- anything else §56 calls "unnecessary sensitive information". A user id is
-- kept because tracing one person's broken checkout is the whole point; the
-- message is truncated rather than stored whole for the same reason.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The reference shown to the user, e.g. REQ-82917 (§57). Unique so the
  -- support lookup is a single indexed read.
  request_id   VARCHAR(40)     NOT NULL,
  user_id      BIGINT UNSIGNED         DEFAULT NULL,
  shop_id      BIGINT UNSIGNED         DEFAULT NULL,
  method       VARCHAR(10)     NOT NULL,
  -- The route pattern where Express knows it (`/offers/:id`), so a thousand
  -- failures on one endpoint group instead of scattering across ids.
  endpoint     VARCHAR(255)    NOT NULL,
  error_type   VARCHAR(80)     NOT NULL,
  -- The stable application code (Logging §8) and its category (§9):
  -- DB_QUERY_TIMEOUT / DATABASE, not the driver's ECONNREFUSED. These are what
  -- the monitoring dashboard filters and groups on (§28, §30), so they must
  -- survive a change of driver, ORM or error message.
  error_code   VARCHAR(60)             DEFAULT NULL,
  category     VARCHAR(40)             DEFAULT NULL,
  http_status  SMALLINT UNSIGNED NOT NULL,
  -- Which dependency was blamed: DATABASE, RAZORPAY, PUSH, STORAGE, GEOCODING,
  -- EMAIL, AI or NULL for a fault of our own.
  dependency   VARCHAR(40)             DEFAULT NULL,
  message      VARCHAR(500)            DEFAULT NULL,
  -- Reported by the client (§56): 'web', 'ios', 'android'.
  platform     VARCHAR(40)             DEFAULT NULL,
  app_version  VARCHAR(40)             DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_error_request (request_id),
  -- The spike detector's read path (§59): one dependency, one short window.
  KEY idx_error_dependency_time (dependency, created_at),
  KEY idx_error_time (created_at),
  KEY idx_error_endpoint (endpoint, created_at),
  -- §30's grouping read: "how many DB_CONNECTION_FAILED in the last 30 min".
  KEY idx_error_code_time (error_code, created_at),
  KEY idx_error_category_time (category, created_at),
  CONSTRAINT fk_error_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_error_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Idempotency keys (§50, §51).
--
-- §50 says that after a timeout on a payment, claim, redemption or booking
-- the client must "first determine whether the original request was
-- completed" rather than blindly repeating it. It cannot determine that on
-- its own - the whole problem is that it never heard back - so the server
-- remembers instead: the client sends the same key on the retry and gets the
-- original answer, not a second charge.
--
-- The unique key is (idempotency_key, user_id): keys are client-generated, so
-- scoping them to the user is what stops one client's UUID collision from
-- handing someone else's response to a stranger.
--
-- `fingerprint` is a hash of the request body. A key reused with different
-- content is a client bug, and answering it with the first request's result
-- would silently drop the second - so it is refused loudly instead.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  idempotency_key VARCHAR(120)    NOT NULL,
  user_id         BIGINT UNSIGNED         DEFAULT NULL,
  endpoint        VARCHAR(255)    NOT NULL,
  fingerprint     CHAR(64)        NOT NULL,
  -- 'in_progress' is the window between the first request starting and
  -- finishing. A retry arriving inside it is told to wait rather than being
  -- allowed to run a second copy of a payment.
  status          ENUM('in_progress','completed') NOT NULL DEFAULT 'in_progress',
  response_status SMALLINT UNSIGNED       DEFAULT NULL,
  response_body   JSON                    DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME                DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_idempotency (idempotency_key, user_id),
  KEY idx_idempotency_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Support tickets.
--
-- The Support page is a form rather than a phone number, so a request has to
-- land somewhere durable: the customer is shown a reference on submit and
-- expects to be able to quote it later, and whoever answers needs a queue
-- rather than an inbox.
--
-- `user_id` is nullable because the platform is browsable without an account
-- (§3) and a guest who cannot get a page to load is exactly the person most
-- likely to need support. Their name, email and phone are therefore stored on
-- the ticket itself rather than read from a user row - which is also why a
-- signed-in user's details are copied in at submit time rather than joined at
-- read time: what they typed is what the reply should go to, even if they
-- change their account email afterwards.
--
-- `entity_type`/`entity_id` carry "Report an Offer/Shop": the platform lists
-- merchant-submitted content, so a customer needs a way to report an offer
-- that is wrong, misleading, expired or fraudulent, and a report is a support
-- ticket that already knows what it is about.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_tickets (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Human-quotable, and deliberately not the primary key: "SUP-10248" is what
  -- a customer reads back over the phone. Assigned from the id after insert.
  reference      VARCHAR(20)             DEFAULT NULL,
  user_id        BIGINT UNSIGNED         DEFAULT NULL,
  name           VARCHAR(120)    NOT NULL,
  email          VARCHAR(190)    NOT NULL,
  phone          VARCHAR(30)             DEFAULT NULL,
  -- Who is asking, in their own words. Decides which queue this belongs to and
  -- how the reply is pitched; it is not an authorization signal.
  user_type      ENUM('customer','merchant','guest') NOT NULL DEFAULT 'customer',
  category       VARCHAR(40)     NOT NULL,
  subject        VARCHAR(200)    NOT NULL,
  description    TEXT            NOT NULL,
  attachment_url VARCHAR(500)            DEFAULT NULL,
  -- What the ticket is about, when it is about something on the platform.
  entity_type    VARCHAR(40)             DEFAULT NULL,
  entity_id      BIGINT UNSIGNED         DEFAULT NULL,
  status         ENUM('open','in_progress','waiting_on_customer','resolved','closed')
                 NOT NULL DEFAULT 'open',
  priority       ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
  assigned_to    BIGINT UNSIGNED         DEFAULT NULL,
  resolved_at    DATETIME                DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_support_reference (reference),
  -- The customer's "my requests" list.
  KEY idx_support_user (user_id, created_at),
  -- The support queue, which is read status-first and oldest-first within it.
  KEY idx_support_status (status, created_at),
  KEY idx_support_category (category, created_at),
  KEY idx_support_entity (entity_type, entity_id),
  -- SET NULL rather than CASCADE: a deleted account must not take the record
  -- of what it reported with it, and the ticket still has its own contact
  -- details to answer on.
  CONSTRAINT fk_support_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_support_assignee FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- The conversation on a ticket.
--
-- "Response sent" is a step in the support flow, so a reply needs somewhere to
-- live that the customer can read - a mailbox thread nobody else can see is
-- how a handover loses the history.
--
-- `is_internal` keeps a triage note out of the customer's view. It is enforced
-- in the service's read path, not here; the column only records the intent.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id   BIGINT UNSIGNED NOT NULL,
  -- NULL for the customer's own opening message when they were a guest.
  author_id   BIGINT UNSIGNED         DEFAULT NULL,
  -- Which side of the conversation this is, kept independently of author_id so
  -- a guest's message is still attributable and a deleted staff account does
  -- not turn its replies into customer messages.
  author_role ENUM('customer','support') NOT NULL,
  body        TEXT            NOT NULL,
  is_internal TINYINT(1)      NOT NULL DEFAULT 0,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_msg_ticket (ticket_id, created_at),
  CONSTRAINT fk_support_msg_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_support_msg_author FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
--  Visibility & Promotion System
--  ("Offers App - Visibility & Promotion System" §22, §31, §32)
--
--  Ten tables, in the order §31 lists them. The through-line: nothing about
--  how listings are ranked or promoted may be a constant in the code (§4,
--  §22), and every prominent impression a customer receives has to be
--  attributable afterwards (§17, §20).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Configurable ranking weights (§4: "Weights must be configurable from the
-- backend rather than permanently hard-coded").
--
-- One row per (surface, factor). Surfaces are separate because the same
-- factor means different things in different places: §13 orders search by
-- relevance first, §14 starts Near Me from the customer's location, and a
-- single global weight set cannot satisfy both.
--
-- Defaults are seeded from `config/visibility.js`; a missing row falls back
-- to that default rather than scoring zero, so a bad delete degrades the
-- ranking instead of emptying it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ranking_weights (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  surface    VARCHAR(40)     NOT NULL,
  factor     VARCHAR(40)     NOT NULL,
  weight     DECIMAL(6,3)    NOT NULL DEFAULT 1.000,
  -- Turning a factor off is not the same as weighting it 0: the weight is
  -- preserved so it can be switched back on at the value it was tuned to.
  is_active  TINYINT(1)      NOT NULL DEFAULT 1,
  updated_by BIGINT UNSIGNED         DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ranking_weight (surface, factor),
  CONSTRAINT fk_rw_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- The rest of the tunables (§2.3, §2.6, §10, §18, §19, §25): decay curve
-- shapes, diversity limits, rotation timing, anti-manipulation thresholds.
--
-- A weight says how much a factor counts; a rule says what the factor's
-- curve looks like. Halving `freshnessHalfLifeDays` and halving the
-- FRESHNESS weight are different changes with different effects, and §22
-- puts both in the Super Admin's hands.
--
-- `value_number` and `value_json` rather than one text column: most rules
-- are a single number and are read on every ranked request, and parsing JSON
-- to get "3" back would be a strange price to pay for uniformity.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visibility_rules (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_key     VARCHAR(80)     NOT NULL,
  value_number DECIMAL(12,4)           DEFAULT NULL,
  value_json   JSON                    DEFAULT NULL,
  description  VARCHAR(255)            DEFAULT NULL,
  is_active    TINYINT(1)      NOT NULL DEFAULT 1,
  updated_by   BIGINT UNSIGNED         DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_visibility_rule (rule_key),
  CONSTRAINT fk_vr_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Featured slots (§6, §11): the controlled promotional spaces themselves.
--
-- `capacity` is what makes §10's rotation meaningful. A slot that showed
-- every eligible campaign at once would need no rotation and would also be
-- useless; capping it at N and rotating the eligible pool through those N
-- positions is exactly the difference between "A A A A" and "A B C A".
--
-- `min_plan_rank` is the slot's own eligibility floor (§9): 2 for the
-- Premium-only spaces, 1 for Ending Soon, which §12 opens to Business too.
-- It is a floor, not the whole check - `promotion.service` still validates
-- the offer, the shop, the location and the schedule.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS featured_slots (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(60)     NOT NULL,
  placement_type VARCHAR(40)     NOT NULL,
  name           VARCHAR(120)    NOT NULL,
  description    VARCHAR(500)            DEFAULT NULL,
  capacity       SMALLINT UNSIGNED NOT NULL DEFAULT 4,
  min_plan_rank  TINYINT UNSIGNED NOT NULL DEFAULT 2,
  -- Slot-level targeting, for spaces that exist only in one place: a
  -- "Featured in Clothing" slot pins its own category so campaigns cannot
  -- wander into it from elsewhere.
  category_id    BIGINT UNSIGNED         DEFAULT NULL,
  city           VARCHAR(120)            DEFAULT NULL,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_slot_code (code),
  KEY idx_slot_placement (placement_type, status),
  CONSTRAINT fk_slot_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Featured campaigns (§8, §9, §10).
--
-- A campaign is a merchant's bid for a slot over a window, with its own
-- targeting. §8 requires the system to activate and deactivate it on
-- schedule, which is why `start_at`/`end_at` are authoritative and `status`
-- is a cache the scheduler maintains: the live query re-checks the window on
-- every read, so a scheduler that has not run yet can make a list look stale
-- but can never show an expired campaign (§24).
--
-- `campaign_id` links to the existing `campaigns` table (the merchant's ROI
-- grouping) so a Featured campaign's spend and its organic offers report
-- together. It is optional - a Featured campaign is useful on its own.
--
-- `status` carries approval as well as lifecycle because §22 gives Super
-- Admin campaign approval, and an approved-but-not-yet-started campaign is a
-- different thing from one awaiting review.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS featured_campaigns (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id            BIGINT UNSIGNED NOT NULL,
  slot_id            BIGINT UNSIGNED NOT NULL,
  campaign_id        BIGINT UNSIGNED         DEFAULT NULL,
  name               VARCHAR(160)    NOT NULL,
  description        VARCHAR(500)            DEFAULT NULL,
  placement_type     VARCHAR(40)     NOT NULL,
  -- Targeting (§8). All optional: an untargeted campaign is eligible
  -- wherever its slot appears, which is the sensible default for a small
  -- merchant with one shop.
  target_category_id BIGINT UNSIGNED         DEFAULT NULL,
  target_city        VARCHAR(120)            DEFAULT NULL,
  target_latitude    DECIMAL(10,7)           DEFAULT NULL,
  target_longitude   DECIMAL(10,7)           DEFAULT NULL,
  target_radius_km   DECIMAL(6,2)            DEFAULT NULL,
  start_at           DATETIME        NOT NULL,
  end_at             DATETIME        NOT NULL,
  -- A Super Admin's ordering hint inside a slot. Deliberately narrow: §10
  -- settles ordering by rotation, and a priority that could override that
  -- would reintroduce the permanent #1 position §21 forbids.
  priority           TINYINT         NOT NULL DEFAULT 0,
  status             ENUM('draft','pending_approval','approved','active','paused',
                          'completed','rejected','archived') NOT NULL DEFAULT 'draft',
  -- Exposure bookkeeping for §10's rotation. Maintained by the placement
  -- service as it serves the slot.
  exposure_count     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_shown_at      DATETIME                DEFAULT NULL,
  approved_by        BIGINT UNSIGNED         DEFAULT NULL,
  approved_at        DATETIME                DEFAULT NULL,
  rejection_reason   VARCHAR(500)            DEFAULT NULL,
  created_by         BIGINT UNSIGNED         DEFAULT NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The live-slot read: one slot, currently within its window, approved.
  KEY idx_fc_slot_window (slot_id, status, start_at, end_at),
  KEY idx_fc_shop (shop_id, status),
  KEY idx_fc_window (status, start_at, end_at),
  KEY idx_fc_placement (placement_type, status),
  -- `fk_fcam_*`, not `fk_fc_*`: InnoDB constraint names are unique per
  -- database, and `followed_categories` already owns fk_fc_user/fk_fc_category.
  CONSTRAINT fk_fcam_shop     FOREIGN KEY (shop_id)            REFERENCES shops (id)          ON DELETE CASCADE,
  CONSTRAINT fk_fcam_slot     FOREIGN KEY (slot_id)            REFERENCES featured_slots (id) ON DELETE CASCADE,
  CONSTRAINT fk_fcam_category FOREIGN KEY (target_category_id) REFERENCES categories (id)     ON DELETE SET NULL,
  CONSTRAINT fk_fcam_approver FOREIGN KEY (approved_by)        REFERENCES users (id)          ON DELETE SET NULL,
  CONSTRAINT fk_fcam_creator  FOREIGN KEY (created_by)         REFERENCES users (id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- What each campaign actually promotes (§6, §9).
--
-- A campaign is the schedule and the targeting; a placement is one listing
-- inside it. Splitting them is what lets "Diwali Collection" promote four
-- offers and rotate between them, and what lets one expired offer drop out
-- of a campaign without taking the campaign down with it (§9: "Offer is
-- active", "Offer is not expired" are per-listing conditions).
--
-- `listing_type` + `listing_id` rather than three nullable FK columns: the
-- three listing kinds live in three tables, and a polymorphic pair keeps the
-- rotation query one index scan. Referential integrity is enforced in
-- `promotion.service` on write and re-checked on every live read, which is
-- what §24 requires anyway.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promotion_placements (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  featured_campaign_id BIGINT UNSIGNED NOT NULL,
  shop_id             BIGINT UNSIGNED NOT NULL,
  listing_type        ENUM('offer','service_offer','shop') NOT NULL,
  listing_id          BIGINT UNSIGNED NOT NULL,
  display_order       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status              ENUM('active','paused') NOT NULL DEFAULT 'active',
  exposure_count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_shown_at       DATETIME                DEFAULT NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_placement (featured_campaign_id, listing_type, listing_id),
  KEY idx_pp_campaign (featured_campaign_id, status, display_order),
  KEY idx_pp_listing (listing_type, listing_id),
  KEY idx_pp_rotation (featured_campaign_id, last_shown_at),
  CONSTRAINT fk_pp_campaign FOREIGN KEY (featured_campaign_id) REFERENCES featured_campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_pp_shop     FOREIGN KEY (shop_id)              REFERENCES shops (id)              ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Visibility entitlements granted outside the subscription (§23).
--
-- §23's resolution rule is
--
--     Role Permission AND (Subscription Entitlement OR Super Admin Override)
--
-- and the OR is what this table is. `feature_overrides` already grants named
-- *feature flags*; a visibility *level* is not a flag - "give this founding
-- merchant Premium visibility until 31 Dec 2026" is a rank, with a reason
-- and an expiry, and squeezing it into a boolean would lose all three.
--
-- Nothing here is ever consulted for billing. It raises what a merchant is
-- eligible for; it never marks anything as paid.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_visibility_entitlements (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shop_id          BIGINT UNSIGNED NOT NULL,
  visibility_level ENUM('BASIC','ENHANCED','PRIORITY') NOT NULL,
  -- Why this merchant has it, in the granter's words: "Founding Merchant".
  -- §23's example includes it, and an override no one can explain later is
  -- an override no one dares revoke.
  reason           VARCHAR(255)            DEFAULT NULL,
  -- Also grants access to Featured placements without a Premium plan, which
  -- §9 puts explicitly in the Super Admin's gift.
  featured_access  TINYINT(1)      NOT NULL DEFAULT 0,
  starts_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL means open-ended. The free-launch grants in §23 all carry a date.
  expires_at       DATETIME                DEFAULT NULL,
  status           ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  granted_by       BIGINT UNSIGNED         DEFAULT NULL,
  revoked_by       BIGINT UNSIGNED         DEFAULT NULL,
  revoked_at       DATETIME                DEFAULT NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One live grant per shop; history is kept by the revoked/expired rows,
  -- which is why this is not unique on shop_id alone.
  KEY idx_mve_shop_status (shop_id, status, expires_at),
  CONSTRAINT fk_mve_shop    FOREIGN KEY (shop_id)    REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_mve_granter FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_mve_revoker FOREIGN KEY (revoked_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- The visibility event stream (§32).
--
-- Distinct from `analytics_events` on purpose. That stream answers "how is
-- my shop doing"; this one answers "where was this listing shown, in what
-- position, under which campaign, and did the customer act on it" - which
-- needs surface, placement and rank on every row. It also feeds ranking
-- (§32: "These events support both analytics and ranking intelligence"),
-- so it carries the fields anti-manipulation needs to discount a signal.
--
-- `session_id`, `device_hash` and `ip_hash` are hashes, never raw values:
-- §25 needs to recognise that fifty impressions came from one device without
-- the platform storing a device fingerprint it has no other use for.
--
-- `is_suspicious` is set by the rollup, not the writer. Deciding at insert
-- time would mean a read-modify-write on the hot path of every impression;
-- deciding in the rollup costs nothing and sees the whole window at once.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visibility_events (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type           VARCHAR(40)     NOT NULL,
  -- Where it happened: SEARCH / NEAR_ME / HOME / CATEGORY / ENDING_SOON.
  surface              VARCHAR(40)             DEFAULT NULL,
  -- Set only for promoted impressions, which is exactly what makes §20's
  -- "Featured placement must not artificially change or falsify organic
  -- analytics" enforceable: organic and featured are the same table split by
  -- one indexed column, so neither can be reported as the other.
  placement_type       VARCHAR(40)             DEFAULT NULL,
  featured_campaign_id BIGINT UNSIGNED         DEFAULT NULL,
  slot_id              BIGINT UNSIGNED         DEFAULT NULL,
  listing_type         ENUM('offer','service_offer','shop') NOT NULL DEFAULT 'offer',
  listing_id           BIGINT UNSIGNED         DEFAULT NULL,
  shop_id              BIGINT UNSIGNED         DEFAULT NULL,
  branch_id            BIGINT UNSIGNED         DEFAULT NULL,
  category_id          BIGINT UNSIGNED         DEFAULT NULL,
  user_id              BIGINT UNSIGNED         DEFAULT NULL,
  session_id           CHAR(64)                DEFAULT NULL,
  device_hash          CHAR(64)                DEFAULT NULL,
  ip_hash              CHAR(64)                DEFAULT NULL,
  -- 1-based rank the listing occupied. This is what makes §15's "average
  -- position" answerable at all.
  position             SMALLINT UNSIGNED       DEFAULT NULL,
  city                 VARCHAR(120)            DEFAULT NULL,
  latitude             DECIMAL(10,7)           DEFAULT NULL,
  longitude            DECIMAL(10,7)           DEFAULT NULL,
  distance_km          DECIMAL(8,2)            DEFAULT NULL,
  term                 VARCHAR(160)            DEFAULT NULL,
  is_suspicious        TINYINT(1)      NOT NULL DEFAULT 0,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The merchant dashboard's read: one shop, one event type, a window.
  KEY idx_ve_shop_type_time (shop_id, event_type, created_at),
  -- The ranking rollup's read: one listing, a window.
  KEY idx_ve_listing (listing_type, listing_id, created_at),
  KEY idx_ve_campaign (featured_campaign_id, event_type, created_at),
  KEY idx_ve_surface (surface, event_type, created_at),
  -- Frequency capping (§18) asks "how often has this person seen this?"
  KEY idx_ve_user_listing (user_id, listing_type, listing_id, created_at),
  KEY idx_ve_session_listing (session_id, listing_type, listing_id, created_at),
  -- Anti-manipulation (§25) sweeps one device's recent events.
  KEY idx_ve_device (device_hash, created_at),
  KEY idx_ve_time (created_at),
  CONSTRAINT fk_ve_shop     FOREIGN KEY (shop_id)              REFERENCES shops (id)              ON DELETE CASCADE,
  CONSTRAINT fk_ve_branch   FOREIGN KEY (branch_id)            REFERENCES shop_branches (id)      ON DELETE SET NULL,
  CONSTRAINT fk_ve_category FOREIGN KEY (category_id)          REFERENCES categories (id)         ON DELETE SET NULL,
  CONSTRAINT fk_ve_user     FOREIGN KEY (user_id)              REFERENCES users (id)              ON DELETE SET NULL,
  CONSTRAINT fk_ve_campaign FOREIGN KEY (featured_campaign_id) REFERENCES featured_campaigns (id) ON DELETE SET NULL,
  CONSTRAINT fk_ve_slot     FOREIGN KEY (slot_id)              REFERENCES featured_slots (id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Per-campaign daily counters (§17).
--
-- Named as §31 names it. It holds aggregates rather than raw rows: the raw
-- events already live in `visibility_events`, and a second copy of them
-- would be a second thing to keep honest. §17's campaign card is eight
-- numbers over a window, and this makes it one indexed read per day instead
-- of a scan over every impression the campaign ever served.
--
-- Rebuilt idempotently by the rollup job, so a re-run corrects rather than
-- doubles.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_events (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  featured_campaign_id BIGINT UNSIGNED NOT NULL,
  shop_id              BIGINT UNSIGNED NOT NULL,
  event_date           DATE            NOT NULL,
  impressions          INT UNSIGNED    NOT NULL DEFAULT 0,
  banner_clicks        INT UNSIGNED    NOT NULL DEFAULT 0,
  offer_views          INT UNSIGNED    NOT NULL DEFAULT 0,
  saves                INT UNSIGNED    NOT NULL DEFAULT 0,
  claims               INT UNSIGNED    NOT NULL DEFAULT 0,
  redemptions          INT UNSIGNED    NOT NULL DEFAULT 0,
  shop_visits          INT UNSIGNED    NOT NULL DEFAULT 0,
  directions_clicks    INT UNSIGNED    NOT NULL DEFAULT 0,
  unique_customers     INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_day (featured_campaign_id, event_date),
  KEY idx_ce_shop_date (shop_id, event_date),
  CONSTRAINT fk_ce_campaign FOREIGN KEY (featured_campaign_id) REFERENCES featured_campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_ce_shop     FOREIGN KEY (shop_id)              REFERENCES shops (id)              ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Ranking exclusions (§24, §25).
--
-- The hard "this must not rank" list, above and beyond the status and date
-- checks the queries already apply. Two sources:
--
--   admin - a Super Admin pulling something from discovery pending review.
--   auto  - the anti-manipulation sweep, which suspends a listing whose
--           engagement is being fabricated rather than silently letting the
--           inflated signal keep ranking it.
--
-- Either a listing or a whole shop; `expires_at` lets an automatic
-- suspension lapse on its own, so a false positive costs a day rather than
-- forever.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ranking_exclusions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  listing_type ENUM('offer','service_offer','shop') DEFAULT NULL,
  listing_id   BIGINT UNSIGNED         DEFAULT NULL,
  shop_id      BIGINT UNSIGNED         DEFAULT NULL,
  scope        ENUM('listing','shop')  NOT NULL DEFAULT 'listing',
  source       ENUM('admin','auto')    NOT NULL DEFAULT 'admin',
  reason       VARCHAR(255)            DEFAULT NULL,
  expires_at   DATETIME                DEFAULT NULL,
  status       ENUM('active','lifted') NOT NULL DEFAULT 'active',
  created_by   BIGINT UNSIGNED         DEFAULT NULL,
  lifted_by    BIGINT UNSIGNED         DEFAULT NULL,
  lifted_at    DATETIME                DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rx_listing (listing_type, listing_id, status),
  KEY idx_rx_shop (shop_id, status),
  KEY idx_rx_status (status, expires_at),
  CONSTRAINT fk_rx_shop    FOREIGN KEY (shop_id)    REFERENCES shops (id) ON DELETE CASCADE,
  CONSTRAINT fk_rx_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_rx_lifter  FOREIGN KEY (lifted_by)  REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Frequency limits (§18).
--
-- "Maximum X prominent impressions per customer/session within a period",
-- with X, the period and the scope all configurable rather than compiled in.
--
-- `applies_to` distinguishes the signed-in customer from the anonymous
-- session, because a guest has no user id and capping them by IP would cap
-- an entire office together.
--
-- A row with `placement_type` set applies only inside that promotional
-- space, which is how featured content is capped more tightly than organic
-- results without needing a second table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS frequency_limits (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope           ENUM('offer','shop','campaign','placement') NOT NULL,
  placement_type  VARCHAR(40)             DEFAULT NULL,
  applies_to      ENUM('user','session')  NOT NULL DEFAULT 'user',
  max_impressions INT UNSIGNED    NOT NULL DEFAULT 6,
  window_minutes  INT UNSIGNED    NOT NULL DEFAULT 1440,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  updated_by      BIGINT UNSIGNED         DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_frequency (scope, placement_type, applies_to),
  KEY idx_fl_status (status),
  CONSTRAINT fk_fl_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Precomputed listing quality and engagement scores (§33: "Precompute
-- merchant/listing quality scores").
--
-- Not in §31's table list, and needed anyway. Engagement (§2.4) is a
-- distinct-customer-weighted aggregate over 30 days of events, and offer
-- quality (§4) is a completeness checklist over the listing and its shop.
-- Computing either inside a ranked request would put a multi-table
-- aggregate on the hot path of every search; computing them hourly turns
-- both into one indexed lookup.
--
-- Staleness is bounded and harmless: an hour-old engagement score cannot
-- show an expired offer, because expiry is checked live in the candidate
-- query. It can only mean a listing that went viral in the last hour has
-- not been rewarded for it yet.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_quality_scores (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  listing_type     ENUM('offer','service_offer','shop') NOT NULL,
  listing_id       BIGINT UNSIGNED NOT NULL,
  shop_id          BIGINT UNSIGNED NOT NULL,
  -- Both normalised 0-1, so a weight change is the only thing that moves
  -- their relative influence.
  quality_score    DECIMAL(6,4)    NOT NULL DEFAULT 0.0000,
  engagement_score DECIMAL(6,4)    NOT NULL DEFAULT 0.0000,
  -- Kept alongside the score so a merchant can be told *why* their quality
  -- score is what it is (§27) rather than just being handed a number.
  quality_detail   JSON                    DEFAULT NULL,
  engagement_raw   JSON                    DEFAULT NULL,
  computed_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lqs_listing (listing_type, listing_id),
  KEY idx_lqs_shop (shop_id),
  KEY idx_lqs_computed (computed_at),
  CONSTRAINT fk_lqs_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
