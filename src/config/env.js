'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

/**
 * Environment file loading (Database §5, §13).
 *
 * §5 asks for `.env.development` / `.env.staging` / `.env.production`, and §13
 * closes with the reason: "Never allow a production application to accidentally
 * load development credentials." Loading a single `.env` does exactly that -
 * start the app with NODE_ENV=production on a machine that has a developer's
 * `.env` and it connects, confidently, to their laptop's database with their
 * test Razorpay keys.
 *
 * So the environment-specific file is loaded first and wins (dotenv never
 * overwrites a variable that is already set), and the generic `.env` is loaded
 * afterwards as a fallback for *non-production* environments only.
 *
 * Production is deliberately left able to run with no file at all. Injecting
 * configuration as real environment variables - from a secrets manager, a
 * systemd unit, a container runtime - is the better practice §12 points at, and
 * requiring a file on disk would push deployments away from it.
 */
const NODE_ENV = process.env.NODE_ENV || 'development';
const envFile = (name) => path.resolve(__dirname, '../../', name);

dotenv.config({ path: envFile(`.env.${NODE_ENV}`) });
if (NODE_ENV !== 'production') {
  dotenv.config({ path: envFile('.env') });
}

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback = []) =>
  value ? String(value).split(',').map((v) => v.trim()).filter(Boolean) : fallback;

const isProduction = NODE_ENV === 'production';

const DEFAULT_SEED_EMAIL = 'superadmin@offers.app';
const DEFAULT_SEED_PASSWORD = 'SuperAdmin@123';

const env = {
  nodeEnv: NODE_ENV,
  isProduction,
  port: int(process.env.PORT, 3000),
  apiPrefix: process.env.API_PREFIX || '/api',
  corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:4200']),
  publicApiUrl: (process.env.PUBLIC_API_URL || 'http://localhost:3000').replace(/\/$/, ''),
  appUrl: (process.env.APP_URL || 'http://localhost:4200').replace(/\/$/, ''),
  /**
   * Custom scheme the mobile app registers (`app.json` -> expo.scheme). Every
   * notification stores a deep link built from this, so tapping one opens the
   * screen it names instead of wherever the app was last (Push §26, §27).
   */
  appScheme: process.env.MOBILE_APP_SCHEME || 'offersapp',

  /**
   * Structured logging (Logging §6, §7, §11, §34, §40).
   *
   * `level` defaults per environment rather than to one value: §7 is explicit
   * that verbose DEBUG must not be on in production by default, and equally a
   * developer should not have to opt in to seeing their own debug lines.
   *
   * `version` and `deploymentId` are what make "did this start after the last
   * release?" answerable (§40). They come from the environment because only the
   * thing that performed the deploy knows them; `version` falls back to
   * package.json, which is right for a local run and honest in production
   * (it names the code, just not the build).
   */
  logging: {
    service: process.env.LOG_SERVICE_NAME || 'offers-api',
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    /** Human-readable output for a terminal; JSON lines everywhere else. */
    pretty: bool(process.env.LOG_PRETTY, !isProduction),
    version: process.env.APP_VERSION || require('../../package.json').version,
    deploymentId: process.env.DEPLOYMENT_ID || null,
    /**
     * Request duration bands (§11). A slow request is not an error - it is
     * logged at WARN so it shows up in a performance review without paging
     * anyone, and the thresholds are configurable because the right numbers
     * depend on hardware we do not control.
     */
    slowRequestMs: int(process.env.LOG_SLOW_REQUEST_MS, 500),
    verySlowRequestMs: int(process.env.LOG_VERY_SLOW_REQUEST_MS, 2000),
    /** The same idea one layer down, for individual queries (§13). */
    slowQueryMs: int(process.env.LOG_SLOW_QUERY_MS, 1000),
    /** §35. Application failure rows are pruned past this age. */
    retentionDays: int(process.env.LOG_RETENTION_DAYS, 90),
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'offers_app',
    connectionLimit: int(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'change-me-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'change-me-refresh-secret',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),

  claims: {
    /**
     * Signs the QR payload printed on a claim (Claim/Redemption §6). Optional:
     * left unset, the key is derived from the access secret, which keeps a
     * fresh install working while still being a different key from the one
     * that signs sessions.
     */
    qrSecret: process.env.CLAIM_QR_SECRET || '',
  },

  /**
   * The httpOnly refresh cookie the web app uses (§22).
   *
   * SameSite depends on where the API sits relative to the SPA: same site can
   * use 'lax', a separate API domain needs 'none' - which browsers only accept
   * on a Secure cookie, so the two default together.
   */
  refreshCookie: {
    sameSite: (process.env.REFRESH_COOKIE_SAMESITE || (isProduction ? 'none' : 'lax')).toLowerCase(),
    secure: bool(process.env.REFRESH_COOKIE_SECURE, isProduction),
    domain: process.env.REFRESH_COOKIE_DOMAIN || '',
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'OffersOffer <no-reply@offers.app>',
  },

  /**
   * Where support requests go, and the numbers the Support and Privacy pages
   * publish.
   *
   * Configurable rather than hardcoded because these are the contact details of
   * a business, not a property of the software - they change when a support
   * desk moves, and a redeploy should not be what it takes. `inbox` is where a
   * new ticket is announced; it defaults to the MAIL_FROM address so a server
   * with SMTP configured and nothing else set still delivers somewhere real.
   */
  support: {
    inbox: process.env.SUPPORT_INBOX || process.env.SUPPORT_EMAIL || '',
    email: process.env.SUPPORT_EMAIL || 'offersoffersupport@gmail.com',
    phones: (process.env.SUPPORT_PHONES || '+91 7540043503,+91 7904795700')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  },

  /**
   * Where processed images go (services/storage.js). `local` is for
   * development; production must use `s3` (config/productionGuard.js).
   *
   * No AWS keys here on purpose: on EC2 the SDK takes short-lived credentials
   * from the server's IAM role. Locally it reads `~/.aws` or AWS_PROFILE.
   */
  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local').trim().toLowerCase(),
    uploadDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || 'uploads'),
    maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
    s3: {
      bucket: (process.env.S3_BUCKET || '').trim(),
      region: process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1',
      // The CDN in front of the bucket (CloudFront), e.g. https://media.offersoffer.in.
      // Stored URLs are built from it, so it has to be right before the first upload.
      publicUrl: (process.env.STORAGE_PUBLIC_URL || '').trim().replace(/\/$/, ''),
      // Only for an S3-compatible store such as MinIO; leave empty for AWS.
      endpoint: (process.env.S3_ENDPOINT || '').trim(),
    },
  },

  /** Discovery tuning (§16, §18). Configurable rather than hardcoded. */
  discovery: {
    defaultRadiusKm: int(process.env.DISCOVERY_DEFAULT_RADIUS_KM, 10),
    endingSoonHours: int(process.env.DISCOVERY_ENDING_SOON_HOURS, 72),
    urgentHours: int(process.env.DISCOVERY_URGENT_HOURS, 6),
  },

  /**
   * How long an anonymous public-discovery response may be cached (§26).
   * `shared` is the CDN/proxy window and is deliberately the longer of the
   * two - a shared cache can be purged, a browser cache cannot.
   */
  cache: {
    publicMaxAgeSeconds: int(process.env.CACHE_PUBLIC_MAX_AGE, 60),
    sharedMaxAgeSeconds: int(process.env.CACHE_SHARED_MAX_AGE, 300),
  },

  /**
   * The Python AI service (TOY-ai-backend). Provider keys live there, never
   * here and never in Angular (§40). `enabled` false makes every AI endpoint
   * answer "unavailable" cleanly rather than time out against a dead port.
   */
  ai: {
    enabled: bool(process.env.AI_SERVICE_ENABLED, true),
    baseUrl: (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''),
    token: process.env.AI_SERVICE_TOKEN || '',
    timeoutMs: int(process.env.AI_SERVICE_TIMEOUT_MS, 60000),
    /** How much history the assistant may be given (§11). */
    historyOfferLimit: int(process.env.AI_HISTORY_OFFER_LIMIT, 12),
    historyWindowDays: int(process.env.AI_HISTORY_WINDOW_DAYS, 180),
    /** Below this many measured offers, history is treated as insufficient (§38). */
    minHistoryOffers: int(process.env.AI_MIN_HISTORY_OFFERS, 2),
  },

  /**
   * Razorpay (V3 payments §2). Left empty in development: the checkout and
   * webhook endpoints then answer with a clear "payments are not configured"
   * rather than failing deep inside an HTTP call to the gateway.
   *
   * `planIds` map this app's plan keys onto Razorpay Plan ids, which is what a
   * recurring subscription (and therefore UPI AutoPay) is created against.
   */
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1',
    planIds: {
      BUSINESS: process.env.RAZORPAY_PLAN_BUSINESS || '',
      PREMIUM: process.env.RAZORPAY_PLAN_PREMIUM || '',
    },
    /** Billing cycles a mandate is authorised for before it must be renewed. */
    totalCount: int(process.env.RAZORPAY_TOTAL_COUNT, 120),
  },

  /**
   * Mobile push (Push §37). The app is a managed Expo build, so the default
   * transport is Expo's relay: it needs no FCM/APNs credentials and accepts
   * the ExponentPushToken the client already produces.
   *
   * `enabled` false leaves the whole in-app notification system working and
   * only skips the device fan-out - which is what a dev machine without
   * outbound network access wants, and what the mail config does already.
   */
  push: {
    enabled: bool(process.env.PUSH_ENABLED, true),
    transport: process.env.PUSH_TRANSPORT || 'expo',
    expoApiBase: (process.env.EXPO_PUSH_API_BASE || 'https://exp.host/--/api/v2/push').replace(/\/$/, ''),
    /** Only needed once "push security" is switched on for the Expo project. */
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
    /** Expo accepts at most 100 messages per request and 1000 receipt ids. */
    batchSize: int(process.env.PUSH_BATCH_SIZE, 100),
    requestTimeoutMs: int(process.env.PUSH_TIMEOUT_MS, 15000),
    /** Consecutive transport failures before a device token is retired. */
    maxDeviceFailures: int(process.env.PUSH_MAX_DEVICE_FAILURES, 5),
  },

  /**
   * Address -> coordinates for shop branches (§17).
   *
   * Distance search is useless without coordinates and merchants cannot type a
   * lat/long, so the address is geocoded on save. The default provider is
   * OpenStreetMap's Nominatim: no API key, but a published usage policy that
   * wants an identifying User-Agent and at most one request a second - hence
   * `userAgent` and `minIntervalMs`. Point `apiBase` at a self-hosted instance
   * or a commercial provider's compatible endpoint to lift that limit.
   *
   * `enabled` false skips the lookup entirely; branches then save with whatever
   * coordinates the caller supplied, which on a dev machine without outbound
   * network access is exactly what is wanted.
   */
  geocoding: {
    enabled: bool(process.env.GEOCODING_ENABLED, true),
    provider: process.env.GEOCODING_PROVIDER || 'nominatim',
    apiBase: (process.env.GEOCODING_API_BASE || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    userAgent:
      process.env.GEOCODING_USER_AGENT || `OffersOffer/1.0 (${process.env.APP_URL || 'http://localhost:4200'})`,
    /** Per-request timeout, and the ceiling on a whole address cascade. */
    requestTimeoutMs: int(process.env.GEOCODING_TIMEOUT_MS, 5000),
    totalBudgetMs: int(process.env.GEOCODING_BUDGET_MS, 12000),
    /** How many progressively coarser queries one address may cost. */
    maxQueries: int(process.env.GEOCODING_MAX_QUERIES, 4),
    minIntervalMs: int(process.env.GEOCODING_MIN_INTERVAL_MS, 1100),
    /** Pending lookups after which new ones are skipped rather than queued. */
    maxQueueDepth: int(process.env.GEOCODING_MAX_QUEUE_DEPTH, 8),
    cacheSize: int(process.env.GEOCODING_CACHE_SIZE, 500),
  },

  billing: {
    /** Days a failed renewal keeps its features before downgrade (§10). */
    graceDays: int(process.env.BILLING_GRACE_DAYS, 5),
    /** Percentage added to the plan price on invoices (§16). */
    taxPercent: Number(process.env.BILLING_TAX_PERCENT ?? 18),
    invoicePrefix: process.env.BILLING_INVOICE_PREFIX || 'INV',
  },

  /**
   * `DEFAULT_SEED_*` are exported alongside the resolved values so the seed
   * script can refuse *these particular strings* in production, rather than
   * only checking that the variables are set. A dev `.env` sets them both, so
   * a presence check passes while still installing the credentials that are
   * printed in the README (§6, §29).
   */
  seed: {
    superAdminEmail: process.env.SEED_SUPERADMIN_EMAIL || DEFAULT_SEED_EMAIL,
    superAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD || DEFAULT_SEED_PASSWORD,
    demoData: bool(process.env.SEED_DEMO_DATA, true),
    defaults: { email: DEFAULT_SEED_EMAIL, password: DEFAULT_SEED_PASSWORD },
  },
};

/**
 * Production database separation (Database §14, §15).
 *
 * Placed in `env.js` rather than in `server.js` on purpose: `migrate.js` and
 * `seed.js` load this module too, so the same guard covers the two commands
 * most capable of doing irreversible damage to the wrong database. A migration
 * run against staging while `NODE_ENV=production` is exactly the mix-up §15
 * exists to prevent.
 */
require('./productionGuard').assertProductionConfig(env);

// Refuse to boot production with the shipped placeholder secrets.
if (env.isProduction) {
  const weak = [];
  if (env.jwt.accessSecret.startsWith('change-me')) weak.push('JWT_ACCESS_SECRET');
  if (env.jwt.refreshSecret.startsWith('change-me')) weak.push('JWT_REFRESH_SECRET');
  if (weak.length) {
    throw new Error(`Refusing to start in production with default secrets: ${weak.join(', ')}`);
  }
}

/**
 * A short CLAIM_QR_SECRET is worse than none at all: leaving it blank derives a
 * full-length key from the access secret, whereas setting it to a handful of
 * characters silently makes the QR signature forgeable. Checked in every
 * environment, not just production, so the mistake surfaces on the machine
 * where it was made.
 */
const MIN_QR_SECRET_LENGTH = 32;
if (env.claims.qrSecret && env.claims.qrSecret.length < MIN_QR_SECRET_LENGTH) {
  throw new Error(
    `CLAIM_QR_SECRET must be at least ${MIN_QR_SECRET_LENGTH} characters, or left blank to derive one. ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
}

module.exports = env;
