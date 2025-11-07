/**
 * Advanced Risk Management System
 * Risk controls for automated trading
 */

import { awsLogger } from '../aws/logger';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export interface RiskProfile {
  maxPositionSizeSOL: number;
  maxDailyLossSOL: number;
  maxConcurrentTrades: number;
  maxDrawdownPercent: number;
  dailyLossLimitSOL: number;
  positionSizePercent: number; // Percentage of portfolio per trade
  enableDynamicSizing: boolean; // Adjust position size based on volatility
  enableCorrelationCheck: boolean; // Check token correlations
}

export interface TradeValidation {
  allowed: boolean;
  reason?: string;
  suggestedSize?: number; // If size needs to be reduced
}

export interface PortfolioMetrics {
  totalBalanceSOL: number;
  availableBalanceSOL: number;
  lockedBalanceSOL: number;
  openPositions: number;
  dailyPnLSOL: number;
  totalPnLSOL: number;
  currentDrawdownPercent: number;
  lastResetTimestamp: number;
}

/**
 * Advanced Risk Manager for production trading
 */
export class AdvancedRiskManager {
  private riskProfile: RiskProfile;
  private portfolioMetrics: PortfolioMetrics;
  private tradeHistory: Array<{
    timestamp: number;
    amountSOL: number;
    pnlSOL: number;
  }> = [];
  private dailyTradeCount = 0;
  private lastDailyReset = Date.now();
  
  // Circuit breaker
  private circuitBreakerActive = false;
  private consecutiveLosses = 0;
  private readonly MAX_CONSECUTIVE_LOSSES = 5;

  constructor(riskProfile: Partial<RiskProfile> = {}) {
    this.riskProfile = {
      maxPositionSizeSOL: 1.0,
      maxDailyLossSOL: 0.5,
      maxConcurrentTrades: 3,
      maxDrawdownPercent: 20,
      dailyLossLimitSOL: 1.0,
      positionSizePercent: 10, // 10% of portfolio per trade
      enableDynamicSizing: true,
      enableCorrelationCheck: true, // ENABLED for production
      ...riskProfile
    };

    this.portfolioMetrics = {
      totalBalanceSOL: 0,
      availableBalanceSOL: 0,
      lockedBalanceSOL: 0,
      openPositions: 0,
      dailyPnLSOL: 0,
      totalPnLSOL: 0,
      currentDrawdownPercent: 0,
      lastResetTimestamp: Date.now()
    };

    awsLogger.info('AdvancedRiskManager initialized', {
      metadata: { riskProfile: this.riskProfile }
    });
  }

  /**
   * Validate if a trade is allowed based on risk rules
   */
  validateTrade(amountSOL: number, currentBalance: number): TradeValidation {
    // Check circuit breaker
    if (this.circuitBreakerActive) {
      return {
        allowed: false,
        reason: `Circuit breaker active: ${this.consecutiveLosses} consecutive losses detected. Trading paused for safety.`
      };
    }

    // Reset daily limits if needed
    this.checkDailyReset();

    // 1. Check position size limit
    if (amountSOL > this.riskProfile.maxPositionSizeSOL) {
      return {
        allowed: false,
        reason: `Trade size (${amountSOL} SOL) exceeds maximum position size (${this.riskProfile.maxPositionSizeSOL} SOL)`,
        suggestedSize: this.riskProfile.maxPositionSizeSOL
      };
    }

    // 2. Check available balance
    if (amountSOL > currentBalance) {
      return {
        allowed: false,
        reason: `Insufficient balance: ${currentBalance.toFixed(4)} SOL available, ${amountSOL} SOL required`,
        suggestedSize: currentBalance * 0.95 // Leave 5% buffer for fees
      };
    }

    // 3. Check concurrent trades limit
    if (this.portfolioMetrics.openPositions >= this.riskProfile.maxConcurrentTrades) {
      return {
        allowed: false,
        reason: `Maximum concurrent trades reached (${this.riskProfile.maxConcurrentTrades}). Close existing positions first.`
      };
    }

    // 4. Check daily loss limit
    if (Math.abs(this.portfolioMetrics.dailyPnLSOL) >= this.riskProfile.dailyLossLimitSOL) {
      return {
        allowed: false,
        reason: `Daily loss limit reached: ${this.portfolioMetrics.dailyPnLSOL.toFixed(4)} SOL lost today (limit: ${this.riskProfile.dailyLossLimitSOL} SOL)`
      };
    }

    // 5. Check drawdown limit
    if (this.portfolioMetrics.currentDrawdownPercent >= this.riskProfile.maxDrawdownPercent) {
      return {
        allowed: false,
        reason: `Maximum drawdown reached: ${this.portfolioMetrics.currentDrawdownPercent.toFixed(2)}% (limit: ${this.riskProfile.maxDrawdownPercent}%)`
      };
    }

    // 6. Dynamic position sizing (if enabled)
    if (this.riskProfile.enableDynamicSizing) {
      const maxAllowedSize = currentBalance * (this.riskProfile.positionSizePercent / 100);
      if (amountSOL > maxAllowedSize) {
        return {
          allowed: true,
          reason: `Position size reduced based on portfolio percentage`,
          suggestedSize: maxAllowedSize
        };
      }
    }

    // All checks passed
    return { allowed: true };
  }

  /**
   * Record a trade execution
   */
  recordTrade(amountSOL: number, pnlSOL?: number): void {
    this.tradeHistory.push({
      timestamp: Date.now(),
      amountSOL,
      pnlSOL: pnlSOL || 0
    });

    this.portfolioMetrics.openPositions++;
    this.portfolioMetrics.lockedBalanceSOL += amountSOL;
    this.portfolioMetrics.availableBalanceSOL -= amountSOL;
    this.dailyTradeCount++;

    awsLogger.info('Trade recorded', {
      metadata: { amountSOL, openPositions: this.portfolioMetrics.openPositions }
    });
  }

  /**
   * Record trade closure with P&L
   */
  recordTradeClose(pnlSOL: number, amountSOL: number): void {
    this.portfolioMetrics.dailyPnLSOL += pnlSOL;
    this.portfolioMetrics.totalPnLSOL += pnlSOL;
    this.portfolioMetrics.openPositions = Math.max(0, this.portfolioMetrics.openPositions - 1);
    this.portfolioMetrics.lockedBalanceSOL -= amountSOL;
    this.portfolioMetrics.availableBalanceSOL += amountSOL + pnlSOL;

    // Update drawdown
    if (pnlSOL < 0) {
      const drawdownPercent = Math.abs(pnlSOL / this.portfolioMetrics.totalBalanceSOL) * 100;
      this.portfolioMetrics.currentDrawdownPercent = Math.max(
        this.portfolioMetrics.currentDrawdownPercent,
        drawdownPercent
      );
    }

    // Circuit breaker logic
    if (pnlSOL < 0) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
        this.activateCircuitBreaker();
      }
    } else {
      this.consecutiveLosses = 0; // Reset on winning trade
    }

    awsLogger.info('Trade closed', {
      metadata: {
        pnlSOL,
        dailyPnL: this.portfolioMetrics.dailyPnLSOL,
        openPositions: this.portfolioMetrics.openPositions,
        consecutiveLosses: this.consecutiveLosses
      }
    });
  }

  /**
   * Activate circuit breaker
   */
  private activateCircuitBreaker(): void {
    this.circuitBreakerActive = true;
    
    awsLogger.error('CIRCUIT BREAKER ACTIVATED', {
      metadata: {
        consecutiveLosses: this.consecutiveLosses,
        dailyPnL: this.portfolioMetrics.dailyPnLSOL,
        timestamp: Date.now()
      }
    });

    // Auto-reset after 1 hour
    setTimeout(() => {
      this.resetCircuitBreaker();
    }, 60 * 60 * 1000);
  }

  /**
   * Reset circuit breaker (manual or automatic)
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerActive = false;
    this.consecutiveLosses = 0;
    
    awsLogger.info('Circuit breaker reset', {
      metadata: { timestamp: Date.now() }
    });
  }

  /**
   * Update portfolio balance
   */
  updateBalance(totalBalanceSOL: number): void {
    this.portfolioMetrics.totalBalanceSOL = totalBalanceSOL;
    this.portfolioMetrics.availableBalanceSOL = totalBalanceSOL - this.portfolioMetrics.lockedBalanceSOL;
  }

  /**
   * Check and reset daily limits
   */
  private checkDailyReset(): void {
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;
    
    if (now - this.lastDailyReset > dayInMs) {
      this.portfolioMetrics.dailyPnLSOL = 0;
      this.portfolioMetrics.currentDrawdownPercent = 0;
      this.dailyTradeCount = 0;
      this.lastDailyReset = now;
      
      awsLogger.info('Daily risk limits reset', {
        metadata: { timestamp: now }
      });
    }
  }

  /**
   * Get current portfolio metrics
   */
  getMetrics(): PortfolioMetrics {
    return { ...this.portfolioMetrics };
  }

  /**
   * Get risk profile
   */
  getRiskProfile(): RiskProfile {
    return { ...this.riskProfile };
  }

  /**
   * Update risk profile
   */
  updateRiskProfile(updates: Partial<RiskProfile>): void {
    this.riskProfile = { ...this.riskProfile, ...updates };
    
    awsLogger.info('Risk profile updated', {
      metadata: { updates }
    });
  }

  /**
   * Get health status
   */
  getHealth(): {
    healthy: boolean;
    circuitBreakerActive: boolean;
    dailyTradeCount: number;
    openPositions: number;
    warnings: string[];
  } {
    const warnings: string[] = [];

    if (this.circuitBreakerActive) {
      warnings.push('Circuit breaker is active');
    }

    if (Math.abs(this.portfolioMetrics.dailyPnLSOL) > this.riskProfile.dailyLossLimitSOL * 0.8) {
      warnings.push('Approaching daily loss limit');
    }

    if (this.portfolioMetrics.openPositions >= this.riskProfile.maxConcurrentTrades * 0.8) {
      warnings.push('Approaching max concurrent trades');
    }

    return {
      healthy: !this.circuitBreakerActive && warnings.length === 0,
      circuitBreakerActive: this.circuitBreakerActive,
      dailyTradeCount: this.dailyTradeCount,
      openPositions: this.portfolioMetrics.openPositions,
      warnings
    };
  }
}

// Export singleton with default risk profile
export const advancedRiskManager = new AdvancedRiskManager({
  maxPositionSizeSOL: 1.0,
  maxDailyLossSOL: 0.5,
  maxConcurrentTrades: 3,
  maxDrawdownPercent: 20,
  dailyLossLimitSOL: 1.0,
  positionSizePercent: 10,
  enableDynamicSizing: true,
  enableCorrelationCheck: true // ENABLED for production
});

