'use strict';

const service = require('./shop.service');
const audit = require('../../utils/audit');
const accessControl = require('../../services/accessControl');
const { ok, created, noContent, paginated } = require('../../utils/respond');

const positionFrom = (query) =>
  query.latitude !== undefined && query.longitude !== undefined
    ? { latitude: Number(query.latitude), longitude: Number(query.longitude) }
    : null;

exports.list = async (req, res) => {
  const { items, pagination } = await service.list(req.query, req.user);
  paginated(res, items, pagination);
};

exports.detail = async (req, res) => {
  ok(res, await service.getById(req.params.id, req.user, positionFrom(req.query)));
};

exports.create = async (req, res) => {
  const shop = await service.create(req.body, req.user);
  await audit.record(req, {
    action: 'SHOP_CREATED',
    entityType: 'shop',
    entityId: shop.id,
    newValue: { name: shop.name, status: shop.status },
  });
  created(res, shop);
};

exports.update = async (req, res) => {
  const shop = await service.update(req.params.id, req.body, req.user);
  await audit.record(req, {
    action: 'SHOP_UPDATED',
    entityType: 'shop',
    entityId: shop.id,
    oldValue: audit.sanitize(req.shop),
    newValue: { name: shop.name, status: shop.status },
  });
  ok(res, shop);
};

exports.remove = async (req, res) => {
  await service.remove(req.params.id);
  await audit.record(req, {
    action: 'SHOP_DELETED',
    entityType: 'shop',
    entityId: Number(req.params.id),
    oldValue: audit.sanitize(req.shop),
  });
  noContent(res);
};

// ---- Branches --------------------------------------------------------------

exports.listBranches = async (req, res) => {
  // Staff see deactivated branches too; customers only see live ones.
  const includeInactive = accessControl.hasShopPermission(req.user, req.params.id, 'MANAGE_LOCATIONS');
  // A branch admin sees their own branch and no sibling's. Undefined - nobody
  // confined - becomes null, which the service reads as "every branch", and
  // is what a customer and a shop owner both get.
  const branchScope =
    accessControl.branchScopesFor(req.user, 'MANAGE_LOCATIONS').get(Number(req.params.id)) ?? null;
  ok(res, await service.listBranches(req.params.id, { includeInactive, branchScope }));
};

exports.createBranch = async (req, res) => {
  const branch = await service.createBranch(req.params.id, req.body);
  await audit.record(req, {
    action: 'BRANCH_CREATED',
    entityType: 'shop_branch',
    entityId: branch.id,
    newValue: { shopId: Number(req.params.id), branchName: branch.branchName, city: branch.city },
  });
  created(res, branch);
};

exports.updateBranch = async (req, res) => {
  const branch = await service.updateBranch(req.params.id, req.params.branchId, req.body);
  await audit.record(req, {
    action: 'BRANCH_UPDATED',
    entityType: 'shop_branch',
    entityId: branch.id,
    newValue: { branchName: branch.branchName, city: branch.city, status: branch.status },
  });
  ok(res, branch);
};

exports.deactivateBranch = async (req, res) => {
  await service.deactivateBranch(req.params.id, req.params.branchId);
  await audit.record(req, {
    action: 'BRANCH_DEACTIVATED',
    entityType: 'shop_branch',
    entityId: Number(req.params.branchId),
  });
  noContent(res);
};

// ---- Members ---------------------------------------------------------------

exports.listMembers = async (req, res) => {
  ok(res, await service.listMembers(req.params.id));
};

exports.addMember = async (req, res) => {
  const member = await service.addMember(req.params.id, req.body);
  await audit.record(req, {
    action: 'MEMBER_ADDED',
    entityType: 'shop_member',
    entityId: member.id,
    newValue: { shopId: Number(req.params.id), userId: member.userId, designation: member.designation },
  });
  created(res, member);
};

exports.updateMember = async (req, res) => {
  const member = await service.updateMember(req.params.id, req.params.memberId, req.body);
  await audit.record(req, {
    action: 'MEMBER_UPDATED',
    entityType: 'shop_member',
    entityId: member.id,
    newValue: { roleId: member.roleId, branchId: member.branchId, status: member.status },
  });
  ok(res, member);
};

exports.removeMember = async (req, res) => {
  await service.removeMember(req.params.id, req.params.memberId);
  await audit.record(req, {
    action: 'MEMBER_REMOVED',
    entityType: 'shop_member',
    entityId: Number(req.params.memberId),
    oldValue: { shopId: Number(req.params.id) },
  });
  noContent(res);
};
