'use strict';

const { query } = require('../db/pool');
const { SUPER_ADMIN_ROLE, MANAGEMENT_PERMISSIONS } = require('../config/permissions');
const shopVerification = require('./shopVerification');

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
              sm.is_branch_restricted,
              sm.designation,
              sm.status,
              s.name           AS shop_name,
              s.slug           AS shop_slug,
              s.logo_url       AS shop_logo_url,
              s.verification_status,
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
        GROUP BY sm.id, sm.shop_id, sm.branch_id, sm.is_branch_restricted, sm.designation, sm.status,
                 s.name, s.slug, s.logo_url, s.verification_status, r.id, r.name`,
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
    /** Attached to a branch is not the same as confined to it. */
    branchRestricted: Boolean(row.is_branch_restricted) && row.branch_id !== null,
    shopName: row.shop_name,
    shopSlug: row.shop_slug,
    shopLogoUrl: row.shop_logo_url,
    designation: row.designation,
    verificationStatus: row.verification_status ?? null,
    /** Still waiting on its first approval, so not yet a shop to run (§12). */
    awaitingFirstApproval: shopVerification.isAwaitingFirstApproval(row.verification_status),
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

  /**
   * The same union, minus shops still waiting on their first approval.
   *
   * Only `canAccessAdmin` reads this, and only to decide which experience the
   * user is shown. Authorization is untouched: the seller keeps every
   * permission on their own registration, which is what lets them edit and
   * submit it, and `hasShopPermission` still answers per shop.
   */
  const administeredPermissions = [
    ...new Set([
      ...globalSet,
      ...shops.filter((shop) => !shop.awaitingFirstApproval).flatMap((shop) => shop.permissions),
    ]),
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
    /**
     * True when the user administers anything at all.
     *
     * A seller whose only shop is an unreviewed registration is not an
     * administrator yet (§12). Mobile reads this to choose between the
     * customer app and the merchant app, so getting it wrong would drop
     * someone mid-registration into a Shop Admin app where every action
     * refuses - and, on mobile, with no way back to the customer tabs.
     */
    canAccessAdmin:
      isSuperAdmin || administeredPermissions.some((name) => MANAGEMENT_PERMISSIONS.includes(name)),
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

/**
 * The one branch this user is confined to within a shop, or `null` for nobody
 * who is confined.
 *
 * `null` is the dangerous value here, so it is given one meaning and only one:
 * **unrestricted**. A shop-level member has `branch_id IS NULL` precisely
 * because they run the whole shop, and a Super Admin has no membership row at
 * all. Reading either as "branch zero" would lock every shop owner out of
 * their own shop, which is why this returns early for both rather than
 * leaving the caller to remember.
 */
function branchScopeFor(access, shopId) {
  if (!access || access.isSuperAdmin) return null;
  const membership = access.shops.find((shop) => shop.shopId === Number(shopId));
  if (!membership) return null;
  // Attachment is not confinement. `branchRestricted` is the stated decision;
  // `branchId` alone has meant "works here" since long before it meant
  // anything about permissions, and still scopes redemption on its own.
  if (!membership.branchRestricted) return null;
  return membership.branchId ?? null;
}

/**
 * Whether this user may act on one particular branch of a shop.
 *
 * A branch-scoped member asked about a shop-wide action - `branchId` absent -
 * is refused, because "every branch" includes branches that are not theirs.
 * That is the rule that stops a branch admin publishing a shop-wide offer.
 */
function mayActOnBranch(access, shopId, branchId) {
  const scope = branchScopeFor(access, shopId);
  if (scope === null) return true;
  if (branchId === null || branchId === undefined) return false;
  return Number(branchId) === scope;
}

/**
 * Every branch confinement that applies to `permission`, keyed by shop id.
 *
 * `shopScopeFor` answers "which shops"; this answers "and within which of them
 * is the caller stuck in one branch". The two are read together by any listing
 * that spans shops, because confinement is per membership: the same person can
 * run the whole of one shop and a single branch of another.
 *
 * An empty map means nobody is confined anywhere, which is the answer for a
 * Super Admin, for a holder of the permission globally - a global grant is
 * wider than any membership, exactly as `shopScopeFor` already treats it - and
 * for the ordinary case of a shop-level member.
 *
 * @returns {Map<number, number>} shop id -> the one branch allowed there
 */
function branchScopesFor(access, permission) {
  const scopes = new Map();
  if (!access || access.isSuperAdmin) return scopes;
  if (hasGlobalPermission(access, permission)) return scopes;

  for (const shop of access.shops) {
    if (!shop.permissions.includes(permission)) continue;
    // Same rule as `branchScopeFor`: attachment is not confinement, and a row
    // claiming confinement without a branch confines nobody.
    if (!shop.branchRestricted || shop.branchId === null) continue;
    scopes.set(shop.shopId, shop.branchId);
  }
  return scopes;
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
  branchScopeFor,
  branchScopesFor,
  mayActOnBranch,
};
