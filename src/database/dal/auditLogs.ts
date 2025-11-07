/**
 * Audit Logs Data Access Layer
 * CRUD operations for audit trail
 */

import { prisma, AuditLog, Prisma } from '../client';

export interface CreateAuditLogInput {
  userId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Create audit log
 */
export async function createAuditLog(
  input: CreateAuditLogInput
): Promise<AuditLog> {
  return prisma.auditLog.create({
    data: input,
  });
}

/**
 * Find logs by user ID
 */
export async function findAuditLogsByUserId(
  userId: string,
  limit: number = 100
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Find logs by action
 */
export async function findAuditLogsByAction(
  action: string,
  limit: number = 100
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: { action },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Find logs by resource
 */
export async function findAuditLogsByResource(
  resourceType: string,
  resourceId: string
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: {
      resourceType,
      resourceId,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * List audit logs with pagination
 */
export async function listAuditLogs(
  page: number = 1,
  limit: number = 50,
  filters?: {
    userId?: string;
    action?: string;
    resourceType?: string;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<{ logs: AuditLog[]; total: number; pages: number }> {
  const skip = (page - 1) * limit;

  const where: Prisma.AuditLogWhereInput = {};
  if (filters?.userId) where.userId = filters.userId;
  if (filters?.action) where.action = filters.action;
  if (filters?.resourceType) where.resourceType = filters.resourceType;
  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {};
    if (filters.startDate) where.createdAt.gte = filters.startDate;
    if (filters.endDate) where.createdAt.lte = filters.endDate;
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
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
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Get recent activity
 */
export async function getRecentActivity(
  userId?: string,
  limit: number = 20
): Promise<AuditLog[]> {
  const where: Prisma.AuditLogWhereInput = {};
  if (userId) where.userId = userId;

  return prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      user: {
        select: {
          id: true,
          username: true,
        },
      },
    },
  });
}

/**
 * Delete old audit logs (cleanup)
 */
export async function deleteOldAuditLogs(daysToKeep: number = 90): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const result = await prisma.auditLog.deleteMany({
    where: {
      createdAt: {
        lt: cutoffDate,
      },
    },
  });

  return result.count;
}

/**
 * Get audit log statistics
 */
export async function getAuditLogStats(
  userId?: string,
  days: number = 30
) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const where: Prisma.AuditLogWhereInput = {
    createdAt: { gte: startDate },
  };
  if (userId) where.userId = userId;

  const logs = await prisma.auditLog.findMany({
    where,
    select: {
      action: true,
      createdAt: true,
    },
  });

  // Group by action
  const actionCounts: { [action: string]: number } = {};
  logs.forEach(log => {
    actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
  });

  // Group by day
  const dailyActivity: { [date: string]: number } = {};
  logs.forEach(log => {
    const date = log.createdAt.toISOString().split('T')[0];
    dailyActivity[date] = (dailyActivity[date] || 0) + 1;
  });

  return {
    totalLogs: logs.length,
    actionCounts,
    dailyActivity,
  };
}

/**
 * Log user action (helper function)
 */
export async function logUserAction(
  userId: string,
  action: string,
  resourceType?: string,
  resourceId?: string,
  details?: any,
  req?: any // Express request object
): Promise<AuditLog> {
  return createAuditLog({
    userId,
    action,
    resourceType,
    resourceId,
    details,
    ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress,
    userAgent: req?.headers?.['user-agent'],
  });
}