/**
 * Production Monitoring and Metrics
 * 
 * Provides comprehensive monitoring for:
 * - Strategy execution performance
 * - RPC endpoint health
 * - User activity tracking
 * - System resource usage
 * - Trade execution metrics
 */

import { strategyExecutionManager } from '../trading_utils/StrategyExecutionManager';
import { getRPCMetrics } from '../config/rpc-config';
import { strategyExecutionTracker } from '../trading_utils/StrategyExecutionTracker';

export interface SystemMetrics {
  timestamp: number;
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  cpu: {
    percentage: number;
  };
}

export interface StrategyMetrics {
  totalRunning: number;
  totalStopped: number;
  totalErrors: number;
  byUser: Map<string, {
    userId: string;
    strategiesCount: number;
    runningCount: number;
  }>;
  executionRate: number; // executions per minute
}

export interface TradeMetrics {
  totalTrades: number;
  totalVolume: number;
  successRate: number;
  avgExecutionTime: number;
  lastTradeTime: number;
}

export interface RPCMetrics {
  endpoint: string;
  healthy: boolean;
  latency: number;
  requestCount: number;
  errorCount: number;
  errorRate: number;
}

/**
 * Monitoring Service
 */
class MonitoringService {
  private metricsHistory: Array<{
    timestamp: number;
    metrics: any;
  }> = [];
  
  private readonly MAX_HISTORY = 100;
  private rpcRequestCount = 0;
  private rpcErrorCount = 0;
  private lastMetricsTime = Date.now();

  /**
   * Get comprehensive system metrics
   */
  async getSystemMetrics(): Promise<SystemMetrics> {
    const memUsage = process.memoryUsage();
    
    return {
      timestamp: Date.now(),
      uptime: process.uptime(),
      memory: {
        used: memUsage.heapUsed,
        total: memUsage.heapTotal,
        percentage: (memUsage.heapUsed / memUsage.heapTotal) * 100,
      },
      cpu: {
        percentage: process.cpuUsage().user / 1000000, // Approximate
      },
    };
  }

  /**
   * Get strategy execution metrics
   */
  getStrategyMetrics(): StrategyMetrics {
    const strategies = strategyExecutionManager.listRunningStrategies();
    
    const byUser = new Map<string, {
      userId: string;
      strategiesCount: number;
      runningCount: number;
    }>();
    
    let totalRunning = 0;
    let totalStopped = 0;
    let totalErrors = 0;
    let totalExecutions = 0;
    
    for (const strategy of strategies) {
      totalExecutions += strategy.executionCount;
      
      if (strategy.status === 'running') totalRunning++;
      else if (strategy.status === 'stopped') totalStopped++;
      else if (strategy.status === 'error') totalErrors++;
      
      if (strategy.userId) {
        if (!byUser.has(strategy.userId)) {
          byUser.set(strategy.userId, {
            userId: strategy.userId,
            strategiesCount: 0,
            runningCount: 0,
          });
        }
        
        const userMetrics = byUser.get(strategy.userId)!;
        userMetrics.strategiesCount++;
        if (strategy.status === 'running') {
          userMetrics.runningCount++;
        }
      }
    }
    
    // Calculate execution rate
    const timeDiff = (Date.now() - this.lastMetricsTime) / 1000 / 60; // minutes
    const executionRate = timeDiff > 0 ? totalExecutions / timeDiff : 0;
    
    return {
      totalRunning,
      totalStopped,
      totalErrors,
      byUser,
      executionRate,
    };
  }

  /**
   * Get RPC health metrics
   */
  async getRPCHealthMetrics(): Promise<RPCMetrics> {
    const rpcMetrics = await getRPCMetrics();
    
    const errorRate = this.rpcRequestCount > 0 
      ? (this.rpcErrorCount / this.rpcRequestCount) * 100 
      : 0;
    
    return {
      endpoint: rpcMetrics.endpoint,
      healthy: rpcMetrics.health.healthy,
      latency: rpcMetrics.health.latency,
      requestCount: this.rpcRequestCount,
      errorCount: this.rpcErrorCount,
      errorRate,
    };
  }

  /**
   * Record RPC request
   */
  recordRPCRequest(success: boolean): void {
    this.rpcRequestCount++;
    if (!success) {
      this.rpcErrorCount++;
    }
  }

  /**
   * Get comprehensive metrics snapshot
   */
  async getMetricsSnapshot() {
    const system = await this.getSystemMetrics();
    const strategies = this.getStrategyMetrics();
    const rpc = await this.getRPCHealthMetrics();
    
    const snapshot = {
      timestamp: Date.now(),
      system,
      strategies,
      rpc,
    };
    
    // Add to history
    this.metricsHistory.push({
      timestamp: Date.now(),
      metrics: snapshot,
    });
    
    // Limit history size
    if (this.metricsHistory.length > this.MAX_HISTORY) {
      this.metricsHistory.shift();
    }
    
    return snapshot;
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(limit: number = 50) {
    return this.metricsHistory.slice(-limit);
  }

  /**
   * Get alerts based on metrics
   */
  async getAlerts() {
    const alerts: Array<{
      level: 'info' | 'warning' | 'critical';
      message: string;
      timestamp: number;
    }> = [];
    
    const system = await this.getSystemMetrics();
    const strategies = this.getStrategyMetrics();
    const rpc = await this.getRPCHealthMetrics();
    
    // Memory alerts
    if (system.memory.percentage > 90) {
      alerts.push({
        level: 'critical',
        message: `High memory usage: ${system.memory.percentage.toFixed(1)}%`,
        timestamp: Date.now(),
      });
    } else if (system.memory.percentage > 75) {
      alerts.push({
        level: 'warning',
        message: `Elevated memory usage: ${system.memory.percentage.toFixed(1)}%`,
        timestamp: Date.now(),
      });
    }
    
    // Strategy error alerts
    if (strategies.totalErrors > 0) {
      alerts.push({
        level: 'warning',
        message: `${strategies.totalErrors} strategies in error state`,
        timestamp: Date.now(),
      });
    }
    
    // RPC health alerts
    if (!rpc.healthy) {
      alerts.push({
        level: 'critical',
        message: `RPC endpoint unhealthy: ${rpc.endpoint}`,
        timestamp: Date.now(),
      });
    } else if (rpc.latency > 1000) {
      alerts.push({
        level: 'warning',
        message: `High RPC latency: ${rpc.latency}ms`,
        timestamp: Date.now(),
      });
    }
    
    if (rpc.errorRate > 10) {
      alerts.push({
        level: 'warning',
        message: `High RPC error rate: ${rpc.errorRate.toFixed(1)}%`,
        timestamp: Date.now(),
      });
    }
    
    return alerts;
  }

  /**
   * Reset metrics counters
   */
  reset(): void {
    this.rpcRequestCount = 0;
    this.rpcErrorCount = 0;
    this.lastMetricsTime = Date.now();
    this.metricsHistory = [];
    console.log('[Monitoring] Metrics reset');
  }
}

// Singleton instance
export const monitoringService = new MonitoringService();

/**
 * Start periodic metrics collection
 */
export function startMetricsCollection(intervalMs: number = 60000): NodeJS.Timeout {
  console.log(`[Monitoring] Starting metrics collection every ${intervalMs / 1000}s`);
  
  return setInterval(async () => {
    try {
      await monitoringService.getMetricsSnapshot();
      
      const alerts = await monitoringService.getAlerts();
      if (alerts.length > 0) {
        console.warn('[Monitoring] Alerts detected:');
        alerts.forEach(alert => {
          console.warn(`  [${alert.level.toUpperCase()}] ${alert.message}`);
        });
      }
    } catch (error) {
      console.error('[Monitoring] Error collecting metrics:', error);
    }
  }, intervalMs);
}
