const express = require('express');
const { createAdminBalancesHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

/**
 * Admin balance & quota routes. #quota #PImac
 * Mounted at /api/admin so the sub-paths are:
 *   GET    /balances
 *   PUT    /users/:userId/balance
 *   POST   /users/:userId/balance/credit
 */
const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

const handlers = createAdminBalancesHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  findBalancesByUserIds: db.findBalancesByUserIds,
  findGroupsByMemberIdOnSources: db.findGroupsByMemberIdOnSources,
  findGroupById: db.findGroupById,
  findGroupMemberUserIds: db.findGroupMemberUserIds,
  upsertBalanceFields: db.upsertBalanceFields,
  creditUserBalance: db.creditUserBalance,
});

router.use(requireJwtAuth, requireAdminAccess);

// List all users with balance + inherited group quotas (tri/filtre via query).
router.get('/balances', requireReadUsers, handlers.listBalances);

// Set balance fields (tokenCredits, autoRefill, refill params) for a single user.
router.put('/users/:userId/balance', requireManageUsers, handlers.updateUserBalance);

// Credit a positive token bonus to a user (audit-logged transaction).
router.post('/users/:userId/balance/credit', requireManageUsers, handlers.creditUserBalance);

module.exports = router;
