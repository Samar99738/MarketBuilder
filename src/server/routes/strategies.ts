/**
 * Strategy CRUD Routes
 * RESTful API endpoints for strategy management
 */

import { Router, Request, Response } from 'express';
import { strategyBuilder } from '../../trading_utils/StrategyBuilder';
import { createStrategyFromTemplate } from '../../trading_utils/StrategyTemplates';
import {
  validateRequest,
  validateStrategyId,
  createStrategySchema,
  updateStrategySchema,
  createFromTemplateSchema,
} from '../middleware/validation';
import { asyncHandler, NotFoundError, ValidationError } from '../middleware/errorHandler';
import { strategyCreationLimiter } from '../middleware/rateLimiting';
import { awsLogger } from '../../aws/logger';

const router = Router();

/**
 * GET /api/v1/strategies
 * List all strategies
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const strategies = strategyBuilder.listStrategies();
  
  const strategiesWithDetails = strategies.map(strategy => ({
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    stepCount: strategy.steps.length,
    isProduction: strategy.isProduction,
    createdAt: strategy.createdAt,
    updatedAt: strategy.updatedAt,
    riskLimits: strategy.riskLimits,
  }));

  res.json({
    success: true,
    data: {
      strategies: strategiesWithDetails,
      total: strategiesWithDetails.length,
    },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/strategies/:id
 * Get strategy details
 */
router.get('/:id', validateStrategyId, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const strategy = strategyBuilder.getStrategy(id);

  if (!strategy) {
    throw new NotFoundError(`Strategy '${id}' not found`);
  }

  res.json({
    success: true,
    data: { strategy },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/strategies
 * Create a new strategy
 */
router.post(
  '/',
  strategyCreationLimiter,
  validateRequest(createStrategySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, name, description, steps, riskLimits } = req.body;

    // Check if strategy already exists
    const existing = strategyBuilder.getStrategy(id);
    if (existing) {
      throw new ValidationError(`Strategy '${id}' already exists`);
    }

    // Create strategy
    const strategy = strategyBuilder.createStrategy(id, name, description, riskLimits);

    // Add steps if provided
    if (steps && steps.length > 0) {
      strategyBuilder.addSteps(id, steps);
    }

    // Validate the strategy
    const errors = strategyBuilder.validateStrategy(id);
    if (errors.length > 0) {
      const criticalErrors = errors.filter(e => e.severity === 'error');
      if (criticalErrors.length > 0) {
        throw new ValidationError('Strategy validation failed', criticalErrors);
      }
    }

    // Get the complete strategy
    const createdStrategy = strategyBuilder.getStrategy(id);

    awsLogger.info('Strategy created', { 
      metadata: { strategyId: id, stepCount: steps?.length || 0 } 
    });

    res.status(201).json({
      success: true,
      data: { 
        strategy: createdStrategy,
        validationErrors: errors.filter(e => e.severity === 'warning'),
      },
      message: `Strategy '${id}' created successfully`,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * PUT /api/v1/strategies/:id
 * Update an existing strategy
 */
router.put(
  '/:id',
  validateStrategyId,
  validateRequest(updateStrategySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, description, steps, riskLimits } = req.body;

    const strategy = strategyBuilder.getStrategy(id);
    if (!strategy) {
      throw new NotFoundError(`Strategy '${id}' not found`);
    }

    // Update strategy properties
    if (name !== undefined) strategy.name = name;
    if (description !== undefined) strategy.description = description;
    if (riskLimits !== undefined) {
      strategy.riskLimits = { ...strategy.riskLimits, ...riskLimits };
    }
    if (steps !== undefined) {
      strategy.steps = steps;
    }

    strategy.updatedAt = Date.now();

    // Validate updated strategy
    const errors = strategyBuilder.validateStrategy(id);
    if (errors.length > 0) {
      const criticalErrors = errors.filter(e => e.severity === 'error');
      if (criticalErrors.length > 0) {
        throw new ValidationError('Updated strategy validation failed', criticalErrors);
      }
    }

    const updatedStrategy = strategyBuilder.getStrategy(id);

    awsLogger.info('Strategy updated', { metadata: { strategyId: id } });

    res.json({
      success: true,
      data: { 
        strategy: updatedStrategy,
        validationErrors: errors.filter(e => e.severity === 'warning'),
      },
      message: `Strategy '${id}' updated successfully`,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * DELETE /api/v1/strategies/:id
 * Delete a strategy
 */
router.delete('/:id', validateStrategyId, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const strategy = strategyBuilder.getStrategy(id);
  if (!strategy) {
    throw new NotFoundError(`Strategy '${id}' not found`);
  }

  const deleted = strategyBuilder.deleteStrategy(id);

  if (!deleted) {
    throw new Error(`Failed to delete strategy '${id}'`);
  }

  awsLogger.info('Strategy deleted', { metadata: { strategyId: id } });

  res.json({
    success: true,
    message: `Strategy '${id}' deleted successfully`,
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/strategies/from-template
 * Create strategy from template
 */
router.post(
  '/from-template',
  strategyCreationLimiter,
  validateRequest(createFromTemplateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { templateName, config, autoExecute, paperTradingMode, paperTradingSessionId, walletAddress } = req.body;

    // Check if strategy already exists
    const existing = strategyBuilder.getStrategy(config.id);
    if (existing) {
      throw new ValidationError(`Strategy '${config.id}' already exists`);
    }

    // Create strategy from template
    const strategy = createStrategyFromTemplate(templateName, config);

    // Validate the strategy
    const errors = strategyBuilder.validateStrategy(config.id);
    if (errors.length > 0) {
      const criticalErrors = errors.filter(e => e.severity === 'error');
      if (criticalErrors.length > 0) {
        throw new ValidationError('Template strategy validation failed', criticalErrors);
      }
    }

    awsLogger.info('Strategy created from template', { 
      metadata: { 
        strategyId: config.id, 
        template: templateName 
      } 
    });

    // 🚀 AUTO-EXECUTE REACTIVE STRATEGIES
    let runningStrategyId: string | undefined;
    const isReactiveStrategy = strategy.name.includes('Reactive') || strategy.name.includes('Mirror');
    
    if (autoExecute !== false && isReactiveStrategy) {
      console.log(`🚀 [Auto-Execute] Starting reactive strategy: ${strategy.id}`);
      
      try {
        const { strategyExecutionManager } = await import('../../trading_utils/StrategyExecutionManager');
        
        runningStrategyId = await strategyExecutionManager.startStrategy(
          strategy.id,
          5000, // Default loop delay
          true, // Continuous execution
          10, // Initial paper balance: 10 SOL
          paperTradingMode || 'paper',
          paperTradingSessionId,
          walletAddress, // userId
          walletAddress, // walletAddress
          undefined // resourceLimits
        );

        awsLogger.info('Reactive strategy auto-executed', { 
          metadata: { 
            strategyId: config.id, 
            runningId: runningStrategyId,
            template: templateName 
          } 
        });

        console.log(`✅ [Auto-Execute] Strategy ${strategy.id} started with runningId: ${runningStrategyId}`);
      } catch (execError: any) {
        console.error(`❌ [Auto-Execute] Failed to start strategy:`, execError);
        awsLogger.error('Auto-execution failed', { 
          metadata: { 
            strategyId: config.id,
            error: execError.message 
          } 
        });
      }
    }

    res.status(201).json({
      success: true,
      data: { 
        strategy,
        template: templateName,
        validationErrors: errors.filter(e => e.severity === 'warning'),
        runningStrategyId, // Include running ID if auto-executed
        autoExecuted: !!runningStrategyId,
      },
      message: runningStrategyId 
        ? `Strategy '${config.id}' created and AUTO-STARTED from '${templateName}' template`
        : `Strategy '${config.id}' created from '${templateName}' template`,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/v1/strategies/:id/validate
 * Validate a strategy
 */
router.post('/:id/validate', validateStrategyId, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const strategy = strategyBuilder.getStrategy(id);
  if (!strategy) {
    throw new NotFoundError(`Strategy '${id}' not found`);
  }

  const errors = strategyBuilder.validateStrategy(id);
  const hasErrors = errors.some(e => e.severity === 'error');
  const hasWarnings = errors.some(e => e.severity === 'warning');

  res.json({
    success: true,
    data: {
      valid: !hasErrors,
      errors: errors.filter(e => e.severity === 'error'),
      warnings: errors.filter(e => e.severity === 'warning'),
      summary: {
        totalIssues: errors.length,
        errorCount: errors.filter(e => e.severity === 'error').length,
        warningCount: errors.filter(e => e.severity === 'warning').length,
      },
    },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/strategies/:id/save
 * Save strategy to file
 */
router.post('/:id/save', validateStrategyId, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { filePath } = req.body;

  const strategy = strategyBuilder.getStrategy(id);
  if (!strategy) {
    throw new NotFoundError(`Strategy '${id}' not found`);
  }

  strategyBuilder.saveStrategy(id, filePath);

  res.json({
    success: true,
    message: `Strategy '${id}' saved to file`,
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/strategies/:id/stop
 * Stop a running strategy
 */
router.post('/:id/stop', validateStrategyId, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { runningId } = req.body;

  console.log(` [ROUTE /stop] API called for strategyId: ${id}, runningId: ${runningId}`);

  if (!runningId) {
    throw new ValidationError('runningId is required');
  }

  // Import strategyExecutionManager
  const { strategyExecutionManager } = await import('../../trading_utils/StrategyExecutionManager');
  
  console.log(` [ROUTE /stop] Calling stopStrategy(${runningId})`);
  const stopped = await strategyExecutionManager.stopStrategy(runningId);
  console.log(` [ROUTE /stop] stopStrategy returned: ${stopped}`);

  if (!stopped) {
    throw new NotFoundError(`Running strategy '${runningId}' not found`);
  }

  // Broadcast status change via WebSocket
  const { getWebSocketHandlers } = await import('../websocket');
  const wsHandlers = getWebSocketHandlers();
  if (wsHandlers) {
    wsHandlers.broadcastStrategyStatusChange(id, 'stopped', runningId);
  }

  awsLogger.info('Strategy stopped via API', { metadata: { strategyId: id, runningId } });

  res.json({
    success: true,
    message: `Strategy '${id}' stopped successfully`,
    data: { runningId, status: 'stopped' },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/strategies/:id/pause
 * Pause a running strategy
 */
router.post('/:id/pause', validateStrategyId, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { runningId } = req.body;

  if (!runningId) {
    throw new ValidationError('runningId is required');
  }

  // Import strategyExecutionManager
  const { strategyExecutionManager } = await import('../../trading_utils/StrategyExecutionManager');
  
  const runningStrategy = strategyExecutionManager.getStrategyStatus(runningId);

  if (!runningStrategy) {
    throw new NotFoundError(`Running strategy '${runningId}' not found`);
  }

  if (runningStrategy.status !== 'running') {
    throw new ValidationError(`Strategy is not running (current status: ${runningStrategy.status})`);
  }

  // Update status to paused
  runningStrategy.status = 'paused';
  
  // Clear the interval to pause execution
  if (runningStrategy.intervalId) {
    clearTimeout(runningStrategy.intervalId);
    runningStrategy.intervalId = undefined;
  }

  // Broadcast status change via WebSocket
  const { getWebSocketHandlers } = await import('../websocket');
  const wsHandlers = getWebSocketHandlers();
  if (wsHandlers) {
    wsHandlers.broadcastStrategyStatusChange(id, 'paused', runningId);
  }

  awsLogger.info('Strategy paused via API', { metadata: { strategyId: id, runningId } });

  res.json({
    success: true,
    message: `Strategy '${id}' paused successfully`,
    data: { runningId, status: 'paused' },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * POST /api/v1/strategies/:id/resume
 * Resume a paused strategy
 */
router.post('/:id/resume', validateStrategyId, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { runningId } = req.body;

  if (!runningId) {
    throw new ValidationError('runningId is required');
  }

  // Import strategyExecutionManager
  const { strategyExecutionManager } = await import('../../trading_utils/StrategyExecutionManager');
  
  const runningStrategy = strategyExecutionManager.getStrategyStatus(runningId);

  if (!runningStrategy) {
    throw new NotFoundError(`Running strategy '${runningId}' not found`);
  }

  if (runningStrategy.status !== 'paused') {
    throw new ValidationError(`Strategy is not paused (current status: ${runningStrategy.status})`);
  }

  // Update status back to running
  runningStrategy.status = 'running';
  
  // Resume execution
  // Access the private method through the manager instance
  (strategyExecutionManager as any).executeStrategyContinuously(runningId);

  // Broadcast status change via WebSocket
  const { getWebSocketHandlers } = await import('../websocket');
  const wsHandlers = getWebSocketHandlers();
  if (wsHandlers) {
    wsHandlers.broadcastStrategyStatusChange(id, 'running', runningId);
  }

  awsLogger.info('Strategy resumed via API', { metadata: { strategyId: id, runningId } });

  res.json({
    success: true,
    message: `Strategy '${id}' resumed successfully`,
    data: { runningId, status: 'running' },
    timestamp: new Date().toISOString(),
  });
}));

/**
 * GET /api/v1/strategies/templates/list
 * List available templates
 */
router.get('/templates/list', asyncHandler(async (req: Request, res: Response) => {
  const templates = [
    {
      name: 'dca',
      displayName: 'Dollar Cost Averaging (DCA)',
      description: 'Buy fixed amounts at regular intervals regardless of price',
      parameters: ['id', 'buyAmountSOL', 'intervalMinutes', 'buyCount'],
    },
    {
      name: 'grid',
      displayName: 'Grid Trading',
      description: 'Place buy and sell orders at regular price intervals',
      parameters: ['id', 'gridLevels', 'lowerPrice', 'upperPrice', 'amountPerLevel'],
    },
    {
      name: 'stop_loss',
      displayName: 'Stop-Loss / Take-Profit',
      description: 'Automatic sell when price reaches stop-loss or take-profit levels',
      parameters: ['id', 'buyAmountSOL', 'stopLossPercentage', 'takeProfitPercentage'],
    },
    {
      name: 'momentum',
      displayName: 'Momentum Trading',
      description: 'Buy on price momentum, sell on reversal',
      parameters: ['id', 'buyAmountSOL', 'momentumThreshold', 'sellThreshold', 'timeframeMinutes'],
    },
  ];

  res.json({
    success: true,
    data: { templates },
    timestamp: new Date().toISOString(),
  });
}));

export default router;

