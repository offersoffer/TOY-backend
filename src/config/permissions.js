'use strict';

/**
 * Canonical permission catalogue (§4). Seeded into the `permissions` table and
 * referenced by name everywhere in the codebase so typos surface at review time.
 */
const PERMISSIONS = {
  VIEW_OFFERS: { category: 'Offers', description: 'View offers' },
  CREATE_OFFER: { category: 'Offers', description: 'Create offers' },
  EDIT_OFFER: { category: 'Offers', description: 'Edit offers' },
  DELETE_OFFER: { category: 'Offers', description: 'Delete or deactivate offers' },
  MODERATE_REVIEWS: { category: 'Offers', description: 'Approve or reject reviews' },

  VIEW_SHOP: { category: 'Shops', description: 'View shop details' },
  CREATE_SHOP: { category: 'Shops', description: 'Create shops' },
  EDIT_SHOP: { category: 'Shops', description: 'Edit shops' },
  DELETE_SHOP: { category: 'Shops', description: 'Delete shops' },
  VIEW_SHOP_MEMBERS: { category: 'Shops', description: 'View the members of a shop' },
  MANAGE_SHOP_MEMBERS: { category: 'Shops', description: 'Add or remove shop members' },
  MANAGE_LOCATIONS: { category: 'Shops', description: 'Manage shop branches and locations' },

  VIEW_USERS: { category: 'Users', description: 'View users' },
  MANAGE_USERS: { category: 'Users', description: 'Create, edit and deactivate users' },
  MANAGE_ROLES: { category: 'Access control', description: 'Manage roles' },
  MANAGE_PERMISSIONS: { category: 'Access control', description: 'Manage permissions' },

  MANAGE_CATEGORIES: { category: 'Catalogue', description: 'Manage offer categories' },

  /**
   * Self-Service Onboarding §14: who may decide a seller registration.
   *
   * A named permission rather than a hardcoded Super Admin check, so review
   * can be delegated to a trusted operations account without a code change -
   * which is the realistic end state, since approving shops is day-to-day
   * work and Super Admin is not. Granted globally only: it is deliberately
   * absent from the shop ADMIN role, because a merchant who held it through
   * a shop membership could approve their own registration.
   */
  REVIEW_SELLER_REGISTRATIONS: {
    category: 'Shops',
    description: 'Review, approve and reject self-service seller registrations',
  },

  // Banner permissions are granted individually (§6). Holding the Admin role
  // is deliberately not enough - a Super Admin must grant each one.
  VIEW_BANNERS: { category: 'Banners', description: 'View featured banners' },
  CREATE_BANNER: { category: 'Banners', description: 'Create featured banners' },
  EDIT_BANNER: { category: 'Banners', description: 'Edit featured banners' },
  DELETE_BANNER: { category: 'Banners', description: 'Delete featured banners' },
  PUBLISH_BANNER: { category: 'Banners', description: 'Publish or deactivate banners' },

  // Claim & redemption (Claim/Redemption §25). Deliberately four grants rather
  // than one: reading who claimed what, pointing a camera at a code, actually
  // giving the benefit away, and taking the history off the platform are
  // different amounts of trust, and a shop with counter staff needs to hand
  // out the middle two without the last.
  VIEW_CLAIMS: { category: 'Offers', description: 'View the claims made on a shop\'s offers' },
  VERIFY_CLAIM: { category: 'Offers', description: 'Look up a claim by QR scan or code' },
  REDEEM_OFFER: { category: 'Offers', description: 'Confirm redemption of a customer offer claim' },
  VIEW_REDEMPTION_HISTORY: { category: 'Offers', description: 'View past redemptions' },
  EXPORT_REDEMPTION_REPORT: { category: 'Offers', description: 'Export the redemption history' },
  REVOKE_CLAIM: { category: 'Offers', description: 'Invalidate a claim during a dispute' },

  VIEW_ANALYTICS: { category: 'Insights', description: 'View analytics dashboards' },
  VIEW_AUDIT_LOGS: { category: 'Insights', description: 'View audit logs' },
  // V3 §26: exporting takes data off the platform, so it is granted separately
  // from merely viewing a dashboard - on top of the plan entitlement.
  EXPORT_ANALYTICS: { category: 'Insights', description: 'Export analytics reports' },

  // V3 §38. Viewing the plan is safe for any shop member; changing it (and so
  // committing the merchant to a charge) is a deliberate, separate grant.
  VIEW_SUBSCRIPTION: { category: 'Subscription', description: 'View the shop subscription plan' },
  MANAGE_SUBSCRIPTION: {
    category: 'Subscription',
    description: 'Change the subscription plan and manage billing',
  },
  MANAGE_CAMPAIGNS: { category: 'Campaigns', description: 'Create and manage marketing campaigns' },

  // Visibility & Promotion (§22).
  //
  // Four grants rather than one, split by who is trusted with what. A
  // merchant may build and read their own promotional campaigns; only the
  // platform owner may change how ranking works or approve a campaign onto a
  // shared promotional space. §24 is explicit that "Admins cannot directly set
  // their own ranking score", and the only structural way to guarantee that is
  // for the ranking controls to be a permission a merchant never holds.
  MANAGE_VISIBILITY: {
    category: 'Visibility',
    description: 'Configure ranking weights, visibility rules, slots and frequency limits',
  },
  MANAGE_FEATURED_CAMPAIGNS: {
    category: 'Visibility',
    description: 'Create and manage featured promotional campaigns',
  },
  APPROVE_FEATURED_CAMPAIGN: {
    category: 'Visibility',
    description: 'Approve, reject or suspend featured campaigns',
  },
  VIEW_VISIBILITY_ANALYTICS: {
    category: 'Insights',
    description: 'View visibility, reach and campaign performance analytics',
  },

  // V4 §18: Services are a first-class listing type alongside offers, with
  // their own permission set mirroring the offer permissions above.
  CREATE_SERVICE: { category: 'Services', description: 'Create services' },
  VIEW_SERVICE: { category: 'Services', description: 'View services' },
  EDIT_SERVICE: { category: 'Services', description: 'Edit services' },
  DELETE_SERVICE: { category: 'Services', description: 'Delete or deactivate services' },
  PUBLISH_SERVICE: { category: 'Services', description: 'Publish or deactivate services' },
  SCHEDULE_SERVICE: { category: 'Services', description: 'Schedule services for future publishing' },
  MANAGE_SERVICE_OFFER: {
    category: 'Services',
    description: 'Create and manage offers attached to a service',
  },
  MANAGE_SERVICE_BOOKING: { category: 'Services', description: 'Manage customer service bookings' },
  VIEW_SERVICE_ANALYTICS: { category: 'Insights', description: 'View service analytics dashboards' },
  EXPORT_SERVICE_ANALYTICS: { category: 'Insights', description: 'Export service analytics reports' },

  // AI (TOY.md). Holding the permission only makes the feature *reachable* -
  // whether it actually runs is decided by the shop's subscription plan, which
  // is checked separately on every call.
  USE_AI_ASSISTANT: { category: 'AI', description: 'Use the AI Offer Assistant' },
  USE_AI_CONTENT: { category: 'AI', description: 'Use the AI content generator' },
  MANAGE_SUBSCRIPTIONS: {
    category: 'AI',
    description: 'Manage subscription plans and AI usage limits',
  },

  // Support. Split in two for the same reason the claim permissions are:
  // reading a queue of customer problems and *answering* on the platform's
  // behalf are different amounts of trust, and a ticket carries the reporter's
  // name, email and phone whether or not they ever had an account.
  VIEW_SUPPORT_TICKETS: { category: 'Support', description: 'View customer support requests' },
  MANAGE_SUPPORT_TICKETS: {
    category: 'Support',
    description: 'Reply to support requests and change their status',
  },
};

const PERMISSION_NAMES = Object.keys(PERMISSIONS);

/**
 * Roles created by the seeder.
 *
 * `scope` decides how a role's permissions are applied when it is assigned to a
 * user directly (via `user_roles`):
 *
 *   global - granted application-wide, across every shop
 *   shop   - granted only for the shops the user is a member of
 *
 * ADMIN is deliberately shop-scoped: §3.2 defines an Admin as "a user assigned
 * to a particular shop", so holding the role must never confer rights over
 * shops the user has nothing to do with.
 */
const SYSTEM_ROLES = {
  SUPER_ADMIN: {
    scope: 'global',
    description: 'Full access to every feature of the platform',
    permissions: PERMISSION_NAMES,
  },
  ADMIN: {
    scope: 'shop',
    description: 'Manages offers for the shops they are a member of',
    permissions: [
      'VIEW_OFFERS',
      'CREATE_OFFER',
      'EDIT_OFFER',
      'DELETE_OFFER',
      'VIEW_SHOP',
      // V3 shop-location §5, §14 and §19 put the shop's own address, map pin
      // and picture in the merchant's hands. Creating and deleting shops stay
      // Super Admin (§16) - those are guarded by the global CREATE_SHOP and
      // DELETE_SHOP - but a shopkeeper who cannot edit their own profile
      // cannot move shop, correct their pin, or upload a photo of their
      // storefront. `requireShopScope` keeps this to shops they belong to.
      'EDIT_SHOP',
      'VIEW_SHOP_MEMBERS',
      'MANAGE_LOCATIONS',
      'VIEW_ANALYTICS',
      'EXPORT_ANALYTICS',
      'VIEW_CLAIMS',
      'VERIFY_CLAIM',
      'REDEEM_OFFER',
      'VIEW_REDEMPTION_HISTORY',
      'EXPORT_REDEMPTION_REPORT',
      // Deliberately no REVOKE_CLAIM: §26 puts invalidating a claim - which is
      // what happens when a customer and a shop disagree - with the Super
      // Admin who is arbitrating, not with either side of the argument.
      // The merchant owns their own plan, so an Admin of the shop can see it
      // and change it. What the plan then unlocks is enforced separately (§30).
      'VIEW_SUBSCRIPTION',
      'MANAGE_SUBSCRIPTION',
      'MANAGE_CAMPAIGNS',
      // The merchant's own promotional campaigns and their reach reporting.
      // Deliberately no MANAGE_VISIBILITY or APPROVE_FEATURED_CAMPAIGN: a
      // merchant who could tune the ranking weights, or wave their own
      // campaign onto the home page, is exactly what §24 forbids.
      'MANAGE_FEATURED_CAMPAIGNS',
      'VIEW_VISIBILITY_ANALYTICS',
      // The subscription plan is the real gate on these two, so granting them
      // to every Admin costs nothing and keeps the upgrade prompt reachable.
      'USE_AI_ASSISTANT',
      'USE_AI_CONTENT',
      // Deliberately no *_BANNER permissions here: §6 requires a Super Admin to
      // grant those explicitly, per Admin.
      'CREATE_SERVICE',
      'VIEW_SERVICE',
      'EDIT_SERVICE',
      'DELETE_SERVICE',
      'PUBLISH_SERVICE',
      'SCHEDULE_SERVICE',
      'MANAGE_SERVICE_OFFER',
      'MANAGE_SERVICE_BOOKING',
      'VIEW_SERVICE_ANALYTICS',
      'EXPORT_SERVICE_ANALYTICS',
    ],
  },
  CUSTOMER: {
    scope: 'global',
    description: 'Discovers and saves offers',
    permissions: ['VIEW_OFFERS', 'VIEW_SHOP', 'VIEW_SERVICE'],
  },
};

/**
 * Permissions that mean "this person administers something". Used to decide who
 * may reach the admin area at all, regardless of which shop they hold them for.
 */
const MANAGEMENT_PERMISSIONS = [
  'VIEW_BANNERS',
  'CREATE_BANNER',
  'EDIT_BANNER',
  'DELETE_BANNER',
  'PUBLISH_BANNER',
  'CREATE_OFFER',
  'EDIT_OFFER',
  'DELETE_OFFER',
  'MANAGE_LOCATIONS',
  'VIEW_SHOP_MEMBERS',
  'MANAGE_SHOP_MEMBERS',
  'VIEW_ANALYTICS',
  'CREATE_SHOP',
  'EDIT_SHOP',
  'DELETE_SHOP',
  'MANAGE_CATEGORIES',
  'MANAGE_USERS',
  'VIEW_USERS',
  'MANAGE_ROLES',
  'MANAGE_PERMISSIONS',
  'MODERATE_REVIEWS',
  'VIEW_AUDIT_LOGS',
  'EXPORT_ANALYTICS',
  'VIEW_SUPPORT_TICKETS',
  'MANAGE_SUPPORT_TICKETS',
  'VIEW_CLAIMS',
  'VERIFY_CLAIM',
  'REDEEM_OFFER',
  'VIEW_REDEMPTION_HISTORY',
  'VIEW_SUBSCRIPTION',
  'MANAGE_SUBSCRIPTION',
  'MANAGE_CAMPAIGNS',
  'MANAGE_VISIBILITY',
  'MANAGE_FEATURED_CAMPAIGNS',
  'APPROVE_FEATURED_CAMPAIGN',
  'VIEW_VISIBILITY_ANALYTICS',
  'CREATE_SERVICE',
  'EDIT_SERVICE',
  'DELETE_SERVICE',
  'VIEW_SERVICE_ANALYTICS',
  'USE_AI_ASSISTANT',
  'USE_AI_CONTENT',
  'MANAGE_SUBSCRIPTIONS',
  'REVIEW_SELLER_REGISTRATIONS',
];

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

module.exports = {
  PERMISSIONS,
  PERMISSION_NAMES,
  SYSTEM_ROLES,
  SUPER_ADMIN_ROLE,
  MANAGEMENT_PERMISSIONS,
};
