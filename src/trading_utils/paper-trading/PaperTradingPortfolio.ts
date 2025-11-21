/**
 * Paper Trading Portfolio Manager
 * 
 * Manages virtual balances, positions, P&L tracking, and performance metrics
 */

import {
  PaperPortfolio,
  PaperPosition,
  PaperTrade,
  PaperTradingMetrics,
} from './types';
import { marketDataProvider } from './MarketDataProvider';
import { awsLogger } from '../../aws/logger';

export class PaperTradingPortfolio {
  private portfolio: PaperPortfolio;
  private trades: PaperTrade[] = [];
  private startTime: number;

  constructor(initialBalanceSOL: number, initialBalanceUSDC: number = 0) {
    // Don't hardcode SOL price - will be updated with first trade
    // Use a reasonable estimate for now, but it will be corrected on first price fetch
    const estimatedSolPrice = 200;

    this.portfolio = {
      balanceSOL: initialBalanceSOL,
      balanceUSDC: initialBalanceUSDC,
      balanceTokens: 0,
      positions: new Map(),
      totalValueSOL: initialBalanceSOL,
      totalValueUSD: initialBalanceSOL * estimatedSolPrice + initialBalanceUSDC,
      initialBalanceSOL,
      initialBalanceUSD: initialBalanceSOL * estimatedSolPrice + initialBalanceUSDC,
    };

    this.startTime = Date.now();
  }

  /**
   * Get current portfolio snapshot
   */
  getPortfolio(): PaperPortfolio {
    return { ...this.portfolio, positions: new Map(this.portfolio.positions) };
  }

  /**
   * Get all trades
   */
  getTrades(): PaperTrade[] {
    return [...this.trades];
  }

  /**
   * Add a new trade and update portfolio
   */
  addTrade(trade: PaperTrade): void {
    // On first trade, correct the initial balance USD with actual SOL price
    if (this.trades.length === 0 && trade.solPriceUSD) {
      this.portfolio.initialBalanceUSD = this.portfolio.initialBalanceSOL * trade.solPriceUSD + this.portfolio.balanceUSDC;
      this.portfolio.totalValueUSD = this.portfolio.initialBalanceUSD;
    }

    this.trades.push(trade);

    // Update balances
    this.portfolio.balanceSOL = trade.balanceSOL;
    this.portfolio.balanceUSDC = trade.balanceUSDC;
    this.portfolio.balanceTokens = trade.balanceTokens;

    // Update or create position
    if (trade.type === 'buy') {
      this.addToPosition(trade);
    } else if (trade.type === 'sell') {
      this.reducePosition(trade);
    }

    // Update total portfolio value
    this.updatePortfolioValue(trade.solPriceUSD);
  }

  /**
   * Add to or create a position
   */
  private addToPosition(trade: PaperTrade): void {
    const existing = this.portfolio.positions.get(trade.tokenAddress);

    if (existing) {
      // Update existing position - calculate new average entry price
      const totalTokens = existing.amount + trade.amountTokens;
      const totalInvested = existing.totalInvestedSOL + trade.amountSOL;

      existing.amount = totalTokens;
      existing.averageEntryPrice = totalInvested / totalTokens;
      existing.totalInvestedSOL = totalInvested;
      existing.totalInvestedUSD = totalInvested * trade.solPriceUSD;
      existing.currentPrice = trade.executionPrice;
      existing.currentValueSOL = totalTokens * trade.executionPrice;
      existing.currentValueUSD = existing.currentValueSOL * trade.solPriceUSD;
      existing.unrealizedPnL = existing.currentValueSOL - existing.totalInvestedSOL;
      existing.unrealizedPnLPercentage = (existing.unrealizedPnL / existing.totalInvestedSOL) * 100;
      existing.lastTradeTimestamp = trade.timestamp;
      existing.tradeCount += 1;
    } else {
      // Create new position
      const position: PaperPosition = {
        tokenAddress: trade.tokenAddress,
        tokenSymbol: trade.tokenSymbol || 'UNKNOWN',
        amount: trade.amountTokens,
        averageEntryPrice: trade.executionPrice,
        totalInvestedSOL: trade.amountSOL,
        totalInvestedUSD: trade.amountSOL * trade.solPriceUSD,
        currentPrice: trade.executionPrice,
        currentValueSOL: trade.amountTokens * trade.executionPrice,
        currentValueUSD: trade.amountTokens * trade.executionPrice * trade.solPriceUSD,
        unrealizedPnL: 0,
        unrealizedPnLPercentage: 0,
        firstTradeTimestamp: trade.timestamp,
        lastTradeTimestamp: trade.timestamp,
        tradeCount: 1,
      };
      this.portfolio.positions.set(trade.tokenAddress, position);
    }
  }

  /**
   * Reduce or close a position
   */
  private reducePosition(trade: PaperTrade): void {
    const position = this.portfolio.positions.get(trade.tokenAddress);

    if (!position) {
      console.warn(`Attempted to sell token with no position: ${trade.tokenAddress}`);
      return;
    }

    // Calculate realized P&L from this sale
    const soldTokens = trade.amountTokens;
    const avgCostPerToken = position.averageEntryPrice;
    const costBasis = soldTokens * avgCostPerToken;
    const proceeds = trade.amountSOL;
    const realizedPnL = proceeds - costBasis;

    console.log(`\n💰 [P&L CALCULATION] ${trade.tokenSymbol || 'TOKEN'} SELL`);
    console.log(`📊 Sold: ${soldTokens.toLocaleString()} tokens`);
    console.log(`💵 Avg Cost: ${avgCostPerToken.toFixed(10)} SOL/token`);
    console.log(`📉 Total Cost Basis: ${costBasis.toFixed(6)} SOL`);
    console.log(`💰 Proceeds (after fees): ${proceeds.toFixed(6)} SOL`);
    console.log(`${realizedPnL >= 0 ? '📈' : '📉'} Realized P&L: ${realizedPnL.toFixed(6)} SOL (${realizedPnL >= 0 ? 'PROFIT ✅' : 'LOSS ❌'})`);
    console.log(`📊 P&L %: ${((realizedPnL / costBasis) * 100).toFixed(2)}%\n`);

    // Update trade with realized P&L
    trade.realizedPnL = realizedPnL;

    // Update position
    position.amount -= soldTokens;
    position.currentPrice = trade.executionPrice;
    position.lastTradeTimestamp = trade.timestamp;
    position.tradeCount += 1;

    if (position.amount <= 0) {
      // Close position completely
      this.portfolio.positions.delete(trade.tokenAddress);
    } else {
      // Update remaining position
      position.currentValueSOL = position.amount * trade.executionPrice;
      position.currentValueUSD = position.currentValueSOL * trade.solPriceUSD;
      position.unrealizedPnL = position.currentValueSOL - (position.amount * position.averageEntryPrice);
      position.unrealizedPnLPercentage = (position.unrealizedPnL / (position.amount * position.averageEntryPrice)) * 100;
    }
  }

  /**
   * Update portfolio value based on current prices
   */
  private async updatePortfolioValue(solPriceUSD: number): Promise<void> {
    let totalPositionValueSOL = 0;

    for (const [tokenAddress, position] of this.portfolio.positions) {
      // Update position with current market price
      const marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);

      if (marketData) {
        position.currentPrice = marketData.price;
        position.currentValueSOL = position.amount * marketData.price;
        position.currentValueUSD = position.currentValueSOL * solPriceUSD;
        position.unrealizedPnL = position.currentValueSOL - position.totalInvestedSOL;
        position.unrealizedPnLPercentage = (position.unrealizedPnL / position.totalInvestedSOL) * 100;
      }
      totalPositionValueSOL += position.currentValueSOL;
    }

    this.portfolio.totalValueSOL = this.portfolio.balanceSOL + totalPositionValueSOL;
    // Include USDC balance in total USD value
    this.portfolio.totalValueUSD = (this.portfolio.totalValueSOL * solPriceUSD) + this.portfolio.balanceUSDC;
  }

  /**
   * Refresh all positions with current market prices
   */
  async refreshPositions(): Promise<void> {
    const solPrice = await marketDataProvider.fetchSolPrice();
    await this.updatePortfolioValue(solPrice);
  }

  /**
   * Get position for a specific token
   */
  getPosition(tokenAddress: string): PaperPosition | undefined {
    return this.portfolio.positions.get(tokenAddress);
  }

  /**
   * Get all open positions
   */
  getAllPositions(): PaperPosition[] {
    return Array.from(this.portfolio.positions.values());
  }

  /**
   * Calculate comprehensive performance metrics
   */
  async calculateMetrics(strategyId?: string, strategyName?: string): Promise<PaperTradingMetrics> {
    await this.refreshPositions();

    const solPrice = await marketDataProvider.fetchSolPrice();
    const buyTrades = this.trades.filter(t => t.type === 'buy');
    const sellTrades = this.trades.filter(t => t.type === 'sell');

    // Calculate realized P&L
    const realizedPnL = sellTrades.reduce((sum, trade) => sum + (trade.realizedPnL || 0), 0);
    const realizedPnLUSD = realizedPnL * solPrice;

    // Calculate unrealized P&L
    let unrealizedPnL = 0;
    for (const position of this.portfolio.positions.values()) {
      unrealizedPnL += position.unrealizedPnL;
    }
    const unrealizedPnLUSD = unrealizedPnL * solPrice;

    // Total P&L (USD values already converted above)
    const totalPnL = realizedPnL + unrealizedPnL;
    const totalPnLUSD = realizedPnLUSD + unrealizedPnLUSD;

    // Calculate fees
    const totalFees = this.trades.reduce((sum, t) => sum + t.tradingFee + t.networkFee, 0);
    const totalFeesUSD = totalFees * solPrice;
    const totalSlippage = this.trades.reduce((sum, t) => sum + t.slippage, 0);

    // Win/Loss analysis
    const profitableTrades = sellTrades.filter(t => (t.realizedPnL || 0) > 0);
    const losingTrades = sellTrades.filter(t => (t.realizedPnL || 0) <= 0 && t.realizedPnL !== undefined);

    const winningTrades = profitableTrades.length;
    const losingTradesCount = losingTrades.length;

    // Calculate winRate based on completed trades (buys + sells)
    // If we have NO sell trades yet, show 0% winRate (not undefined/NaN)
    // If we have sell trades, calculate based on profitable vs losing sells
    const winRate = sellTrades.length > 0 ? (winningTrades / sellTrades.length) * 100 : 0;

    console.log('📊 [Portfolio Metrics] Win/Loss Analysis:', {
      totalTrades: this.trades.length,
      buyTrades: buyTrades.length,
      sellTrades: sellTrades.length,
      profitableTrades: profitableTrades.length,
      profitableTradesList: profitableTrades.map(t => ({
        id: t.id.substring(0, 8),
        realizedPnL: t.realizedPnL?.toFixed(6)
      })),
      losingTrades: losingTrades.length,
      losingTradesList: losingTrades.map(t => ({
        id: t.id.substring(0, 8),
        realizedPnL: t.realizedPnL?.toFixed(6)
      })),
      winRate: winRate.toFixed(2) + '%',
      sellTradesWithPnL: sellTrades.map(t => ({
        id: t.id.substring(0, 8),
        realizedPnL: t.realizedPnL,
        isProfitable: (t.realizedPnL || 0) > 0
      }))
    });

    const averageWin = winningTrades > 0 ? profitableTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0) / winningTrades : 0;

    const averageLoss = losingTradesCount > 0 ? Math.abs(losingTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0) / losingTradesCount) : 0;

    // Improved Profit Factor calculation
    // Profit Factor = Total Winning $ / Total Losing $
    // If no losing trades, profit factor is infinite (cap at 999)
    // If no winning trades, profit factor is 0
    const totalWinAmount = profitableTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
    const totalLossAmount = Math.abs(losingTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0));

    let profitFactor = 0;
    if (winningTrades > 0 && losingTradesCount === 0) {
      profitFactor = 999; // All winning trades, cap at 999
    } else if (totalLossAmount > 0) {
      profitFactor = totalWinAmount / totalLossAmount;
    }

    console.log('💰 [Portfolio Metrics] Profit Analysis:', {
      averageWin: averageWin.toFixed(6),
      averageLoss: averageLoss.toFixed(6),
      totalWinAmount: totalWinAmount.toFixed(6),
      totalLossAmount: totalLossAmount.toFixed(6),
      profitFactor: profitFactor.toFixed(2),
      winningTrades,
      losingTradesCount
    });

    // Calculate percentages
    const initialValueUSD = this.portfolio.initialBalanceUSD;
    const realizedPnLPercentage = (realizedPnLUSD / initialValueUSD) * 100;
    const unrealizedPnLPercentage = (unrealizedPnLUSD / initialValueUSD) * 100;
    const totalPnLPercentage = (totalPnLUSD / initialValueUSD) * 100;

    // ROI
    const roi = ((this.portfolio.totalValueUSD - this.portfolio.initialBalanceUSD) / this.portfolio.initialBalanceUSD) * 100;

    // Time-based metrics
    const duration = Date.now() - this.startTime;
    const daysElapsed = duration / (1000 * 60 * 60 * 24);
    const dailyROI = daysElapsed > 0 ? roi / daysElapsed : 0;
    const roiAnnualized = daysElapsed > 0 ? (roi / daysElapsed) * 365 : 0;

    const averageTradeInterval = this.trades.length > 1 ? duration / (this.trades.length - 1) : 0;

    // Max drawdown calculation (simplified)
    let maxDrawdown = 0;
    let peak = this.portfolio.initialBalanceSOL;

    for (const trade of this.trades) {
      const currentValue = trade.balanceSOL;
      if (currentValue > peak) {
        peak = currentValue;
      }
      const drawdown = ((peak - currentValue) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    const metrics: PaperTradingMetrics = {
      // Overall
      totalTrades: this.trades.length,
      buyTrades: buyTrades.length,
      sellTrades: sellTrades.length,

      // Financial
      initialBalanceSOL: this.portfolio.initialBalanceSOL,
      initialBalanceUSD: this.portfolio.initialBalanceUSD,
      currentBalanceSOL: this.portfolio.balanceSOL,
      currentBalanceUSD: this.portfolio.balanceUSDC,
      totalValueSOL: this.portfolio.totalValueSOL,
      totalValueUSD: this.portfolio.totalValueUSD,

      // P&L
      realizedPnL,
      realizedPnLUSD,
      unrealizedPnL,
      unrealizedPnLUSD,
      totalPnL,
      totalPnLUSD,

      // Percentages
      realizedPnLPercentage,
      unrealizedPnLPercentage,
      totalPnLPercentage,

      // Fees
      totalFees,
      totalFeesUSD,
      totalSlippage,

      // Performance
      winningTrades,
      losingTrades: losingTradesCount,
      winRate,
      averageWin,
      averageLoss,
      profitFactor,
      maxDrawdown,

      // Timing
      startTime: this.startTime,
      duration,
      averageTradeInterval,

      // ROI
      roi,
      roiAnnualized,
      dailyROI,

      // Strategy info
      strategyId,
      strategyName,
    };

    return metrics;
  }

  /**
   * Check if sufficient balance for trade
   */
  hasSufficientBalance(amountSOL: number): boolean {
    return this.portfolio.balanceSOL >= amountSOL;
  }

  /**
   * Reset portfolio to initial state
   */
  reset(initialBalanceSOL: number, initialBalanceUSDC: number = 0): void {
    const solPrice = 200; // Will be updated dynamically

    this.portfolio = {
      balanceSOL: initialBalanceSOL,
      balanceUSDC: initialBalanceUSDC,
      balanceTokens: 0,
      positions: new Map(),
      totalValueSOL: initialBalanceSOL,
      totalValueUSD: initialBalanceSOL * solPrice,
      initialBalanceSOL,
      initialBalanceUSD: initialBalanceSOL * solPrice + initialBalanceUSDC,
    };

    this.trades = [];
    this.startTime = Date.now();
  }

  /**
   * Export portfolio state for persistence
   */
  exportState(): any {
    return {
      portfolio: {
        ...this.portfolio,
        positions: Array.from(this.portfolio.positions.entries()),
      },
      trades: this.trades,
      startTime: this.startTime,
    };
  }

  /**
   * Import portfolio state from persistence
   */
  importState(state: any): void {
    this.portfolio = {
      balanceSOL: state.portfolio.balanceSOL,
      balanceUSDC: state.portfolio.balanceUSDC,
      balanceTokens: state.portfolio.balanceTokens || 0,
      positions: new Map(state.portfolio.positions),
      totalValueSOL: state.portfolio.totalValueSOL,
      totalValueUSD: state.portfolio.totalValueUSD,
      initialBalanceSOL: state.portfolio.initialBalanceSOL,
      initialBalanceUSD: state.portfolio.initialBalanceUSD,
    };
    this.trades = state.trades || [];
    this.startTime = state.startTime || Date.now();
  }
}
