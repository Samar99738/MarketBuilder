/**
 * AI Agent Routes
 * API endpoints for conversational trading agent powered by Gemini AI
 */

import { Router, Request, Response } from 'express';
import { agentController } from '../../agent/agentController';
import { asyncHandler } from '../middleware/errorHandler';
import { awsLogger } from '../../aws/logger';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

/**
 * GET /api/agent/health
 * Health check endpoint for monitoring and load balancer
 */
router.get('/health', asyncHandler(async (req: Request, res: Response) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    services: {
      ai: true, // AI is always available
      wallet: !!process.env.WALLET_PRIVATE_KEY,
      trading: process.env.NODE_ENV === 'production',
      database: true // No external database dependency
    }
  };

  res.json({
    success: true,
    data: health,
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /api/agent/chat
 * Send a message to the AI trading agent
 */
router.post('/chat', asyncHandler(async (req: Request, res: Response) => {
  const { message, sessionId, walletAddress, enabledTools } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Message is required'
    });
  }

  // Generate session ID if not provided
  const activeSessionId = sessionId || uuidv4();

  // Process message through agent with enabled tools filter
  const agentResponse = await agentController.processMessage(
    activeSessionId,
    message.trim(),
    walletAddress,
    enabledTools
  );

  // Set proper UTF-8 encoding for emoji support
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  
  res.json({
    success: true,
    sessionId: activeSessionId,
    data: agentResponse,
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /api/agent/execute
 * Execute the current strategy in session
 */
router.post('/execute', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId, userId, walletAddress, paperTradingMode, paperTradingSessionId, resourceLimits } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Session ID is required'
    });
  }

  // userId is optional but recommended for multi-user environments
  // If not provided, use walletAddress as identifier
  const userIdentifier = userId || walletAddress;

  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      error: 'Wallet address is required. Please connect your Phantom wallet.'
    });
  }

  // Execute strategy with paper trading parameters and user context
  const result = await agentController.executeStrategy(
    sessionId, 
    walletAddress, 
    paperTradingMode || 'paper', 
    paperTradingSessionId,
    userIdentifier, // Pass user identifier for multi-user isolation
    resourceLimits // Optional resource limits per user
  );

  if (result.success) {
    await awsLogger.info('Strategy executed via agent', {
      metadata: {
        sessionId,
        strategyId: result.strategyId,
        walletAddress,
        paperTradingMode: paperTradingMode || 'paper',
        paperTradingSessionId
      }
    });

    res.json({
      success: true,
      data: {
        strategyId: result.strategyId,
        message: result.message,
        paperTradingMode: paperTradingMode || 'paper',
        paperTradingSessionId
      },
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(400).json({
      success: false,
      error: result.message,
      timestamp: new Date().toISOString()
    });
  }
}));

/**
 * GET /api/agent/session/:sessionId
 * Get session information
 */
router.get('/session/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const session = agentController.getSession(sessionId);

  res.json({
    success: true,
    data: {
      sessionId: session.sessionId,
      walletConnected: session.walletConnected,
      walletAddress: session.walletAddress,
      hasCurrentStrategy: !!session.currentStrategy,
      currentStrategy: session.currentStrategy,
      messageCount: session.conversationHistory.length,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity
    },
    timestamp: new Date().toISOString()
  });
}));


/**
 * GET /api/agent/stats
 * Get agent statistics
 */
router.get('/stats', asyncHandler(async (req: Request, res: Response) => {
  const activeSessionCount = agentController.getActiveSessions().length;

  res.json({
    success: true,
    data: {
      activeSessions: activeSessionCount,
      status: 'operational',
      aiProvider: 'Gemini Pro',
      walletSupport: 'Phantom',
    },
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/agent/user/:userId/strategies
 * Get all strategies for a specific user
 */
router.get('/user/:userId/strategies', asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  
  // Import here to avoid circular dependency
  const { strategyExecutionManager } = require('../../trading_utils/StrategyExecutionManager');
  
  const strategyIds = strategyExecutionManager.getUserStrategies(userId);
  const strategyDetails = strategyIds.map((runningId: string) => 
    strategyExecutionManager.getStrategyStatus(runningId)
  ).filter((s: any) => s !== null && s !== undefined);
  
  res.json({
    success: true,
    data: {
      userId,
      strategies: strategyDetails,
      count: strategyDetails.length,
      limits: {
        maxConcurrent: 5,
        maxDaily: 100,
        maxPositionSize: 10
      }
    },
    timestamp: new Date().toISOString()
  });
}));

export default router;

