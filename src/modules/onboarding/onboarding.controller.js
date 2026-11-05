'use strict';

const service = require('./onboarding.service');
const { ok, created } = require('../../utils/respond');

/** Self-service seller onboarding (§21). Thin: the rules live in the service. */

const start = async (req, res) => created(res, await service.start(req.body, req.user));
const mine = async (req, res) => ok(res, await service.mine(req.user));
const get = async (req, res) => ok(res, await service.get(req.params.id, req.user));
const update = async (req, res) => ok(res, await service.update(req.params.id, req.body, req.user));
const submit = async (req, res) => ok(res, await service.submit(req.params.id, req.user));

module.exports = { start, mine, get, update, submit };
