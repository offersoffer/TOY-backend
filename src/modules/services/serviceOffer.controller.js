'use strict';

const service = require('./serviceOffer.service');
const audit = require('../../utils/audit');
const { ok, created, noContent, paginated } = require('../../utils/respond');

exports.list = async (req, res) => {
  const { items, pagination } = await service.list(req.params.id, req.query, { manage: Boolean(req.query.manage) });
  paginated(res, items, pagination);
};

exports.detail = async (req, res) => {
  const record = await service.getById(req.params.id, req.params.offerId);
  ok(res, record);
};

exports.create = async (req, res) => {
  const record = await service.create(req.params.id, req.body, req.user);
  await audit.record(req, {
    action: 'SERVICE_OFFER_CREATED',
    entityType: 'service_offer',
    entityId: record.id,
    newValue: { serviceId: record.serviceId, offerText: record.offerText, status: record.status },
  });
  created(res, record);
};

exports.update = async (req, res) => {
  const record = await service.update(req.params.offerId, req.body, req.serviceOffer);
  await audit.record(req, {
    action: 'SERVICE_OFFER_UPDATED',
    entityType: 'service_offer',
    entityId: record.id,
    oldValue: audit.sanitize(req.serviceOffer),
    newValue: { offerText: record.offerText, status: record.status },
  });
  ok(res, record);
};

exports.updateStatus = async (req, res) => {
  const record = await service.changeStatus(req.serviceOffer, req.body.status);
  await audit.record(req, {
    action: 'SERVICE_OFFER_STATUS_CHANGED',
    entityType: 'service_offer',
    entityId: record.id,
    oldValue: { status: req.serviceOffer.status },
    newValue: { status: record.status },
  });
  ok(res, record);
};

exports.remove = async (req, res) => {
  await service.remove(req.params.offerId);
  await audit.record(req, {
    action: 'SERVICE_OFFER_DELETED',
    entityType: 'service_offer',
    entityId: Number(req.params.offerId),
    oldValue: audit.sanitize(req.serviceOffer),
  });
  noContent(res);
};
