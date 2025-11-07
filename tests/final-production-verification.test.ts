/**
 * Final Production Verification Test
 * Quick smoke test to verify all production features are working
 */

import { describe, it, expect } from '@jest/globals';

describe('Final Production Verification', () => {
  it('should import all production modules successfully', () => {
    const { AdvancedRiskManager } = require('../src/trading_utils/AdvancedRiskManager');
    const { ProductionErrorHandler } = require('../src/trading_utils/ProductionErrorHandler');
    const { EmergencyStopSystem } = require('../src/trading_utils/EmergencyStopSystem');
    const { PerformanceMonitor } = require('../src/trading_utils/PerformanceMonitor');
    const { RealTimePriceService } = require('../src/trading_utils/RealTimePriceService');
    const { ProductionDashboard } = require('../src/trading_utils/ProductionDashboard');
    const { StrategyOptimizer } = require('../src/trading_utils/StrategyOptimizer');
    const { MultiTokenPortfolio } = require('../src/trading_utils/MultiTokenPortfolio');
    
    expect(AdvancedRiskManager).toBeDefined();
    expect(ProductionErrorHandler).toBeDefined();
    expect(EmergencyStopSystem).toBeDefined();
    expect(PerformanceMonitor).toBeDefined();
    expect(RealTimePriceService).toBeDefined();
    expect(ProductionDashboard).toBeDefined();
    expect(StrategyOptimizer).toBeDefined();
    expect(MultiTokenPortfolio).toBeDefined();
  });

  it('should create instances of all production modules', () => {
    const { AdvancedRiskManager } = require('../src/trading_utils/AdvancedRiskManager');
    const { ProductionErrorHandler } = require('../src/trading_utils/ProductionErrorHandler');
    const { EmergencyStopSystem } = require('../src/trading_utils/EmergencyStopSystem');
    const { PerformanceMonitor } = require('../src/trading_utils/PerformanceMonitor');
    
    const riskManager = new AdvancedRiskManager();
    const errorHandler = new ProductionErrorHandler();
    const stopSystem = new EmergencyStopSystem();
    const monitor = new PerformanceMonitor();
    
    expect(riskManager).toBeInstanceOf(AdvancedRiskManager);
    expect(errorHandler).toBeInstanceOf(ProductionErrorHandler);
    expect(stopSystem).toBeInstanceOf(EmergencyStopSystem);
    expect(monitor).toBeInstanceOf(PerformanceMonitor);
  });

  it('should verify Risk Manager basic functionality', () => {
    const { AdvancedRiskManager } = require('../src/trading_utils/AdvancedRiskManager');
    const rm = new AdvancedRiskManager();
    
    rm.updateBalance(10.0);
    const validation = rm.validateTrade(0.5, 10.0);
    
    expect(validation.allowed).toBe(true);
  });

  it('should verify Error Handler basic functionality', async () => {
    const { ProductionErrorHandler } = require('../src/trading_utils/ProductionErrorHandler');
    const eh = new ProductionErrorHandler();
    
    const result = await eh.executeWithFallback(
      async () => { throw new Error('test'); },
      'fallback',
      { component: 'test', operation: 'test', timestamp: Date.now() }
    );
    
    expect(result).toBe('fallback');
  });

  it('should verify Emergency Stop basic functionality', async () => {
    const { EmergencyStopSystem } = require('../src/trading_utils/EmergencyStopSystem');
    const es = new EmergencyStopSystem();
    
    const canTrade = await es.checkSafety();
    expect(canTrade).toBe(true);
    
    es.triggerEmergencyStop('Test');
    expect(es.isTradingStopped()).toBe(true);
  });

  it('should verify Performance Monitor basic functionality', () => {
    const { PerformanceMonitor } = require('../src/trading_utils/PerformanceMonitor');
    const pm = new PerformanceMonitor();
    
    pm.startOperation('test');
    pm.endOperation('test', true);
    
    const metrics = pm.getMetrics();
    expect(metrics.totalRequests).toBe(1);
  });

  it('should verify all modules export singletons', () => {
    const { advancedRiskManager } = require('../src/trading_utils/AdvancedRiskManager');
    const { productionErrorHandler } = require('../src/trading_utils/ProductionErrorHandler');
    const { emergencyStopSystem } = require('../src/trading_utils/EmergencyStopSystem');
    const { performanceMonitor } = require('../src/trading_utils/PerformanceMonitor');
    const { realTimePriceService } = require('../src/trading_utils/RealTimePriceService');
    const { productionDashboard } = require('../src/trading_utils/ProductionDashboard');
    const { strategyOptimizer } = require('../src/trading_utils/StrategyOptimizer');
    const { multiTokenPortfolio } = require('../src/trading_utils/MultiTokenPortfolio');
    
    expect(advancedRiskManager).toBeDefined();
    expect(productionErrorHandler).toBeDefined();
    expect(emergencyStopSystem).toBeDefined();
    expect(performanceMonitor).toBeDefined();
    expect(realTimePriceService).toBeDefined();
    expect(productionDashboard).toBeDefined();
    expect(strategyOptimizer).toBeDefined();
    expect(multiTokenPortfolio).toBeDefined();
  });
});

