/**
 * Production Alert System
 * Real-time alerts for critical trading events
 */

import { EventEmitter } from 'events';
import { awsLogger } from '../aws/logger';

export interface Alert {
  id: string;
  level: 'info' | 'warning' | 'critical' | 'emergency';
  title: string;
  message: string;
  timestamp: number;
  metadata?: any;
}

export interface AlertConfig {
  enableConsoleAlerts: boolean;
  enableLogAlerts: boolean;
  enableWebSocketAlerts: boolean;
  criticalAlertThreshold: number; // Max critical alerts before emergency stop
}

/**
 * Production Alert System
 */
export class ProductionAlertSystem extends EventEmitter {
  private alerts: Alert[] = [];
  private config: AlertConfig;
  private criticalAlertCount = 0;
  private readonly MAX_ALERTS_STORED = 1000;

  constructor(config?: Partial<AlertConfig>) {
    super();
    
    this.config = {
      enableConsoleAlerts: true,
      enableLogAlerts: true,
      enableWebSocketAlerts: true,
      criticalAlertThreshold: 5,
      ...config
    };

    awsLogger.info('ProductionAlertSystem initialized', {
      metadata: { config: this.config }
    });
  }

  
   //Send alert
  
  alert(
    level: Alert['level'],
    title: string,
    message: string,
    metadata?: any
  ): void {
    const alert: Alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      level,
      title,
      message,
      timestamp: Date.now(),
      metadata
    };

    // Store alert
    this.alerts.push(alert);
    if (this.alerts.length > this.MAX_ALERTS_STORED) {
      this.alerts.shift();
    }

    // Track critical alerts
    if (level === 'critical' || level === 'emergency') {
      this.criticalAlertCount++;

      if (this.criticalAlertCount >= this.config.criticalAlertThreshold) {
        this.emergencyAlert(
          'CRITICAL THRESHOLD EXCEEDED',
          `${this.criticalAlertCount} critical alerts detected. System may need immediate attention.`
        );
      }
    }

    // Dispatch alert through configured channels
    this.dispatchAlert(alert);
  }

  
   // Convenience methods
   
  info(title: string, message: string, metadata?: any): void {
    this.alert('info', title, message, metadata);
  }

  warning(title: string, message: string, metadata?: any): void {
    this.alert('warning', title, message, metadata);
  }

  critical(title: string, message: string, metadata?: any): void {
    this.alert('critical', title, message, metadata);
  }

  emergencyAlert(title: string, message: string, metadata?: any): void {
    this.alert('emergency', title, message, metadata);
  }

   // Dispatch alert through configured channels
   
  private dispatchAlert(alert: Alert): void {
    // Console alerts
    if (this.config.enableConsoleAlerts) {
      const icon = this.getAlertIcon(alert.level);
      console.log(`\n${icon} [${alert.level.toUpperCase()}] ${alert.title}`);
      console.log(`   ${alert.message}`);
      if (alert.metadata) {
        console.log(`   Metadata:`, alert.metadata);
      }
    }

    // Log alerts
    if (this.config.enableLogAlerts) {
      const logMethod = alert.level === 'critical' || alert.level === 'emergency' ? 'error' : 
                       alert.level === 'warning' ? 'warn' : 'info';
      
      awsLogger[logMethod](alert.title, {
        metadata: {
          message: alert.message,
          level: alert.level,
          ...alert.metadata
        }
      });
    }

    // WebSocket alerts
    if (this.config.enableWebSocketAlerts) {
      this.emit('alert', alert);
    }
  }

  /**
   * Get alert icon
   */
  private getAlertIcon(level: Alert['level']): string {
    switch (level) {
      case 'info': return 'ℹ️';
      case 'warning': return '⚠️';
      case 'critical': return '🔴';
      case 'emergency': return '🚨';
      default: return '📢';
    }
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(limit: number = 50): Alert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Get alerts by level
   */
  getAlertsByLevel(level: Alert['level']): Alert[] {
    return this.alerts.filter(a => a.level === level);
  }

  /**
   * Reset critical alert counter
   */
  resetCriticalCount(): void {
    this.criticalAlertCount = 0;
    awsLogger.info('Critical alert counter reset');
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalAlerts: number;
    criticalAlerts: number;
    warningAlerts: number;
    infoAlerts: number;
    emergencyAlerts: number;
  } {
    return {
      totalAlerts: this.alerts.length,
      criticalAlerts: this.alerts.filter(a => a.level === 'critical').length,
      warningAlerts: this.alerts.filter(a => a.level === 'warning').length,
      infoAlerts: this.alerts.filter(a => a.level === 'info').length,
      emergencyAlerts: this.alerts.filter(a => a.level === 'emergency').length
    };
  }

  /**
   * Clear old alerts
   */
  clearOldAlerts(olderThanMs: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - olderThanMs;
    this.alerts = this.alerts.filter(a => a.timestamp > cutoff);
  }
}

// Export singleton
export const productionAlertSystem = new ProductionAlertSystem({
  enableConsoleAlerts: true,
  enableLogAlerts: true,
  enableWebSocketAlerts: true,
  criticalAlertThreshold: 5
});

