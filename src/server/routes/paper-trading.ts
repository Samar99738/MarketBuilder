/**
 * Paper Trading API Routes
 * 
 * RESTful API endpoints for paper trading functionality
 */

import { Router, Request, Response } from 'express';
import { paperTradingEngine } from '../../trading_utils/paper-trading/PaperTradingEngine';
import { strategyExecutionManager } from '../../trading_utils/StrategyExecutionManager';
import { asyncHandler, NotFoundError, ValidationError } from '../middleware/errorHandler';
import { awsLogger } from '../../aws/logger';

const router = Router();

/**
 * GET /api/v1/paper-trading/config
 * Get default paper trading configuration
 */
router.get('/config', asyncHandler(async (req: Request, res: Response) => {
  const config = paperTradingEngine.getDefaultConfig();

  res.json({
    success: true,
    data: { config },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/paper-trading/sessions
 * Create a new paper trading session
 */
router.post('/sessions', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId, userId, strategyId, config } = req.body;

  if (!sessionId) {
    throw new ValidationError('sessionId is required');
  }

  const session = await paperTradingEngine.createSession(
    sessionId,
    userId,
    strategyId,
    config
  );

  await awsLogger.info('Paper trading session created via API', {
    metadata: { sessionId, userId, strategyId }
  });

  res.status(201).json({
    success: true,
    data: { session },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/paper-trading/sessions/:sessionId
 * Get paper trading session state
 */
router.get('/sessions/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const session = paperTradingEngine.getSession(sessionId);

  if (!session) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  res.json({
    success: true,
    data: { session },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * DELETE /api/v1/paper-trading/sessions/:sessionId
 * Delete a paper trading session
 */
router.delete('/sessions/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const deleted = paperTradingEngine.deleteSession(sessionId);

  if (!deleted) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  await awsLogger.info('Paper trading session deleted via API', {
    metadata: { sessionId }
  });

  res.json({
    success: true,
    message: `Session ${sessionId} deleted successfully`,
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/paper-trading/sessions/:sessionId/metrics
 * Get performance metrics for a session
 */
router.get('/sessions/:sessionId/metrics', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const metrics = await paperTradingEngine.getMetrics(sessionId);

  if (!metrics) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  res.json({
    success: true,
    data: { metrics },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/paper-trading/sessions/:sessionId/trades
 * Get all trades for a session
 */
router.get('/sessions/:sessionId/trades', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { limit, offset } = req.query;

  let trades = paperTradingEngine.getTrades(sessionId);

  if (!trades) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  // Apply pagination
  const limitNum = limit ? parseInt(limit as string) : undefined;
  const offsetNum = offset ? parseInt(offset as string) : 0;

  if (limitNum) {
    trades = trades.slice(offsetNum, offsetNum + limitNum);
  }

  res.json({
    success: true,
    data: {
      trades,
      total: trades.length,
      limit: limitNum,
      offset: offsetNum,
    },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/paper-trading/sessions/:sessionId/logs
 * Get logs for a session
 */
router.get('/sessions/:sessionId/logs', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { level, limit } = req.query;

  let logs = paperTradingEngine.getLogs(sessionId);

  // Filter by level if specified
  if (level) {
    logs = logs.filter(log => log.level === level);
  }

  // Apply limit
  const limitNum = limit ? parseInt(limit as string) : 100;
  logs = logs.slice(-limitNum);

  res.json({
    success: true,
    data: {
      logs,
      total: logs.length,
    },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/paper-trading/sessions/:sessionId/pause
 * Pause a paper trading session
 */
router.post('/sessions/:sessionId/pause', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const success = paperTradingEngine.pauseSession(sessionId);

  if (!success) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  await awsLogger.info('Paper trading session paused', {
    metadata: { sessionId }
  });

  res.json({
    success: true,
    message: 'Session paused',
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/paper-trading/sessions/:sessionId/resume
 * Resume a paper trading session
 */
router.post('/sessions/:sessionId/resume', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const success = paperTradingEngine.resumeSession(sessionId);

  if (!success) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  await awsLogger.info('Paper trading session resumed', {
    metadata: { sessionId }
  });

  res.json({
    success: true,
    message: 'Session resumed',
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/paper-trading/sessions/:sessionId/end
 * End a paper trading session
 */
router.post('/sessions/:sessionId/end', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const success = await paperTradingEngine.endSession(sessionId);

  if (!success) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  const metrics = await paperTradingEngine.getMetrics(sessionId);

  await awsLogger.info('Paper trading session ended', {
    metadata: { sessionId, metrics }
  });

  res.json({
    success: true,
    message: 'Session ended',
    data: { metrics },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/paper-trading/sessions/:sessionId/reset
 * Reset a paper trading session
 */
router.post('/sessions/:sessionId/reset', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const success = await paperTradingEngine.resetSession(sessionId);

  if (!success) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  await awsLogger.info('Paper trading session reset', {
    metadata: { sessionId }
  });

  res.json({
    success: true,
    message: 'Session reset',
    timestamp: new Date().toISOString(),
  });
}));

/**
 * PUT /api/v1/paper-trading/sessions/:sessionId/config
 * Update session configuration
 */
router.put('/sessions/:sessionId/config', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { config } = req.body;

  if (!config) {
    throw new ValidationError('config is required');
  }

  const success = paperTradingEngine.updateConfig(sessionId, config);

  if (!success) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  await awsLogger.info('Paper trading session config updated', {
    metadata: { sessionId, config }
  });

  res.json({
    success: true,
    message: 'Configuration updated',
    timestamp: new Date().toISOString(),
  });
}));

/**
 * DELETE /api/v1/paper-trading/sessions/:sessionId
 * Delete a paper trading session
 */
router.delete('/sessions/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const success = paperTradingEngine.deleteSession(sessionId);

  if (!success) {
    throw new NotFoundError(`Paper trading session '${sessionId}' not found`);
  }

  await awsLogger.info('Paper trading session deleted', {
    metadata: { sessionId }
  });

  res.json({
    success: true,
    message: 'Session deleted',
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/paper-trading/active-sessions
 * Get all active paper trading sessions
 */
router.get('/active-sessions', asyncHandler(async (req: Request, res: Response) => {
  const sessions = paperTradingEngine.getActiveSessions();

  res.json({
    success: true,
    data: {
      sessions,
      total: sessions.length,
    },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/paper-trading/strategies/:runningId/metrics
 * Get paper trading metrics for a running strategy
 */
router.get('/strategies/:runningId/metrics', asyncHandler(async (req: Request, res: Response) => {
  const { runningId } = req.params;

  const metrics = await strategyExecutionManager.getPaperTradingMetrics(runningId);

  if (!metrics) {
    throw new NotFoundError(`No paper trading metrics found for running strategy '${runningId}'`);
  }

  res.json({
    success: true,
    data: { metrics },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/paper-trading/strategies/:runningId/trades
 * Get paper trading trades for a running strategy
 */
router.get('/strategies/:runningId/trades', asyncHandler(async (req: Request, res: Response) => {
  const { runningId } = req.params;

  const trades = strategyExecutionManager.getPaperTradingTrades(runningId);

  res.json({
    success: true,
    data: {
      trades,
      total: trades.length,
    },
    timestamp: new Date().toISOString(),
  });
}));

export default router;
