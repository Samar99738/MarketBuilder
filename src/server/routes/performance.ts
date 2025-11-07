/**
 * Performance Analytics API Routes
 * Endpoints for viewing strategy execution performance and analytics
 */

import express, { Request, Response, NextFunction } from 'express';
import { strategyExecutionTracker } from '../../trading_utils/StrategyExecutionTracker';
import { awsLogger } from '../../aws/logger';

const router = express.Router();

/**
 * GET /api/performance/:strategyId
 * Get detailed performance data for a specific strategy
 */
router.get('/performance/:strategyId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { strategyId } = req.params;
    
    const performance = strategyExecutionTracker.getPerformance(strategyId);
    
    if (!performance) {
      return res.status(404).json({
        success: false,
        error: 'Strategy not found or not being tracked',
      });
    }
    
    res.json({
      success: true,
      data: performance,
    });
  } catch (error) {
    awsLogger.error('Error fetching performance data', {
      metadata: { 
        strategyId: req.params.strategyId,
        error: error instanceof Error ? error.message : String(error) 
      }
    });
    next(error);
  }
});

/**
 * GET /api/performance/:strategyId/summary
 * Get structured summary of strategy performance
 */
router.get('/performance/:strategyId/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { strategyId } = req.params;
    
    const summary = strategyExecutionTracker.generateSummary(strategyId);
    
    if (!summary) {
      return res.status(404).json({
        success: false,
        error: 'Strategy not found or not being tracked',
      });
    }
    
    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    awsLogger.error('Error generating performance summary', {
      metadata: { 
        strategyId: req.params.strategyId,
        error: error instanceof Error ? error.message : String(error) 
      }
    });
    next(error);
  }
});

/**
 * GET /api/performance/:strategyId/report
 * Get formatted text report of strategy performance
 */
router.get('/performance/:strategyId/report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { strategyId } = req.params;
    
    const report = strategyExecutionTracker.generateReport(strategyId);
    
    if (report === 'Strategy not found') {
      return res.status(404).json({
        success: false,
        error: 'Strategy not found or not being tracked',
      });
    }
    
    res.type('text/plain').send(report);
  } catch (error) {
    awsLogger.error('Error generating performance report', {
      metadata: { 
        strategyId: req.params.strategyId,
        error: error instanceof Error ? error.message : String(error) 
      }
    });
    next(error);
  }
});

/**
 * GET /api/performances
 * Get all tracked strategy performances
 */
router.get('/performances', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const performances = strategyExecutionTracker.getAllPerformances();
    
    res.json({
      success: true,
      count: performances.length,
      data: performances,
    });
  } catch (error) {
    awsLogger.error('Error fetching all performances', {
      metadata: { error: error instanceof Error ? error.message : String(error) }
    });
    next(error);
  }
});

/**
 * POST /api/performance/:strategyId/update
 * Manually trigger metrics update (recalculates unrealized P&L)
 */
router.post('/performance/:strategyId/update', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { strategyId } = req.params;
    
    await strategyExecutionTracker.updateCurrentMetrics(strategyId);
    
    const performance = strategyExecutionTracker.getPerformance(strategyId);
    
    if (!performance) {
      return res.status(404).json({
        success: false,
        error: 'Strategy not found or not being tracked',
      });
    }
    
    res.json({
      success: true,
      message: 'Metrics updated successfully',
      data: performance,
    });
  } catch (error) {
    awsLogger.error('Error updating performance metrics', {
      metadata: { 
        strategyId: req.params.strategyId,
        error: error instanceof Error ? error.message : String(error) 
      }
    });
    next(error);
  }
});

/**
 * DELETE /api/performance/:strategyId
 * Delete strategy performance data
 */
router.delete('/performance/:strategyId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { strategyId } = req.params;
    
    const deleted = strategyExecutionTracker.deleteStrategy(strategyId);
    
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Strategy not found',
      });
    }
    
    res.json({
      success: true,
      message: 'Performance data deleted successfully',
    });
  } catch (error) {
    awsLogger.error('Error deleting performance data', {
      metadata: { 
        strategyId: req.params.strategyId,
        error: error instanceof Error ? error.message : String(error) 
      }
    });
    next(error);
  }
});

export default router;
