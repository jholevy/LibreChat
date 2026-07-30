import { Types } from 'mongoose';
import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import type { IBalance, IGroup, IUser } from '@librechat/data-schemas';
import type { FilterQuery, ClientSession } from 'mongoose';
import type { Response } from 'express';
import type { ValidationError } from '~/types/error';
import type { ServerRequest } from '~/types/http';
import { parsePagination } from './pagination';

/** A single user row enriched with balance + inherited group quotas. #quota #PImac */
export interface AdminBalanceListItem {
  id: string;
  name: string;
  email: string;
  role: string;
  groups: Array<{ id: string; name: string; tokenQuota: number }>;
  tokenCredits: number;
  /** Effective quota === current tokenCredits (group bonuses are baked in once credited). */
  quotaEffectif: number;
  autoRefillEnabled: boolean;
  refillAmount?: number;
}

export interface AdminBalanceList {
  users: AdminBalanceListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminBalancesDeps {
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<IUser[]>;
  countUsers: (searchCriteria: FilterQuery<IUser>) => Promise<number>;
  findBalancesByUserIds: (userIds: string[]) => Promise<IBalance[]>;
  findGroupsByMemberIdOnSources: (
    idOnSources: string[],
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  findGroupById: (
    groupId: string | Types.ObjectId,
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findGroupMemberUserIds: (
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<string[]>;
  upsertBalanceFields: (
    user: string,
    fields: {
      tokenCredits?: number;
      autoRefillEnabled?: boolean;
      refillAmount?: number;
      refillIntervalValue?: number;
      refillIntervalUnit?: string;
    },
  ) => Promise<IBalance | null>;
  creditUserBalance: (params: {
    user: string;
    amount: number;
    note?: string;
    context?: string;
  }) => Promise<{ transaction: unknown; balance: IBalance }>;
}

const VALID_SORT_FIELDS = new Set(['tokenCredits', 'email', 'role', 'name', 'quotaEffectif']);
const MAX_SEARCH_LENGTH = 200;

interface BalanceQuery {
  role?: string;
  q?: string;
  groupId?: string;
  sortBy?: string;
  order?: string;
}

export function createAdminBalancesHandlers(deps: AdminBalancesDeps): {
  listBalances: (req: ServerRequest, res: Response) => Promise<Response>;
  updateUserBalance: (req: ServerRequest, res: Response) => Promise<Response>;
  creditUserBalance: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    findUsers,
    countUsers,
    findBalancesByUserIds,
    findGroupsByMemberIdOnSources,
    findGroupById,
    findGroupMemberUserIds,
    upsertBalanceFields,
    creditUserBalance,
  } = deps;

  /**
   * GET /api/admin/balances
   * Lists all users enriched with their balance and inherited group quotas.
   * Supports: role, q (name/email), groupId filters; sortBy + order; limit/offset.
   */
  async function listBalancesHandler(req: ServerRequest, res: Response) {
    try {
      const { role, q, groupId, sortBy, order } = (req.query ?? {}) as BalanceQuery;
      const { limit, offset } = parsePagination(req.query);

      if (q && q.length > MAX_SEARCH_LENGTH) {
        return res
          .status(400)
          .json({ error: `q must not exceed ${MAX_SEARCH_LENGTH} characters` });
      }

      const criteria: FilterQuery<IUser> = {};
      if (role) {
        criteria.role = role;
      }
      if (q) {
        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        criteria.$or = [{ name: regex }, { email: regex }, { username: regex }];
      }

      // groupId filter: restrict to users who are members of that group.
      let groupMemberUserIds: string[] | null = null;
      if (groupId) {
        if (!isValidObjectIdString(groupId)) {
          return res.status(400).json({ error: 'Invalid groupId format' });
        }
        const group = await findGroupById(groupId, { name: 1 });
        if (!group) {
          return res.status(404).json({ error: 'Group not found' });
        }
        groupMemberUserIds = await findGroupMemberUserIds(groupId);
        if (groupMemberUserIds.length === 0) {
          return res.status(200).json({ users: [], total: 0, limit, offset });
        }
        criteria._id = { $in: groupMemberUserIds.map((id) => new Types.ObjectId(id)) };
      }

      const total = await countUsers(criteria);
      if (total === 0) {
        return res.status(200).json({ users: [], total: 0, limit, offset });
      }

      const users = await findUsers(
        criteria,
        '_id name email username role idOnTheSource avatar',
      );

      // Batch-fetch balances and groups for all users in one pass each.
      const userIds = users.map((u) => u._id?.toString() ?? '').filter(Boolean);
      const allSources = [
        ...new Set(
          users
            .map((u) => u.idOnTheSource || u._id?.toString())
            .filter((s): s is string => Boolean(s)),
        ),
      ];

      const [balances, groups] = await Promise.all([
        findBalancesByUserIds(userIds),
        findGroupsByMemberIdOnSources(allSources),
      ]);

      const balanceByUser = new Map<string, IBalance>();
      for (const b of balances) {
        balanceByUser.set((b.user as Types.ObjectId).toString(), b);
      }

      const items: AdminBalanceListItem[] = users.map((u) => {
        const userKey = u._id?.toString() ?? '';
        const source = u.idOnTheSource || userKey;
        const userGroups = groups.filter((g) => g.memberIds?.includes(source));
        const balance = balanceByUser.get(userKey);
        const tokenCredits = balance?.tokenCredits ?? 0;
        return {
          id: userKey,
          name: u.name ?? u.email ?? userKey,
          email: u.email ?? '',
          role: u.role ?? 'USER',
          groups: userGroups.map((g) => ({
            id: g._id?.toString() ?? '',
            name: g.name,
            tokenQuota: g.tokenQuota ?? 0,
          })),
          tokenCredits,
          quotaEffectif: tokenCredits,
          autoRefillEnabled: balance?.autoRefillEnabled ?? false,
          refillAmount: balance?.refillAmount ?? 0,
        };
      });

      // In-memory sort (balanced datasets for admin panels are small).
      if (sortBy && VALID_SORT_FIELDS.has(sortBy)) {
        const descending = order === 'desc' || order === 'DESC';
        items.sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[sortBy];
          const bv = (b as unknown as Record<string, unknown>)[sortBy];
          if (typeof av === 'number' && typeof bv === 'number') {
            return descending ? bv - av : av - bv;
          }
          const as = String(av ?? '');
          const bs = String(bv ?? '');
          return descending ? bs.localeCompare(as) : as.localeCompare(bs);
        });
      }

      const page = items.slice(offset, offset + limit);
      return res.status(200).json({ users: page, total, limit, offset });
    } catch (error) {
      logger.error('[adminBalances] listBalances error:', error);
      return res.status(500).json({ error: 'Failed to list balances' });
    }
  }

  /**
   * PUT /api/admin/users/:userId/balance
   * Sets balance fields directly (tokenCredits, autoRefill, refill params).
   */
  async function updateUserBalanceHandler(req: ServerRequest, res: Response) {
    try {
      const { userId } = req.params as { userId: string };
      if (!isValidObjectIdString(userId)) {
        return res.status(400).json({ error: 'Invalid userId format' });
      }
      const body = req.body as {
        tokenCredits?: number;
        autoRefillEnabled?: boolean;
        refillAmount?: number;
        refillIntervalValue?: number;
        refillIntervalUnit?: string;
      };

      const fields: {
        tokenCredits?: number;
        autoRefillEnabled?: boolean;
        refillAmount?: number;
        refillIntervalValue?: number;
        refillIntervalUnit?: string;
      } = {};
      if (body.tokenCredits !== undefined) {
        if (typeof body.tokenCredits !== 'number' || isNaN(body.tokenCredits) || body.tokenCredits < 0) {
          return res.status(400).json({ error: 'tokenCredits must be a non-negative number' });
        }
        fields.tokenCredits = body.tokenCredits;
      }
      if (body.autoRefillEnabled !== undefined) {
        fields.autoRefillEnabled = Boolean(body.autoRefillEnabled);
      }
      if (body.refillAmount !== undefined) {
        if (typeof body.refillAmount !== 'number' || isNaN(body.refillAmount) || body.refillAmount < 0) {
          return res.status(400).json({ error: 'refillAmount must be a non-negative number' });
        }
        fields.refillAmount = body.refillAmount;
      }
      if (body.refillIntervalValue !== undefined) {
        fields.refillIntervalValue = body.refillIntervalValue;
      }
      if (body.refillIntervalUnit !== undefined) {
        fields.refillIntervalUnit = body.refillIntervalUnit;
      }

      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const balance = await upsertBalanceFields(userId, fields);
      return res.status(200).json({ balance });
    } catch (error) {
      if ((error as ValidationError).name === 'ValidationError') {
        return res.status(400).json({ error: (error as ValidationError).message });
      }
      logger.error('[adminBalances] updateUserBalance error:', error);
      return res.status(500).json({ error: 'Failed to update balance' });
    }
  }

  /**
   * POST /api/admin/users/:userId/balance/credit
   * Credits a positive token amount to a user (admin manual bonus), with audit trail.
   */
  async function creditUserBalanceHandler(req: ServerRequest, res: Response) {
    try {
      const { userId } = req.params as { userId: string };
      if (!isValidObjectIdString(userId)) {
        return res.status(400).json({ error: 'Invalid userId format' });
      }
      const body = req.body as { amount?: number; note?: string };
      if (
        body.amount === undefined ||
        typeof body.amount !== 'number' ||
        isNaN(body.amount) ||
        body.amount <= 0
      ) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      const result = await creditUserBalance({
        user: userId,
        amount: Math.floor(body.amount),
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined,
        context: 'admin:manual',
      });
      return res.status(200).json(result);
    } catch (error) {
      logger.error('[adminBalances] creditUserBalance error:', error);
      return res.status(500).json({ error: 'Failed to credit balance' });
    }
  }

  return {
    listBalances: listBalancesHandler,
    updateUserBalance: updateUserBalanceHandler,
    creditUserBalance: creditUserBalanceHandler,
  };
}
