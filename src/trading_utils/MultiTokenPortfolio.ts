/**
 * Multi-Token Portfolio Manager
 * Enable trading multiple tokens simultaneously with correlation tracking
 */

import { awsLogger } from '../aws/logger';
import { realTimePriceService, PriceUpdate } from './RealTimePriceService';

export interface TokenPosition {
  tokenAddress: string;
  amountHeld: number;
  avgBuyPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  totalInvested: number;
  lastUpdate: number;
}

export interface PortfolioMetrics {
  totalValueSOL: number;
  totalValueUSD: number;
  totalInvestedSOL: number;
  totalPnLSOL: number;
  totalPnLPercent: number;
  positions: TokenPosition[];
  diversificationScore: number; // 0-1, higher is better
  correlation: number; // Average correlation between positions
}

export interface PortfolioAllocation {
  tokenAddress: string;
  targetPercent: number;
  currentPercent: number;
  needsRebalance: boolean;
  suggestedAction?: 'buy' | 'sell' | 'hold';
  suggestedAmount?: number;
}

/**
 * Multi-Token Portfolio Manager
 */
export class MultiTokenPortfolio {
  private positions: Map<string, TokenPosition> = new Map();
  private priceSubscriptions: Map<string, () => void> = new Map();
  private correlationMatrix: Map<string, Map<string, number>> = new Map();
  private maxPositions: number;
  private rebalanceThreshold: number; // % deviation before rebalancing
  
  constructor(maxPositions: number = 10, rebalanceThreshold: number = 10) {
    this.maxPositions = maxPositions;
    this.rebalanceThreshold = rebalanceThreshold;
    
    awsLogger.info('MultiTokenPortfolio initialized', {
      metadata: { maxPositions, rebalanceThreshold }
    });
  }

  /**
   * Add token to portfolio
   */
  async addToken(
    tokenAddress: string,
    amountHeld: number,
    avgBuyPrice: number
  ): Promise<void> {
    if (this.positions.size >= this.maxPositions) {
      throw new Error(`Portfolio full (max ${this.maxPositions} tokens)`);
    }
    
    const position: TokenPosition = {
      tokenAddress,
      amountHeld,
      avgBuyPrice,
      currentPrice: avgBuyPrice,
      unrealizedPnL: 0,
      realizedPnL: 0,
      totalInvested: amountHeld * avgBuyPrice,
      lastUpdate: Date.now()
    };
    
    this.positions.set(tokenAddress, position);
    
    // Subscribe to price updates
    const unsubscribe = realTimePriceService.subscribe(tokenAddress, (update) => {
      this.handlePriceUpdate(update);
    });
    
    this.priceSubscriptions.set(tokenAddress, unsubscribe);
    
    awsLogger.info('Token added to portfolio', {
      metadata: { tokenAddress, amountHeld, avgBuyPrice }
    });
  }

  /**
   * Remove token from portfolio
   */
  removeToken(tokenAddress: string): void {
    // Unsubscribe from price updates
    const unsubscribe = this.priceSubscriptions.get(tokenAddress);
    if (unsubscribe) {
      unsubscribe();
      this.priceSubscriptions.delete(tokenAddress);
    }
    
    this.positions.delete(tokenAddress);
    
    awsLogger.info('Token removed from portfolio', {
      metadata: { tokenAddress }
    });
  }

  /**
   * Update position after buy/sell
   */
  updatePosition(
    tokenAddress: string,
    action: 'buy' | 'sell',
    amount: number,
    price: number
  ): void {
    let position = this.positions.get(tokenAddress);
    
    if (!position && action === 'buy') {
      // Create new position
      this.addToken(tokenAddress, amount, price);
      return;
    }
    
    if (!position) {
      throw new Error(`Position not found: ${tokenAddress}`);
    }
    
    if (action === 'buy') {
      // Calculate new average buy price
      const totalInvested = position.totalInvested + (amount * price);
      const totalAmount = position.amountHeld + amount;
      position.avgBuyPrice = totalInvested / totalAmount;
      position.amountHeld = totalAmount;
      position.totalInvested = totalInvested;
    } else {
      // Sell
      const soldValue = amount * price;
      const costBasis = amount * position.avgBuyPrice;
      const realizedPnL = soldValue - costBasis;
      
      position.amountHeld -= amount;
      position.realizedPnL += realizedPnL;
      position.totalInvested -= costBasis;
      
      // Remove position if fully sold
      if (position.amountHeld <= 0) {
        this.removeToken(tokenAddress);
        return;
      }
    }
    
    position.lastUpdate = Date.now();
    this.positions.set(tokenAddress, position);
  }

  /**
   * Handle price update
   */
  private handlePriceUpdate(update: PriceUpdate): void {
    const position = this.positions.get(update.tokenAddress);
    if (!position) return;
    
    position.currentPrice = update.priceInSOL || update.price;
    position.unrealizedPnL = (position.currentPrice - position.avgBuyPrice) * position.amountHeld;
    position.lastUpdate = Date.now();
    
    this.positions.set(update.tokenAddress, position);
  }

  /**
   * Get portfolio metrics
   */
  getMetrics(): PortfolioMetrics {
    const positions = Array.from(this.positions.values());
    
    const totalValueSOL = positions.reduce(
      (sum, p) => sum + (p.currentPrice * p.amountHeld),
      0
    );
    
    const totalInvestedSOL = positions.reduce(
      (sum, p) => sum + p.totalInvested,
      0
    );
    
    const totalPnLSOL = positions.reduce(
      (sum, p) => sum + p.unrealizedPnL + p.realizedPnL,
      0
    );
    
    const totalPnLPercent = totalInvestedSOL > 0
      ? (totalPnLSOL / totalInvestedSOL) * 100
      : 0;
    
    // Calculate diversification score (simplified)
    const diversificationScore = positions.length > 0
      ? Math.min(positions.length / this.maxPositions, 1.0)
      : 0;
    
    // Calculate average correlation (placeholder - would need historical data)
    const correlation = 0; // Implement with historical price data
    
    return {
      totalValueSOL,
      totalValueUSD: 0, // Would need SOL/USD price
      totalInvestedSOL,
      totalPnLSOL,
      totalPnLPercent,
      positions,
      diversificationScore,
      correlation
    };
  }

  /**
   * Get position for a token
   */
  getPosition(tokenAddress: string): TokenPosition | null {
    return this.positions.get(tokenAddress) || null;
  }

  /**
   * Get all positions
   */
  getAllPositions(): TokenPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Calculate portfolio allocations
   */
  getPortfolioAllocations(): PortfolioAllocation[] {
    const metrics = this.getMetrics();
    const allocations: PortfolioAllocation[] = [];
    
    for (const position of metrics.positions) {
      const positionValue = position.currentPrice * position.amountHeld;
      const currentPercent = (positionValue / metrics.totalValueSOL) * 100;
      
      // Equal weight target allocation
      const targetPercent = 100 / metrics.positions.length;
      
      const deviation = Math.abs(currentPercent - targetPercent);
      const needsRebalance = deviation > this.rebalanceThreshold;
      
      let suggestedAction: 'buy' | 'sell' | 'hold' = 'hold';
      let suggestedAmount: number | undefined;
      
      if (needsRebalance) {
        if (currentPercent > targetPercent) {
          suggestedAction = 'sell';
          const excessValue = (currentPercent - targetPercent) / 100 * metrics.totalValueSOL;
          suggestedAmount = excessValue / position.currentPrice;
        } else {
          suggestedAction = 'buy';
          const deficitValue = (targetPercent - currentPercent) / 100 * metrics.totalValueSOL;
          suggestedAmount = deficitValue / position.currentPrice;
        }
      }
      
      allocations.push({
        tokenAddress: position.tokenAddress,
        targetPercent,
        currentPercent,
        needsRebalance,
        suggestedAction,
        suggestedAmount
      });
    }
    
    return allocations;
  }

  /**
   * Get portfolio report
   */
  getPortfolioReport(): string {
    const metrics = this.getMetrics();
    
    let report = `
📊 **MULTI-TOKEN PORTFOLIO REPORT**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Portfolio Summary:**
• Total Value: ${metrics.totalValueSOL.toFixed(4)} SOL
• Total Invested: ${metrics.totalInvestedSOL.toFixed(4)} SOL
• Total P&L: ${metrics.totalPnLSOL.toFixed(4)} SOL (${metrics.totalPnLPercent.toFixed(2)}%)
• Number of Positions: ${metrics.positions.length}
• Diversification Score: ${(metrics.diversificationScore * 100).toFixed(0)}%

**Individual Positions:**

`;

    for (const position of metrics.positions) {
      const pnlPercent = ((position.unrealizedPnL / position.totalInvested) * 100).toFixed(2);
      const pnlIcon = position.unrealizedPnL >= 0 ? '📈' : '📉';
      
      report += `${pnlIcon} **${position.tokenAddress.substring(0, 8)}...**\n`;
      report += `   Amount: ${position.amountHeld.toFixed(2)} tokens\n`;
      report += `   Avg Buy: ${position.avgBuyPrice.toFixed(6)} SOL\n`;
      report += `   Current: ${position.currentPrice.toFixed(6)} SOL\n`;
      report += `   P&L: ${position.unrealizedPnL.toFixed(4)} SOL (${pnlPercent}%)\n\n`;
    }
    
    // Add rebalancing suggestions
    const allocations = this.getPortfolioAllocations();
    const needsRebalance = allocations.some(a => a.needsRebalance);
    
    if (needsRebalance) {
      report += `\n⚖️ **Rebalancing Suggestions:**\n\n`;
      
      for (const alloc of allocations.filter(a => a.needsRebalance)) {
        const action = alloc.suggestedAction === 'buy' ? '🟢 BUY' : '🔴 SELL';
        report += `${action} ${alloc.tokenAddress.substring(0, 8)}: ${alloc.suggestedAmount?.toFixed(2)} tokens\n`;
        report += `   Current: ${alloc.currentPercent.toFixed(1)}% | Target: ${alloc.targetPercent.toFixed(1)}%\n\n`;
      }
    }
    
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return report;
  }

  /**
   * Shutdown portfolio (cleanup subscriptions)
   */
  shutdown(): void {
    for (const unsubscribe of this.priceSubscriptions.values()) {
      unsubscribe();
    }
    
    this.priceSubscriptions.clear();
    this.positions.clear();
    
    awsLogger.info('MultiTokenPortfolio shutdown complete');
  }
}

// Export singleton
export const multiTokenPortfolio = new MultiTokenPortfolio(10, 10);

