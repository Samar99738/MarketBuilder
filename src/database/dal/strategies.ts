/**
 * Strategies Data Access Layer
 * CRUD operations for trading strategies
 */

import { prisma, Strategy, StrategyStatus, Prisma } from '../client';

export interface CreateStrategyInput {
  userId: string;
  name: string;
  description?: string;
  config: any; // JSON strategy configuration
  template?: string;
  status?: StrategyStatus;
}

export interface UpdateStrategyInput {
  name?: string;
  description?: string;
  config?: any;
  status?: StrategyStatus;
  template?: string;
}

/**
 * Create a new strategy
 */
export async function createStrategy(input: CreateStrategyInput): Promise<Strategy> {
  return prisma.strategy.create({
    data: {
      userId: input.userId,
      name: input.name,
      description: input.description,
      config: input.config,
      template: input.template,
      status: input.status || 'DRAFT',
    },
    include: {
      user: true,
    },
  });
}

/**
 * Find strategy by ID
 */
export async function findStrategyById(id: string): Promise<Strategy | null> {
  return prisma.strategy.findUnique({
    where: { id },
    include: {
      user: true,
      trades: {
        orderBy: { createdAt: 'desc' },
        take: 10, // Last 10 trades
      },
      executionLogs: {
        orderBy: { timestamp: 'desc' },
        take: 20, // Last 20 logs
      },
    },
  });
}

/**
 * Find strategies by user ID
 */
export async function findStrategiesByUserId(
  userId: string,
  filters?: {
    status?: StrategyStatus;
    template?: string;
  }
): Promise<Strategy[]> {
  const where: Prisma.StrategyWhereInput = { userId };
  
  if (filters?.status) where.status = filters.status;
  if (filters?.template) where.template = filters.template;

  return prisma.strategy.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      trades: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });
}

/**
 * Update strategy
 */
export async function updateStrategy(
  id: string,
  input: UpdateStrategyInput
): Promise<Strategy> {
  return prisma.strategy.update({
    where: { id },
    data: input,
  });
}

/**
 * Delete strategy
 */
export async function deleteStrategy(id: string): Promise<Strategy> {
  return prisma.strategy.delete({
    where: { id },
  });
}

/**
 * List strategies with pagination
 */
export async function listStrategies(
  page: number = 1,
  limit: number = 50,
  filters?: {
    userId?: string;
    status?: StrategyStatus;
    template?: string;
  }
): Promise<{ strategies: Strategy[]; total: number; pages: number }> {
  const skip = (page - 1) * limit;

  const where: Prisma.StrategyWhereInput = {};
  if (filters?.userId) where.userId = filters.userId;
  if (filters?.status) where.status = filters.status;
  if (filters?.template) where.template = filters.template;

  const [strategies, total] = await Promise.all([
    prisma.strategy.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
        _count: {
          select: {
            trades: true,
            executionLogs: true,
          },
        },
      },
    }),
    prisma.strategy.count({ where }),
  ]);

  return {
    strategies,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Update strategy status
 */
export async function updateStrategyStatus(
  id: string,
  status: StrategyStatus
): Promise<Strategy> {
  return prisma.strategy.update({
    where: { id },
    data: { status },
  });
}

/**
 * Get active strategies for a user
 */
export async function getActiveStrategies(userId: string): Promise<Strategy[]> {
  return prisma.strategy.findMany({
    where: {
      userId,
      status: 'ACTIVE',
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get strategy statistics
 */
export async function getStrategyStats(strategyId: string) {
  const [
    tradeCount,
    successfulTrades,
    totalPnL,
    executionLogs,
  ] = await Promise.all([
    prisma.trade.count({ where: { strategyId } }),
    prisma.trade.count({
      where: {
        strategyId,
        profitLoss: { gt: 0 },
      },
    }),
    prisma.trade.aggregate({
      where: { strategyId, profitLoss: { not: null } },
      _sum: { profitLoss: true, profitLossUSD: true },
      _avg: { profitLoss: true },
    }),
    prisma.executionLog.count({ where: { strategyId } }),
  ]);

  const winRate = tradeCount > 0 ? (successfulTrades / tradeCount) * 100 : 0;

  return {
    trades: tradeCount,
    successfulTrades,
    winRate: Math.round(winRate * 100) / 100,
    totalPnL: totalPnL._sum.profitLoss || 0,
    totalPnLUSD: totalPnL._sum.profitLossUSD || 0,
    avgPnL: totalPnL._avg.profitLoss || 0,
    executionLogs,
  };
}

/**
 * Get strategy performance metrics
 */
export async function getStrategyPerformance(strategyId: string, days: number = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const trades = await prisma.trade.findMany({
    where: {
      strategyId,
      createdAt: { gte: startDate },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Calculate daily P&L
  const dailyPnL: { [date: string]: number } = {};
  
  trades.forEach(trade => {
    const date = trade.createdAt.toISOString().split('T')[0];
    if (!dailyPnL[date]) dailyPnL[date] = 0;
    dailyPnL[date] += trade.profitLoss || 0;
  });

  return {
    trades: trades.length,
    dailyPnL,
    totalPnL: trades.reduce((sum, t) => sum + (t.profitLoss || 0), 0),
  };
}