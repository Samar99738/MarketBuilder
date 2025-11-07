/**
 * Production Monitoring Dashboard
 * Real-time metrics, alerts, and health monitoring
 */

import { EventEmitter } from 'events';
import { awsLogger } from '../aws/logger';
import { performanceMonitor } from './PerformanceMonitor';
import { advancedRiskManager } from './AdvancedRiskManager';
import { emergencyStopSystem } from './EmergencyStopSystem';
import { strategyExecutionManager } from './StrategyExecutionManager';

export interface DashboardMetrics {
  // System Health
  systemHealth: {
    healthy: boolean;
    uptime: number;
    timestamp: number;
  };
  
  // Performance
  performance: {
    avgResponseTime: number;
    requestsPerSecond: number;
    errorRate: number;
    memoryUsageMB: number;
  };
  
  // Trading
  trading: {
    activeStrategies: number;
    totalTrades: number;
    successRate: number;
    totalPnL: number;
  };
  
  // Risk
  risk: {
    circuitBreakerActive: boolean;
    openPositions: number;
    dailyPnL: number;
    currentDrawdown: number;
  };
  
  // Alerts
  alerts: Array<{
    level: 'info' | 'warning' | 'critical';
    message: string;
    timestamp: number;
  }>;
}

/**
 * Production Dashboard
 */
export class ProductionDashboard extends EventEmitter {
  private readonly startTime = Date.now();
  private metricsInterval: NodeJS.Timeout | null = null;
  private alerts: Array<{
    level: 'info' | 'warning' | 'critical';
    message: string;
    timestamp: number;
  }> = [];
  
  constructor() {
    super();
    
    // Start metrics collection
    this.startMetricsCollection();
    
    // Listen for emergency stops
    emergencyStopSystem.on('emergencyStop', (reason) => {
      this.addAlert('critical', `Emergency stop triggered: ${reason.message}`);
    });
    
    // Listen for performance issues
    performanceMonitor.on('operation', (data) => {
      if (data.duration > 5000) {
        this.addAlert('warning', `Slow operation: ${data.name} took ${data.duration}ms`);
      }
    });
    
    awsLogger.info('ProductionDashboard initialized');
  }

  /**
   * Start collecting metrics periodically
   */
  private startMetricsCollection(): void {
    // Collect metrics every 10 seconds
    this.metricsInterval = setInterval(() => {
      this.collectAndEmitMetrics();
    }, 10000);
  }

  /**
   * Collect and emit current metrics
   */
  private async collectAndEmitMetrics(): Promise<void> {
    try {
      const metrics = this.getMetrics();
      
      // Emit to listeners
      this.emit('metrics', metrics);
      
      // Log to AWS
      awsLogger.info('Dashboard metrics', {
        metadata: { metrics }
      });
      
      // Check for issues
      this.checkForIssues(metrics);
    } catch (error) {
      awsLogger.error('Error collecting dashboard metrics', {
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  /**
   * Get current dashboard metrics
   */
  getMetrics(): DashboardMetrics {
    const uptime = Date.now() - this.startTime;
    
    // Performance metrics
    const perfMetrics = performanceMonitor.getMetrics();
    const perfHealth = performanceMonitor.getHealth();
    
    // Risk metrics
    const riskMetrics = advancedRiskManager.getMetrics();
    const riskHealth = advancedRiskManager.getHealth();
    
    // Strategy metrics
    const runningStrategies = strategyExecutionManager.listRunningStrategies();
    const activeStrategies = runningStrategies.filter(s => s.status === 'running').length;
    
    // Emergency stop status
    const stopStatus = emergencyStopSystem.getStatus();
    
    return {
      systemHealth: {
        healthy: perfHealth.healthy && riskHealth.healthy && !stopStatus.stopped,
        uptime,
        timestamp: Date.now()
      },
      
      performance: {
        avgResponseTime: perfMetrics.avgResponseTime,
        requestsPerSecond: perfMetrics.requestsPerSecond,
        errorRate: perfMetrics.errorRate,
        memoryUsageMB: perfMetrics.memoryUsageMB
      },
      
      trading: {
        activeStrategies,
        totalTrades: perfMetrics.totalRequests,
        successRate: perfMetrics.successRate,
        totalPnL: riskMetrics.totalPnLSOL
      },
      
      risk: {
        circuitBreakerActive: riskHealth.circuitBreakerActive,
        openPositions: riskMetrics.openPositions,
        dailyPnL: riskMetrics.dailyPnLSOL,
        currentDrawdown: riskMetrics.currentDrawdownPercent
      },
      
      alerts: [...this.alerts].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10)
    };
  }

  /**
   * Add alert
   */
  private addAlert(level: 'info' | 'warning' | 'critical', message: string): void {
    const alert = {
      level,
      message,
      timestamp: Date.now()
    };
    
    this.alerts.push(alert);
    
    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
    
    // Emit alert
    this.emit('alert', alert);
    
    // Log critical alerts
    if (level === 'critical') {
      awsLogger.error('CRITICAL ALERT', {
        metadata: { alert }
      });
    }
  }

  /**
   * Check for issues and generate alerts
   */
  private checkForIssues(metrics: DashboardMetrics): void {
    // Check system health
    if (!metrics.systemHealth.healthy) {
      this.addAlert('critical', 'System unhealthy - check all subsystems');
    }
    
    // Check performance
    if (metrics.performance.avgResponseTime > 2000) {
      this.addAlert('warning', `High response time: ${metrics.performance.avgResponseTime.toFixed(0)}ms`);
    }
    
    if (metrics.performance.errorRate > 5) {
      this.addAlert('warning', `High error rate: ${metrics.performance.errorRate.toFixed(2)}%`);
    }
    
    if (metrics.performance.memoryUsageMB > 1000) {
      this.addAlert('warning', `High memory usage: ${metrics.performance.memoryUsageMB.toFixed(0)}MB`);
    }
    
    // Check trading
    if (metrics.trading.successRate < 80 && metrics.trading.totalTrades > 10) {
      this.addAlert('warning', `Low success rate: ${metrics.trading.successRate.toFixed(2)}%`);
    }
    
    // Check risk
    if (metrics.risk.circuitBreakerActive) {
      this.addAlert('critical', 'Circuit breaker active - trading paused');
    }
    
    if (metrics.risk.dailyPnL < -0.5) {
      this.addAlert('warning', `Daily loss: ${metrics.risk.dailyPnL.toFixed(4)} SOL`);
    }
    
    if (metrics.risk.currentDrawdown > 15) {
      this.addAlert('warning', `High drawdown: ${metrics.risk.currentDrawdown.toFixed(2)}%`);
    }
  }

  /**
   * Get system health status
   */
  getHealth(): {
    overall: 'healthy' | 'degraded' | 'critical';
    subsystems: {
      performance: boolean;
      risk: boolean;
      trading: boolean;
      emergency: boolean;
    };
    issues: string[];
  } {
    const perfHealth = performanceMonitor.getHealth();
    const riskHealth = advancedRiskManager.getHealth();
    const stopStatus = emergencyStopSystem.getStatus();
    const executionHealth = strategyExecutionManager.getHealthStatus();
    
    const issues: string[] = [];
    
    // Collect issues
    if (!perfHealth.healthy) {
      issues.push(...perfHealth.warnings);
    }
    
    if (!riskHealth.healthy) {
      issues.push(...riskHealth.warnings);
    }
    
    if (stopStatus.stopped) {
      issues.push(`Trading stopped: ${stopStatus.reason?.message}`);
    }
    
    if (!executionHealth.healthy) {
      issues.push('Strategy execution issues detected');
    }
    
    // Determine overall health
    let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';
    
    if (issues.length > 0) {
      overall = 'degraded';
    }
    
    if (stopStatus.stopped || riskHealth.circuitBreakerActive || executionHealth.errorCount > 5) {
      overall = 'critical';
    }
    
    return {
      overall,
      subsystems: {
        performance: perfHealth.healthy,
        risk: riskHealth.healthy,
        trading: executionHealth.healthy,
        emergency: !stopStatus.stopped
      },
      issues
    };
  }

  /**
   * Get detailed status report
   */
  getStatusReport(): string {
    const metrics = this.getMetrics();
    const health = this.getHealth();
    
    const uptimeHours = (metrics.systemHealth.uptime / 1000 / 60 / 60).toFixed(2);
    
    let report = `
📊 **PRODUCTION DASHBOARD**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 **System Status: ${health.overall.toUpperCase()}**
⏱️ Uptime: ${uptimeHours} hours

**Performance Metrics:**
• Avg Response Time: ${metrics.performance.avgResponseTime.toFixed(0)}ms
• Requests/sec: ${metrics.performance.requestsPerSecond}
• Error Rate: ${metrics.performance.errorRate.toFixed(2)}%
• Memory Usage: ${metrics.performance.memoryUsageMB.toFixed(0)}MB

**Trading Metrics:**
• Active Strategies: ${metrics.trading.activeStrategies}
• Total Trades: ${metrics.trading.totalTrades}
• Success Rate: ${metrics.trading.successRate.toFixed(2)}%
• Total P&L: ${metrics.trading.totalPnL.toFixed(4)} SOL

**Risk Metrics:**
• Circuit Breaker: ${metrics.risk.circuitBreakerActive ? '🔴 ACTIVE' : '🟢 Inactive'}
• Open Positions: ${metrics.risk.openPositions}
• Daily P&L: ${metrics.risk.dailyPnL.toFixed(4)} SOL
• Current Drawdown: ${metrics.risk.currentDrawdown.toFixed(2)}%

`;

    if (health.issues.length > 0) {
      report += `\n⚠️ **Active Issues:**\n`;
      health.issues.forEach(issue => {
        report += `• ${issue}\n`;
      });
    }
    
    if (metrics.alerts.length > 0) {
      report += `\n🔔 **Recent Alerts:**\n`;
      metrics.alerts.slice(0, 5).forEach(alert => {
        const icon = alert.level === 'critical' ? '🔴' : alert.level === 'warning' ? '⚠️' : 'ℹ️';
        report += `${icon} ${alert.message}\n`;
      });
    }
    
    report += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return report;
  }

  /**
   * Shutdown dashboard
   */
  shutdown(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    
    awsLogger.info('ProductionDashboard shutdown complete');
  }
}

// Export singleton
export const productionDashboard = new ProductionDashboard();