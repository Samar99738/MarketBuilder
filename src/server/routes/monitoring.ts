/**
 * Monitoring Routes
 * API endpoints for production monitoring and metrics
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { monitoringService } from '../../utils/monitoring';
import { getRPCMetrics } from '../../config/rpc-config';
import { strategyExecutionManager } from '../../trading_utils/StrategyExecutionManager';

const router = Router();

/**
 * GET /api/monitoring/health
 * Comprehensive health check with all service statuses
 */
router.get('/health', asyncHandler(async (req: Request, res: Response) => {
  const systemMetrics = await monitoringService.getSystemMetrics();
  const strategyMetrics = monitoringService.getStrategyMetrics();
  const rpcMetrics = await monitoringService.getRPCHealthMetrics();
  const alerts = await monitoringService.getAlerts();
  
  const isHealthy = rpcMetrics.healthy && 
                   systemMetrics.memory.percentage < 90 &&
                   strategyMetrics.totalErrors === 0;
  
  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    data: {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        rpc: rpcMetrics.healthy,
        strategies: strategyMetrics.totalErrors === 0,
        memory: systemMetrics.memory.percentage < 90,
      },
      metrics: {
        system: systemMetrics,
        strategies: {
          running: strategyMetrics.totalRunning,
          stopped: strategyMetrics.totalStopped,
          errors: strategyMetrics.totalErrors,
          executionRate: strategyMetrics.executionRate,
        },
        rpc: {
          endpoint: rpcMetrics.endpoint,
          latency: rpcMetrics.latency,
          errorRate: rpcMetrics.errorRate,
        },
      },
      alerts: alerts.length > 0 ? alerts : undefined,
    },
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/monitoring/metrics
 * Get current metrics snapshot
 */
router.get('/metrics', asyncHandler(async (req: Request, res: Response) => {
  const snapshot = await monitoringService.getMetricsSnapshot();
  
  res.json({
    success: true,
    data: snapshot,
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/monitoring/metrics/history
 * Get metrics history
 */
router.get('/metrics/history', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const history = monitoringService.getMetricsHistory(limit);
  
  res.json({
    success: true,
    data: {
      history,
      count: history.length,
    },
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/monitoring/alerts
 * Get current alerts
 */
router.get('/alerts', asyncHandler(async (req: Request, res: Response) => {
  const alerts = await monitoringService.getAlerts();
  
  res.json({
    success: true,
    data: {
      alerts,
      count: alerts.length,
      hasAlerts: alerts.length > 0,
      hasCritical: alerts.some(a => a.level === 'critical'),
    },
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/monitoring/rpc
 * Get detailed RPC metrics
 */
router.get('/rpc', asyncHandler(async (req: Request, res: Response) => {
  const metrics = await getRPCMetrics();
  
  res.json({
    success: true,
    data: metrics,
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/monitoring/strategies
 * Get detailed strategy execution metrics
 */
router.get('/strategies', asyncHandler(async (req: Request, res: Response) => {
  const strategyMetrics = monitoringService.getStrategyMetrics();
  const strategies = strategyExecutionManager.listRunningStrategies();
  
  // Convert Map to array for JSON serialization
  const byUserArray = Array.from(strategyMetrics.byUser.values());
  
  res.json({
    success: true,
    data: {
      summary: {
        totalRunning: strategyMetrics.totalRunning,
        totalStopped: strategyMetrics.totalStopped,
        totalErrors: strategyMetrics.totalErrors,
        executionRate: strategyMetrics.executionRate,
        totalUsers: byUserArray.length,
      },
      byUser: byUserArray,
      strategies: strategies.map(s => ({
        id: s.id,
        strategyId: s.strategyId,
        userId: s.userId,
        status: s.status,
        executionCount: s.executionCount,
        uptime: Date.now() - s.startTime,
        mode: s.paperTradingMode,
      })),
    },
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /api/monitoring/reset
 * Reset monitoring metrics (admin only)
 */
router.post('/reset', asyncHandler(async (req: Request, res: Response) => {
  monitoringService.reset();
  
  res.json({
    success: true,
    message: 'Monitoring metrics reset successfully',
    timestamp: new Date().toISOString()
  });
}));

export default router;
