/**
 * Real-Time Performance Monitoring
 * 
 * This module tracks execution latency, trade processing speed,
 * and identifies performance bottlenecks in production.
 */

import { EventEmitter } from 'events';

export interface LatencyMetric {
  strategyId: string;
  tradeDetectionTime: number;  // When trade was detected on blockchain
  contextUpdateTime: number;    // When strategy context was updated
  executionStartTime: number;   // When strategy execution started
  executionEndTime: number;     // When strategy execution completed
  totalLatency: number;         // Total time from detection to completion
  executionDuration: number;    // Time spent in strategy execution
  queueWaitTime: number;        // Time spent waiting in queue
}

export interface ExecutionStats {
  avgLatency: number;
  maxLatency: number;
  minLatency: number;
  p95Latency: number;  // 95th percentile
  p99Latency: number;  // 99th percentile
  avgExecutionTime: number;
  maxExecutionTime: number;
  totalExecutions: number;
  slowExecutions: number;  // Executions > 1 second
  failedExecutions: number;
}

/**
 * Real-Time Trading Metrics
 * Track execution latency and performance for production monitoring
 */
export class RealTimeMetrics extends EventEmitter {
  private latencyMetrics: Map<string, LatencyMetric[]> = new Map();
  private executionFailures: Map<string, number> = new Map();
  private slowExecutionCount: Map<string, number> = new Map();
  
  // Alerts
  private readonly SLOW_EXECUTION_THRESHOLD_MS = 1000;
  private readonly HIGH_LATENCY_THRESHOLD_MS = 500;
  
  /**
   * Record when a trade is first detected on the blockchain
   */
  recordTradeDetection(strategyId: string, timestamp: number): void {
    // Store for later correlation
    const metric: Partial<LatencyMetric> = {
      strategyId,
      tradeDetectionTime: timestamp
    };
    
    console.log(`📊 [METRICS] Trade detected for ${strategyId} at ${timestamp}`);
  }
  
  /**
   * Record when strategy context is updated with trade data
   */
  recordContextUpdate(strategyId: string, tradeDetectionTime: number): void {
    const now = Date.now();
    const queueWaitTime = now - tradeDetectionTime;
    
    console.log(`📊 [METRICS] Context updated for ${strategyId} - queue wait: ${queueWaitTime}ms`);
    
    if (queueWaitTime > this.HIGH_LATENCY_THRESHOLD_MS) {
      console.warn(`⚠️ [HIGH LATENCY] Strategy ${strategyId} waited ${queueWaitTime}ms in queue!`);
      this.emit('high-latency-warning', {
        strategyId,
        queueWaitTime,
        threshold: this.HIGH_LATENCY_THRESHOLD_MS
      });
    }
  }
  
  /**
   * Record full execution cycle
   */
  recordExecution(
    strategyId: string,
    tradeDetectionTime: number,
    contextUpdateTime: number,
    executionStartTime: number,
    executionEndTime: number
  ): void {
    const executionDuration = executionEndTime - executionStartTime;
    const queueWaitTime = executionStartTime - contextUpdateTime;
    const totalLatency = executionEndTime - tradeDetectionTime;
    
    const metric: LatencyMetric = {
      strategyId,
      tradeDetectionTime,
      contextUpdateTime,
      executionStartTime,
      executionEndTime,
      totalLatency,
      executionDuration,
      queueWaitTime
    };
    
    // Store metric
    if (!this.latencyMetrics.has(strategyId)) {
      this.latencyMetrics.set(strategyId, []);
    }
    
    this.latencyMetrics.get(strategyId)!.push(metric);
    
    // Keep only last 1000 measurements per strategy
    const metrics = this.latencyMetrics.get(strategyId)!;
    if (metrics.length > 1000) {
      metrics.shift();
    }
    
    // Log detailed breakdown
    console.log(`⚡ [EXECUTION BREAKDOWN] Strategy ${strategyId}:`);
    console.log(`   Detection → Context Update: ${contextUpdateTime - tradeDetectionTime}ms`);
    console.log(`   Context Update → Execution Start: ${queueWaitTime}ms`);
    console.log(`   Execution Duration: ${executionDuration}ms`);
    console.log(`   Total Latency: ${totalLatency}ms`);
    
    // Alert on slow execution
    if (executionDuration > this.SLOW_EXECUTION_THRESHOLD_MS) {
      if (!this.slowExecutionCount.has(strategyId)) {
        this.slowExecutionCount.set(strategyId, 0);
      }
      this.slowExecutionCount.set(strategyId, this.slowExecutionCount.get(strategyId)! + 1);
      
      console.warn(`⚠️ [SLOW EXECUTION] Strategy ${strategyId} took ${executionDuration}ms!`);
      console.warn(`⚠️ Slow execution count: ${this.slowExecutionCount.get(strategyId)}`);
      
      this.emit('slow-execution', {
        strategyId,
        executionDuration,
        totalLatency,
        threshold: this.SLOW_EXECUTION_THRESHOLD_MS
      });
    }
    
    // Alert on high total latency
    if (totalLatency > this.HIGH_LATENCY_THRESHOLD_MS) {
      console.warn(`⚠️ [HIGH TOTAL LATENCY] Strategy ${strategyId}: ${totalLatency}ms from detection to completion`);
      
      this.emit('high-total-latency', {
        strategyId,
        totalLatency,
        breakdown: {
          detectionToContext: contextUpdateTime - tradeDetectionTime,
          queueWait: queueWaitTime,
          execution: executionDuration
        }
      });
    }
    
    // Success - reset failure count
    this.executionFailures.set(strategyId, 0);
  }
  
  /**
   * Record execution failure
   */
  recordFailure(strategyId: string, error: string): void {
    const currentFailures = this.executionFailures.get(strategyId) || 0;
    this.executionFailures.set(strategyId, currentFailures + 1);
    
    console.error(`❌ [EXECUTION FAILURE] Strategy ${strategyId} failed (count: ${currentFailures + 1}):`, error);
    
    // Alert on repeated failures
    if (currentFailures + 1 >= 3) {
      console.error(`🚨 [REPEATED FAILURES] Strategy ${strategyId} has failed ${currentFailures + 1} times!`);
      
      this.emit('repeated-failures', {
        strategyId,
        failureCount: currentFailures + 1,
        lastError: error
      });
    }
  }
  
  /**
   * Get execution statistics for a strategy
   */
  getStats(strategyId: string): ExecutionStats | null {
    const metrics = this.latencyMetrics.get(strategyId);
    
    if (!metrics || metrics.length === 0) {
      return null;
    }
    
    // Calculate latencies
    const latencies = metrics.map(m => m.totalLatency).sort((a, b) => a - b);
    const executionTimes = metrics.map(m => m.executionDuration).sort((a, b) => a - b);
    
    const p95Index = Math.floor(latencies.length * 0.95);
    const p99Index = Math.floor(latencies.length * 0.99);
    
    return {
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      maxLatency: Math.max(...latencies),
      minLatency: Math.min(...latencies),
      p95Latency: latencies[p95Index] || 0,
      p99Latency: latencies[p99Index] || 0,
      avgExecutionTime: executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length,
      maxExecutionTime: Math.max(...executionTimes),
      totalExecutions: metrics.length,
      slowExecutions: this.slowExecutionCount.get(strategyId) || 0,
      failedExecutions: this.executionFailures.get(strategyId) || 0
    };
  }
  
  /**
   * Get detailed metrics history
   */
  getHistory(strategyId: string, limit: number = 100): LatencyMetric[] {
    const metrics = this.latencyMetrics.get(strategyId);
    if (!metrics) return [];
    
    return metrics.slice(-limit);
  }
  
  /**
   * Get all strategies being monitored
   */
  getAllStrategies(): string[] {
    return Array.from(this.latencyMetrics.keys());
  }
  
  /**
   * Clear metrics for a strategy
   */
  clearMetrics(strategyId: string): void {
    this.latencyMetrics.delete(strategyId);
    this.executionFailures.delete(strategyId);
    this.slowExecutionCount.delete(strategyId);
    console.log(`🧹 [METRICS] Cleared metrics for ${strategyId}`);
  }
  
  /**
   * Generate summary report for all strategies
   */
  generateReport(): Record<string, ExecutionStats> {
    const report: Record<string, ExecutionStats> = {};
    
    for (const strategyId of this.getAllStrategies()) {
      const stats = this.getStats(strategyId);
      if (stats) {
        report[strategyId] = stats;
      }
    }
    
    return report;
  }
  
  /**
   * Print formatted report to console
   */
  printReport(): void {
    console.log('\n========================================');
    console.log('📊 REAL-TIME EXECUTION METRICS REPORT');
    console.log('========================================\n');
    
    const report = this.generateReport();
    const strategies = Object.keys(report);
    
    if (strategies.length === 0) {
      console.log('No metrics collected yet.\n');
      return;
    }
    
    for (const strategyId of strategies) {
      const stats = report[strategyId];
      
      console.log(`Strategy: ${strategyId}`);
      console.log(`  Total Executions: ${stats.totalExecutions}`);
      console.log(`  Latency:`);
      console.log(`    Average: ${stats.avgLatency.toFixed(2)}ms`);
      console.log(`    Min: ${stats.minLatency.toFixed(2)}ms`);
      console.log(`    Max: ${stats.maxLatency.toFixed(2)}ms`);
      console.log(`    P95: ${stats.p95Latency.toFixed(2)}ms`);
      console.log(`    P99: ${stats.p99Latency.toFixed(2)}ms`);
      console.log(`  Execution Time:`);
      console.log(`    Average: ${stats.avgExecutionTime.toFixed(2)}ms`);
      console.log(`    Max: ${stats.maxExecutionTime.toFixed(2)}ms`);
      console.log(`  Issues:`);
      console.log(`    Slow Executions (>${this.SLOW_EXECUTION_THRESHOLD_MS}ms): ${stats.slowExecutions}`);
      console.log(`    Failed Executions: ${stats.failedExecutions}`);
      console.log('');
    }
    
    console.log('========================================\n');
  }
}

// Export singleton instance
export const realTimeMetrics = new RealTimeMetrics();

// Set up periodic reporting (every 5 minutes)
setInterval(() => {
  realTimeMetrics.printReport();
}, 5 * 60 * 1000);

// Set up event listeners for alerts
realTimeMetrics.on('high-latency-warning', (data) => {
  console.warn(`🚨 [ALERT] High latency detected:`, data);
  // TODO: Send to monitoring service (Datadog, Sentry, etc.)
});

realTimeMetrics.on('slow-execution', (data) => {
  console.warn(`🚨 [ALERT] Slow execution detected:`, data);
  // TODO: Send to monitoring service
});

realTimeMetrics.on('repeated-failures', (data) => {
  console.error(`🚨 [ALERT] Repeated execution failures:`, data);
  // TODO: Send to monitoring service and alert ops team
});

realTimeMetrics.on('high-total-latency', (data) => {
  console.warn(`🚨 [ALERT] High total latency:`, data);
  // TODO: Send to monitoring service
});