'use strict';

const service = require('./onboarding.service');
const claims = require('./claim.service');
const { ok, created } = require('../../utils/respond');

/** Self-service seller onboarding (§21). Thin: the rules live in the service. */

const start = async (req, res) => created(res, await service.start(req.body, req.user));
const mine = async (req, res) => ok(res, await service.mine(req.user));
const get = async (req, res) => ok(res, await service.get(req.params.id, req.user));
const update = async (req, res) => ok(res, await service.update(req.params.id, req.body, req.user));
const submit = async (req, res) => ok(res, await service.submit(req.params.id, req.user));

/** §16: shops we already have that might be the one they are registering. */
const duplicates = async (req, res) => ok(res, await claims.findPossibleMatches(req.query, req.user));

const createClaim = async (req, res) => created(res, await claims.createClaim(req.body, req.user));
const myClaims = async (req, res) => ok(res, await claims.myClaims(req.user));
const getClaim = async (req, res) => ok(res, await claims.getClaim(req.params.id, req.user));
const withdrawClaim = async (req, res) => ok(res, await claims.withdrawClaim(req.params.id, req.user));

module.exports = {
  start,
  mine,
  get,
  update,
  submit,
  duplicates,
  createClaim,
  myClaims,
  getClaim,
  withdrawClaim,
};
