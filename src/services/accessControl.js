'use strict';

const { query } = require('../db/pool');
const { SUPER_ADMIN_ROLE, MANAGEMENT_PERMISSIONS } = require('../config/permissions');

/**
 * Resolves everything the authorization layer needs about a user:
 *
 *   - roles assigned directly (users -> user_roles -> roles)
 *   - permissions those roles grant, split by the role's scope
 *   - shop memberships, each with the permissions that apply there
 *
 * Scope is what makes an Admin an admin *of a particular shop* (§3.2):
 *
 *   global role -> permissions apply everywhere
 *   shop role   -> permissions apply only to the shops the user is a member of
 *
 * So assigning ADMIN to someone grants nothing until they are also attached to
 * a shop, and it never leaks rights over shops they have no connection to.
 *
 * Permissions are resolved per request rather than embedded in the JWT so that
 * a revoked role or a new shop assignment takes effect immediately.
 */
async function loadAccessContext(userId) {
  const [roles, memberships] = await Promise.all([
    query(
      `SELECT r.id, r.name, r.description, r.scope,
              GROUP_CONCAT(DISTINCT p.name) AS permissions
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.status = 'active'
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = ?
        GROUP BY r.id, r.name, r.description, r.scope`,
      [userId],
    ),
    query(
      `SELECT sm.id            AS member_id,
              sm.shop_id,
              sm.branch_id,
              sm.designation,
              sm.status,
              s.name           AS shop_name,
              s.slug           AS shop_slug,
              s.logo_url       AS shop_logo_url,
              r.id             AS role_id,
              r.name           AS role_name,
              GROUP_CONCAT(DISTINCT p.name) AS permissions
         FROM shop_members sm
         JOIN shops s ON s.id = sm.shop_id
         LEFT JOIN roles r ON r.id = sm.role_id AND r.status = 'active'
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        -- The s.status check is what makes deactivating a shop remove its
        -- staff's access, and that stays. The exception is a shop inside the
        -- seller-registration lifecycle (Onboarding §11, §12): a draft and a
        -- shop awaiting review are both deliberately inactive, so without
        -- this a seller would have no access to the registration they just
        -- created - they could not see it, edit it, or submit it. A shop with
        -- a NULL verification_status is outside that lifecycle and behaves
        -- exactly as before.
        WHERE sm.user_id = ? AND sm.status = 'active'
          AND (s.status = 'active' OR s.verification_status IS NOT NULL)
        GROUP BY sm.id, sm.shop_id, sm.branch_id, sm.designation, sm.status,
                 s.name, s.slug, s.logo_url, r.id, r.name`,
      [userId],
    ),
  ]);

  const roleNames = roles.map((role) => role.name);
  const isSuperAdmin = roleNames.includes(SUPER_ADMIN_ROLE);

  const globalSet = new Set();
  // Permissions from shop-scoped roles held directly; these are folded into
  // every membership below rather than granted application-wide.
  const shopScopedSet = new Set();
  const shopScopedRoleNames = [];

  for (const role of roles) {
    const permissions = role.permissions ? role.permissions.split(',') : [];
    if (role.scope === 'shop') {
      shopScopedRoleNames.push(role.name);
      for (const permission of permissions) shopScopedSet.add(permission);
    } else {
      for (const permission of permissions) globalSet.add(permission);
    }
  }

  const shops = memberships.map((row) => ({
    memberId: Number(row.member_id),
    shopId: Number(row.shop_id),
    branchId: row.branch_id === null ? null : Number(row.branch_id),
    shopName: row.shop_name,
    shopSlug: row.shop_slug,
    shopLogoUrl: row.shop_logo_url,
    designation: row.designation,
    roleId: row.role_id === null ? null : Number(row.role_id),
    roleName: row.role_name,
    permissions: [
      ...new Set([...(row.permissions ? row.permissions.split(',') : []), ...shopScopedSet]),
    ],
  }));

  /**
   * Shop-scoped roles the user holds that cannot take effect yet because they
   * are not attached to any shop. The UI turns this into an explicit
   * "you need to be assigned to a shop" message instead of failing silently.
   */
  const unassignedShopRoles = shops.length === 0 ? shopScopedRoleNames : [];

  const effectivePermissions = [
    ...new Set([...globalSet, ...shops.flatMap((shop) => shop.permissions)]),
  ];

  return {
    roles: roles.map((role) => ({
      id: Number(role.id),
      name: role.name,
      description: role.description,
      scope: role.scope,
    })),
    roleNames,
    isSuperAdmin,
    globalPermissions: [...globalSet],
    shops,
    shopIds: shops.map((shop) => shop.shopId),
    unassignedShopRoles,
    /** Union of global + every shop-scoped permission; used for UI hints only. */
    effectivePermissions,
    /** True when the user administers anything at all. */
    canAccessAdmin:
      isSuperAdmin || effectivePermissions.some((name) => MANAGEMENT_PERMISSIONS.includes(name)),
  };
}

/** True when the permission is granted application-wide (not just for one shop). */
function hasGlobalPermission(access, permission) {
  if (!access) return false;
  if (access.isSuperAdmin) return true;
  return access.globalPermissions.includes(permission);
}

/** True when the permission is granted for the given shop (globally or via membership). */
function hasShopPermission(access, shopId, permission) {
  if (!access) return false;
  if (hasGlobalPermission(access, permission)) return true;
  const membership = access.shops.find((shop) => shop.shopId === Number(shopId));
  return Boolean(membership && membership.permissions.includes(permission));
}

/** True when the permission is held anywhere - globally or for at least one shop. */
function hasAnyPermission(access, permission) {
  if (!access) return false;
  if (hasGlobalPermission(access, permission)) return true;
  return access.shops.some((shop) => shop.permissions.includes(permission));
}

/** Shop ids where the user holds `permission`; `null` means "every shop". */
function shopScopeFor(access, permission) {
  if (hasGlobalPermission(access, permission)) return null;
  return access.shops.filter((shop) => shop.permissions.includes(permission)).map((shop) => shop.shopId);
}

module.exports = {
  loadAccessContext,
  hasGlobalPermission,
  hasShopPermission,
  hasAnyPermission,
  shopScopeFor,
};
