/**
 * Database Client
 * Singleton pattern for Prisma Client with connection pooling
 */
import { PrismaClient } from '@prisma/client';
import { awsLogger } from '../aws/logger';

// PrismaClient is attached to the `global` object in development to prevent
// exhausting database connections due to hot reloading in development
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'error', 'warn'] 
      : ['error'],
    errorFormat: 'pretty',
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Connect to database
 */
export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    awsLogger.info('Database connected successfully', {
      metadata: {
        environment: process.env.NODE_ENV,
        databaseUrl: process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@'), // Hide password
      }
    });
  } catch (error) {
    awsLogger.error('Database connection failed', {
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      }
    });
    throw error;
  }
}

/**
 * Disconnect from database
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    awsLogger.info('Database disconnected successfully');
  } catch (error) {
    awsLogger.error('Database disconnection failed', {
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      }
    });
  }
}

/**
 * Health check
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    awsLogger.error('Database health check failed', {
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      }
    });
    return false;
  }
}

/**
 * Get database statistics
 */
export async function getDatabaseStats() {
  try {
    const [
      userCount,
      strategyCount,
      tradeCount,
      paperSessionCount,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.strategy.count(),
      prisma.trade.count(),
      prisma.paperTradingSession.count(),
    ]);

    return {
      users: userCount,
      strategies: strategyCount,
      trades: tradeCount,
      paperSessions: paperSessionCount,
    };
  } catch (error) {
    awsLogger.error('Failed to get database stats', {
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      }
    });
    return null;
  }
}

// Export Prisma types for use in other files
export * from '@prisma/client';