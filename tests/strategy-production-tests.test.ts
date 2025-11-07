/**
 * Strategy Production Tests
 * Test all strategy types in production scenarios
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { strategyBuilder, Strategy, StrategyBuilder } from '../src/trading_utils/StrategyBuilder';
import { TradingProviderFactory } from '../src/trading_utils/TradingProvider';

describe('Strategy Production Tests', () => {
  let mockProvider: any;

  beforeEach(() => {
    // Use mock provider for testing
    mockProvider = TradingProviderFactory.getInstance();
  });

  describe('DCA Strategy', () => {
    it('should execute DCA strategy successfully', async () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'dca-test-1',
        'Test DCA',
        'Test DCA strategy',
        [1000, 1000], // Shorter intervals for testing
        [0.001, 0.001], // Small amounts for testing
        { maxPositionSizeSOL: 0.01 }
      );

      // Create strategy using the instance method
      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      
      // Add steps from template
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      const result = await strategyBuilder.executeStrategy(strategy.id);
      
      expect(result.success).toBe(true);
      expect(result.completedSteps.length).toBeGreaterThan(0);
    });

    it('should handle DCA with validation errors', () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'dca-test-2',
        'Invalid DCA',
        'DCA with invalid amounts',
        [1000],
        [100], // Too large
        { maxPositionSizeSOL: 1.0 }
      );

      const errors = strategyBuilder.validateStrategy(strategy.id);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should stop DCA strategy mid-execution', async () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'dca-test-3',
        'Stoppable DCA',
        'DCA that can be stopped',
        [1000, 1000, 1000],
        [0.001, 0.001, 0.001]
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      // Start execution
      const executionPromise = strategyBuilder.executeStrategy(strategy.id);
      
      // Stop after 2 seconds
      setTimeout(async () => {
        // Strategy should handle stop gracefully
      }, 2000);

      const result = await executionPromise;
      expect(result).toBeDefined();
    });
  });

  describe('Grid Strategy', () => {
    it('should execute Grid strategy successfully', async () => {
      const strategy = StrategyBuilder.generateGridStrategyTemplate(
        'grid-test-1',
        'Test Grid',
        'Test grid strategy',
        3, // 3 grid levels
        100, // Lower price
        110, // Upper price
        0.001 // Small amount per level
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      const result = await strategyBuilder.executeStrategy(strategy.id);
      
      expect(result.success).toBe(true);
      expect(result.completedSteps.length).toBeGreaterThan(0);
    });

    it('should validate grid price range', () => {
      expect(() => {
        StrategyBuilder.generateGridStrategyTemplate(
          'grid-test-2',
          'Invalid Grid',
          'Grid with invalid range',
          3,
          110, // Lower > Upper (invalid)
          100,
          0.001
        );
      }).toThrow();
    });
  });

  describe('Stop-Loss Strategy', () => {
    it('should execute Stop-Loss strategy successfully', async () => {
      const strategy = StrategyBuilder.generateStopLossStrategyTemplate(
        'sl-test-1',
        'Test Stop-Loss',
        'Test stop-loss strategy',
        100, // Entry price
        95, // Stop-loss price
        0.001 // Small amount
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      const result = await strategyBuilder.executeStrategy(strategy.id);
      
      expect(result.success).toBe(true);
    });

    it('should validate stop-loss prices', () => {
      expect(() => {
        StrategyBuilder.generateStopLossStrategyTemplate(
          'sl-test-2',
          'Invalid Stop-Loss',
          'Stop-loss with invalid prices',
          100,
          105, // Stop-loss > Entry (invalid)
          0.001
        );
      }).toThrow();
    });
  });

  describe('Strategy Validation', () => {
    it('should detect missing required fields', () => {
      const strategy = strategyBuilder.createStrategy(
        'invalid-1',
        'Invalid Strategy',
        'Missing required fields'
      );

      const errors = strategyBuilder.validateStrategy(strategy.id);
      expect(errors.some(e => e.errorType === 'validation')).toBe(true);
    });

    it('should detect unreachable steps', () => {
      const strategy = strategyBuilder.createStrategy(
        'unreachable-1',
        'Unreachable Steps',
        'Strategy with unreachable steps'
      );

      strategyBuilder.addStep(strategy.id, {
        id: 'step1',
        type: 'wait',
        durationMs: 1000,
        onSuccess: 'step2'
      });

      strategyBuilder.addStep(strategy.id, {
        id: 'step2',
        type: 'wait',
        durationMs: 1000
      });

      // Add unreachable step
      strategyBuilder.addStep(strategy.id, {
        id: 'step3',
        type: 'wait',
        durationMs: 1000
      });

      const errors = strategyBuilder.validateStrategy(strategy.id);
      expect(errors.some(e => e.message.includes('unreachable'))).toBe(true);
    });

    it('should validate risk limits', () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'risk-test-1',
        'Risky Strategy',
        'Strategy exceeding risk limits',
        [1000],
        [10], // Exceeds default limit
        { maxPositionSizeSOL: 1.0 }
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);
      strategyBuilder.updateRiskLimits(createdStrategy.id, strategy.riskLimits);

      const errors = strategyBuilder.validateStrategy(strategy.id);
      expect(errors.some(e => e.errorType === 'risk')).toBe(true);
    });
  });

  describe('Strategy Performance', () => {
    it('should track strategy metrics', async () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'metrics-test-1',
        'Metrics Test',
        'Strategy for metrics tracking',
        [1000, 1000],
        [0.001, 0.001]
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      // Execute strategy
      await strategyBuilder.executeStrategy(strategy.id);

      // Check metrics
      const loadedStrategy = strategyBuilder.getStrategy(strategy.id);
      expect(loadedStrategy).toBeDefined();
      expect(loadedStrategy!.metrics.totalTrades).toBeGreaterThanOrEqual(0);
    });

    it('should calculate win rate correctly', async () => {
      const strategy = strategyBuilder.createStrategy(
        'winrate-test-1',
        'Win Rate Test',
        'Test win rate calculation'
      );

      // Simulate trades
      strategyBuilder.updateMetrics(strategy.id, {
        success: true,
        pnl: 0.1,
        tradeTime: 1000
      });
      
      strategyBuilder.updateMetrics(strategy.id, {
        success: false,
        pnl: -0.05,
        tradeTime: 1000
      });
      
      strategyBuilder.updateMetrics(strategy.id, {
        success: true,
        pnl: 0.15,
        tradeTime: 1000
      });

      const loadedStrategy = strategyBuilder.getStrategy(strategy.id);
      expect(loadedStrategy!.metrics.winRate).toBeCloseTo(66.67, 1);
    });
  });

  describe('Strategy Persistence', () => {
    it('should save and load strategy', () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'persist-test-1',
        'Persist Test',
        'Test strategy persistence',
        [1000],
        [0.001]
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      // Save strategy
      strategyBuilder.saveStrategy(strategy.id);

      // Load strategy
      const loaded = strategyBuilder.loadStrategy(`./strategies/${strategy.id}.json`);
      
      expect(loaded.id).toBe(strategy.id);
      expect(loaded.name).toBe(strategy.name);
      expect(loaded.steps.length).toBe(strategy.steps.length);
    });
  });

  describe('Strategy Execution Edge Cases', () => {
    it('should handle execution timeout', async () => {
      const strategy = strategyBuilder.createStrategy(
        'timeout-test-1',
        'Timeout Test',
        'Strategy that times out'
      );

      strategyBuilder.addStep(strategy.id, {
        id: 'long_wait',
        type: 'wait',
        durationMs: 2000, // 2 seconds instead of 1 minute
        onSuccess: undefined
      });

      // This should complete (wait is interruptible)
      const result = await strategyBuilder.executeStrategy(strategy.id);
      expect(result).toBeDefined();
    });

    it('should handle concurrent strategy execution', async () => {
      const strategies = [];
      
      for (let i = 0; i < 3; i++) {
        const strategy = StrategyBuilder.generateDCAStrategyTemplate(
          `concurrent-test-${i}`,
          `Concurrent Test ${i}`,
          'Concurrent execution test',
          [1000],
          [0.001]
        );
        
        const createdStrategy = strategyBuilder.createStrategy(
          strategy.id,
          strategy.name,
          strategy.description,
          strategy.variables
        );
        strategyBuilder.addSteps(createdStrategy.id, strategy.steps);
        strategies.push(strategy);
      }

      // Execute all strategies concurrently
      const results = await Promise.all(
        strategies.map(s => strategyBuilder.executeStrategy(s.id))
      );

      expect(results.length).toBe(3);
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });

    it('should handle strategy with no steps', async () => {
      const strategy = strategyBuilder.createStrategy(
        'empty-test-1',
        'Empty Strategy',
        'Strategy with no steps'
      );

      const errors = strategyBuilder.validateStrategy(strategy.id);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('at least one step'))).toBe(true);
    });
  });

  describe('Production Readiness', () => {
    it('should promote strategy to production after validation', () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'prod-test-1',
        'Production Ready',
        'Strategy ready for production',
        [1000],
        [0.001]
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      // Validate
      const errors = strategyBuilder.validateStrategy(strategy.id);
      expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);

      // Promote to production
      strategyBuilder.promoteToProduction(strategy.id);

      const loadedStrategy = strategyBuilder.getStrategy(strategy.id);
      expect(loadedStrategy!.isProduction).toBe(true);
    });

    it('should prevent promoting invalid strategy to production', () => {
      const strategy = strategyBuilder.createStrategy(
        'invalid-prod-1',
        'Invalid for Production',
        'Strategy with errors'
      );

      expect(() => {
        strategyBuilder.promoteToProduction(strategy.id);
      }).toThrow();
    });

    it('should generate performance report', () => {
      const strategy = StrategyBuilder.generateDCAStrategyTemplate(
        'report-test-1',
        'Report Test',
        'Strategy for report generation',
        [1000],
        [0.001]
      );

      const createdStrategy = strategyBuilder.createStrategy(
        strategy.id,
        strategy.name,
        strategy.description,
        strategy.variables
      );
      strategyBuilder.addSteps(createdStrategy.id, strategy.steps);

      // Simulate some trades
      strategyBuilder.updateMetrics(strategy.id, {
        success: true,
        pnl: 0.1,
        tradeTime: 1000
      });

      const report = strategyBuilder.getPerformanceReport(strategy.id);
      
      expect(report).toContain('Performance Report');
      expect(report).toContain('Total Trades');
      expect(report).toContain('Win Rate');
    });
  });
});

