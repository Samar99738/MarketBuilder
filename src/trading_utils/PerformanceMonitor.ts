/**
 * Performance Monitor
 * Real-time performance tracking and optimization for production trading
 */

import { EventEmitter } from 'events';
import { awsLogger } from '../aws/logger';

export interface PerformanceMetrics {
  // Latency metrics
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  maxResponseTime: number;
  
  // Throughput metrics
  requestsPerSecond: number;
  requestsPerMinute: number;
  totalRequests: number;
  
  // Success metrics
  successRate: number;
  errorRate: number;
  totalErrors: number;
  
  // Resource metrics
  memoryUsageMB: number;
  cpuUsagePercent: number;
  
  // Trading metrics
  tradesPerSecond: number;
  avgTradeExecutionTime: number;
  priceUpdateLatency: number;
}

export interface OperationMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  success: boolean;
  error?: string;
}

/**
 * Production Performance Monitor
 */
export class PerformanceMonitor extends EventEmitter {
  private operations: Map<string, OperationMetric[]> = new Map();
  private responseTimes: number[] = [];
  private requestCount = 0;
  private errorCount = 0;
  private startTime = Date.now();
  private lastMinuteRequests: number[] = [];
  private readonly MAX_STORED_OPERATIONS = 1000;
  private readonly MAX_RESPONSE_TIMES = 10000;

  constructor() {
    super();
    
    // Cleanup old data every minute
    setInterval(() => {
      this.cleanup();
    }, 60000);

    awsLogger.info('PerformanceMonitor initialized');
  }

  /**
   * Start tracking an operation
   */
  startOperation(name: string, id?: string): string {
    const operationId = id || `${name}-${Date.now()}-${Math.random()}`;
    
    const metric: OperationMetric = {
      name,
      startTime: Date.now(),
      success: false
    };

    if (!this.operations.has(name)) {
      this.operations.set(name, []);
    }

    const operations = this.operations.get(name)!;
    operations.push(metric);

    // Limit stored operations to prevent memory leaks
    if (operations.length > this.MAX_STORED_OPERATIONS) {
      operations.shift();
    }
    return operationId;
  }

  /**
   * End tracking an operation
   */
  endOperation(name: string, success: boolean, error?: string): void {
    const operations = this.operations.get(name);
    if (!operations || operations.length === 0) return;

    const metric = operations[operations.length - 1];
    metric.endTime = Date.now();
    metric.duration = metric.endTime - metric.startTime;
    metric.success = success;
    metric.error = error;

    // Update global metrics
    this.responseTimes.push(metric.duration);
    if (this.responseTimes.length > this.MAX_RESPONSE_TIMES) {
      this.responseTimes.shift();
    }

    this.requestCount++;
    if (!success) {
      this.errorCount++;
    }

    // Track requests per minute
    this.lastMinuteRequests.push(Date.now());

    // Emit event for real-time monitoring
    this.emit('operation', {
      name,
      duration: metric.duration,
      success,
      timestamp: metric.endTime
    });

    // Alert on slow operations
    if (metric.duration > 5000) { // 5 seconds threshold
      awsLogger.warn('Slow operation detected', {
        metadata: {
          operation: name,
          duration: metric.duration,
          timestamp: metric.endTime
        }
      });
    }
  }

  /**
   * Record trade execution
   */
  recordTrade(executionTimeMs: number, success: boolean): void {
    this.startOperation('trade');
    this.endOperation('trade', success);
    
    if (success) {
      awsLogger.info('Trade executed', {
        metadata: { executionTimeMs }
      });
    }
  }

  /**
   * Record price update latency
   */
  recordPriceUpdate(latencyMs: number): void {
    this.startOperation('priceUpdate');
    this.endOperation('priceUpdate', latencyMs < 1000); // Success if < 1 second
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    const now = Date.now();
    const uptimeSeconds = (now - this.startTime) / 1000;

    // Calculate percentiles
    const sortedTimes = [...this.responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedTimes.length * 0.95);
    const p99Index = Math.floor(sortedTimes.length * 0.99);

    // Calculate requests per time period
    const recentRequests = this.lastMinuteRequests.filter(
      time => now - time < 60000 // Last minute
    );
    const requestsPerMinute = recentRequests.length;
    const requestsPerSecond = recentRequests.filter(
      time => now - time < 1000 // Last second
    ).length;

    // Calculate success rate
    const successRate = this.requestCount > 0
      ? ((this.requestCount - this.errorCount) / this.requestCount) * 100
      : 100;
    const errorRate = 100 - successRate;

    // Get memory usage
    const memUsage = process.memoryUsage();
    const memoryUsageMB = memUsage.heapUsed / 1024 / 1024;

    // Get trade metrics
    const tradeOps = this.operations.get('trade') || [];
    const recentTrades = tradeOps.filter(
      op => op.endTime && now - op.endTime < 1000
    );
    const tradesPerSecond = recentTrades.length;
    const avgTradeTime = tradeOps.length > 0
      ? tradeOps.reduce((sum, op) => sum + (op.duration || 0), 0) / tradeOps.length
      : 0;

    // Get price update latency
    const priceOps = this.operations.get('priceUpdate') || [];
    const avgPriceLatency = priceOps.length > 0
      ? priceOps.reduce((sum, op) => sum + (op.duration || 0), 0) / priceOps.length
      : 0;

    return {
      // Latency metrics
      avgResponseTime: sortedTimes.length > 0
        ? sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length
        : 0,
      p95ResponseTime: sortedTimes[p95Index] || 0,
      p99ResponseTime: sortedTimes[p99Index] || 0,
      maxResponseTime: sortedTimes[sortedTimes.length - 1] || 0,
      
      // Throughput metrics
      requestsPerSecond,
      requestsPerMinute,
      totalRequests: this.requestCount,
      
      // Success metrics
      successRate,
      errorRate,
      totalErrors: this.errorCount,
      
      // Resource metrics
      memoryUsageMB,
      cpuUsagePercent: 0, // Would need external library to track CPU
      
      // Trading metrics
      tradesPerSecond,
      avgTradeExecutionTime: avgTradeTime,
      priceUpdateLatency: avgPriceLatency
    };
  }

  /**
   * Get operation statistics
   */
  getOperationStats(operationName: string): {
    count: number;
    avgDuration: number;
    minDuration: number;
    maxDuration: number;
    successRate: number;
  } | null {
    const operations = this.operations.get(operationName);
    if (!operations || operations.length === 0) {
      return null;
    }

    const durations = operations
      .filter(op => op.duration !== undefined)
      .map(op => op.duration!);
    
    const successCount = operations.filter(op => op.success).length;

    return {
      count: operations.length,
      avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      successRate: (successCount / operations.length) * 100
    };
  }

  /**
   * Get health status
   */
  getHealth(): {
    healthy: boolean;
    warnings: string[];
    metrics: PerformanceMetrics;
  } {
    const metrics = this.getMetrics();
    const warnings: string[] = [];

    // Check for performance issues
    if (metrics.avgResponseTime > 2000) {
      warnings.push('High average response time (>2s)');
    }

    if (metrics.errorRate > 5) {
      warnings.push('High error rate (>5%)');
    }

    if (metrics.memoryUsageMB > 1000) {
      warnings.push('High memory usage (>1GB)');
    }

    if (metrics.priceUpdateLatency > 1000) {
      warnings.push('Slow price updates (>1s)');
    }

    return {
      healthy: warnings.length === 0,
      warnings,
      metrics
    };
  }

  /**
   * Cleanup old data to prevent memory leaks
   */
  private cleanup(): void {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    // Remove old request timestamps
    this.lastMinuteRequests = this.lastMinuteRequests.filter(
      time => now - time < 60000
    );

    // Trim response times array
    if (this.responseTimes.length > this.MAX_RESPONSE_TIMES) {
      this.responseTimes = this.responseTimes.slice(-this.MAX_RESPONSE_TIMES);
    }

    // Remove old operations (keep only last hour)
    for (const [name, ops] of this.operations.entries()) {
      const recentOps = ops.filter(
        op => op.endTime && now - op.endTime < ONE_HOUR
      );
      
      if (recentOps.length === 0) {
        this.operations.delete(name);
      } else {
        this.operations.set(name, recentOps);
      }
    }

    awsLogger.debug('Performance data cleanup completed', {
      metadata: {
        operationTypes: this.operations.size,
        totalOperations: Array.from(this.operations.values()).reduce((sum, ops) => sum + ops.length, 0)
      }
    });
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.operations.clear();
    this.responseTimes = [];
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    this.lastMinuteRequests = [];

    awsLogger.info('Performance metrics reset');
  }

  /**
   * Export metrics to AWS CloudWatch (if configured)
   */
  async exportToCloudWatch(): Promise<void> {
    const metrics = this.getMetrics();
    
    awsLogger.info('Performance metrics', {
      metadata: { metrics }
    });

    // Emit event for external monitoring systems
    this.emit('metricsExport', metrics);
  }
}

// Export singleton
export const performanceMonitor = new PerformanceMonitor();

