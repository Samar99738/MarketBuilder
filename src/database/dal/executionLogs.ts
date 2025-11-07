/**
 * Execution Logs Data Access Layer
 * CRUD operations for strategy execution logs
 */

import { prisma, ExecutionLog, LogStatus, Prisma } from '../client';

export interface CreateExecutionLogInput {
  strategyId: string;
  runningId: string;
  step: string;
  status: LogStatus;
  message: string;
  metadata?: any;
  duration?: number;
}

/**
 * Create execution log
 */
export async function createExecutionLog(
  input: CreateExecutionLogInput
): Promise<ExecutionLog> {
  return prisma.executionLog.create({
    data: input,
  });
}

/**
 * Find logs by strategy ID
 */
export async function findLogsByStrategyId(
  strategyId: string,
  limit: number = 100
): Promise<ExecutionLog[]> {
  return prisma.executionLog.findMany({
    where: { strategyId },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
}

/**
 * Find logs by running ID
 */
export async function findLogsByRunningId(
  runningId: string
): Promise<ExecutionLog[]> {
  return prisma.executionLog.findMany({
    where: { runningId },
    orderBy: { timestamp: 'asc' },
  });
}

/**
 * Find logs by status
 */
export async function findLogsByStatus(
  strategyId: string,
  status: LogStatus,
  limit: number = 50
): Promise<ExecutionLog[]> {
  return prisma.executionLog.findMany({
    where: {
      strategyId,
      status,
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
}

/**
 * Get recent error logs
 */
export async function getRecentErrors(
  strategyId?: string,
  limit: number = 20
): Promise<ExecutionLog[]> {
  const where: Prisma.ExecutionLogWhereInput = {
    status: 'ERROR',
  };
  if (strategyId) where.strategyId = strategyId;

  return prisma.executionLog.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: limit,
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
 * Delete old logs (cleanup)
 */
export async function deleteOldLogs(daysToKeep: number = 30): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const result = await prisma.executionLog.deleteMany({
    where: {
      timestamp: {
        lt: cutoffDate,
      },
    },
  });

  return result.count;
}

/**
 * Get log statistics for a strategy
 */
export async function getLogStats(strategyId: string) {
  const [total, infoCount, successCount, warningCount, errorCount] =
    await Promise.all([
      prisma.executionLog.count({ where: { strategyId } }),
      prisma.executionLog.count({
        where: { strategyId, status: 'INFO' },
      }),
      prisma.executionLog.count({
        where: { strategyId, status: 'SUCCESS' },
      }),
      prisma.executionLog.count({
        where: { strategyId, status: 'WARNING' },
      }),
      prisma.executionLog.count({
        where: { strategyId, status: 'ERROR' },
      }),
    ]);

  return {
    total,
    info: infoCount,
    success: successCount,
    warning: warningCount,
    error: errorCount,
    errorRate: total > 0 ? (errorCount / total) * 100 : 0,
  };
}