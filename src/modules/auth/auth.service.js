'use strict';

const { query, queryOne, execute, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const env = require('../../config/env');
const password = require('../../utils/password');
const tokens = require('../../utils/tokens');
const mailer = require('../../utils/mailer');
const access = require('../../services/accessControl');
const analyticsEvents = require('../../services/analyticsEvents');
const deviceInfo = require('../../utils/device');
const logger = require('../../utils/logger');
const requestContext = require('../../utils/requestContext');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/** Shape of the user object returned to the client - never includes the hash. */
function publicUser(user, context) {
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    emailVerified: Boolean(user.email_verified),
    avatarUrl: user.avatar_url,
    preferencesCompleted: Boolean(user.preferences_completed),
    minimumDiscountPercent:
      user.minimum_discount_percent === null || user.minimum_discount_percent === undefined
        ? null
        : Number(user.minimum_discount_percent),
    preferredLocation:
      user.pref_city || user.pref_latitude
        ? {
            city: user.pref_city,
            latitude: user.pref_latitude === null ? null : Number(user.pref_latitude),
            longitude: user.pref_longitude === null ? null : Number(user.pref_longitude),
          }
        : null,
    roles: context.roleNames,
    permissions: context.effectivePermissions,
    isSuperAdmin: context.isSuperAdmin,
    canAccessAdmin: context.canAccessAdmin,
    /** Shop-scoped roles that are inert until the user is assigned to a shop. */
    unassignedShopRoles: context.unassignedShopRoles,
    shops: context.shops.map((shop) => ({
      shopId: shop.shopId,
      shopName: shop.shopName,
      shopSlug: shop.shopSlug,
      shopLogoUrl: shop.shopLogoUrl,
      branchId: shop.branchId,
      designation: shop.designation,
      roleName: shop.roleName,
      permissions: shop.permissions,
      /**
       * Where this shop sits in review, or null for one that never went
       * through it (§15). The clients use it to tell a registration in flight
       * from a shop to run, and to link to the right screen for each.
       */
      verificationStatus: shop.verificationStatus,
      awaitingFirstApproval: shop.awaitingFirstApproval,
    })),
  };
}

/**
 * Issues an access + refresh pair and persists the refresh token's digest.
 *
 * `familyId` ties every rotation of one device's session together (§29): a
 * login starts a new family, a refresh continues the existing one. That is
 * what makes "log this iPhone out" and reuse detection possible without
 * storing the tokens themselves.
 */
async function issueSession(user, req, { familyId = tokens.randomToken(16) } = {}) {
  const jti = tokens.randomToken(16);
  const accessToken = tokens.signAccessToken(user);
  const refreshToken = tokens.signRefreshToken(user, jti);
  const expiresAt = new Date(Date.now() + tokens.durationToMs(env.jwt.refreshExpiresIn));
  const device = deviceInfo.describe(req);

  await execute(
    `INSERT INTO refresh_tokens
       (user_id, token_hash, family_id, expires_at, device_type, device_name,
        platform, user_agent, ip_address, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      user.id,
      tokens.hashToken(refreshToken),
      familyId,
      expiresAt,
      device.deviceType,
      device.deviceName,
      device.platform,
      device.userAgent,
      device.ipAddress,
    ],
  );

  return {
    accessToken,
    refreshToken,
    familyId,
    expiresIn: Math.floor(tokens.durationToMs(env.jwt.accessExpiresIn) / 1000),
    refreshExpiresIn: Math.floor(tokens.durationToMs(env.jwt.refreshExpiresIn) / 1000),
  };
}

/** Revokes every live token in one session family. */
async function revokeFamily(familyId, reason) {
  if (!familyId) return 0;
  const result = await execute(
    'UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = ? WHERE family_id = ? AND revoked_at IS NULL',
    [reason, familyId],
  );
  return result.affectedRows;
}

/** Revokes every live session for a user, optionally sparing one family. */
async function revokeAllSessions(userId, reason, { exceptFamilyId = null } = {}) {
  const result = exceptFamilyId
    ? await execute(
        `UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = ?
          WHERE user_id = ? AND revoked_at IS NULL AND (family_id IS NULL OR family_id <> ?)`,
        [reason, userId, exceptFamilyId],
      )
    : await execute(
        `UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = ?
          WHERE user_id = ? AND revoked_at IS NULL`,
        [reason, userId],
      );
  return result.affectedRows;
}

async function createAuthToken(userId, purpose, ttlMs) {
  const token = tokens.randomToken();
  await execute(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [userId, purpose, tokens.hashToken(token), new Date(Date.now() + ttlMs)],
  );
  return token;
}

async function sendVerificationEmail(user) {
  const token = await createAuthToken(user.id, 'email_verification', VERIFY_TTL_MS);
  const url = `${env.appUrl}/auth/verify-email?token=${token}`;
  return mailer.send({ to: user.email, ...mailer.templates.verifyEmail(user.name, url) });
}

// ---------------------------------------------------------------------------

async function register(payload, req) {
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [payload.email]);
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const passwordHash = await password.hash(payload.password);

  const userId = await transaction(async (connection) => {
    const [result] = await connection.execute(
      `INSERT INTO users (name, email, password_hash, phone) VALUES (?, ?, ?, ?)`,
      [payload.name, payload.email, passwordHash, payload.phone || null],
    );
    const newId = result.insertId;

    // Everyone starts as a Customer (§19); elevation is an explicit admin action.
    await connection.execute(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT ?, id FROM roles WHERE name = 'CUSTOMER'`,
      [newId],
    );
    await connection.execute(`INSERT INTO notification_preferences (user_id) VALUES (?)`, [newId]);
    return newId;
  });

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);

  // V3 §28. Platform-level, so no shop is attached - shop-level acquisition is
  // recorded the first time the customer engages with that shop's offers.
  analyticsEvents.record(analyticsEvents.EVENT_TYPES.CUSTOMER_SIGNUP, { userId });

  await sendVerificationEmail(user);

  const context = await access.loadAccessContext(userId);
  const session = await issueSession(user, req);
  return { user: publicUser(user, context), ...session };
}

async function login({ email, password: plain }, req) {
  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  // Identical message for unknown email and wrong password so the endpoint
  // cannot be used to enumerate registered addresses.
  const invalid = ApiError.unauthorized('Invalid email or password');
  if (!user) {
    // Spend comparable time so timing does not leak account existence either.
    await password.compare(plain, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    throw invalid;
  }

  const matches = await password.compare(plain, user.password_hash);
  if (!matches) throw invalid;
  if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated');

  // A return is only interesting when there was a previous visit to return from.
  if (user.last_login_at) {
    analyticsEvents.record(analyticsEvents.EVENT_TYPES.CUSTOMER_RETURN, { userId: user.id });
  }
  await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  const context = await access.loadAccessContext(user.id);
  const session = await issueSession(user, req);
  return { user: publicUser(user, context), ...session };
}

/**
 * Rotates the refresh token (§29): the presented one is revoked as the new one
 * is issued, and both belong to the same session family.
 *
 * Presenting a token that was already rotated away means a copy leaked - the
 * legitimate client would be holding the newest one. The whole family is
 * revoked in that case, which logs that device out and forces a real login,
 * rather than letting the thief and the owner take turns refreshing (§29).
 */
async function refresh(refreshToken, req) {
  if (!refreshToken) throw ApiError.unauthorized('Refresh token is required');

  let payload;
  try {
    payload = tokens.verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const stored = await queryOne(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1',
    [tokens.hashToken(refreshToken)],
  );
  if (!stored) throw ApiError.unauthorized('Refresh token is no longer valid');

  if (stored.revoked_at) {
    // Reuse of a spent token. `rotated` is the only reason that implies the
    // token was valid when it was retired, so it is the only one that points
    // at a leak rather than an ordinary logout.
    if (stored.revoked_reason === 'rotated') {
      const revoked = await revokeFamily(stored.family_id, 'reuse_detected');
      /**
       * §18's "suspicious authentication activity", and the clearest such
       * signal this system produces.
       *
       * A refresh token that was already rotated away has been presented by
       * someone - and the legitimate client would be holding the newest one.
       * That means a copy leaked. It is logged at ERROR, above every other
       * authentication event, because unlike an expired session or a wrong
       * password this is never routine and always warrants a look.
       *
       * The token is not logged, in any form (§18, §37). The family id is what
       * identifies the session, and it is ours rather than a credential.
       */
      logger.error(
        {
          event: 'REFRESH_TOKEN_REUSE_DETECTED',
          error_code: 'AUTH_REFRESH_FAILED',
          category: 'AUTHENTICATION',
          request_id: requestContext.currentId(),
          user_id: String(stored.user_id),
          family_id: stored.family_id,
          sessions_revoked: revoked,
          ip_address: deviceInfo.describe(req).ipAddress,
          result: 'SESSION_FAMILY_REVOKED',
        },
        'Refresh token reuse detected; the whole session family was revoked',
      );
    }
    throw ApiError.unauthorized('Refresh token is no longer valid');
  }

  if (new Date(stored.expires_at) < new Date()) {
    throw ApiError.unauthorized('Refresh token is no longer valid');
  }

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.sub]);
  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated');

  await execute(
    "UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'rotated' WHERE id = ?",
    [stored.id],
  );

  const context = await access.loadAccessContext(user.id);
  const session = await issueSession(user, req, { familyId: stored.family_id });
  return { user: publicUser(user, context), ...session };
}

/**
 * Ends the session the caller is holding (§25). The whole family goes, not
 * just the presented token, so a logout cannot be undone with a refresh token
 * the client had already rotated away but still has in memory.
 *
 * With no refresh token to identify the device - a client that only sent its
 * access token - every session for the user is ended instead. Signing out of
 * more than was asked is the safe direction to err in.
 */
async function logout(refreshToken, userId) {
  if (refreshToken) {
    const stored = await queryOne('SELECT id, family_id FROM refresh_tokens WHERE token_hash = ? LIMIT 1', [
      tokens.hashToken(refreshToken),
    ]);
    if (stored?.family_id) return void (await revokeFamily(stored.family_id, 'logout'));
    if (stored) {
      await execute(
        "UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'logout' WHERE id = ? AND revoked_at IS NULL",
        [stored.id],
      );
      return;
    }
  }
  if (userId) await revokeAllSessions(userId, 'logout');
}

// ---------------------------------------------------------------------------
// Active device sessions (§27, §28)

/**
 * One row per live session family, carrying the descriptors of its newest
 * token. The aggregate picks the family's bounds, then joins back to the row
 * holding `MAX(id)` for the device fields - reading them off the newest row
 * directly, rather than concatenating and splitting, so a device name that
 * itself contains a comma survives intact.
 */
const SESSION_SELECT = `
  SELECT f.family_id, f.created_at, f.last_used_at, f.expires_at,
         t.device_type, t.device_name, t.platform, t.ip_address
    FROM (
      SELECT family_id, MAX(id) AS newest_id, MIN(created_at) AS created_at,
             MAX(last_used_at) AS last_used_at, MAX(expires_at) AS expires_at
        FROM refresh_tokens
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
       GROUP BY family_id
    ) f
    JOIN refresh_tokens t ON t.id = f.newest_id`;

/**
 * The user's live sessions, one row per device (§28).
 * `currentFamilyId` marks the session making the request, which the UI needs
 * so it can label it "this device" and not offer to revoke it by accident.
 */
async function listSessions(userId, currentFamilyId = null) {
  const rows = await query(`${SESSION_SELECT} ORDER BY f.last_used_at DESC`, [userId]);
  return rows.map((row) => ({
    id: row.family_id,
    deviceType: row.device_type || 'unknown',
    deviceName: row.device_name || null,
    platform: row.platform || null,
    ipAddress: row.ip_address || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    current: Boolean(currentFamilyId) && row.family_id === currentFamilyId,
  }));
}

/** Ends one device's session. Only the session's own owner may do this. */
async function revokeSession(userId, familyId) {
  const owned = await queryOne(
    'SELECT 1 AS ok FROM refresh_tokens WHERE user_id = ? AND family_id = ? LIMIT 1',
    [userId, familyId],
  );
  if (!owned) throw ApiError.notFound('Session not found');
  const revoked = await revokeFamily(familyId, 'revoked');
  return { revoked };
}

/** "Log out other devices" (§28) - everything except the caller's own session. */
async function revokeOtherSessions(userId, currentFamilyId) {
  const revoked = await revokeAllSessions(userId, 'logout_others', {
    exceptFamilyId: currentFamilyId,
  });
  return { revoked };
}

/** The family a presented refresh token belongs to, or null. */
async function familyForToken(refreshToken) {
  if (!refreshToken) return null;
  const row = await queryOne(
    'SELECT family_id FROM refresh_tokens WHERE token_hash = ? LIMIT 1',
    [tokens.hashToken(refreshToken)],
  );
  return row?.family_id ?? null;
}

async function forgotPassword(email) {
  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  // Always report the same outcome - otherwise this endpoint enumerates
  // accounts. Whether mail delivery is configured is a property of the server,
  // not of the address, so it is safe to report.
  if (!user || user.status !== 'active') return { delivered: mailer.isConfigured };

  const token = await createAuthToken(user.id, 'password_reset', RESET_TTL_MS);
  const url = `${env.appUrl}/auth/reset-password?token=${token}`;
  return mailer.send({ to: user.email, ...mailer.templates.resetPassword(user.name, url) });
}

async function consumeToken(token, purpose) {
  const row = await queryOne(
    `SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? LIMIT 1`,
    [tokens.hashToken(token), purpose],
  );
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw ApiError.badRequest('This link is invalid or has expired');
  }
  await execute('UPDATE auth_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
  return row;
}

async function resetPassword({ token, password: plain }) {
  const row = await consumeToken(token, 'password_reset');
  const passwordHash = await password.hash(plain);

  await execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, row.user_id]);
  // A password reset invalidates every existing session (§26).
  await revokeAllSessions(row.user_id, 'password_changed');
}

async function verifyEmail(token) {
  const row = await consumeToken(token, 'email_verification');
  await execute('UPDATE users SET email_verified = 1 WHERE id = ?', [row.user_id]);
}

async function resendVerification(email) {
  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  // Same response shape whether or not the address exists, again to avoid
  // leaking which addresses are registered.
  if (!user || user.email_verified) return { delivered: mailer.isConfigured };
  return sendVerificationEmail(user);
}

async function changePassword(userId, { currentPassword, password: plain }, currentFamilyId = null) {
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw ApiError.notFound('User not found');

  const matches = await password.compare(currentPassword, user.password_hash);
  if (!matches) throw ApiError.badRequest('Current password is incorrect');

  const passwordHash = await password.hash(plain);
  await execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);

  // §26: a password change is a security event, so every *other* device has to
  // sign in again. The device that made the change keeps its session - it just
  // proved it knows the old password.
  await revokeAllSessions(userId, 'password_changed', { exceptFamilyId: currentFamilyId });
}

/** Current user + freshly resolved permissions, used by the SPA on boot. */
async function me(userId) {
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw ApiError.notFound('User not found');
  const context = await access.loadAccessContext(userId);
  const unread = await queryOne(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId],
  );
  return { ...publicUser(user, context), unreadNotifications: Number(unread.count) };
}

/** Removes refresh/reset tokens that expired more than a day ago. */
async function pruneExpiredTokens() {
  const [refreshResult, authResult] = await Promise.all([
    execute('DELETE FROM refresh_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'),
    execute('DELETE FROM auth_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'),
  ]);
  return refreshResult.affectedRows + authResult.affectedRows;
}

module.exports = {
  publicUser,
  register,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  revokeAllSessions,
  familyForToken,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  changePassword,
  me,
  pruneExpiredTokens,
};
