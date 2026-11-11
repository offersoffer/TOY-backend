'use strict';

const ApiError = require('../utils/ApiError');
const { queryOne, query } = require('../db/pool');
const access = require('../services/accessControl');

/**
 * Authorization pipeline (§38):
 *
 *   authenticated user -> role -> permission -> resource ownership -> allow/deny
 *
 * `requirePermission` covers the first three steps. Ownership is enforced by
 * `requireShopScope` / `loadOfferForWrite`, which are what stop an Admin from
 * one shop touching another shop's offer by editing the id in the URL.
 */

/** Requires the permission globally OR through at least one shop membership. */
const requirePermission = (permission) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!access.hasAnyPermission(req.user, permission)) {
    return next(ApiError.forbidden(`Missing permission: ${permission}`));
  }
  next();
};

/** Requires the permission application-wide - shop membership is not enough. */
const requireGlobalPermission = (permission) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!access.hasGlobalPermission(req.user, permission)) {
    return next(ApiError.forbidden(`Missing permission: ${permission}`));
  }
  next();
};

const requireSuperAdmin = (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!req.user.isSuperAdmin) return next(ApiError.forbidden('Super Admin access required'));
  next();
};

/**
 * Requires `permission` for a specific shop. The shop id is read from
 * `req.params[param]` (default `shopId`), falling back to the request body.
 */
const requireShopScope = (permission, param = 'shopId') => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  const shopId = req.params[param] ?? req.params.id ?? req.body?.shopId ?? req.body?.shop_id;
  if (!shopId) return next(ApiError.badRequest('Shop id is required'));
  if (!access.hasShopPermission(req.user, shopId, permission)) {
    return next(ApiError.forbidden('You do not have access to this shop'));
  }
  req.shopId = Number(shopId);
  next();
};

/**
 * Keeps a branch admin out of their siblings' branches.
 *
 * `requireShopScope` answers "may you touch this shop", which for a branch
 * admin is yes - they run part of it. It does not answer "which branch", and
 * for a write that is the question that matters: editing another branch's
 * address or deactivating it is a good deal more consequential than reading
 * its figures, which is already refused elsewhere.
 *
 * `param` names the branch in the URL. A route with no branch in it - adding
 * one - is refused outright for a confined caller, because a new branch is a
 * shop-level act and a branch admin has no branch of their own to add it to.
 */
const requireBranchScope = (permission, param = 'branchId') => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());

  const shopId = req.params.id ?? req.params.shopId ?? req.shopId;
  const scope = access.branchScopesFor(req.user, permission).get(Number(shopId));
  if (scope === undefined) return next();

  const branchId = req.params[param];
  if (branchId === undefined) {
    return next(ApiError.forbidden('You run one branch, so you cannot add another to this shop'));
  }
  if (Number(branchId) !== scope) {
    return next(ApiError.forbidden('That branch is not yours'));
  }
  next();
};

/**
 * Loads the offer named by `:id` and checks the caller may write to it.
 * Puts the row on `req.offer` so handlers do not re-query.
 */
const loadOfferForWrite = (permission) => async (req, _res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const offer = await queryOne('SELECT * FROM offers WHERE id = ?', [req.params.id]);
    if (!offer) throw ApiError.notFound('Offer not found');
    if (!access.hasShopPermission(req.user, offer.shop_id, permission)) {
      throw ApiError.forbidden('This offer belongs to another shop');
    }

    /**
     * A member who runs one branch may only touch that branch's offers.
     *
     * Enforced here, where the offer is loaded, rather than only in the
     * service: delete has no payload to inspect, so a check that lived on the
     * way in with the body would guard editing and miss removal entirely.
     *
     * A `shop_wide` or `online` offer has no branch of its own, so it belongs
     * to whoever runs the shop - `mayActOnBranch` refuses a branch-scoped
     * member for a null branch, which is exactly that.
     */
    const branchScope = access.branchScopeFor(req.user, offer.shop_id);
    if (branchScope !== null) {
      const links =
        offer.applicability_type === 'selected_branches'
          ? await query('SELECT branch_id FROM offer_locations WHERE offer_id = ?', [offer.id])
          : [];
      const branchIds = links.map((row) => Number(row.branch_id));
      const mine = branchIds.length === 1 && branchIds[0] === branchScope;
      if (!mine) throw ApiError.forbidden('This offer belongs to another branch');
    }

    req.offer = offer;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Loads the service named by `:id` and checks the caller may write to it.
 * Puts the row on `req.service` so handlers do not re-query.
 */
const loadServiceForWrite = (permission) => async (req, _res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const service = await queryOne('SELECT * FROM services WHERE id = ?', [req.params.id]);
    if (!service) throw ApiError.notFound('Service not found');
    if (!access.hasShopPermission(req.user, service.shop_id, permission)) {
      throw ApiError.forbidden('This service belongs to another shop');
    }
    req.service = service;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Loads the service offer named by `:offerId`, scoped to `:id` (the service),
 * and checks the caller may write to it via the owning service's shop.
 */
const loadServiceOfferForWrite = (permission) => async (req, _res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const offer = await queryOne(
      'SELECT * FROM service_offers WHERE id = ? AND service_id = ?',
      [req.params.offerId, req.params.id],
    );
    if (!offer) throw ApiError.notFound('Service offer not found');
    if (!access.hasShopPermission(req.user, offer.shop_id, permission)) {
      throw ApiError.forbidden('This service offer belongs to another shop');
    }
    req.serviceOffer = offer;
    next();
  } catch (error) {
    next(error);
  }
};

/** Ensures the shop in `:id`/`:shopId` exists, and exposes it as `req.shop`. */
const loadShop = (param = 'id') => async (req, _res, next) => {
  try {
    const shop = await queryOne('SELECT * FROM shops WHERE id = ?', [req.params[param]]);
    if (!shop) throw ApiError.notFound('Shop not found');
    req.shop = shop;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  requirePermission,
  requireGlobalPermission,
  requireSuperAdmin,
  requireShopScope,
  requireBranchScope,
  loadOfferForWrite,
  loadServiceForWrite,
  loadServiceOfferForWrite,
  loadShop,
};
