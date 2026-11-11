'use strict';

const ApiError = require('../utils/ApiError');
const accessControl = require('./accessControl');

/**
 * Confining an analytics request to one branch.
 *
 * The premium dashboards - offers, services - already take a `branchId`
 * filter, and it already means the right thing: an offer counts towards a
 * branch when it *runs* there, so a shop-wide offer counts towards every
 * branch of its shop. A member confined to one branch therefore does not need
 * a new rule, only to have that filter decided for them instead of chosen.
 *
 * This lives in its own module because three routers need the same answer -
 * `analytics/premium`, `services/serviceAnalytics` and anything added beside
 * them - and a rule about who may see what is not something to re-derive per
 * dashboard.
 */

/**
 * Forces the branch filter for a confined caller, and refuses the requests
 * that cannot be answered honestly.
 *
 * Two refusals, both deliberate:
 *
 *   - a branch admin naming a *different* branch is told so, rather than shown
 *     their own branch's figures under someone else's heading; and
 *   - a caller confined in one shop while reporting on several at once is
 *     asked to pick a shop, because `branchId` is a single value and silently
 *     applying one shop's branch to another shop's offers would filter that
 *     second shop down to nothing while still printing its name.
 *
 * The second case needs two memberships that each confine the same person to a
 * branch of a different shop. It is rare, and that is the argument for failing
 * loudly: nobody will have a mental model of it when it happens.
 *
 * @param {object} user          the access context
 * @param {number[]|null} shopIds the shops already resolved for this request
 * @param {object} filters       the filter bag, mutated in place
 * @param {string} permission    the analytics permission being exercised
 * @returns {number|null} the branch the response now covers
 */
function confineFilters(user, shopIds, filters, permission) {
  const confined = accessControl.branchScopesFor(user, permission);
  if (confined.size === 0) return null;

  // `null` shopIds means platform-wide, which `branchScopesFor` already
  // excludes - a Super Admin and a global grant are both unconfined.
  const scope = shopIds ?? [];
  const here = scope.filter((shopId) => confined.has(Number(shopId)));
  if (here.length === 0) return null;

  if (scope.length > 1) {
    throw ApiError.badRequest(
      'You run a single branch, so analytics cover one shop at a time. Add a shopId to the request.',
    );
  }

  const branchId = confined.get(Number(scope[0]));
  if (filters.branchId && Number(filters.branchId) !== branchId) {
    throw ApiError.forbidden('You can only view analytics for your own branch');
  }

  filters.branchId = branchId;
  return branchId;
}

/** True when this caller is confined to a branch of any shop they can report on. */
function isConfined(user, permission) {
  return accessControl.branchScopesFor(user, permission).size > 0;
}

module.exports = { confineFilters, isConfined };
