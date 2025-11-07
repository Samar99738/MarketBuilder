/**
 * Production Integration Tests
 * Comprehensive test suite for all production features
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AdvancedRiskManager } from '../src/trading_utils/AdvancedRiskManager';
import { ProductionErrorHandler } from '../src/trading_utils/ProductionErrorHandler';
import { EmergencyStopSystem } from '../src/trading_utils/EmergencyStopSystem';
import { PerformanceMonitor } from '../src/trading_utils/PerformanceMonitor';
import { RealTimePriceService } from '../src/trading_utils/RealTimePriceService';

describe('Production Integration Tests', () => {
  describe('AdvancedRiskManager', () => {
    let riskManager: AdvancedRiskManager;

    beforeEach(() => {
      riskManager = new AdvancedRiskManager({
        maxPositionSizeSOL: 1.0,
        maxDailyLossSOL: 0.5,
        maxConcurrentTrades: 3,
        maxDrawdownPercent: 20
      });
    });

    it('should allow valid trade within limits', () => {
      riskManager.updateBalance(10.0);
      const validation = riskManager.validateTrade(0.5, 10.0);
      
      expect(validation.allowed).toBe(true);
      expect(validation.reason).toBeUndefined();
    });

    it('should reject trade exceeding position size', () => {
      riskManager.updateBalance(10.0);
      const validation = riskManager.validateTrade(2.0, 10.0);
      
      expect(validation.allowed).toBe(false);
      expect(validation.reason).toContain('exceeds maximum position size');
      expect(validation.suggestedSize).toBe(1.0);
    });

    it('should reject trade with insufficient balance', () => {
      riskManager.updateBalance(0.3);
      const validation = riskManager.validateTrade(0.5, 0.3);
      
      expect(validation.allowed).toBe(false);
      expect(validation.reason).toContain('Insufficient balance');
    });

    it('should track consecutive losses and activate circuit breaker', () => {
      riskManager.updateBalance(10.0);
      
      // Record 5 consecutive losses
      for (let i = 0; i < 5; i++) {
        riskManager.recordTradeClose(-0.1, 0.5);
      }
      
      const validation = riskManager.validateTrade(0.5, 10.0);
      expect(validation.allowed).toBe(false);
      expect(validation.reason).toContain('Circuit breaker active');
    });

    it('should reset circuit breaker after manual reset', () => {
      riskManager.updateBalance(10.0);
      
      // Trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        riskManager.recordTradeClose(-0.1, 0.5);
      }
      
      // Reset manually
      riskManager.resetCircuitBreaker();
      
      const validation = riskManager.validateTrade(0.5, 10.0);
      expect(validation.allowed).toBe(true);
    });

    it('should enforce daily loss limit', () => {
      riskManager.updateBalance(10.0);
      
      // Record trades totaling more than daily limit
      riskManager.recordTradeClose(-0.3, 0.5);
      riskManager.recordTradeClose(-0.3, 0.5);
      
      const validation = riskManager.validateTrade(0.5, 10.0);
      expect(validation.allowed).toBe(false);
      expect(validation.reason).toContain('Daily loss limit reached');
    });

    it('should track portfolio metrics correctly', () => {
      riskManager.updateBalance(10.0);
      riskManager.recordTrade(0.5);
      
      const metrics = riskManager.getMetrics();
      expect(metrics.totalBalanceSOL).toBe(10.0);
      expect(metrics.lockedBalanceSOL).toBe(0.5);
      expect(metrics.openPositions).toBe(1);
    });
  });

  describe('ProductionErrorHandler', () => {
    let errorHandler: ProductionErrorHandler;

    beforeEach(() => {
      errorHandler = new ProductionErrorHandler();
    });

    afterEach(() => {
      errorHandler.reset();
    });

    it('should retry on retryable errors', async () => {
      let attempts = 0;
      
      const operation = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('NETWORK_ERROR');
        }
        return 'success';
      };

      const result = await errorHandler.executeWithRetry(
        operation,
        { component: 'test', operation: 'network', timestamp: Date.now() }
      );

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should not retry on non-retryable errors', async () => {
      let attempts = 0;
      
      const operation = async () => {
        attempts++;
        throw new Error('INVALID_PARAMETERS');
      };

      await expect(
        errorHandler.executeWithRetry(
          operation,
          { component: 'test', operation: 'validation', timestamp: Date.now() }
        )
      ).rejects.toThrow();

      expect(attempts).toBe(1);
    });

    it('should use fallback value on error', async () => {
      const operation = async () => {
        throw new Error('TEST_ERROR');
      };

      const result = await errorHandler.executeWithFallback(
        operation,
        'fallback_value',
        { component: 'test', operation: 'fallback', timestamp: Date.now() }
      );

      expect(result).toBe('fallback_value');
    });

    it('should timeout long operations', async () => {
      const operation = async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return 'success';
      };

      await expect(
        errorHandler.executeWithTimeout(
          operation,
          1000,
          { component: 'test', operation: 'timeout', timestamp: Date.now() }
        )
      ).rejects.toThrow('timeout');
    });

    it('should track error statistics', async () => {
      const operation = async () => {
        throw new Error('NETWORK_ERROR');
      };

      // Generate multiple errors
      for (let i = 0; i < 3; i++) {
        try {
          await errorHandler.executeWithRetry(
            operation,
            { component: 'test', operation: 'stats', timestamp: Date.now() },
            { maxRetries: 1 }
          );
        } catch (e) {
          // Expected
        }
      }

      const stats = errorHandler.getErrorStats();
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].count).toBeGreaterThan(0);
    });
  });

  describe('EmergencyStopSystem', () => {
    let stopSystem: EmergencyStopSystem;

    beforeEach(() => {
      stopSystem = new EmergencyStopSystem({
        maxLossPercent: 15,
        maxDailyTrades: 10,
        maxConsecutiveLosses: 5,
        minBalanceSOL: 0.1
      });
    });

    it('should allow trading initially', async () => {
      const canTrade = await stopSystem.checkSafety();
      expect(canTrade).toBe(true);
      expect(stopSystem.isTradingStopped()).toBe(false);
    });

    it('should trigger emergency stop manually', () => {
      stopSystem.triggerEmergencyStop('Manual test stop');
      
      expect(stopSystem.isTradingStopped()).toBe(true);
      
      const reason = stopSystem.getStopReason();
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('manual');
    });

    it('should stop trading after consecutive losses', async () => {
      // Simulate 5 consecutive losses
      for (let i = 0; i < 5; i++) {
        await stopSystem.checkSafety({ pnl: -0.1, balance: 10 - (i + 1) * 0.1 });
      }
      
      expect(stopSystem.isTradingStopped()).toBe(true);
      
      const reason = stopSystem.getStopReason();
      expect(reason?.type).toBe('consecutive_losses');
    });

    it('should stop trading on low balance', async () => {
      await stopSystem.checkSafety({ pnl: 0, balance: 0.05 });
      
      expect(stopSystem.isTradingStopped()).toBe(true);
      
      const reason = stopSystem.getStopReason();
      expect(reason?.type).toBe('low_balance');
    });

    it('should allow resuming after manual stop', () => {
      stopSystem.triggerEmergencyStop('Test');
      expect(stopSystem.isTradingStopped()).toBe(true);
      
      stopSystem.resume();
      expect(stopSystem.isTradingStopped()).toBe(false);
    });

    it('should track metrics correctly', async () => {
      await stopSystem.checkSafety({ pnl: 0.1, balance: 10.1 });
      await stopSystem.checkSafety({ pnl: -0.05, balance: 10.05 });
      
      const status = stopSystem.getStatus();
      expect(status.metrics.currentBalance).toBe(10.05);
    });
  });

  describe('PerformanceMonitor', () => {
    let monitor: PerformanceMonitor;

    beforeEach(() => {
      monitor = new PerformanceMonitor();
    });

    afterEach(() => {
      monitor.reset();
    });

    it('should track operation metrics', () => {
      monitor.startOperation('test');
      monitor.endOperation('test', true);
      
      const stats = monitor.getOperationStats('test');
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(1);
      expect(stats!.successRate).toBe(100);
    });

    it('should calculate performance metrics', () => {
      // Generate some operations
      for (let i = 0; i < 10; i++) {
        monitor.startOperation('test');
        monitor.endOperation('test', true);
      }
      
      const metrics = monitor.getMetrics();
      expect(metrics.totalRequests).toBe(10);
      expect(metrics.successRate).toBe(100);
    });

    it('should track trade execution', () => {
      monitor.recordTrade(100, true);
      monitor.recordTrade(150, true);
      
      const stats = monitor.getOperationStats('trade');
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(2);
    });

    it('should detect slow operations', (done) => {
      monitor.on('operation', (data) => {
        if (data.duration > 100) {
          expect(data.name).toBe('slow');
          done();
        }
      });
      
      monitor.startOperation('slow');
      setTimeout(() => {
        monitor.endOperation('slow', true);
      }, 150);
    });

    it('should report health status', () => {
      const health = monitor.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.warnings).toHaveLength(0);
    });
  });

  describe('RealTimePriceService', () => {
    let priceService: RealTimePriceService;

    beforeEach(() => {
      priceService = new RealTimePriceService();
    });

    afterEach(async () => {
      await priceService.shutdown();
    });

    it('should subscribe to price updates', (done) => {
      const tokenAddress = 'So11111111111111111111111111111111111111112';
      
      const unsubscribe = priceService.subscribe(tokenAddress, (update) => {
        expect(update.tokenAddress).toBe(tokenAddress);
        expect(update.price).toBeGreaterThan(0);
        unsubscribe();
        done();
      });
    });

    it('should cache price updates', async () => {
      const tokenAddress = 'So11111111111111111111111111111111111111112';
      
      // Wait for initial price update
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const cached = priceService.getCachedPrice(tokenAddress);
      expect(cached).not.toBeNull();
      if (cached) {
        expect(cached.tokenAddress).toBe(tokenAddress);
      }
    });

    it('should return health status', () => {
      const health = priceService.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.activeSubscriptions).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Integration Tests', () => {
    it('should work together: Risk Manager + Error Handler', async () => {
      const riskManager = new AdvancedRiskManager();
      const errorHandler = new ProductionErrorHandler();
      
      riskManager.updateBalance(10.0);
      
      const executeTrade = async () => {
        const validation = riskManager.validateTrade(0.5, 10.0);
        if (!validation.allowed) {
          throw new Error(validation.reason);
        }
        return 'Trade executed';
      };

      const result = await errorHandler.executeWithRetry(
        executeTrade,
        { component: 'trading', operation: 'execute', timestamp: Date.now() }
      );

      expect(result).toBe('Trade executed');
    });

    it('should work together: Risk Manager + Emergency Stop', async () => {
      const riskManager = new AdvancedRiskManager();
      const stopSystem = new EmergencyStopSystem();
      
      riskManager.updateBalance(10.0);
      
      // Simulate multiple losses
      for (let i = 0; i < 5; i++) {
        riskManager.recordTradeClose(-0.1, 0.5);
        await stopSystem.checkSafety({ pnl: -0.1, balance: 10 - (i + 1) * 0.1 });
      }
      
      // Both systems should detect the issue
      expect(riskManager.validateTrade(0.5, 10.0).allowed).toBe(false);
      expect(stopSystem.isTradingStopped()).toBe(true);
    });

    it('should work together: All systems', async () => {
      const riskManager = new AdvancedRiskManager();
      const errorHandler = new ProductionErrorHandler();
      const stopSystem = new EmergencyStopSystem();
      const monitor = new PerformanceMonitor();
      
      riskManager.updateBalance(10.0);
      
      const executeTrade = async () => {
        monitor.startOperation('integration_trade');
        
        // Check emergency stop first
        const canTrade = await stopSystem.checkSafety({ pnl: 0.1, balance: 10.1 });
        if (!canTrade) {
          throw new Error('Trading stopped');
        }
        
        // Validate with risk manager
        const validation = riskManager.validateTrade(0.5, 10.0);
        if (!validation.allowed) {
          throw new Error(validation.reason);
        }
        
        riskManager.recordTrade(0.5);
        monitor.endOperation('integration_trade', true);
        
        return 'Success';
      };

      const result = await errorHandler.executeWithRetry(
        executeTrade,
        { component: 'integration', operation: 'trade', timestamp: Date.now() }
      );

      expect(result).toBe('Success');
      
      // Verify all systems tracked the operation
      const metrics = monitor.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThan(0);
      
      const riskMetrics = riskManager.getMetrics();
      expect(riskMetrics.openPositions).toBe(1);
      
      expect(stopSystem.isTradingStopped()).toBe(false);
    });
  });
});

