/**
 * Strategy Execution Tracker
 * Comprehensive analytics and performance tracking for trading strategies
 */

import { awsLogger } from '../aws/logger';
import { getTokenPriceUSD, getSolPriceUSD } from './TokenUtils';
import { marketDataProvider } from './paper-trading/MarketDataProvider';

// Import broadcaster - will be initialized by server
let performanceBroadcaster: any = null;
try {
  performanceBroadcaster = require('../server/websocket/performanceBroadcaster').performanceBroadcaster;
} catch (error) {
  // Broadcaster not available (e.g., in tests)
}

export interface TradeExecution {
  tradeId: string;
  strategyId: string;
  timestamp: number;
  type: 'buy' | 'sell';
  tokenAddress: string;
  amountSOL: number;
  amountTokens: number;
  priceUSD: number;
  solPriceUSD: number;
  txSignature: string;
  fees: {
    priorityFee: number;
    networkFee: number;
    totalFeeSOL: number;
  };
}

export interface StrategyPerformance {
  strategyId: string;
  strategyName: string;
  startTime: number;
  endTime?: number;
  status: 'running' | 'completed' | 'failed' | 'paused';
  
  // Execution stats
  totalExecutions: number;
  buyExecutions: number;
  sellExecutions: number;
  
  // Financial metrics
  initialBalanceSOL: number;
  currentBalanceSOL: number;
  totalInvestedSOL: number;
  totalReturnedSOL: number;
  currentTokenBalance: number;
  
  // Profit/Loss
  realizedProfitSOL: number;
  realizedProfitUSD: number;
  unrealizedProfitSOL: number;
  unrealizedProfitUSD: number;
  totalProfitSOL: number;
  totalProfitUSD: number;
  profitPercentage: number;
  
  // Fees
  totalFeesSOL: number;
  totalFeesUSD: number;
  
  // Trade history
  trades: TradeExecution[];
  
  // Performance metrics
  averageExecutionTime: number;
  successRate: number;
  failedExecutions: number;
  
  // ROI metrics
  roi: number;
  dailyROI: number;
  
  // Token info
  tokenAddress?: string;
  tokenSymbol?: string;
  
  // Price caching
  lastKnownTokenPrice?: number;  // Cache for fallback when price API fails
}

export class StrategyExecutionTracker {
  private performances: Map<string, StrategyPerformance> = new Map();

  /**
   * Initialize tracking for a new strategy
   */
  async initializeStrategy(
    strategyId: string,
    strategyName: string,
    initialBalanceSOL: number,
    tokenAddress?: string,
    tokenSymbol?: string
  ): Promise<void> {
    const performance: StrategyPerformance = {
      strategyId,
      strategyName,
      startTime: Date.now(),
      status: 'running',
      totalExecutions: 0,
      buyExecutions: 0,
      sellExecutions: 0,
      initialBalanceSOL,
      currentBalanceSOL: initialBalanceSOL,
      totalInvestedSOL: 0,
      totalReturnedSOL: 0,
      currentTokenBalance: 0,
      realizedProfitSOL: 0,
      realizedProfitUSD: 0,
      unrealizedProfitSOL: 0,
      unrealizedProfitUSD: 0,
      totalProfitSOL: 0,
      totalProfitUSD: 0,
      profitPercentage: 0,
      totalFeesSOL: 0,
      totalFeesUSD: 0,
      trades: [],
      averageExecutionTime: 0,
      successRate: 100,
      failedExecutions: 0,
      roi: 0,
      dailyROI: 0,
      tokenAddress,
      tokenSymbol,
      lastKnownTokenPrice: undefined,  // Will be set on first price fetch
    };

    this.performances.set(strategyId, performance);
    // Strategy tracking initialized
  }

  /**
   * Record a trade execution
   */
  async recordTrade(trade: TradeExecution): Promise<void> {
    const performance = this.performances.get(trade.strategyId);
    if (!performance) {
      awsLogger.error('Strategy not found for trade recording', { 
        metadata: { strategyId: trade.strategyId } 
      });
      return;
    }

    // Add trade to history
    performance.trades.push(trade);
    performance.totalExecutions++;

    // Update execution counts
    if (trade.type === 'buy') {
      performance.buyExecutions++;
      performance.totalInvestedSOL += trade.amountSOL;
      performance.currentBalanceSOL -= trade.amountSOL;
      performance.currentTokenBalance += trade.amountTokens;
    } else {
      performance.sellExecutions++;
      performance.totalReturnedSOL += trade.amountSOL;
      performance.currentBalanceSOL += trade.amountSOL;
      performance.currentTokenBalance -= trade.amountTokens;
    }

    // Update fees
    performance.totalFeesSOL += trade.fees.totalFeeSOL;
    performance.totalFeesUSD += trade.fees.totalFeeSOL * trade.solPriceUSD;

    // Recalculate metrics
    await this.calculateMetrics(performance);

    awsLogger.info('Trade recorded', { 
      metadata: { 
        strategyId: trade.strategyId, 
        type: trade.type,
        amountSOL: trade.amountSOL,
        totalExecutions: performance.totalExecutions,
        totalProfitUSD: performance.totalProfitUSD.toFixed(2)
      } 
    });

    // Broadcast performance update via WebSocket
    if (performanceBroadcaster) {
      performanceBroadcaster.broadcast(trade.strategyId);
    }
  }

  /**
   * Record a failed execution
   */
  recordFailure(strategyId: string, error: string): void {
    const performance = this.performances.get(strategyId);
    if (!performance) return;

    performance.failedExecutions++;
    const totalAttempts = performance.totalExecutions + performance.failedExecutions;
    performance.successRate = totalAttempts > 0 
      ? (performance.totalExecutions / totalAttempts) * 100 
      : 100;

    awsLogger.warn('Strategy execution failed', { 
      metadata: { 
        strategyId, 
        error, 
        successRate: performance.successRate.toFixed(2),
        failedExecutions: performance.failedExecutions
      } 
    });
  }

  /**
   * Calculate performance metrics
   */
  private async calculateMetrics(performance: StrategyPerformance): Promise<void> {
    const latestTrade = performance.trades[performance.trades.length - 1];
    if (!latestTrade) return;

    // Calculate realized profit
    if (performance.sellExecutions > 0) {
      performance.realizedProfitSOL = performance.totalReturnedSOL - performance.totalInvestedSOL;
      performance.realizedProfitUSD = performance.realizedProfitSOL * latestTrade.solPriceUSD;
    }

    // Calculate unrealized profit (current token holdings) with price fallback
    if (performance.currentTokenBalance > 0 && performance.tokenAddress) {
      // Calculate average entry price from total invested and total tokens bought
      const totalTokensBought = performance.trades
        .filter(t => t.type === 'buy')
        .reduce((sum, t) => sum + t.amountTokens, 0);
      const averageEntryPrice = totalTokensBought > 0 
        ? performance.totalInvestedSOL / totalTokensBought 
        : 0;
      
      // Start with fallback: use last known price or average entry price
      let currentPrice = performance.lastKnownTokenPrice || averageEntryPrice;
      let priceSource = performance.lastKnownTokenPrice ? 'cached' : 'entry_price';
      
      try {
        // Fetch token price in SOL (not USD!)
        const priceData = await marketDataProvider.fetchTokenPrice(performance.tokenAddress);
        
        if (priceData?.price && priceData.price > 0) {
          currentPrice = priceData.price; // This is in SOL per token
          performance.lastKnownTokenPrice = currentPrice; // Cache for next time
          priceSource = 'live';
        }
      } catch (error) {
        console.warn(`⚠️ [Unrealized P&L] Using ${priceSource} price for ${performance.tokenSymbol || 'token'}: ${currentPrice.toFixed(10)} SOL`);
        awsLogger.warn('Failed to fetch current price, using fallback', { 
          metadata: { 
            strategyId: performance.strategyId, 
            fallbackPrice: currentPrice,
            priceSource,
            error 
          } 
        });
      }
      
      // Calculate in SOL first (all prices are in SOL per token)
      const costBasisSOL = performance.currentTokenBalance * averageEntryPrice;
      const currentValueSOL = performance.currentTokenBalance * currentPrice;
      
      // Calculate P&L in SOL, then convert to USD
      performance.unrealizedProfitSOL = currentValueSOL - costBasisSOL;
      performance.unrealizedProfitUSD = performance.unrealizedProfitSOL * latestTrade.solPriceUSD;
      
      console.log(`💎 [Unrealized P&L] ${performance.tokenSymbol || 'Token'}:`, {
        tokens: performance.currentTokenBalance.toFixed(2),
        avgEntrySOL: averageEntryPrice.toFixed(10),
        currentPriceSOL: currentPrice.toFixed(10),
        priceSource,
        costBasisSOL: costBasisSOL.toFixed(6),
        currentValueSOL: currentValueSOL.toFixed(6),
        unrealizedSOL: performance.unrealizedProfitSOL.toFixed(6),
        unrealizedUSD: performance.unrealizedProfitUSD.toFixed(2),
        solPriceUSD: latestTrade.solPriceUSD.toFixed(2)
      });
    } else {
      performance.unrealizedProfitSOL = 0;
      performance.unrealizedProfitUSD = 0;
    }

    // Calculate total profit
    // IMPORTANT: Fees are already deducted in realized P&L from individual trades
    // Do NOT subtract fees again here to avoid double-counting
    performance.totalProfitSOL = 
      performance.realizedProfitSOL + performance.unrealizedProfitSOL;
    performance.totalProfitUSD = 
      performance.realizedProfitUSD + performance.unrealizedProfitUSD;

    console.log('💰 [P&L Breakdown]:', {
      realizedSOL: performance.realizedProfitSOL.toFixed(6),
      unrealizedSOL: performance.unrealizedProfitSOL.toFixed(6),
      totalProfitSOL: performance.totalProfitSOL.toFixed(6),
      totalFeesSOL: performance.totalFeesSOL.toFixed(6),
      note: 'Fees already included in realized P&L from trades'
    });

    // Calculate profit percentage
    if (performance.totalInvestedSOL > 0) {
      performance.profitPercentage = 
        (performance.totalProfitSOL / performance.totalInvestedSOL) * 100;
    }

    // Calculate ROI: (Current Portfolio Value - Initial Investment) / Initial Investment * 100
    // Current Portfolio Value = Cash Balance + Current Value of Open Positions
    if (performance.initialBalanceSOL > 0) {
      // Calculate current token value at market price
      let currentTokenValueSOL = 0;
      if (performance.currentTokenBalance > 0) {
        const totalTokensBought = performance.trades
          .filter(t => t.type === 'buy')
          .reduce((sum, t) => sum + t.amountTokens, 0);
        const averageEntryPrice = totalTokensBought > 0 
          ? performance.totalInvestedSOL / totalTokensBought 
          : 0;
        const tokenPrice = performance.lastKnownTokenPrice || averageEntryPrice;
        currentTokenValueSOL = performance.currentTokenBalance * tokenPrice;
      }
      
      // Total current portfolio value in SOL
      const currentPortfolioValue = performance.currentBalanceSOL + currentTokenValueSOL;
      
      // ROI = (Current Value - Initial Value) / Initial Value * 100
      performance.roi = ((currentPortfolioValue - performance.initialBalanceSOL) / performance.initialBalanceSOL) * 100;
      
      // Calculate daily ROI
      const durationDays = (Date.now() - performance.startTime) / (1000 * 60 * 60 * 24);
      if (durationDays > 0) {
        performance.dailyROI = performance.roi / durationDays;
      }
      
      console.log('📊 [ROI Calculation]:', {
        initialBalanceSOL: performance.initialBalanceSOL.toFixed(4),
        currentBalanceSOL: performance.currentBalanceSOL.toFixed(4),
        currentTokenBalance: performance.currentTokenBalance.toFixed(2),
        tokenPrice: (performance.lastKnownTokenPrice || 0).toFixed(8),
        currentTokenValueSOL: currentTokenValueSOL.toFixed(4),
        currentPortfolioValue: currentPortfolioValue.toFixed(4),
        changeInValue: (currentPortfolioValue - performance.initialBalanceSOL).toFixed(4),
        roi: performance.roi.toFixed(2) + '%',
        calculation: `((${currentPortfolioValue.toFixed(4)} - ${performance.initialBalanceSOL.toFixed(4)}) / ${performance.initialBalanceSOL.toFixed(4)}) * 100`
      });
    }

    // Calculate average execution time
    if (performance.trades.length > 1) {
      const times = performance.trades.map((t, i) => 
        i > 0 ? t.timestamp - performance.trades[i - 1].timestamp : 0
      ).filter(t => t > 0);
      
      if (times.length > 0) {
        performance.averageExecutionTime = 
          times.reduce((a, b) => a + b, 0) / times.length;
      }
    }
    
    // Validate calculations for consistency
    this.validatePerformanceMetrics(performance);
  }
  
  /**
   * Validate performance metrics for consistency
   */
  private validatePerformanceMetrics(perf: StrategyPerformance): void {
    // Check 1: Total profit should equal realized + unrealized
    const expectedTotal = perf.realizedProfitSOL + perf.unrealizedProfitSOL;
    if (Math.abs(perf.totalProfitSOL - expectedTotal) > 0.000001) {
      console.error('❌ [VALIDATION] Total P&L mismatch:', {
        expected: expectedTotal.toFixed(6),
        actual: perf.totalProfitSOL.toFixed(6),
        difference: (perf.totalProfitSOL - expectedTotal).toFixed(6)
      });
    }
    
    // Check 2: ROI should reflect change in portfolio value
    let currentTokenValueSOL = 0;
    if (perf.currentTokenBalance > 0) {
      const totalTokensBought = perf.trades
        .filter(t => t.type === 'buy')
        .reduce((sum, t) => sum + t.amountTokens, 0);
      const averageEntryPrice = totalTokensBought > 0 
        ? perf.totalInvestedSOL / totalTokensBought 
        : 0;
      const tokenPrice = perf.lastKnownTokenPrice || averageEntryPrice;
      currentTokenValueSOL = perf.currentTokenBalance * tokenPrice;
    }
    const currentValue = perf.currentBalanceSOL + currentTokenValueSOL;
    const expectedROI = ((currentValue - perf.initialBalanceSOL) / perf.initialBalanceSOL) * 100;
    
    if (Math.abs(perf.roi - expectedROI) > 0.01) {
      console.error('❌ [VALIDATION] ROI mismatch:', {
        expected: expectedROI.toFixed(2) + '%',
        actual: perf.roi.toFixed(2) + '%',
        difference: (perf.roi - expectedROI).toFixed(2) + '%'
      });
    }
  }

  /**
   * Update current token price for unrealized P&L
   */
  async updateCurrentMetrics(strategyId: string): Promise<void> {
    const performance = this.performances.get(strategyId);
    if (!performance) return;

    await this.calculateMetrics(performance);
  }

  /**
   * Get strategy performance
   */
  getPerformance(strategyId: string): StrategyPerformance | null {
    return this.performances.get(strategyId) || null;
  }

  /**
   * Get all performances
   */
  getAllPerformances(): StrategyPerformance[] {
    return Array.from(this.performances.values());
  }

  /**
   * Mark strategy as completed
   */
  completeStrategy(strategyId: string): void {
    const performance = this.performances.get(strategyId);
    if (performance) {
      performance.status = 'completed';
      performance.endTime = Date.now();
      
      const duration = performance.endTime - performance.startTime;
      awsLogger.info('Strategy completed', { 
        metadata: { 
          strategyId, 
          duration,
          totalExecutions: performance.totalExecutions,
          totalProfitUSD: performance.totalProfitUSD.toFixed(2),
          roi: performance.roi.toFixed(2) + '%'
        } 
      });
    }
  }

  /**
   * Pause strategy tracking
   */
  pauseStrategy(strategyId: string): void {
    const performance = this.performances.get(strategyId);
    if (performance) {
      performance.status = 'paused';
      awsLogger.info('Strategy paused', { metadata: { strategyId } });
    }
  }

  /**
   * Resume strategy tracking
   */
  resumeStrategy(strategyId: string): void {
    const performance = this.performances.get(strategyId);
    if (performance) {
      performance.status = 'running';
      awsLogger.info('Strategy resumed', { metadata: { strategyId } });
    }
  }

  /**
   * Mark strategy as failed
   */
  failStrategy(strategyId: string, reason: string): void {
    const performance = this.performances.get(strategyId);
    if (performance) {
      performance.status = 'failed';
      performance.endTime = Date.now();
      awsLogger.error('Strategy failed', { 
        metadata: { strategyId, reason } 
      });
    }
  }

  /**
   * Generate detailed performance report
   */
  generateReport(strategyId: string): string {
    const perf = this.performances.get(strategyId);
    if (!perf) return 'Strategy not found';

    const duration = (perf.endTime || Date.now()) - perf.startTime;
    const durationHours = (duration / (1000 * 60 * 60)).toFixed(2);
    const durationDays = (duration / (1000 * 60 * 60 * 24)).toFixed(2);

    const profitEmoji = perf.totalProfitUSD > 0 ? '🟢' : perf.totalProfitUSD < 0 ? '🔴' : '⚪';

    return `
╔════════════════════════════════════════════════════════════════╗
║              STRATEGY PERFORMANCE REPORT                       ║
╚════════════════════════════════════════════════════════════════╝

📊 Strategy: ${perf.strategyName}
🆔 ID: ${perf.strategyId}
${perf.tokenSymbol ? `🪙 Token: ${perf.tokenSymbol}` : ''}
⏱️  Duration: ${durationHours} hours (${durationDays} days)
📈 Status: ${perf.status.toUpperCase()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 EXECUTION STATISTICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Total Executions:    ${perf.totalExecutions}
📥 Buy Executions:      ${perf.buyExecutions}
📤 Sell Executions:     ${perf.sellExecutions}
❌ Failed Executions:   ${perf.failedExecutions}
🎯 Success Rate:        ${perf.successRate.toFixed(2)}%
⏱️ Avg Execution Time: ${(perf.averageExecutionTime / 1000 / 60).toFixed(2)} minutes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 FINANCIAL SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 Initial Balance:     ${perf.initialBalanceSOL.toFixed(4)} SOL
💵 Current Balance:     ${perf.currentBalanceSOL.toFixed(4)} SOL
📊 Total Invested:      ${perf.totalInvestedSOL.toFixed(4)} SOL
💸 Total Returned:      ${perf.totalReturnedSOL.toFixed(4)} SOL
🪙 Current Tokens:      ${perf.currentTokenBalance.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PROFIT & LOSS ${profitEmoji}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Realized Profit:     ${perf.realizedProfitSOL.toFixed(4)} SOL ($${perf.realizedProfitUSD.toFixed(2)})
📈 Unrealized Profit:   ${perf.unrealizedProfitSOL.toFixed(4)} SOL ($${perf.unrealizedProfitUSD.toFixed(2)})
💵 Total Profit:        ${perf.totalProfitSOL.toFixed(4)} SOL ($${perf.totalProfitUSD.toFixed(2)})
📊 Profit Percentage:   ${perf.profitPercentage > 0 ? '+' : ''}${perf.profitPercentage.toFixed(2)}%
💰 ROI:                 ${perf.roi > 0 ? '+' : ''}${perf.roi.toFixed(2)}%
📅 Daily ROI:           ${perf.dailyROI > 0 ? '+' : ''}${perf.dailyROI.toFixed(2)}%
💸 Total Fees:          ${perf.totalFeesSOL.toFixed(4)} SOL ($${perf.totalFeesUSD.toFixed(2)})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 RECENT TRADES (Last 5)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${perf.trades.slice(-5).map((t, i) => `
${i + 1}. ${t.type.toUpperCase()}: ${t.amountSOL.toFixed(4)} SOL → ${t.amountTokens.toFixed(2)} tokens
   Price: $${t.priceUSD.toFixed(6)} | Fee: ${t.fees.totalFeeSOL.toFixed(6)} SOL
   Time: ${new Date(t.timestamp).toLocaleString()}
   TX: ${t.txSignature.substring(0, 30)}...
`).join('')}

${perf.trades.length === 0 ? '   No trades executed yet.' : ''}

╚════════════════════════════════════════════════════════════════╝

📊 Summary:
   • You executed ${perf.totalExecutions} trades (${perf.buyExecutions} buys, ${perf.sellExecutions} sells)
   • Your strategy ${perf.totalProfitUSD > 0 ? 'made' : 'lost'} $${Math.abs(perf.totalProfitUSD).toFixed(2)}
   • Success rate: ${perf.successRate.toFixed(2)}%
   • ROI: ${perf.roi > 0 ? '+' : ''}${perf.roi.toFixed(2)}%
`;
  }

  /**
   * Generate JSON summary for API
   */
  generateSummary(strategyId: string): any {
    const perf = this.performances.get(strategyId);
    if (!perf) return null;

    const duration = (perf.endTime || Date.now()) - perf.startTime;

    return {
      strategy: {
        id: perf.strategyId,
        name: perf.strategyName,
        status: perf.status,
        token: perf.tokenSymbol,
        duration: {
          milliseconds: duration,
          hours: (duration / (1000 * 60 * 60)).toFixed(2),
          days: (duration / (1000 * 60 * 60 * 24)).toFixed(2),
        }
      },
      executions: {
        total: perf.totalExecutions,
        buys: perf.buyExecutions,
        sells: perf.sellExecutions,
        failed: perf.failedExecutions,
        successRate: parseFloat(perf.successRate.toFixed(2)),
        avgExecutionTimeMinutes: parseFloat((perf.averageExecutionTime / 1000 / 60).toFixed(2)),
      },
      financials: {
        initialBalanceSOL: parseFloat(perf.initialBalanceSOL.toFixed(4)),
        currentBalanceSOL: parseFloat(perf.currentBalanceSOL.toFixed(4)),
        totalInvestedSOL: parseFloat(perf.totalInvestedSOL.toFixed(4)),
        totalReturnedSOL: parseFloat(perf.totalReturnedSOL.toFixed(4)),
        currentTokenBalance: parseFloat(perf.currentTokenBalance.toFixed(2)),
      },
      profitLoss: {
        realized: {
          sol: parseFloat(perf.realizedProfitSOL.toFixed(4)),
          usd: parseFloat(perf.realizedProfitUSD.toFixed(2)),
        },
        unrealized: {
          sol: parseFloat(perf.unrealizedProfitSOL.toFixed(4)),
          usd: parseFloat(perf.unrealizedProfitUSD.toFixed(2)),
        },
        total: {
          sol: parseFloat(perf.totalProfitSOL.toFixed(4)),
          usd: parseFloat(perf.totalProfitUSD.toFixed(2)),
        },
        percentage: parseFloat(perf.profitPercentage.toFixed(2)),
        roi: parseFloat(perf.roi.toFixed(2)),
        dailyROI: parseFloat(perf.dailyROI.toFixed(2)),
        fees: {
          sol: parseFloat(perf.totalFeesSOL.toFixed(4)),
          usd: parseFloat(perf.totalFeesUSD.toFixed(2)),
        },
      },
      trades: perf.trades.map(t => ({
        id: t.tradeId,
        type: t.type,
        timestamp: t.timestamp,
        amountSOL: parseFloat(t.amountSOL.toFixed(4)),
        amountTokens: parseFloat(t.amountTokens.toFixed(2)),
        priceUSD: parseFloat(t.priceUSD.toFixed(6)),
        txSignature: t.txSignature,
        fee: parseFloat(t.fees.totalFeeSOL.toFixed(6)),
      })),
    };
  }

  /**
   * Delete strategy performance data
   */
  deleteStrategy(strategyId: string): boolean {
    return this.performances.delete(strategyId);
  }
}

// Export singleton
export const strategyExecutionTracker = new StrategyExecutionTracker();
