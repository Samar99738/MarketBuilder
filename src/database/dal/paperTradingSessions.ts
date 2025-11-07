/**
 * Paper Trading Sessions Data Access Layer
 * CRUD operations for paper trading sessions
 */

import { prisma, PaperTradingSession, SessionStatus, Prisma } from '../client';

export interface CreatePaperSessionInput {
  userId: string;
  strategyId?: string;
  name?: string;
  initialBalanceSOL: number;
  initialBalanceUSDC?: number;
  tokenAddress: string;
}

export interface UpdatePaperSessionInput {
  name?: string;
  currentBalanceSOL?: number;
  currentBalanceUSDC?: number;
  balanceTokens?: number;
  status?: SessionStatus;
  totalPnL?: number;
  totalPnLUSD?: number;
  realizedPnL?: number;
  realizedPnLUSD?: number;
  unrealizedPnL?: number;
  unrealizedPnLUSD?: number;
  roi?: number;
  totalValueUSD?: number;
  tradeCount?: number;
  winRate?: number;
  metadata?: any;
  endedAt?: Date;
}

/**
 * Create a new paper trading session
 */
export async function createPaperSession(
  input: CreatePaperSessionInput
): Promise<PaperTradingSession> {
  return prisma.paperTradingSession.create({
    data: {
      userId: input.userId,
      strategyId: input.strategyId,
      name: input.name || `Paper Session ${new Date().toISOString()}`,
      initialBalanceSOL: input.initialBalanceSOL,
      initialBalanceUSDC: input.initialBalanceUSDC || 0,
      currentBalanceSOL: input.initialBalanceSOL,
      currentBalanceUSDC: input.initialBalanceUSDC || 0,
      tokenAddress: input.tokenAddress,
      status: 'ACTIVE',
    },
    include: {
      user: true,
      strategy: true,
    },
  });
}

/**
 * Find paper session by ID
 */
export async function findPaperSessionById(
  id: string
): Promise<PaperTradingSession | null> {
  return prisma.paperTradingSession.findUnique({
    where: { id },
    include: {
      user: true,
      strategy: true,
    },
  });
}

/**
 * Find sessions by user ID
 */
export async function findPaperSessionsByUserId(
  userId: string,
  filters?: {
    status?: SessionStatus;
    strategyId?: string;
  }
): Promise<PaperTradingSession[]> {
  const where: Prisma.PaperTradingSessionWhereInput = { userId };

  if (filters?.status) where.status = filters.status;
  if (filters?.strategyId) where.strategyId = filters.strategyId;

  return prisma.paperTradingSession.findMany({
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
 * Update paper session
 */
export async function updatePaperSession(
  id: string,
  input: UpdatePaperSessionInput
): Promise<PaperTradingSession> {
  return prisma.paperTradingSession.update({
    where: { id },
    data: input,
  });
}

/**
 * Update session balances
 */
export async function updateSessionBalances(
  id: string,
  balanceSOL: number,
  balanceUSDC: number,
  balanceTokens: number
): Promise<PaperTradingSession> {
  return prisma.paperTradingSession.update({
    where: { id },
    data: {
      currentBalanceSOL: balanceSOL,
      currentBalanceUSDC: balanceUSDC,
      balanceTokens: balanceTokens,
    },
  });
}

/**
 * Update session metrics
 */
export async function updateSessionMetrics(
  id: string,
  metrics: {
    totalPnL: number;
    totalPnLUSD: number;
    realizedPnL: number;
    realizedPnLUSD: number;
    unrealizedPnL: number;
    unrealizedPnLUSD: number;
    roi: number;
    totalValueUSD: number;
    tradeCount: number;
    winRate: number;
  }
): Promise<PaperTradingSession> {
  return prisma.paperTradingSession.update({
    where: { id },
    data: metrics,
  });
}

/**
 * End paper session
 */
export async function endPaperSession(id: string): Promise<PaperTradingSession> {
  return prisma.paperTradingSession.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      endedAt: new Date(),
    },
  });
}

/**
 * Delete paper session
 */
export async function deletePaperSession(id: string): Promise<PaperTradingSession> {
  return prisma.paperTradingSession.delete({
    where: { id },
  });
}

/**
 * List sessions with pagination
 */
export async function listPaperSessions(
  page: number = 1,
  limit: number = 50,
  filters?: {
    userId?: string;
    status?: SessionStatus;
    strategyId?: string;
  }
): Promise<{
  sessions: PaperTradingSession[];
  total: number;
  pages: number;
}> {
  const skip = (page - 1) * limit;

  const where: Prisma.PaperTradingSessionWhereInput = {};
  if (filters?.userId) where.userId = filters.userId;
  if (filters?.status) where.status = filters.status;
  if (filters?.strategyId) where.strategyId = filters.strategyId;

  const [sessions, total] = await Promise.all([
    prisma.paperTradingSession.findMany({
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
    prisma.paperTradingSession.count({ where }),
  ]);

  return {
    sessions,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Get active sessions for a user
 */
export async function getActiveSessions(
  userId: string
): Promise<PaperTradingSession[]> {
  return prisma.paperTradingSession.findMany({
    where: {
      userId,
      status: 'ACTIVE',
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get session statistics
 */
export async function getPaperSessionStats(userId: string) {
  const [totalSessions, activeSessions, completedSessions, aggregate] =
    await Promise.all([
      prisma.paperTradingSession.count({ where: { userId } }),
      prisma.paperTradingSession.count({
        where: { userId, status: 'ACTIVE' },
      }),
      prisma.paperTradingSession.count({
        where: { userId, status: 'COMPLETED' },
      }),
      prisma.paperTradingSession.aggregate({
        where: { userId },
        _sum: {
          totalPnL: true,
          totalPnLUSD: true,
          tradeCount: true,
        },
        _avg: {
          roi: true,
          winRate: true,
        },
      }),
    ]);

  return {
    totalSessions,
    activeSessions,
    completedSessions,
    totalPnL: aggregate._sum.totalPnL || 0,
    totalPnLUSD: aggregate._sum.totalPnLUSD || 0,
    totalTrades: aggregate._sum.tradeCount || 0,
    avgROI: aggregate._avg.roi || 0,
    avgWinRate: aggregate._avg.winRate || 0,
  };
}

/**
 * Get session performance over time
 */
export async function getSessionPerformance(sessionId: string) {
  const session = await findPaperSessionById(sessionId);
  if (!session) return null;

  // Get all trades for this session
  const trades = await prisma.trade.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });

  // Calculate cumulative P&L
  let cumulativePnL = 0;
  const performanceTimeline = trades.map(trade => {
    cumulativePnL += trade.profitLoss || 0;
    return {
      timestamp: trade.createdAt,
      tradeType: trade.type,
      pnl: trade.profitLoss || 0,
      cumulativePnL,
      price: trade.price,
    };
  });

  return {
    session,
    trades: trades.length,
    performanceTimeline,
    currentPnL: cumulativePnL,
  };
}