/**
 * Trades Data Access Layer
 * CRUD operations for trade records
 */

import { prisma, Trade, TradeType, Prisma } from '../client';

export interface CreateTradeInput {
  sessionId?: string;
  userId: string;
  strategyId?: string;
  type: TradeType;
  tokenAddress: string;
  amountSOL: number;
  amountTokens: number;
  price: number;
  priceUSD: number;
  total: number;
  fee: number;
  slippage?: number;
  profitLoss?: number;
  profitLossUSD?: number;
  metadata?: any;
  signature?: string;
  isPaper?: boolean;
  trigger?: string;
}

/**
 * Create a new trade record
 */
export async function createTrade(input: CreateTradeInput): Promise<Trade> {
  return prisma.trade.create({
    data: {
      sessionId: input.sessionId,
      userId: input.userId,
      strategyId: input.strategyId,
      type: input.type,
      tokenAddress: input.tokenAddress,
      amountSOL: input.amountSOL,
      amountTokens: input.amountTokens,
      price: input.price,
      priceUSD: input.priceUSD,
      total: input.total,
      fee: input.fee,
      slippage: input.slippage || 0,
      profitLoss: input.profitLoss,
      profitLossUSD: input.profitLossUSD,
      metadata: input.metadata,
      signature: input.signature,
      isPaper: input.isPaper || false,
      trigger: input.trigger,
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
        },
      },
      strategy: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });
}

/**
 * Find trade by ID
 */
export async function findTradeById(id: string): Promise<Trade | null> {
  return prisma.trade.findUnique({
    where: { id },
    include: {
      user: true,
      strategy: true,
    },
  });
}

/**
 * Find trades by session ID
 */
export async function findTradesBySessionId(sessionId: string): Promise<Trade[]> {
  return prisma.trade.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Find trades by user ID
 */
export async function findTradesByUserId(
  userId: string,
  filters?: {
    type?: TradeType;
    isPaper?: boolean;
    strategyId?: string;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<Trade[]> {
  const where: Prisma.TradeWhereInput = { userId };

  if (filters?.type) where.type = filters.type;
  if (filters?.isPaper !== undefined) where.isPaper = filters.isPaper;
  if (filters?.strategyId) where.strategyId = filters.strategyId;
  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {};
    if (filters.startDate) where.createdAt.gte = filters.startDate;
    if (filters.endDate) where.createdAt.lte = filters.endDate;
  }

  return prisma.trade.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      strategy: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });
}

/**
 * Find trades by strategy ID
 */
export async function findTradesByStrategyId(strategyId: string): Promise<Trade[]> {
  return prisma.trade.findMany({
    where: { strategyId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * List trades with pagination
 */
export async function listTrades(
  page: number = 1,
  limit: number = 50,
  filters?: {
    userId?: string;
    strategyId?: string;
    type?: TradeType;
    isPaper?: boolean;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<{ trades: Trade[]; total: number; pages: number }> {
  const skip = (page - 1) * limit;

  const where: Prisma.TradeWhereInput = {};
  if (filters?.userId) where.userId = filters.userId;
  if (filters?.strategyId) where.strategyId = filters.strategyId;
  if (filters?.type) where.type = filters.type;
  if (filters?.isPaper !== undefined) where.isPaper = filters.isPaper;
  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {};
    if (filters.startDate) where.createdAt.gte = filters.startDate;
    if (filters.endDate) where.createdAt.lte = filters.endDate;
  }

  const [trades, total] = await Promise.all([
    prisma.trade.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            username: true,
          },
        },
        strategy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    prisma.trade.count({ where }),
  ]);

  return {
    trades,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Get trade statistics for a user
 */
export async function getTradeStats(
  userId: string,
  filters?: {
    isPaper?: boolean;
    strategyId?: string;
    days?: number;
  }
) {
  const where: Prisma.TradeWhereInput = { userId };

  if (filters?.isPaper !== undefined) where.isPaper = filters.isPaper;
  if (filters?.strategyId) where.strategyId = filters.strategyId;
  if (filters?.days) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - filters.days);
    where.createdAt = { gte: startDate };
  }

  const [
    totalTrades,
    buyTrades,
    sellTrades,
    profitableTrades,
    totalPnL,
  ] = await Promise.all([
    prisma.trade.count({ where }),
    prisma.trade.count({ where: { ...where, type: 'BUY' } }),
    prisma.trade.count({ where: { ...where, type: 'SELL' } }),
    prisma.trade.count({
      where: {
        ...where,
        profitLoss: { gt: 0 },
      },
    }),
    prisma.trade.aggregate({
      where: { ...where, profitLoss: { not: null } },
      _sum: {
        profitLoss: true,
        profitLossUSD: true,
        fee: true,
      },
      _avg: {
        profitLoss: true,
      },
      _max: {
        profitLoss: true,
      },
      _min: {
        profitLoss: true,
      },
    }),
  ]);

  const winRate = sellTrades > 0 ? (profitableTrades / sellTrades) * 100 : 0;

  return {
    totalTrades,
    buyTrades,
    sellTrades,
    profitableTrades,
    winRate: Math.round(winRate * 100) / 100,
    totalPnL: totalPnL._sum.profitLoss || 0,
    totalPnLUSD: totalPnL._sum.profitLossUSD || 0,
    avgPnL: totalPnL._avg.profitLoss || 0,
    maxProfit: totalPnL._max.profitLoss || 0,
    maxLoss: totalPnL._min.profitLoss || 0,
    totalFees: totalPnL._sum.fee || 0,
  };
}

/**
 * Get recent trades (last N trades)
 */
export async function getRecentTrades(
  userId: string,
  limit: number = 10,
  isPaper?: boolean
): Promise<Trade[]> {
  const where: Prisma.TradeWhereInput = { userId };
  if (isPaper !== undefined) where.isPaper = isPaper;

  return prisma.trade.findMany({
    where,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      strategy: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });
}

/**
 * Delete trade
 */
export async function deleteTrade(id: string): Promise<Trade> {
  return prisma.trade.delete({
    where: { id },
  });
}

/**
 * Get trade history with P&L timeline
 */
export async function getTradeHistory(
  userId: string,
  days: number = 30,
  isPaper?: boolean
) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const where: Prisma.TradeWhereInput = {
    userId,
    createdAt: { gte: startDate },
  };
  if (isPaper !== undefined) where.isPaper = isPaper;

  const trades = await prisma.trade.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });

  // Group by day
  const dailyStats: {
    [date: string]: {
      trades: number;
      volume: number;
      pnl: number;
      fees: number;
    };
  } = {};

  trades.forEach(trade => {
    const date = trade.createdAt.toISOString().split('T')[0];
    if (!dailyStats[date]) {
      dailyStats[date] = { trades: 0, volume: 0, pnl: 0, fees: 0 };
    }
    dailyStats[date].trades++;
    dailyStats[date].volume += trade.total;
    dailyStats[date].pnl += trade.profitLoss || 0;
    dailyStats[date].fees += trade.fee;
  });

  return {
    trades: trades.length,
    dailyStats,
    totalVolume: trades.reduce((sum, t) => sum + t.total, 0),
    totalPnL: trades.reduce((sum, t) => sum + (t.profitLoss || 0), 0),
    totalFees: trades.reduce((sum, t) => sum + t.fee, 0),
  };
}