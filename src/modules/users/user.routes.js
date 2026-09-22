'use strict';

const express = require('express');
const { z } = require('zod');
const { query, queryOne, execute, rawQuery, transaction } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const audit = require('../../utils/audit');
const authService = require('../auth/auth.service');
const { authenticate } = require('../../middleware/auth');
const { requireGlobalPermission } = require('../../middleware/authorize');
const { limitOffset, paginationSchema } = require('../../utils/pagination');
const { ok, created, noContent, paginated } = require('../../utils/respond');
const accessControl = require('../../services/accessControl');
const shopService = require('../shops/shop.service');
const passwordUtil = require('../../utils/password');
const storage = require('../../services/storage');
const logger = require('../../utils/logger');
const { SUPER_ADMIN_ROLE } = require('../../config/permissions');

const router = express.Router();

const listQuery = z.object({
  ...paginationSchema,
  search: z.string().trim().max(190).optional(),
  roleId: z.coerce.number().int().positive().optional(),
  shopId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  sort: z.enum(['newest', 'name', 'lastLogin']).default('newest'),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  avatarUrl: z.string().url().max(500).optional().nullable(),
  roleIds: z.array(z.coerce.number().int().positive()).optional(),
});

/** Self-service profile update (§40) - no role changes allowed here. */
const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  avatarUrl: z.string().url().max(500).optional().nullable(),
  preferredLocation: z
    .object({
      city: z.string().trim().max(120).optional().nullable(),
      latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
      longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
    })
    .optional()
    .nullable(),
});

const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Shop access, managed from the user's side. A shop-scoped role such as ADMIN
 * does nothing until the user is attached to a shop (§3.2), so the Users screen
 * needs to be able to make that assignment without detouring via the shop.
 */
const membershipSchema = z.object({
  shopId: z.coerce.number().int().positive({ message: 'Choose a shop' }),
  roleId: z.coerce.number().int().positive().optional().nullable(),
  branchId: z.coerce.number().int().positive().optional().nullable(),
  designation: z.string().trim().max(120).optional().nullable(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
});

const membershipParams = z.object({
  id: z.coerce.number().int().positive(),
  membershipId: z.coerce.number().int().positive(),
});

const ROLE_AGG = `(
  SELECT GROUP_CONCAT(CONCAT(r.id, '::', r.name) SEPARATOR '||')
    FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id
)`;

const mapUser = (row) => ({
  id: Number(row.id),
  name: row.name,
  email: row.email,
  phone: row.phone,
  status: row.status,
  emailVerified: Boolean(row.email_verified),
  avatarUrl: row.avatar_url,
  preferencesCompleted: Boolean(row.preferences_completed),
  minimumDiscountPercent:
    row.minimum_discount_percent === null || row.minimum_discount_percent === undefined
      ? null
      : Number(row.minimum_discount_percent),
  preferredLocation: {
    city: row.pref_city,
    latitude: row.pref_latitude === null ? null : Number(row.pref_latitude),
    longitude: row.pref_longitude === null ? null : Number(row.pref_longitude),
  },
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
  roles: row.role_list
    ? row.role_list.split('||').map((entry) => {
        const [id, name] = entry.split('::');
        return { id: Number(id), name };
      })
    : [],
  shops: row.shop_list
    ? row.shop_list.split('||').map((entry) => {
        const [id, name] = entry.split('::');
        return { id: Number(id), name };
      })
    : [],
});

router.use(authenticate);

// ---- Self service ----------------------------------------------------------

router.put(
  '/me',
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const location = req.body.preferredLocation;

    await execute(
      `UPDATE users SET name = ?, phone = ?, avatar_url = ?,
              pref_city = ?, pref_latitude = ?, pref_longitude = ?
        WHERE id = ?`,
      [
        req.body.name ?? existing.name,
        req.body.phone !== undefined ? req.body.phone : existing.phone,
        req.body.avatarUrl !== undefined ? req.body.avatarUrl : existing.avatar_url,
        location !== undefined ? location?.city ?? null : existing.pref_city,
        location !== undefined ? location?.latitude ?? null : existing.pref_latitude,
        location !== undefined ? location?.longitude ?? null : existing.pref_longitude,
        req.user.id,
      ],
    );

    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list, NULL AS shop_list FROM users u WHERE u.id = ?`,
      [req.user.id],
    );
    ok(res, mapUser(row));
  }),
);

/**
 * Account deletion (Google Play "Data deletion" policy; Apple 5.1.1(v)).
 *
 * Both stores require an in-app path that actually deletes the account and its
 * personal data, not merely a support request. The schema already makes that
 * safe: every FK to `users` is either ON DELETE CASCADE for personal data
 * (claims, favorites, reviews, notifications, push devices, search history,
 * sessions, shop memberships) or ON DELETE SET NULL for records the business
 * has to keep (audit logs, offer authorship, redemption history). So one DELETE
 * does the right thing, and this route is mostly about *refusing* in the two
 * cases where it would not.
 */
const deleteAccountSchema = z.object({
  // Re-authentication. The action is irreversible, so an unlocked handset must
  // not be enough on its own.
  password: z.string().min(1, { message: 'Enter your password to confirm' }),
});

router.delete(
  '/me',
  validate({ body: deleteAccountSchema }),
  asyncHandler(async (req, res) => {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) throw ApiError.notFound('User not found');

    const matches = await passwordUtil.compare(req.body.password, user.password_hash);
    if (!matches) throw ApiError.badRequest('Password is incorrect');

    // A Super Admin is platform staff, not a customer. There may be exactly
    // one, and §28 wants an administrator's removal to be a deliberate audited
    // act by another administrator rather than a button on a phone.
    const superAdmin = await queryOne(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ? AND r.name = ?`,
      [req.user.id, SUPER_ADMIN_ROLE],
    );
    if (superAdmin) {
      throw ApiError.forbidden(
        'Platform administrator accounts cannot be deleted from the app. ' +
          'Contact support so another administrator can remove it.',
      );
    }

    // A shop has no owner column - only `created_by`, which is SET NULL, and a
    // `shop_members` row, which cascades. Deleting a shop's Admin would
    // therefore leave a live shop with running offers that nobody can manage.
    // Refuse and say what to do instead, rather than quietly taking a
    // merchant's business down with their account.
    const managedShops = await query(
      `SELECT s.id, s.name
         FROM shop_members sm
         JOIN shops s ON s.id = sm.shop_id
         JOIN roles r ON r.id = sm.role_id
        WHERE sm.user_id = ? AND sm.status = 'active' AND r.name = 'ADMIN'
        ORDER BY s.name`,
      [req.user.id],
    );
    if (managedShops.length) {
      const names = managedShops.map((row) => row.name).join(', ');
      throw new ApiError(
        409,
        `You manage ${managedShops.length === 1 ? 'a shop' : 'shops'} on OffersOffer (${names}). ` +
          'Transfer it to another admin, or ask support to close it, before deleting your account.',
        { shops: managedShops.map((row) => ({ id: Number(row.id), name: row.name })) },
        'CONFLICT',
      );
    }

    // Written before the DELETE, not after: `audit_logs.user_id` is SET NULL on
    // delete, so afterwards nothing identifies the row. The email is recorded
    // deliberately - it is the only way to answer "was this person's account
    // deleted, and when" once the user row is gone.
    await audit.record(req, {
      action: 'ACCOUNT_DELETED',
      entityType: 'user',
      entityId: req.user.id,
      oldValue: { id: Number(user.id), name: user.name, email: user.email },
    });

    // Best effort, and deliberately before the row disappears: once the user is
    // gone the avatar URL is unrecoverable, so failing here would strand an
    // object in S3 forever. A storage outage must not block the deletion
    // itself, which is the part the user has a right to.
    if (user.avatar_url) {
      try {
        await storage.remove(user.avatar_url);
      } catch (error) {
        logger.warn(
          { event: 'AVATAR_CLEANUP_FAILED', user_id: Number(user.id) },
          'Account deleted but its avatar could not be removed from storage',
        );
      }
    }

    // One statement; InnoDB applies every cascade atomically. Refresh tokens go
    // with it, so every device is signed out as a side effect.
    await execute('DELETE FROM users WHERE id = ?', [req.user.id]);

    logger.info(
      { event: 'ACCOUNT_DELETED', user_id: Number(user.id) },
      'User deleted their own account',
    );

    noContent(res);
  }),
);

// ---- Administration --------------------------------------------------------

router.get(
  '/',
  requireGlobalPermission('VIEW_USERS'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = limitOffset(req.query);
    const where = ['1 = 1'];
    const params = [];

    if (req.query.search) {
      const term = `%${req.query.search}%`;
      where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      params.push(term, term, term);
    }
    if (req.query.status && req.query.status !== 'all') {
      where.push('u.status = ?');
      params.push(req.query.status);
    }
    if (req.query.roleId) {
      where.push('EXISTS (SELECT 1 FROM user_roles ur2 WHERE ur2.user_id = u.id AND ur2.role_id = ?)');
      params.push(req.query.roleId);
    }
    if (req.query.shopId) {
      where.push('EXISTS (SELECT 1 FROM shop_members sm2 WHERE sm2.user_id = u.id AND sm2.shop_id = ?)');
      params.push(req.query.shopId);
    }

    const orderBy = {
      newest: 'u.created_at DESC',
      name: 'u.name ASC',
      lastLogin: 'u.last_login_at IS NULL, u.last_login_at DESC',
    }[req.query.sort];

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows, countRows] = await Promise.all([
      rawQuery(
        `SELECT u.*, ${ROLE_AGG} AS role_list,
                (SELECT GROUP_CONCAT(CONCAT(s.id, '::', s.name) SEPARATOR '||')
                   FROM shop_members sm JOIN shops s ON s.id = sm.shop_id
                  WHERE sm.user_id = u.id) AS shop_list
           FROM users u ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      rawQuery(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params),
    ]);

    paginated(res, rows.map(mapUser), { page, limit, total: Number(countRows[0].total) });
  }),
);

router.get(
  '/:id',
  requireGlobalPermission('VIEW_USERS'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list,
              (SELECT GROUP_CONCAT(CONCAT(s.id, '::', s.name) SEPARATOR '||')
                 FROM shop_members sm JOIN shops s ON s.id = sm.shop_id
                WHERE sm.user_id = u.id) AS shop_list
         FROM users u WHERE u.id = ?`,
      [req.params.id],
    );
    if (!row) throw ApiError.notFound('User not found');

    const memberships = await query(
      `SELECT sm.id, sm.shop_id, s.name AS shop_name, sm.branch_id, b.branch_name,
              sm.designation, sm.status, r.name AS role_name
         FROM shop_members sm
         JOIN shops s ON s.id = sm.shop_id
         LEFT JOIN shop_branches b ON b.id = sm.branch_id
         LEFT JOIN roles r ON r.id = sm.role_id
        WHERE sm.user_id = ?`,
      [req.params.id],
    );

    ok(res, {
      ...mapUser(row),
      memberships: memberships.map((membership) => ({
        id: Number(membership.id),
        shopId: Number(membership.shop_id),
        shopName: membership.shop_name,
        branchId: membership.branch_id === null ? null : Number(membership.branch_id),
        branchName: membership.branch_name,
        designation: membership.designation,
        status: membership.status,
        roleName: membership.role_name,
      })),
    });
  }),
);

router.put(
  '/:id',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ params: idParam, body: updateUserSchema }),
  asyncHandler(async (req, res) => {
    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('User not found');

    await transaction(async (connection) => {
      await connection.execute('UPDATE users SET name = ?, phone = ?, avatar_url = ? WHERE id = ?', [
        req.body.name ?? existing.name,
        req.body.phone !== undefined ? req.body.phone : existing.phone,
        req.body.avatarUrl !== undefined ? req.body.avatarUrl : existing.avatar_url,
        req.params.id,
      ]);

      if (req.body.roleIds !== undefined) {
        await connection.execute('DELETE FROM user_roles WHERE user_id = ?', [req.params.id]);
        for (const roleId of req.body.roleIds) {
          await connection.execute(
            'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
            [req.params.id, roleId],
          );
        }
      }
    });

    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list, NULL AS shop_list FROM users u WHERE u.id = ?`,
      [req.params.id],
    );
    await audit.record(req, {
      action: req.body.roleIds !== undefined ? 'USER_ROLES_ASSIGNED' : 'USER_UPDATED',
      entityType: 'user',
      entityId: Number(req.params.id),
      oldValue: audit.sanitize(existing),
      newValue: { name: row.name, roleIds: req.body.roleIds },
    });
    ok(res, mapUser(row));
  }),
);

// ---- Shop access -----------------------------------------------------------

router.post(
  '/:id/memberships',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ params: idParam, body: membershipSchema }),
  asyncHandler(async (req, res) => {
    const user = await queryOne('SELECT id, name FROM users WHERE id = ?', [req.params.id]);
    if (!user) throw ApiError.notFound('User not found');

    // Assigning someone to a shop is a shop-membership action, so it is gated
    // on that shop's permission rather than on MANAGE_USERS alone.
    if (!accessControl.hasShopPermission(req.user, req.body.shopId, 'MANAGE_SHOP_MEMBERS')) {
      throw ApiError.forbidden('You cannot assign members to that shop');
    }

    const member = await shopService.addMember(req.body.shopId, {
      userId: Number(req.params.id),
      roleId: req.body.roleId ?? null,
      branchId: req.body.branchId ?? null,
      designation: req.body.designation ?? null,
      status: req.body.status,
    });

    await audit.record(req, {
      action: 'MEMBER_ADDED',
      entityType: 'shop_member',
      entityId: member.id,
      newValue: { shopId: req.body.shopId, userId: Number(req.params.id), roleId: req.body.roleId },
    });
    created(res, member);
  }),
);

router.put(
  '/:id/memberships/:membershipId',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ params: membershipParams, body: membershipSchema.partial() }),
  asyncHandler(async (req, res) => {
    const membership = await queryOne(
      'SELECT shop_id FROM shop_members WHERE id = ? AND user_id = ?',
      [req.params.membershipId, req.params.id],
    );
    if (!membership) throw ApiError.notFound('Shop access not found for this user');
    if (!accessControl.hasShopPermission(req.user, membership.shop_id, 'MANAGE_SHOP_MEMBERS')) {
      throw ApiError.forbidden('You cannot manage members of that shop');
    }

    const member = await shopService.updateMember(membership.shop_id, req.params.membershipId, req.body);
    await audit.record(req, {
      action: 'MEMBER_UPDATED',
      entityType: 'shop_member',
      entityId: Number(req.params.membershipId),
      newValue: { roleId: member.roleId, branchId: member.branchId, status: member.status },
    });
    ok(res, member);
  }),
);

router.delete(
  '/:id/memberships/:membershipId',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ params: membershipParams }),
  asyncHandler(async (req, res) => {
    const membership = await queryOne(
      'SELECT shop_id FROM shop_members WHERE id = ? AND user_id = ?',
      [req.params.membershipId, req.params.id],
    );
    if (!membership) throw ApiError.notFound('Shop access not found for this user');
    if (!accessControl.hasShopPermission(req.user, membership.shop_id, 'MANAGE_SHOP_MEMBERS')) {
      throw ApiError.forbidden('You cannot manage members of that shop');
    }

    await shopService.removeMember(membership.shop_id, req.params.membershipId);
    await audit.record(req, {
      action: 'MEMBER_REMOVED',
      entityType: 'shop_member',
      entityId: Number(req.params.membershipId),
      oldValue: { shopId: Number(membership.shop_id), userId: Number(req.params.id) },
    });
    noContent(res);
  }),
);

router.patch(
  '/:id/status',
  requireGlobalPermission('MANAGE_USERS'),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(async (req, res) => {
    if (Number(req.params.id) === req.user.id) {
      throw ApiError.badRequest('You cannot change your own account status');
    }
    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!existing) throw ApiError.notFound('User not found');

    await execute('UPDATE users SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    if (req.body.status === 'inactive') {
      // Deactivation must end existing sessions, not just block new logins (§26).
      await authService.revokeAllSessions(Number(req.params.id), 'account_disabled');
    }

    await audit.record(req, {
      action: req.body.status === 'inactive' ? 'USER_DEACTIVATED' : 'USER_ACTIVATED',
      entityType: 'user',
      entityId: Number(req.params.id),
      oldValue: { status: existing.status },
      newValue: { status: req.body.status },
    });

    const row = await queryOne(
      `SELECT u.*, ${ROLE_AGG} AS role_list, NULL AS shop_list FROM users u WHERE u.id = ?`,
      [req.params.id],
    );
    ok(res, mapUser(row));
  }),
);

module.exports = router;
