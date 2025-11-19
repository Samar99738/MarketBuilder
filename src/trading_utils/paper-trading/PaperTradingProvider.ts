/**
 * Paper Trading Provider
 * Implements ITradingProvider interface but routes all trades through paper trading engine
 */

import { TradingProvider, TradingResult, PriceResult } from '../TradingProvider';
import { paperTradingEngine } from './PaperTradingEngine';
import { getTokenPriceUSD, getSolPriceUSD } from '../TokenUtils';
import { ENV_CONFIG } from '../../config/environment';

export class PaperTradingProvider implements TradingProvider {
  private sessionId: string;
  private strategyId: string;
  private strategyName: string;
  private tokenAddress?: string; // Store token address for price fetching

  constructor(sessionId: string, strategyId: string, strategyName: string, tokenAddress?: string) {
    this.sessionId = sessionId;
    this.strategyId = strategyId;
    this.strategyName = strategyName;
    this.tokenAddress = tokenAddress;
  }

  async initialize(): Promise<boolean> {
    return true;
  }

  /**
   * Simulate an initial virtual position for paper trading
   * Used for reactive sell strategies where user wants to start with tokens
   */
  async simulateInitialPosition(tokenAddress: string, amount: number): Promise<void> {
    try {
      console.log(`📦 [PaperTradingProvider] Creating initial virtual position:`);
      console.log(`   Token: ${tokenAddress.substring(0, 8)}...`);
      console.log(`   Amount: ${amount.toLocaleString()} tokens`);
      
      // Get session state
      const state = paperTradingEngine.getSession(this.sessionId);
      if (!state) {
        console.warn(`⚠️ [PaperTradingProvider] Session not found: ${this.sessionId}`);
        return;
      }
      
      // Fetch current price for tracking
      const currentPrice = await getTokenPriceUSD(tokenAddress);
      const solPrice = await getSolPriceUSD();
      const priceInSOL = currentPrice && solPrice && typeof currentPrice === 'number' && typeof solPrice === 'number' 
        ? currentPrice / solPrice 
        : 0;
      
      // Add position to portfolio Map with full PaperPosition structure
      const currentTimestamp = Date.now();
      const currentPriceUSD = currentPrice && typeof currentPrice === 'number' ? currentPrice : 0;
      
      const position: import('./types').PaperPosition = {
        tokenAddress,
        tokenSymbol: 'TOKEN', // Will be updated on first real fetch
        amount,
        averageEntryPrice: 0, // Zero cost - virtual airdrop
        totalInvestedSOL: 0,
        totalInvestedUSD: 0,
        currentPrice: priceInSOL,
        currentValueSOL: amount * priceInSOL,
        currentValueUSD: amount * currentPriceUSD,
        unrealizedPnL: 0, // No cost basis = no PnL
        unrealizedPnLPercentage: 0,
        firstTradeTimestamp: currentTimestamp,
        lastTradeTimestamp: currentTimestamp,
        tradeCount: 0 // No actual trades - just initial position
      };
      
      state.portfolio.positions.set(tokenAddress, position);
      state.portfolio.balanceTokens = amount;
      
      console.log(`✅ [PaperTradingProvider] Virtual position added successfully`);
      console.log(`   Price (SOL): ${priceInSOL.toFixed(9)}`);
    } catch (error) {
      console.error(`❌ [PaperTradingProvider] Failed to create initial position:`, error);
      // Don't throw - just log error and continue
    }
  }

  /**
   * Execute a paper buy order
   */
  async buyTokens(amountInSol: number, context?: any): Promise<string> {
    try {
      // FIX #5: Require explicit tokenAddress from context or constructor (no ENV_CONFIG fallback)
      const tokenAddress = context?.variables?.tokenAddress || this.tokenAddress;
      
      if (!tokenAddress || tokenAddress.length !== 44) {
        throw new Error(`[PaperTradingProvider] tokenAddress is required for buyTokens. Received: ${tokenAddress}`);
      }
      
      // Update stored token address if provided in context
      if (context?.variables?.tokenAddress && !this.tokenAddress) {
        this.tokenAddress = context.variables.tokenAddress;
      }
      
      //  ADD DETAILED LOGGING FOR BUY
      console.log(`[PaperTradingProvider]  BUY REQUEST RECEIVED:`, {
        amountInSol,
        sessionId: this.sessionId,
        strategyId: this.strategyId,
        strategyName: this.strategyName,
        tokenAddress: tokenAddress
      });
      
      //  VALIDATE AMOUNT
      if (!amountInSol || amountInSol <= 0) {
        throw new Error(`[PaperTradingProvider] Invalid buy amount: ${amountInSol}. Must be positive number.`);
      }

      //console.log(`Paper BUY: ${amountInSol} SOL (Session: ${this.sessionId})`);
      
      const result = await paperTradingEngine.executeBuy(
        this.sessionId,
        tokenAddress, // Use token from context
        amountInSol,
        this.strategyId,
        this.strategyName,
        'strategy_execution'
      );

      if (!result.success) {
        throw new Error(result.error || 'Paper buy failed');
      }

      // Return trade ID as signature
      const signature = result.trade?.id || `paper-buy-${Date.now()}`;
      //console.log(` Paper BUY executed: ${signature}, Amount: ${amountInSol} SOL`);
      
      return signature;
    } catch (error) {
      console.error(` Paper BUY failed:`, error);
      throw error;
    }
  }

  /**
   * Execute a paper sell order
   */
  async sellTokens(amountToSell: number, context?: any): Promise<string> {
    try {
      //  ADD MORE DETAILED LOGGING
      console.log(`[PaperTradingProvider] SELL REQUEST RECEIVED:`, {
        amountToSell,
        sessionId: this.sessionId,
        strategyId: this.strategyId,
        strategyName: this.strategyName,
        hasContext: !!context,
        contextVariables: context?.variables ? Object.keys(context.variables) : [],
        tokenAmountToSell: context?.variables?.tokenAmountToSell,
        sellAmountSOL: context?.variables?.sellAmountSOL
      });

      // Check if there's a dynamic token amount from DCA sell strategy
      let actualAmountToSell = amountToSell;
      
      if (context?.variables?.tokenAmountToSell && amountToSell === -1) {
        actualAmountToSell = context.variables.tokenAmountToSell;
        console.log(`[PaperTradingProvider] Using DYNAMIC sell amount from context:`, {
          originalAmount: amountToSell,
          dynamicAmount: actualAmountToSell,
          source: 'context.variables.tokenAmountToSell'
        });
      } else if (amountToSell === -1) {
        console.log(`[PaperTradingProvider] Selling ALL tokens (amountToSell = -1, no dynamic amount in context)`);
      } else {
        console.log(`[PaperTradingProvider] Using STATIC sell amount:`, {
          amount: actualAmountToSell,
          source: 'step configuration'
        });
      }

      // VALIDATE AMOUNT
      if (actualAmountToSell === 0) {
        throw new Error(`[PaperTradingProvider] Invalid sell amount: 0. Must be -1 (all) or positive number.`);
      }
      if (actualAmountToSell < -1) {
        throw new Error(`[PaperTradingProvider] Invalid sell amount: ${actualAmountToSell}. Must be -1 (all) or positive number.`);
      }

      // FIX #5: Require explicit tokenAddress from context or constructor (no ENV_CONFIG fallback)
      const tokenAddress = context?.variables?.tokenAddress || this.tokenAddress;
      
      console.log(`[PaperTradingProvider] sellTokens - tokenAddress check:`, {
        fromContext: context?.variables?.tokenAddress,
        fromThis: this.tokenAddress,
        final: tokenAddress,
        finalLength: tokenAddress?.length,
        finalType: typeof tokenAddress
      });
      
      if (!tokenAddress || (typeof tokenAddress === 'string' && tokenAddress.length < 32)) {
        throw new Error(`[PaperTradingProvider] tokenAddress is required for sellTokens. Received: ${tokenAddress} (length: ${tokenAddress?.length})`);
      }
      
      // Update stored token address if provided in context
      if (context?.variables?.tokenAddress && !this.tokenAddress) {
        this.tokenAddress = context.variables.tokenAddress;
      }
      
      console.log(`[PaperTradingProvider] Calling paperTradingEngine.executeSell with:`, {
        sessionId: this.sessionId,
        tokenAddress: tokenAddress,
        actualAmountToSell,
        strategyId: this.strategyId,
        strategyName: this.strategyName
      });

      const result = await paperTradingEngine.executeSell(
        this.sessionId,
        tokenAddress,
        actualAmountToSell,
        this.strategyId,
        this.strategyName,
        'strategy_execution'
      );

      if (!result.success) {
        console.error(`[PaperTradingProvider] executeSell failed:`, {
          error: result.error,
          insufficientBalance: result.insufficientBalance
        });
        throw new Error(result.error || 'Paper sell failed');
      }

      const signature = result.trade?.id || `paper-sell-${Date.now()}`;
      console.log(`[PaperTradingProvider] Paper SELL executed successfully:`, {
        signature,
        amountSold: actualAmountToSell,
        tradeId: result.trade?.id
      });

      return signature;
    } catch (error) {
      console.error(`[PaperTradingProvider] Paper SELL failed:`, error);
      throw error;
    }
  }

  /**
   * Get token price (uses real market data)
   */
  async getTokenPriceUSD(): Promise<PriceResult> {
    // FIX #5: Require explicit tokenAddress from constructor (no ENV_CONFIG fallback)
    const tokenAddress = this.tokenAddress;
    
    if (!tokenAddress || tokenAddress.length !== 44) {
      throw new Error(`[PaperTradingProvider] tokenAddress is required for getTokenPriceUSD. Received: ${tokenAddress}`);
    }
    const result = await getTokenPriceUSD(tokenAddress);
    return {
      price: result.price,
      source: result.source,
      timestamp: Date.now(),
    };
  }

  /**
   * Get Jupiter token price (uses real market data)
   */
  async getJupiterTokenPrice(): Promise<PriceResult> {
    // FIX #5: Require explicit tokenAddress from constructor (no ENV_CONFIG fallback)
    const tokenAddress = this.tokenAddress;
    
    if (!tokenAddress || tokenAddress.length !== 44) {
      throw new Error(`[PaperTradingProvider] tokenAddress is required for getJupiterTokenPrice. Received: ${tokenAddress}`);
    }
    const result = await getTokenPriceUSD(tokenAddress);
    return {
      price: result.price,
      source: 'jupiter',
      timestamp: Date.now(),
    };
  }

  /**
   * Get SOL price (uses real market data)
   */
  async getSolPriceUSD(): Promise<PriceResult> {
    const price = await getSolPriceUSD();
    return {
      price: price, // getSolPriceUSD returns just a number
      source: 'coingecko',
      timestamp: Date.now(),
    };
  }

  /**
   * Wait for price above target
   */
  async waitForPriceAbove(
    targetPrice: number,
    checkIntervalMs: number = 5000,
    timeoutMs: number = 300000
  ): Promise<TradingResult> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const priceResult = await this.getTokenPriceUSD();
      
      if (priceResult.price > targetPrice) {
        return {
          success: true,
          data: { price: priceResult.price },
          message: `Price ${priceResult.price} exceeded target ${targetPrice}`,
        };
      }

      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }

    return {
      success: false,
      message: `Timeout: Price did not reach ${targetPrice} within ${timeoutMs}ms`,
    };
  }

  /**
   * Wait for price below target
   */
  async waitForPriceBelow(
    targetPrice: number,
    checkIntervalMs: number = 5000,
    timeoutMs: number = 300000
  ): Promise<TradingResult> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const priceResult = await this.getTokenPriceUSD();
      
      if (priceResult.price < targetPrice) {
        return {
          success: true,
          data: { price: priceResult.price },
          message: `Price ${priceResult.price} below target ${targetPrice}`,
        };
      }

      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }

    return {
      success: false,
      message: `Timeout: Price did not reach ${targetPrice} within ${timeoutMs}ms`,
    };
  }

  /**
   * Get provider name
   */
  getProviderName(): string {
    return 'PaperTradingProvider';
  }

  /**
   * Check if provider is initialized
   */
  isInitialized(): boolean {
    return true;
  }

  /**
   * Clear price cache (no-op for paper trading)
   */
  clearPriceCache(): void {
    // Paper trading uses live prices, no cache to clear
  }
}