/**
 * Emergency Stop System
 * Production-grade kill switches and circuit breakers
 */

import { EventEmitter } from 'events';
import { awsLogger } from '../aws/logger';

export interface EmergencyStopConfig {
  maxLossPercent: number; // Max portfolio loss before auto-stop
  maxDailyTrades: number; // Max trades per day before pause
  maxConsecutiveLosses: number; // Max losses in a row before stop
  minBalanceSOL: number; // Minimum balance to maintain
  enableAutoRecovery: boolean; // Auto-resume after cooling period
  coolingPeriodMs: number; // Time before auto-recovery (if enabled)
}

export interface StopReason {
  type: 'manual' | 'loss_limit' | 'trade_limit' | 'consecutive_losses' | 'low_balance' | 'external';
  message: string;
  timestamp: number;
  severity: 'warning' | 'critical' | 'emergency';
}

/**
 * Emergency Stop System with multiple safety layers
 */
export class EmergencyStopSystem extends EventEmitter {
  private isStopped = false;
  private stopReason: StopReason | null = null;
  private config: EmergencyStopConfig;
  private coolingTimer: NodeJS.Timeout | null = null;
  
  // Tracking metrics
  private consecutiveLosses = 0;
  private dailyTradeCount = 0;
  private dailyStartTime = Date.now();
  private initialBalance = 0;
  private currentBalance = 0;

  constructor(config: Partial<EmergencyStopConfig> = {}) {
    super();
    
    this.config = {
      maxLossPercent: 15, // 15% max loss
      maxDailyTrades: 100,
      maxConsecutiveLosses: 5,
      minBalanceSOL: 0.1,
      enableAutoRecovery: false,
      coolingPeriodMs: 60 * 60 * 1000, // 1 hour
      ...config
    };

    awsLogger.info('EmergencyStopSystem initialized', {
      metadata: { config: this.config }
    });
  }

  /**
   * Manual emergency stop (highest priority)
   */
  triggerEmergencyStop(reason: string): void {
    this.stop({
      type: 'manual',
      message: reason,
      timestamp: Date.now(),
      severity: 'emergency'
    });

    awsLogger.error('EMERGENCY STOP TRIGGERED MANUALLY', {
      metadata: { reason, timestamp: Date.now() }
    });
  }

  /**
   * Check if trading should continue
   */
  async checkSafety(tradeResult?: { pnl: number; balance: number }): Promise<boolean> {
    if (this.isStopped) {
      return false;
    }

    // Update metrics if trade result provided
    if (tradeResult) {
      this.updateMetrics(tradeResult);
    }

    // Check all safety conditions
    this.checkLossLimit();
    this.checkTradeLimit();
    this.checkConsecutiveLosses();
    this.checkMinBalance();

    return !this.isStopped;
  }

  /**
   * Record trade and update metrics
   */
  updateMetrics(tradeResult: { pnl: number; balance: number }): void {
    // Reset daily counter if new day
    const now = Date.now();
    if (now - this.dailyStartTime > 24 * 60 * 60 * 1000) {
      this.dailyTradeCount = 0;
      this.dailyStartTime = now;
    }

    this.dailyTradeCount++;
    this.currentBalance = tradeResult.balance;

    // Track consecutive losses
    if (tradeResult.pnl < 0) {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0; // Reset on win
    }

    // Set initial balance on first trade
    if (this.initialBalance === 0) {
      this.initialBalance = tradeResult.balance;
    }
  }

  /**
   * Check if portfolio loss exceeds limit
   */
  private checkLossLimit(): void {
    if (this.initialBalance === 0) return;

    const lossPercent = ((this.initialBalance - this.currentBalance) / this.initialBalance) * 100;
    
    if (lossPercent >= this.config.maxLossPercent) {
      this.stop({
        type: 'loss_limit',
        message: `Portfolio loss (${lossPercent.toFixed(2)}%) exceeded limit (${this.config.maxLossPercent}%)`,
        timestamp: Date.now(),
        severity: 'critical'
      });
    }
  }

  /**
   * Check if daily trade limit exceeded
   */
  private checkTradeLimit(): void {
    if (this.dailyTradeCount >= this.config.maxDailyTrades) {
      this.stop({
        type: 'trade_limit',
        message: `Daily trade limit (${this.config.maxDailyTrades}) exceeded`,
        timestamp: Date.now(),
        severity: 'warning'
      });
    }
  }

  /**
   * Check consecutive losses
   */
  private checkConsecutiveLosses(): void {
    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.stop({
        type: 'consecutive_losses',
        message: `${this.consecutiveLosses} consecutive losses detected`,
        timestamp: Date.now(),
        severity: 'critical'
      });
    }
  }

  /**
   * Check minimum balance
   */
  private checkMinBalance(): void {
    if (this.currentBalance < this.config.minBalanceSOL) {
      this.stop({
        type: 'low_balance',
        message: `Balance (${this.currentBalance.toFixed(4)} SOL) below minimum (${this.config.minBalanceSOL} SOL)`,
        timestamp: Date.now(),
        severity: 'emergency'
      });
    }
  }

  /**
   * Execute stop
   */
  private stop(reason: StopReason): void {
    if (this.isStopped) return; // Already stopped

    this.isStopped = true;
    this.stopReason = reason;

    // Emit stop event
    this.emit('emergencyStop', reason);

    // Log to AWS
    awsLogger.error('EMERGENCY STOP ACTIVATED', {
      metadata: {
        reason,
        metrics: {
          consecutiveLosses: this.consecutiveLosses,
          dailyTrades: this.dailyTradeCount,
          balance: this.currentBalance,
          initialBalance: this.initialBalance
        }
      }
    });

    // Setup auto-recovery if enabled
    if (this.config.enableAutoRecovery && reason.severity !== 'emergency') {
      this.setupAutoRecovery();
    }
  }

  /**
   * Setup automatic recovery after cooling period
   */
  private setupAutoRecovery(): void {
    this.coolingTimer = setTimeout(() => {
      awsLogger.info('Auto-recovery initiated after cooling period', {
        metadata: { coolingPeriodMs: this.config.coolingPeriodMs }
      });
      
      this.resume();
    }, this.config.coolingPeriodMs);
  }

  /**
   * Manually resume trading
   */
  resume(): void {
    if (!this.isStopped) return;

    this.isStopped = false;
    this.stopReason = null;
    this.consecutiveLosses = 0; // Reset on manual resume

    // Clear cooling timer
    if (this.coolingTimer) {
      clearTimeout(this.coolingTimer);
      this.coolingTimer = null;
    }

    // Emit resume event
    this.emit('resumed');

    awsLogger.info('Trading resumed', {
      metadata: { timestamp: Date.now() }
    });
  }

  /**
   * Check if stopped
   */
  isTradingStopped(): boolean {
    return this.isStopped;
  }

  /**
   * Get stop reason
   */
  getStopReason(): StopReason | null {
    return this.stopReason;
  }

  /**
   * Get current status
   */
  getStatus(): {
    stopped: boolean;
    reason: StopReason | null;
    metrics: {
      consecutiveLosses: number;
      dailyTrades: number;
      currentBalance: number;
      lossPercent: number;
    };
    config: EmergencyStopConfig;
  } {
    const lossPercent = this.initialBalance > 0
      ? ((this.initialBalance - this.currentBalance) / this.initialBalance) * 100
      : 0;

    return {
      stopped: this.isStopped,
      reason: this.stopReason,
      metrics: {
        consecutiveLosses: this.consecutiveLosses,
        dailyTrades: this.dailyTradeCount,
        currentBalance: this.currentBalance,
        lossPercent
      },
      config: this.config
    };
  }

  /**
   * Reset all metrics (use carefully)
   */
  reset(): void {
    this.consecutiveLosses = 0;
    this.dailyTradeCount = 0;
    this.dailyStartTime = Date.now();
    this.initialBalance = 0;
    this.currentBalance = 0;

    awsLogger.info('EmergencyStopSystem metrics reset', {
      metadata: { timestamp: Date.now() }
    });
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<EmergencyStopConfig>): void {
    this.config = { ...this.config, ...updates };
    
    awsLogger.info('EmergencyStopSystem config updated', {
      metadata: { updates }
    });
  }
}

// Export singleton with default config
export const emergencyStopSystem = new EmergencyStopSystem({
  maxLossPercent: 15,
  maxDailyTrades: 100,
  maxConsecutiveLosses: 5,
  minBalanceSOL: 0.1,
  enableAutoRecovery: false,
  coolingPeriodMs: 60 * 60 * 1000
});

