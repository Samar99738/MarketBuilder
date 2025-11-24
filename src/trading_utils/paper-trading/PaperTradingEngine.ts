/**
 * Paper Trading Engine
 * 
 * Core engine for simulating trades with real-time market data
 * Handles order execution, slippage simulation, fee calculation, and logging
 */

import { v4 as uuidv4 } from 'uuid';
import type { Server as SocketServer } from 'socket.io';
import {
  PaperTradingConfig,
  PaperTrade,
  PaperTradingState,
  PaperTradingMode,
  OrderExecutionResult,
  PaperTradingLog,
  PaperTradingMetrics,
} from './types';
import { PaperTradingPortfolio } from './PaperTradingPortfolio';
import { marketDataProvider } from './MarketDataProvider';
import { awsLogger } from '../../aws/logger';
import { ENV_CONFIG } from '../../config/environment';
import { timeStamp } from 'console';
import { date, symbol } from 'zod';
import { token } from '@coral-xyz/anchor/dist/cjs/utils';

const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';

export class PaperTradingEngine {
  private sessions: Map<string, PaperTradingState> = new Map();
  private logs: Map<string, PaperTradingLog[]> = new Map();
  private io: SocketServer | null = null; // WebSocket server for real-time updates
  private periodicUpdateInterval: NodeJS.Timeout | null = null;
  private defaultConfig: PaperTradingConfig = {
    enabled: false,
    initialBalanceSOL: 10,
    initialBalanceUSDC: 1000, // User starts with $1000 USD
    enableSlippage: true,
    slippagePercentage: 0.5, // 0.5%
    enableFees: true,
    tradingFeePercentage: 0.25, // 0.25%
    networkFeeSOL: 0.000005, // 5000 lamports
    enableLiquiditySimulation: false,
    dataSource: 'jupiter',
  };

  /**
   * Set WebSocket server for real-time updates
   */
  setSocketIO(io: SocketServer): void {
    this.io = io;
    console.log(' Paper Trading Engine: WebSocket IO configured');

    // Start periodic portfolio updates for live simulation
    this.startPeriodicUpdates();
  }

  /**
   * Start periodic portfolio updates for live simulation
   */
  private startPeriodicUpdates(): void {
    if (this.periodicUpdateInterval) {
      clearInterval(this.periodicUpdateInterval);
    }

    this.periodicUpdateInterval = setInterval(async () => {
      await this.emitPeriodicPortfolioUpdates();
    }, 5000); // Update every 5 seconds
  }

  /**
   * Emit periodic portfolio updates for all active sessions
   */
  private async emitPeriodicPortfolioUpdates(): Promise<void> {
    if (!this.io) return;

    for (const [sessionId, state] of this.sessions.entries()) {
      if (!state.isActive) continue;

      try {
        // FIX #5: Get token address from portfolio positions (no hardcoded fallback)
        // Skip periodic updates if no token position exists
        const positions = Array.from((state.portfolio as any).positions?.values() || []);
        if (positions.length === 0) continue;
        
        const firstPosition = positions[0] as any;
        const tokenAddress = firstPosition?.tokenAddress;
        
        if (!tokenAddress || tokenAddress.length !== 44) {
          console.warn(`[PaperTradingEngine] Invalid token address in position: ${tokenAddress}`);
          continue;
        }
        
        // Get current market price for the token
        const currentPrice = await marketDataProvider.fetchTokenPrice(tokenAddress);

        if (currentPrice) {
          // Calculate current portfolio value
          const portfolio = new PaperTradingPortfolio(0, 0);
          portfolio.importState({ portfolio: state.portfolio, trades: state.trades, startTime: state.startTime });

          const metrics = await portfolio.calculateMetrics(state.metrics.strategyId, state.metrics.strategyName);

          // Calculate unrealized P&L
          const unrealizedPnL = metrics.totalValueUSD - (metrics.initialBalanceSOL * currentPrice.priceUSD);
          const unrealizedPnLUSD = unrealizedPnL;

          const simulationData = {
            sessionId,
            type: 'portfolio_update',
            timestamp: Date.now(),
            portfolioSnapshot: {
              balanceSOL: state.portfolio.balanceSOL,
              balanceUSDC: state.portfolio.balanceUSDC,
              balanceTokens: state.portfolio.balanceTokens,
              totalValueUSD: metrics.totalValueUSD,
              totalPnL: metrics.totalPnL,
              totalPnLUSD: metrics.totalPnLUSD,
              roi: metrics.roi,
              unrealizedPnL: unrealizedPnL,
              unrealizedPnLUSD: unrealizedPnLUSD
            },
            currentPrice: currentPrice.price,
            currentPriceUSD: currentPrice.priceUSD,
            tokenSymbol: currentPrice.tokenSymbol,
            strategyInfo: {
              strategyId: state.metrics.strategyId,
              strategyName: state.metrics.strategyName,
              executionCount: state.trades.length,
              isActive: state.isActive,
              startTime: state.startTime
            },
            marketData: {
              source: currentPrice.source,
              volume24h: currentPrice.volume24h,
              priceChange24h: currentPrice.priceChange24h
            }
          };

          this.io.emit('paper:simulation:update', simulationData);
        }
      } catch (error) {
        console.error(`Failed to emit periodic update for session ${sessionId}:`, error);
      }
    }
  }

  /**
   * Create a new paper trading session
   */
  async createSession(
    sessionId: string,
    userId?: string,
    strategyId?: string,
    config?: Partial<PaperTradingConfig> & {
      initialTokenBalance?: number;
      tokenAddress?: string;
      initialSupply?: number;
    }
  ): Promise<PaperTradingState> {
    const mergedConfig = { ...this.defaultConfig, ...config, enabled: true };
    
    const portfolio = new PaperTradingPortfolio(
      mergedConfig.initialBalanceSOL,
      mergedConfig.initialBalanceUSDC
    );

    // FIX #6: Initialize positions for sell strategies at session creation (not during first sell)
    const initialTokenBalance = (config as any)?.initialBalanceTokens || 0;
    const tokenAddress = (config as any)?.tokenAddress; // FIX #5: No ENV_CONFIG fallback
    const strategySide = (config as any)?.strategySide || 'buy'; // 'buy' or 'sell'
    
    // Validate tokenAddress is provided (required for all strategies)
    // Solana addresses are typically 43-44 characters (base58 encoded 32-byte pubkeys)
    if (!tokenAddress || typeof tokenAddress !== 'string' || tokenAddress.length < 32 || tokenAddress.length > 44) {
      console.error(`❌ [PaperTradingEngine] Invalid or missing tokenAddress: ${tokenAddress}`);
      console.error(`   Expected: 32-44 character Solana address, Got: ${typeof tokenAddress} with length ${tokenAddress?.length || 0}`);
      throw new Error(`tokenAddress is required for paper trading session creation. Received: ${tokenAddress}`);
    }
    
    console.log(`✅ [PaperTradingEngine] Token address validated: ${tokenAddress} (length: ${tokenAddress.length})`);
    
    // Auto-initialize position for SELL strategies (reactive mirror strategies)
    const shouldAutoInitForSellStrategy = initialTokenBalance === 0 && 
                                          strategySide === 'sell' && 
                                          tokenAddress;
    
    const configuredSupply = (config as any)?.initialSupply || 1000000;
    const effectiveTokenBalance = shouldAutoInitForSellStrategy ? configuredSupply : initialTokenBalance;
    
    if (effectiveTokenBalance > 0) {
      console.log(`💰 [PaperTradingEngine] Initializing position: ${effectiveTokenBalance} tokens${shouldAutoInitForSellStrategy ? ' (auto-init for sell strategy)' : ''}`);
      const now = Date.now();
      
      // PRODUCTION: Fetch REAL current market price - NO FALLBACKS ALLOWED
      let marketPrice: number;
      let priceUSD: number;
      let solPriceUSD: number;
      let tokenSymbol: string;
      
      try {
        const marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);
        if (!marketData) {
          // FAIL FAST: Never use fake prices in production
          const errorMsg = `❌ CRITICAL: Cannot fetch real market price for ${tokenAddress}. All market data sources failed. Session creation aborted to prevent false data.`;
          console.error(errorMsg);
          throw new Error(`Market data unavailable for ${tokenAddress}. Please try again when market APIs are responsive.`);
        }
        
        marketPrice = marketData.price; // Real token price in SOL
        priceUSD = marketData.priceUSD; // Real token price in USD
        solPriceUSD = marketData.solPrice; // Real SOL price in USD
        tokenSymbol = marketData.tokenSymbol || 'TOKEN';
        console.log(`📊 [PaperTradingEngine] Fetched REAL market price: $${priceUSD} USD per token (${marketPrice} SOL)`);
      } catch (error) {
        console.error(`❌ [PaperTradingEngine] FATAL: Market price fetch failed:`, error);
        throw new Error(`Cannot create session without real market data: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // PRODUCTION SAFETY: Validate prices are real and not suspiciously low
      if (marketPrice < 0.000000001 || priceUSD < 0.0000001) {
        const errorMsg = `❌ PRODUCTION SAFETY: Detected suspiciously low price (${priceUSD} USD, ${marketPrice} SOL). Refusing to use potentially fake data.`;
        console.error(errorMsg);
        throw new Error(`Invalid market data: Price too low (${priceUSD} USD). This may be a data error. Please verify token address is correct.`);
      }
      
      if (!marketPrice || !priceUSD || !solPriceUSD || isNaN(marketPrice) || isNaN(priceUSD) || isNaN(solPriceUSD)) {
        const errorMsg = `❌ PRODUCTION SAFETY: Invalid price data detected (marketPrice: ${marketPrice}, priceUSD: ${priceUSD}, solPriceUSD: ${solPriceUSD})`;
        console.error(errorMsg);
        throw new Error(`Invalid market data: Prices contain NaN or null values. Cannot proceed with invalid data.`);
      }
      
      console.log(`✅ [PRODUCTION] Price validation passed: $${priceUSD} USD (${marketPrice} SOL, SOL=$${solPriceUSD})`);
      
      // Calculate actual cost basis based on REAL current price
      const costBasisSOL = effectiveTokenBalance * marketPrice; // Real SOL value
      const costBasisUSD = effectiveTokenBalance * priceUSD; // Real USD value
      
      // Create a mock buy trade to initialize the position properly
      const mockTrade: PaperTrade = {
        id: uuidv4(),
        strategyId: strategyId || 'init',
        strategyName: 'Initial Position',
        timestamp: now,
        type: 'buy',
        tokenAddress: tokenAddress,
        tokenSymbol: tokenSymbol,
        orderType: 'market',
        requestedAmount: costBasisSOL,
        executedAmount: costBasisSOL,
        marketPrice: marketPrice, // REAL current price in SOL
        executionPrice: marketPrice, // REAL current price in SOL
        priceUSD: priceUSD, // REAL current price in USD
        solPriceUSD: solPriceUSD, // REAL SOL price
        amountSOL: costBasisSOL, // Real SOL value of tokens
        amountTokens: effectiveTokenBalance,
        tradingFee: 0,
        networkFee: 0,
        slippage: 0,
        totalCost: costBasisSOL,
        balanceSOL: mergedConfig.initialBalanceSOL, // Keep initial SOL unchanged (no actual purchase)
        balanceUSDC: mergedConfig.initialBalanceUSDC,
        balanceTokens: effectiveTokenBalance,
        realizedPnL: 0,
        trigger: 'initial_position',
      };
      
      // Add the mock trade to initialize the position
      portfolio.addTrade(mockTrade);
      
      console.log(`💰 [PaperTradingEngine] Initialized session with ${initialTokenBalance} tokens for ${tokenAddress}`);
      console.log(`💵 Initial position value: ${costBasisSOL.toFixed(6)} SOL = $${costBasisUSD.toFixed(2)} USD`);
    }

    const state: PaperTradingState = {
      sessionId,
      userId,
      mode: 'paper',
      config: mergedConfig,
      portfolio: portfolio.getPortfolio(),
      trades: portfolio.getTrades(),
      metrics: await portfolio.calculateMetrics(strategyId),
      startTime: Date.now(),
      isActive: true,
    };

    this.sessions.set(sessionId, state);
    this.logs.set(sessionId, []);

    this.log(sessionId, 'info', `Paper trading session created`, {
      sessionId,
      userId,
      strategyId,
      initialBalanceSOL: mergedConfig.initialBalanceSOL,
      initialBalanceTokens: initialTokenBalance,
    });

    await awsLogger.info('Paper trading session created', {
      metadata: { sessionId, userId, strategyId }
    });

    // Emit initial balance to UI immediately after session creation
    if (this.io) {
      const positions = Array.from((portfolio as any).positions?.values() || []);
      const firstPosition = positions[0] as any;
      const tokenSymbol = firstPosition?.tokenSymbol || 'USDC';
      const tokenBalance = firstPosition?.amount || 0;
      
      const initialBalanceEvent = {
        sessionId,
        balanceSOL: mergedConfig.initialBalanceSOL,
        balanceUSDC: mergedConfig.initialBalanceUSDC,
        balanceTokens: tokenBalance,
        totalValueUSD: mergedConfig.initialBalanceSOL * 100 + mergedConfig.initialBalanceUSDC, // Rough estimate
        roi: 0,
        totalPnLUSD: 0,
        primaryToken: {
          address: tokenAddress || 'none',
          symbol: tokenSymbol,
          balance: tokenBalance
        },
        timestamp: Date.now(),
        positions: positions,
        isInitialState: true
      };
      this.io.emit('paper:balance:update', initialBalanceEvent);
      console.log(`📡 [WebSocket] Emitted INITIAL balance: ${state.portfolio.balanceSOL} SOL, ${state.portfolio.balanceTokens} tokens`);
    }

    return state;
  }

  /**
   * Get paper trading session state
   */
  getSession(sessionId: string): PaperTradingState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Execute a paper buy order
   * Added retry logic and better error handling for market data
   */
  async executeBuy(
    sessionId: string,
    tokenAddress: string,
    amountSOL: number,
    strategyId: string,
    strategyName: string,
    trigger?: string
  ): Promise<OrderExecutionResult> {
    const state = this.sessions.get(sessionId);
    
    if (!state || !state.isActive) {
      return {
        success: false,
        error: 'Paper trading session not found or inactive',
      };
    }

    const portfolio = new PaperTradingPortfolio(0, 0);
    portfolio.importState({ portfolio: state.portfolio, trades: state.trades, startTime: state.startTime });

    // Check balance
    if (!portfolio.hasSufficientBalance(amountSOL)) {
      this.log(sessionId, 'error', 'Insufficient balance for buy order', {
        required: amountSOL,
        available: state.portfolio.balanceSOL,
      });

      return {
        success: false,
        error: 'Insufficient SOL balance',
        insufficientBalance: true,
      };
    }

    try {
      // FIX #10: Fetch real-time market data with enhanced retry logic and multiple fallbacks
      let marketData = null;
      let lastError = '';
      const maxRetries = 5; // Increased from 3 to 5 for better reliability
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);
          if (marketData && marketData.price > 0) {
            console.log(`✅ [Market Data] Fetched on attempt ${attempt}: $${marketData.priceUSD}`);
            break; // Success!
          }
          // If price is 0 or null, retry
          console.warn(`⚠️ [Market Data] Invalid price on attempt ${attempt}, retrying...`);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          console.warn(`[PaperTradingEngine] Market data fetch attempt ${attempt}/${maxRetries} failed: ${lastError}`);
          if (attempt < maxRetries) {
            // Exponential backoff with jitter to avoid thundering herd
            const baseDelay = 1000 * Math.pow(1.5, attempt); // 1.5s, 2.25s, 3.375s, 5.06s
            const jitter = Math.random() * 500; // 0-500ms random delay
            const delay = baseDelay + jitter;
            console.log(`⏳ [Market Data] Retrying in ${(delay/1000).toFixed(1)}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      
      if (!marketData) {
        this.log(sessionId, 'error', 'Failed to fetch market data after retries', {tokenAddress, lastError});

        // Emmit error state without changing balnaces or charging fees
        if (this.io) {
          this.io.emit('trade_execution_failed', {
            sessionId,
            timestamp: Date.now(),
            error: `Market data fetch failed: ${lastError}`,
            tokenAddress,
            attemptedAmount: amountSOL,
            reason: 'price_fetch_failure',
            currentBalance: {
              balanceSOL: state.portfolio.balanceSOL,
              balanceUSDC: state.portfolio.balanceUSDC,
              totalValueUSD: state.portfolio.totalValueUSD,
            }
          });
        }
        return {
          success: false,
          error: `Failed to fetch market data: ${lastError}. Please try again.`,
        };
      }

      // Calculate execution price with slippage
      const basePrice = marketData.price;
      const slippageAmount = state.config.enableSlippage
        ? basePrice * (state.config.slippagePercentage / 100) : 0;
      const executionPrice = basePrice + slippageAmount;

      // Calculate fees FIRST (on the SOL amount)
      const tradingFee = state.config.enableFees
        ? amountSOL * (state.config.tradingFeePercentage / 100) : 0;
      const networkFee = state.config.enableFees ? state.config.networkFeeSOL : 0;
      const totalFees = tradingFee + networkFee;

      // Effective SOL after fees
      const effectiveSOL = amountSOL - totalFees;
      
      // Calculate token amount (no additional slippage on token amount)
      const tokensReceived = effectiveSOL / basePrice; // Use base price, not execution price with slippage

      // Calculate USD cost (we're spending USD to buy SOL/tokens)
      const usdCost = amountSOL * marketData.solPrice;

      // Capture balance BEFORE trade for real-time tracking
      const balanceBefore = {
        sol: state.portfolio.balanceSOL,
        usdc: state.portfolio.balanceUSDC,
        tokens: portfolio.getPosition(tokenAddress)?.amount || 0,
        totalValueUSD: state.portfolio.totalValueUSD,
      };

      // Create trade record
      const trade: PaperTrade = {
        id: uuidv4(),
        strategyId,
        strategyName,
        timestamp: Date.now(),
        type: 'buy',
        tokenAddress,
        tokenSymbol: marketData.tokenSymbol,
        orderType: 'market',
        requestedAmount: amountSOL,
        executedAmount: amountSOL, // Show full amount requested
        marketPrice: basePrice,
        executionPrice: basePrice, // Use base price for display
        priceUSD: marketData.priceUSD,
        solPriceUSD: marketData.solPrice,
        amountSOL: amountSOL,
        amountTokens: tokensReceived,
        tradingFee,
        networkFee,
        slippage: slippageAmount,
        totalCost: amountSOL,
        balanceSOL: state.portfolio.balanceSOL - amountSOL, // SUBTRACT SOL spent (buying tokens WITH SOL)
        balanceUSDC: state.portfolio.balanceUSDC, // USDC unchanged (not using USDC)
        balanceTokens: (portfolio.getPosition(tokenAddress)?.amount || 0) + tokensReceived,
        trigger,
      };

      // Update portfolio
      portfolio.addTrade(trade);
      state.portfolio = portfolio.getPortfolio();
      state.lastTradeTime = trade.timestamp;
      state.metrics = await portfolio.calculateMetrics(strategyId, strategyName);

      // Calculate Sharpe Ratio (the only metric not in Portfolio's calculateMetrics)
      const riskMetrics = await this.calculateRiskMetrics(sessionId);
      if (riskMetrics) {
        state.metrics.sharpeRatio = riskMetrics.sharpeRatio || 0;
      }

      console.log('✅ [BUY] Metrics after calculation:', {
        profitFactor: state.metrics.profitFactor,
        sharpeRatio: state.metrics.sharpeRatio,
        maxDrawdown: state.metrics.maxDrawdown,
        averageWin: state.metrics.averageWin,
        averageLoss: state.metrics.averageLoss,
        winningTrades: state.metrics.winningTrades,
        losingTrades: state.metrics.losingTrades,
        winRate: state.metrics.winRate,
        totalTrades: state.metrics.totalTrades,
        totalFeesUSD: state.metrics.totalFeesUSD,
        duration: state.metrics.duration,
        executionsPerMin: state.metrics.duration > 0 
          ? (state.metrics.totalTrades / (state.metrics.duration / 60000)) 
          : 0
      });

      // Emit real-time balance update IMMEDIATELY after trade
      if (this.io) {
        const balanceAfter = {
          sol: state.portfolio.balanceSOL,
          usdc: state.portfolio.balanceUSDC,
          tokens: portfolio.getPosition(tokenAddress)?.amount || 0,
          totalValueUSD: state.metrics.totalValueUSD,
        };

        // ENHANCED: Get token-specific date
        const position = portfolio.getPosition(tokenAddress);
        const tokenSymbol = marketData.tokenSymbol || 'TOKEN';

        const balanceUpdateEvent = {
          sessionId,
          timestamp: Date.now(),
          tradeId: trade.id,
          tradeType: 'buy',
          
          // Before/After snapshots with millisecond precision
          before: {
            balanceSOL: balanceBefore.sol,
            balanceUSDC: balanceBefore.usdc,
            balanceTokens: balanceBefore.tokens,
            totalValueUSD: balanceBefore.totalValueUSD,
          },
          after: {
            balanceSOL: balanceAfter.sol,
            balanceUSDC: balanceAfter.usdc,
            balanceTokens: balanceAfter.tokens,
            totalValueUSD: balanceAfter.totalValueUSD,
          },
          
          // Deltas with millisecond precision
          deltas: {
            solDelta: balanceAfter.sol - balanceBefore.sol,
            usdcDelta: balanceAfter.usdc - balanceBefore.usdc,
            tokenDelta: balanceAfter.tokens - balanceBefore.tokens,
            totalValueDeltaUSD: balanceAfter.totalValueUSD - balanceBefore.totalValueUSD,
          },

          // NEW: Primary token info for UI
          primaryToken: {
            address: tokenAddress,
            symbol: tokenSymbol,
            balance: balanceAfter.tokens,
            balanceBefore: balanceBefore.tokens,
            balanceDelta: balanceAfter.tokens - balanceBefore.tokens,
          },
          
          // Available capital
          availableCapital: {
            sol: balanceAfter.sol,
            usdc: balanceAfter.usdc,
            totalUSD: (balanceAfter.sol * marketData.solPrice) + balanceAfter.usdc,
            marginUsed: 0, // For future margin trading
          },
          
          // Trade execution details
          executionDetails: {
            amountSOL: amountSOL,
            tokensReceived: tokensReceived,
            fees: tradingFee + networkFee,
            slippage: slippageAmount,
            tokenSymbol: tokenSymbol,
            executionPrice: executionPrice,
          },

          // NEW: Token Positioins
          tokenPositions: position ? [{
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol || tokenSymbol,
            amount: position.amount,
            valueSOL: position.currentValueSOL,
            valueUSD: position.currentValueSOL,
            unrealizedPnL: position.unrealizedPnL,
            unrealizedPnLPercentage: position.unrealizedPnLPercentage,
          }] : [],
        };

        this.io.emit('paper:balance:update', balanceUpdateEvent);
        console.log('💰 [Balance Update] SOL: %s → %s, Tokens: %s → %s', 
          balanceBefore.sol.toFixed(6), balanceAfter.sol.toFixed(6),
          balanceBefore.tokens.toFixed(2), balanceAfter.tokens.toFixed(2)
        );
      }

      this.log(sessionId, 'trade', `Buy executed: ${tokensReceived.toFixed(4)} tokens for ${amountSOL} SOL`, {
        trade,
      });

      await awsLogger.info('Paper trade executed (BUY)', {
        metadata: {
          sessionId,
          tokenAddress,
          amountSOL,
          tokensReceived,
          executionPrice,
          trigger,
        }
      });

      // Emit WebSocket event for real-time UI updates
      if (this.io) {
        const solToUSD = amountSOL * marketData.solPrice;
        const position = portfolio.getPosition(tokenAddress);
        
        // Calculate portfolio allocation
        const totalPortfolioValueUSD = state.metrics.totalValueUSD;
        const positionValueUSD = tokensReceived * marketData.priceUSD;
        const allocationPercentage = totalPortfolioValueUSD > 0 
          ? (positionValueUSD / totalPortfolioValueUSD) * 100 
          : 0;
        
        // Calculate trade velocity (trades per minute)
        const sessionDuration = (Date.now() - state.startTime) / 60000; // in minutes
        const tradesPerMinute = sessionDuration > 0 ? state.trades.length / sessionDuration : 0;
        
        // Calculate balance deltas
        const balanceDeltas = {
          solDelta: -amountSOL, // Negative because we're spending SOL
          usdcDelta: -solToUSD, // Negative because we're converting USD to tokens
          tokenDelta: tokensReceived, // Positive because we received tokens
          totalValueDelta: 0 // No immediate value change on buy
        };
        
        const eventData = {
          sessionId,
          side: 'buy',
          type: 'buy', // Add type for compatibility
          amount: amountSOL, // Show SOL amount
          amountSOL: amountSOL, // Explicit SOL amount
          amountTokens: tokensReceived, // Tokens received
          amountUSD: solToUSD, // Show USD equivalent
          price: basePrice, // Token price in SOL
          priceUSD: marketData.priceUSD, // Token price in USD (not SOL price)
          tokenSymbol: marketData.tokenSymbol, // Token symbol
          baseToken: 'SOL',
          quoteToken: marketData.tokenSymbol,
          pnl: 0, // No P&L on buy
          pnlUSD: 0,
          timestamp: trade.timestamp,
          executionTimeMs: Date.now() - trade.timestamp, // Execution latency
          tradeId: trade.id,
          totalTrades: state.trades.length,
          
          // Enhanced fee breakdown
          fees: {
            tradingFee: tradingFee,
            tradingFeeUSD: tradingFee * marketData.solPrice,
            networkFee: networkFee,
            networkFeeUSD: networkFee * marketData.solPrice,
            totalFees: totalFees,
            totalFeesUSD: totalFees * marketData.solPrice,
            feePercentage: (totalFees / amountSOL) * 100
          },
          
          // Slippage impact
          slippage: {
            amount: slippageAmount,
            amountUSD: slippageAmount * marketData.solPrice,
            percentage: state.config.slippagePercentage,
            impactOnPrice: (slippageAmount / basePrice) * 100
          },
          
          // Position details
          position: {
            tokenAddress: tokenAddress,
            tokenSymbol: marketData.tokenSymbol,
            size: tokensReceived,
            sizeUSD: positionValueUSD,
            averageEntryPrice: position?.averageEntryPrice || basePrice,
            costBasis: amountSOL,
            costBasisUSD: solToUSD,
            breakEvenPrice: basePrice * (1 + (totalFees / amountSOL)), // Price needed to break even after fees
            allocationPercentage: allocationPercentage,
            totalPositionSize: (position?.amount || 0) + tokensReceived
          },
          
          // Balance changes
          balanceDeltas: balanceDeltas,
          
          // Current balances after trade
          balances: {
            solBalance: state.portfolio.balanceSOL,
            usdcBalance: state.portfolio.balanceUSDC,
            tokenBalance: state.portfolio.balanceTokens,
            totalValueUSD: state.metrics.totalValueUSD,
            availableCash: state.portfolio.balanceSOL + state.portfolio.balanceUSDC / marketData.solPrice
          },
          
          // Execution details
          execution: {
            orderType: 'market',
            requestedAmount: amountSOL,
            executedAmount: amountSOL,
            executionPrice: basePrice,
            marketPrice: basePrice,
            priceDeviation: 0, // No deviation for market orders
            fillRate: 100 // Always 100% for paper trading
          },
          
          // Trading velocity
          velocity: {
            tradesPerMinute: tradesPerMinute,
            sessionDuration: sessionDuration,
            averageTradeInterval: sessionDuration > 0 ? sessionDuration / state.trades.length : 0
          },
          
          strategyInfo: {
            strategyId: strategyId,
            strategyName: strategyName,
            trigger: trigger
          },
          
          // Comprehensive metrics
          metrics: {
            totalTrades: state.metrics.totalTrades,
            roi: state.metrics.roi,
            totalPnLPercentage: state.metrics.totalPnLPercentage,
            totalPnL: state.metrics.totalPnL,
            totalPnLUSD: state.metrics.totalPnLUSD,
            winRate: state.metrics.winRate,
            profitFactor: state.metrics.profitFactor || 0,
            sharpeRatio: state.metrics.sharpeRatio || 0,
            maxDrawdown: state.metrics.maxDrawdown || 0,
            averageWin: state.metrics.averageWin || 0,
            averageLoss: state.metrics.averageLoss || 0,
            winningTrades: state.metrics.winningTrades || 0,
            losingTrades: state.metrics.losingTrades || 0,
            totalFeesUSD: state.metrics.totalFeesUSD || 0,
            executionsPerMin: state.metrics.duration > 0 
              ? (state.metrics.totalTrades / (state.metrics.duration / 60000)) 
              : 0
          },
          
          // FLATTENED METRICS AT TOP LEVEL - for frontend compatibility (production-ready)
          winningTrades: state.metrics.winningTrades || 0,
          losingTrades: state.metrics.losingTrades || 0,
          winRate: state.metrics.winRate,
          profitFactor: state.metrics.profitFactor || 0,
          sharpeRatio: state.metrics.sharpeRatio || 0,
          maxDrawdown: state.metrics.maxDrawdown || 0,
          roi: state.metrics.roi,
          avgWin: state.metrics.averageWin || 0,
          avgLoss: state.metrics.averageLoss || 0
        };

        console.log('📡 Emitting paper:trade:executed (BUY) - FLATTENED METRICS:', {
          'TOP_LEVEL.winRate': eventData.winRate,
          'TOP_LEVEL.profitFactor': eventData.profitFactor,
          'TOP_LEVEL.sharpeRatio': eventData.sharpeRatio,
          'TOP_LEVEL.totalTrades': eventData.totalTrades,
          'NESTED.metrics.winRate': eventData.metrics.winRate,
          'NESTED.metrics.profitFactor': eventData.metrics.profitFactor,
          amount: amountSOL,
          amountUSD: solToUSD,
          tokensReceived: tokensReceived.toFixed(6)
        });

        console.log('📦 Full eventData structure:', JSON.stringify({
          sessionId: eventData.sessionId,
          hasMetrics: !!eventData.metrics,
          metricsKeys: eventData.metrics ? Object.keys(eventData.metrics) : [],
          sampleMetrics: eventData.metrics ? {
            totalTrades: eventData.metrics.totalTrades,
            profitFactor: eventData.metrics.profitFactor,
            winningTrades: eventData.metrics.winningTrades
          } : null
        }, null, 2));

        console.log('🔍 CRITICAL: state.metrics right before emission:', JSON.stringify({
          hasStateMetrics: !!state.metrics,
          stateMetricsKeys: state.metrics ? Object.keys(state.metrics) : [],
          winRate: state.metrics?.winRate,
          totalTrades: state.metrics?.totalTrades,
          roi: state.metrics?.roi,
          profitFactor: state.metrics?.profitFactor,
          sharpeRatio: state.metrics?.sharpeRatio
        }, null, 2));

        console.log('🔍 CRITICAL: eventData.metrics construction:', JSON.stringify({
          hasEventDataMetrics: !!eventData.metrics,
          eventDataMetricsKeys: eventData.metrics ? Object.keys(eventData.metrics) : [],
          directAccess: {
            totalTrades: eventData.metrics?.totalTrades,
            winRate: eventData.metrics?.winRate,
            roi: eventData.metrics?.roi
          }
        }, null, 2));

        console.log('🚀 FINAL CHECK - About to emit with keys:', Object.keys(eventData));
        console.log('🚀 FINAL CHECK - eventData.metrics exists?', !!eventData.metrics);
        console.log('🚀 FINAL CHECK - eventData.metrics value:', eventData.metrics);

        this.io.emit('paper:trade:executed', eventData);

        // Enhanced simulation event with comprehensive portfolio tracking
        const simulationData = {
          sessionId,
          type: 'buy_simulation',
          side: 'buy',
          amountSOL: amountSOL, // SOL spent
          amountTokens: tokensReceived, // Tokens received
          tokenSymbol: marketData.tokenSymbol, // Token symbol
          priceUSD: marketData.priceUSD, // Token price in USD
          timestamp: Date.now(),
          
          // Complete portfolio snapshot
          portfolioSnapshot: {
            balanceSOL: state.portfolio.balanceSOL,
            balanceUSDC: state.portfolio.balanceUSDC,
            balanceTokens: state.portfolio.balanceTokens,
            totalValueUSD: state.metrics.totalValueUSD,
            totalPnL: state.metrics.totalPnL,
            totalPnLUSD: state.metrics.totalPnLUSD,
            roi: state.metrics.roi,
            unrealizedPnL: state.metrics.unrealizedPnL,
            unrealizedPnLUSD: state.metrics.unrealizedPnLUSD,
            realizedPnL: state.metrics.realizedPnL,
            realizedPnLUSD: state.metrics.realizedPnLUSD,
            
            // Portfolio allocation breakdown
            allocation: {
              solPercentage: (state.portfolio.balanceSOL * marketData.solPrice / state.metrics.totalValueUSD) * 100,
              usdcPercentage: (state.portfolio.balanceUSDC / state.metrics.totalValueUSD) * 100,
              tokenPercentage: (state.portfolio.balanceTokens * marketData.priceUSD / state.metrics.totalValueUSD) * 100
            },
            
            // Capital utilization
            capitalUtilization: {
              totalCapital: state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC,
              usedCapital: (state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC) - (state.portfolio.balanceSOL * marketData.solPrice + state.portfolio.balanceUSDC),
              availableCash: state.portfolio.balanceSOL * marketData.solPrice + state.portfolio.balanceUSDC,
              utilizationPercentage: ((state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC) - (state.portfolio.balanceSOL * marketData.solPrice + state.portfolio.balanceUSDC)) / (state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC) * 100
            }
          },
          
          // Current market data
          currentPrice: basePrice,
          currentPriceUSD: marketData.priceUSD,
          solPriceUSD: marketData.solPrice,
          
          // Market depth (if available)
          marketData: {
            source: marketData.source || 'jupiter',
            volume24h: marketData.volume24h || 0,
            priceChange24h: marketData.priceChange24h || 0,
            high24h: marketData.high24h || basePrice,
            low24h: marketData.low24h || basePrice,
            liquidity: marketData.liquidity || 0
          },
          
          // Strategy execution context
          strategyInfo: {
            strategyId: strategyId,
            strategyName: strategyName,
            executionCount: state.trades.length,
            isActive: state.isActive,
            startTime: state.startTime,
            sessionDuration: Date.now() - state.startTime,
            lastTradeTime: trade.timestamp
          },
          
          // Detailed trade information
          tradeDetails: {
            tradeId: trade.id,
            type: 'buy',
            amountSOL: amountSOL,
            amountTokens: tokensReceived, // Use consistent naming with paper:trade:executed
            tokensReceived: tokensReceived, // Keep for backward compatibility
            executionPrice: basePrice,
            marketPrice: basePrice,
            averageEntryPrice: eventData.position.averageEntryPrice,
            
            fees: {
              tradingFee: tradingFee,
              tradingFeeUSD: tradingFee * marketData.solPrice,
              networkFee: networkFee,
              networkFeeUSD: networkFee * marketData.solPrice,
              totalFees: totalFees,
              totalFeesUSD: totalFees * marketData.solPrice,
              slippage: slippageAmount,
              slippageUSD: slippageAmount * marketData.solPrice
            },
            
            costBasis: amountSOL,
            costBasisUSD: solToUSD,
            breakEvenPrice: eventData.position.breakEvenPrice,
            timestamp: trade.timestamp
          },
          
          // Session-wide statistics
          sessionStats: {
            totalTrades: state.trades.length,
            totalVolume: state.trades.reduce((sum, t) => sum + (t.amountSOL * t.solPriceUSD), 0),
            averageTradeSize: state.trades.length > 0 
              ? state.trades.reduce((sum, t) => sum + (t.amountSOL * t.solPriceUSD), 0) / state.trades.length 
              : 0,
            tradingFrequency: tradesPerMinute,
            buyTrades: state.trades.filter(t => t.type === 'buy').length,
            sellTrades: state.trades.filter(t => t.type === 'sell').length
          }
        };

        this.io.emit('paper:simulation:update', simulationData);
      }
      return {
        success: true,
        trade,
      };
    } catch (error) {
      this.log(sessionId, 'error', 'Buy order execution failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Execute a paper sell order
   * Supports both:
   * - Selling SOL for USD (when tokenAddress = SOL_ADDRESS)
   * - Selling TOKEN for SOL (when tokenAddress = custom token)
   */
  async executeSell(
    sessionId: string,
    tokenAddress: string,
    tokenAmount: number,
    strategyId: string,
    strategyName: string,
    trigger?: string
  ): Promise<OrderExecutionResult> {
    const state = this.sessions.get(sessionId);
    
    if (!state || !state.isActive) {
      return {
        success: false,
        error: 'Paper trading session not found or inactive',
      };
    }

    const portfolio = new PaperTradingPortfolio(0, 0);
    portfolio.importState({ 
      portfolio: state.portfolio, 
      trades: state.trades, 
      startTime: state.startTime 
    });

    // Determine trade type: SOL → USD or TOKEN → SOL
    const isSellingSol = tokenAddress === SOL_ADDRESS;
    
    if (isSellingSol) {
      // CASE 1: SELLING SOL FOR USD
      return await this.executeSellSolForUsd(
        sessionId,
        state,
        portfolio,
        tokenAddress,
        tokenAmount,
        strategyId,
        strategyName,
        trigger
      );
    } else {
      // CASE 2: SELLING TOKEN FOR SOL
      return await this.executeSellTokenForSol(
        sessionId,
        state,
        portfolio,
        tokenAddress,
        tokenAmount,
        strategyId,
        strategyName,
        trigger
      );
    }
  }

  /**
   * PRIVATE: Execute SOL → USD sell
   */
  private async executeSellSolForUsd(
    sessionId: string,
    state: PaperTradingState,
    portfolio: PaperTradingPortfolio,
    tokenAddress: string,
    tokenAmount: number,
    strategyId: string,
    strategyName: string,
    trigger?: string
  ): Promise<OrderExecutionResult> {
    // Check if position exists and has sufficient tokens
    const position = portfolio.getPosition(tokenAddress);
    
    if (!position || position.amount < tokenAmount) {
      this.log(sessionId, 'error', 'Insufficient SOL balance for sell order', {
        required: tokenAmount,
        available: position?.amount || 0,
      });

      return {
        success: false,
        error: 'Insufficient token balance',
        insufficientBalance: true,
      };
    }

    try {
      // Fetch real-time market data
      const marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);
      
      if (!marketData) {
        this.log(sessionId, 'error', 'Failed to fetch market data', { tokenAddress });
        return {
          success: false,
          error: 'Failed to fetch market data',
        };
      }

      const solToSell = tokenAmount;
      const basePrice = marketData.solPrice; // SOL price in USD
      
      // Calculate slippage
      const slippageAmount = state.config.enableSlippage
        ? basePrice * (state.config.slippagePercentage / 100)
        : 0;
      const executionPrice = basePrice - slippageAmount;

      // Calculate USD we get from selling SOL
      const usdBeforeFees = solToSell * executionPrice;
      
      // Calculate fees (in USD)
      const tradingFee = state.config.enableFees
        ? usdBeforeFees * (state.config.tradingFeePercentage / 100)
        : 0;
      const networkFeeUSD = state.config.enableFees ? state.config.networkFeeSOL * marketData.solPrice : 0;
      const totalFeesUSD = tradingFee + networkFeeUSD;

      // Final USD received after fees
      const usdReceived = usdBeforeFees - totalFeesUSD;

      // Calculate realized P&L (in USD)
      const costBasisUSD = tokenAmount * position.averageEntryPrice * marketData.solPrice;
      const realizedPnL = usdReceived - costBasisUSD;
      const realizedPnLSOL = realizedPnL / marketData.solPrice;

      // Create trade record
      const trade: PaperTrade = {
        id: uuidv4(),
        strategyId,
        strategyName,
        timestamp: Date.now(),
        type: 'sell',
        tokenAddress,
        tokenSymbol: 'SOL',
        orderType: 'market',
        requestedAmount: tokenAmount,
        executedAmount: tokenAmount,
        marketPrice: basePrice,
        executionPrice,
        priceUSD: marketData.priceUSD,
        solPriceUSD: marketData.solPrice,
        amountSOL: solToSell,
        amountTokens: tokenAmount,
        tradingFee,
        networkFee: networkFeeUSD / marketData.solPrice,
        slippage: slippageAmount,
        totalCost: usdBeforeFees,
        balanceSOL: state.portfolio.balanceSOL - solToSell,
        balanceUSDC: state.portfolio.balanceUSDC + usdReceived,
        balanceTokens: position.amount - tokenAmount,
        realizedPnL: realizedPnLSOL,
        trigger,
      };

      // Update portfolio
      portfolio.addTrade(trade);
      state.portfolio = portfolio.getPortfolio();
      state.lastTradeTime = trade.timestamp;
      state.metrics = await portfolio.calculateMetrics(strategyId, strategyName);

      // Calculate Sharpe Ratio (the only metric not in Portfolio's calculateMetrics)
      const riskMetrics = await this.calculateRiskMetrics(sessionId);
      if (riskMetrics) {
        state.metrics.sharpeRatio = riskMetrics.sharpeRatio || 0;
      }

      console.log('✅ [SELL] Metrics after calculation:', {
        profitFactor: state.metrics.profitFactor,
        sharpeRatio: state.metrics.sharpeRatio,
        maxDrawdown: state.metrics.maxDrawdown,
        averageWin: state.metrics.averageWin,
        averageLoss: state.metrics.averageLoss,
        winningTrades: state.metrics.winningTrades,
        losingTrades: state.metrics.losingTrades,
        winRate: state.metrics.winRate,
        totalTrades: state.metrics.totalTrades,
        totalFeesUSD: state.metrics.totalFeesUSD,
        duration: state.metrics.duration,
        executionsPerMin: state.metrics.duration > 0 
          ? (state.metrics.totalTrades / (state.metrics.duration / 60000)) 
          : 0
      });

      this.log(sessionId, 'trade', `Sell SOL executed: ${tokenAmount.toFixed(4)} SOL for ${usdReceived.toFixed(2)} USD`, {
        trade, realizedPnL: realizedPnLSOL,
      });

      await awsLogger.info('Paper trade executed (SELL SOL→USD)', {
        metadata: {
          sessionId,
          tokenAddress,
          solAmount: tokenAmount,
          usdReceived,
          executionPrice,
          realizedPnL: realizedPnLSOL,
          trigger,
        }
      });

      // Emit WebSocket event
      if (this.io) {
        const remainingPosition = portfolio.getPosition(tokenAddress);
        
        // Calculate portfolio allocation
        const totalPortfolioValueUSD = state.metrics.totalValueUSD;
        const remainingPositionValueUSD = remainingPosition 
          ? remainingPosition.amount * basePrice 
          : 0;
        const allocationPercentage = totalPortfolioValueUSD > 0 
          ? (remainingPositionValueUSD / totalPortfolioValueUSD) * 100 
          : 0;
        
        // Calculate trade velocity
        const sessionDuration = (Date.now() - state.startTime) / 60000;
        const tradesPerMinute = sessionDuration > 0 ? state.trades.length / sessionDuration : 0;
        
        // Calculate balance deltas
        const balanceDeltas = {
          solDelta: -solToSell, // Negative because we're selling SOL
          usdcDelta: usdReceived, // Positive because we received USD
          tokenDelta: 0,
          totalValueDelta: realizedPnL // Realized P&L
        };
        
        const eventData = {
          sessionId,
          side: 'sell',
          amount: solToSell,
          amountSOL: solToSell, // Explicit SOL amount for consistency
          amountUSD: usdReceived,
          price: basePrice,
          priceUSD: marketData.solPrice,
          tokenSymbol: 'SOL', // Token symbol for consistency
          baseToken: 'SOL',
          quoteToken: 'USD',
          pnl: realizedPnLSOL,
          pnlUSD: realizedPnL,
          timestamp: trade.timestamp,
          executionTimeMs: Date.now() - trade.timestamp,
          tradeId: trade.id,
          totalTrades: state.trades.length,
          
          // Enhanced fee breakdown
          fees: {
            tradingFee: tradingFee,
            tradingFeeUSD: tradingFee,
            networkFee: networkFeeUSD / marketData.solPrice,
            networkFeeUSD: networkFeeUSD,
            totalFees: totalFeesUSD,
            totalFeesUSD: totalFeesUSD,
            feePercentage: (totalFeesUSD / usdBeforeFees) * 100
          },
          
          // Slippage impact
          slippage: {
            amount: slippageAmount * tokenAmount,
            amountUSD: slippageAmount * tokenAmount,
            percentage: state.config.slippagePercentage,
            impactOnPrice: (slippageAmount / basePrice) * 100
          },
          
          // Position details after sell
          position: {
            tokenAddress: tokenAddress,
            tokenSymbol: 'SOL',
            size: remainingPosition?.amount || 0,
            sizeUSD: remainingPositionValueUSD,
            averageEntryPrice: remainingPosition?.averageEntryPrice || basePrice,
            costBasis: costBasisUSD / marketData.solPrice,
            costBasisUSD: costBasisUSD,
            realizedPnL: realizedPnLSOL,
            realizedPnLUSD: realizedPnL,
            allocationPercentage: allocationPercentage,
            soldAmount: solToSell,
            soldPercentage: position ? (solToSell / position.amount) * 100 : 0
          },
          
          // Balance changes
          balanceDeltas: balanceDeltas,
          
          // Current balances after trade
          balances: {
            solBalance: state.portfolio.balanceSOL,
            usdcBalance: state.portfolio.balanceUSDC,
            tokenBalance: state.portfolio.balanceTokens,
            totalValueUSD: state.metrics.totalValueUSD,
            availableCash: state.portfolio.balanceSOL * marketData.solPrice + state.portfolio.balanceUSDC
          },
          
          // Execution details
          execution: {
            orderType: 'market',
            requestedAmount: tokenAmount,
            executedAmount: tokenAmount,
            executionPrice: executionPrice,
            marketPrice: basePrice,
            priceDeviation: ((executionPrice - basePrice) / basePrice) * 100,
            fillRate: 100
          },
          
          // Trading velocity
          velocity: {
            tradesPerMinute: tradesPerMinute,
            sessionDuration: sessionDuration,
            averageTradeInterval: sessionDuration > 0 ? sessionDuration / state.trades.length : 0
          },
          
          // Comprehensive metrics
          metrics: {
            totalTrades: state.metrics.totalTrades,
            roi: state.metrics.roi,
            totalPnLPercentage: state.metrics.totalPnLPercentage,
            totalPnL: state.metrics.totalPnL,
            totalPnLUSD: state.metrics.totalPnLUSD,
            winRate: state.metrics.winRate,
            profitFactor: state.metrics.profitFactor || 0,
            sharpeRatio: state.metrics.sharpeRatio || 0,
            maxDrawdown: state.metrics.maxDrawdown || 0,
            averageWin: state.metrics.averageWin || 0,
            averageLoss: state.metrics.averageLoss || 0,
            winningTrades: state.metrics.winningTrades || 0,
            losingTrades: state.metrics.losingTrades || 0,
            totalFeesUSD: state.metrics.totalFeesUSD || 0,
            executionsPerMin: state.metrics.duration > 0 
              ? (state.metrics.totalTrades / (state.metrics.duration / 60000)) 
              : 0,
            realizedPnL: state.metrics.realizedPnL,
            realizedPnLUSD: state.metrics.realizedPnLUSD
          },
          
          // FLATTENED METRICS AT TOP LEVEL - for frontend compatibility (production-ready)
          // These allow frontend to access metrics without knowing if they're nested or not
          winningTrades: state.metrics.winningTrades || 0,
          losingTrades: state.metrics.losingTrades || 0,
          winRate: state.metrics.winRate,
          profitFactor: state.metrics.profitFactor || 0,
          sharpeRatio: state.metrics.sharpeRatio || 0,
          maxDrawdown: state.metrics.maxDrawdown || 0,
          roi: state.metrics.roi,
          avgWin: state.metrics.averageWin || 0,
          avgLoss: state.metrics.averageLoss || 0
        };
        
        console.log('📡 Emitting paper:trade:executed (SELL) - FLATTENED METRICS:', {
          'TOP_LEVEL.winRate': eventData.winRate,
          'TOP_LEVEL.profitFactor': eventData.profitFactor,
          'TOP_LEVEL.sharpeRatio': eventData.sharpeRatio,
          'TOP_LEVEL.totalTrades': eventData.totalTrades,
          'NESTED.metrics.winRate': eventData.metrics.winRate,
          'NESTED.metrics.profitFactor': eventData.metrics.profitFactor,
          realizedPnL: realizedPnL.toFixed(4),
          realizedPnLSOL: realizedPnLSOL.toFixed(8)
        });

        console.log('📦 Full SELL eventData structure:', JSON.stringify({
          sessionId: eventData.sessionId,
          hasMetrics: !!eventData.metrics,
          metricsKeys: eventData.metrics ? Object.keys(eventData.metrics) : [],
          sampleMetrics: eventData.metrics ? {
            totalTrades: eventData.metrics.totalTrades,
            profitFactor: eventData.metrics.profitFactor,
            winningTrades: eventData.metrics.winningTrades
          } : null
        }, null, 2));
        
        this.io.emit('paper:trade:executed', eventData);
        console.log(`📊 [PaperTradingEngine] Emitted SELL trade execution to UI (total trades: ${state.trades.length}, P&L: $${realizedPnL.toFixed(2)})`);

        const simulationData = {
          sessionId,
          type: 'sell_executed',
          timestamp: Date.now(),
          
          // Complete portfolio snapshot
          portfolioSnapshot: {
            balanceSOL: state.portfolio.balanceSOL,
            balanceUSDC: state.portfolio.balanceUSDC,
            balanceTokens: state.portfolio.balanceTokens,
            totalValueUSD: state.metrics.totalValueUSD,
            totalPnL: state.metrics.totalPnL,
            totalPnLUSD: state.metrics.totalPnLUSD,
            totalPnLPercentage: state.metrics.totalPnLPercentage,
            winRate: state.metrics.winRate,
            totalTrades: state.trades.length,
            winningTrades: state.metrics.winningTrades,
            losingTrades: state.metrics.losingTrades,
            realizedPnL: state.metrics.realizedPnL,
            realizedPnLUSD: state.metrics.realizedPnLUSD,
            unrealizedPnL: state.metrics.unrealizedPnL,
            unrealizedPnLUSD: state.metrics.unrealizedPnLUSD,
            
            // Portfolio allocation
            allocation: {
              solPercentage: (state.portfolio.balanceSOL * marketData.solPrice / state.metrics.totalValueUSD) * 100,
              usdcPercentage: (state.portfolio.balanceUSDC / state.metrics.totalValueUSD) * 100,
              tokenPercentage: (state.portfolio.balanceTokens * marketData.priceUSD / state.metrics.totalValueUSD) * 100
            },
            
            // Capital utilization
            capitalUtilization: {
              totalCapital: state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC,
              usedCapital: (state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC) - (state.portfolio.balanceSOL * marketData.solPrice + state.portfolio.balanceUSDC),
              availableCash: state.portfolio.balanceSOL * marketData.solPrice + state.portfolio.balanceUSDC,
              utilizationPercentage: ((state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC) - (state.portfolio.balanceSOL * marketData.solPrice + state.portfolio.balanceUSDC)) / (state.config.initialBalanceSOL * marketData.solPrice + state.config.initialBalanceUSDC) * 100
            }
          },
          
          currentPrice: basePrice,
          currentPriceUSD: marketData.solPrice,
          tokenSymbol: 'SOL',
          
          // Market data
          marketData: {
            source: marketData.source || 'jupiter',
            volume24h: marketData.volume24h || 0,
            priceChange24h: marketData.priceChange24h || 0,
            high24h: marketData.high24h || basePrice,
            low24h: marketData.low24h || basePrice,
            liquidity: marketData.liquidity || 0
          },
          
          strategyInfo: {
            strategyId: strategyId,
            strategyName: strategyName,
            executionCount: state.trades.length,
            isActive: state.isActive,
            startTime: state.startTime,
            sessionDuration: Date.now() - state.startTime,
            lastTradeTime: trade.timestamp
          },
          
          tradeDetails: {
            tradeId: trade.id,
            type: 'sell',
            amountSOL: solToSell,
            usdReceived: usdReceived,
            executionPrice: executionPrice,
            marketPrice: basePrice,
            averageEntryPrice: position.averageEntryPrice,
            
            fees: {
              tradingFee: tradingFee,
              tradingFeeUSD: tradingFee,
              networkFee: networkFeeUSD / marketData.solPrice,
              networkFeeUSD: networkFeeUSD,
              totalFees: totalFeesUSD,
              totalFeesUSD: totalFeesUSD,
              slippage: slippageAmount,
              slippageUSD: slippageAmount * tokenAmount
            },
            
            realizedPnL: realizedPnLSOL,
            realizedPnLUSD: realizedPnL,
            costBasis: costBasisUSD / marketData.solPrice,
            costBasisUSD: costBasisUSD,
            profitPercentage: (realizedPnL / costBasisUSD) * 100,
            timestamp: trade.timestamp
          },
          
          // Session-wide statistics
          sessionStats: {
            totalTrades: state.trades.length,
            totalVolume: state.trades.reduce((sum, t) => sum + (t.amountSOL * t.solPriceUSD), 0),
            averageTradeSize: state.trades.length > 0 
              ? state.trades.reduce((sum, t) => sum + (t.amountSOL * t.solPriceUSD), 0) / state.trades.length 
              : 0,
            tradingFrequency: tradesPerMinute,
            buyTrades: state.trades.filter(t => t.type === 'buy').length,
            sellTrades: state.trades.filter(t => t.type === 'sell').length
          }
        };

        this.io.emit('paper:simulation:update', simulationData);
      }

      return {
        success: true,
        trade,
      };
    } catch (error) {
      this.log(sessionId, 'error', 'Sell SOL order execution failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * PRIVATE: Execute TOKEN → SOL sell
   * This is the NEW functionality for selling meme tokens
   */
  private async executeSellTokenForSol(
    sessionId: string,
    state: PaperTradingState,
    portfolio: PaperTradingPortfolio,
    tokenAddress: string,
    tokenAmount: number,
    strategyId: string,
    strategyName: string,
    trigger?: string
  ): Promise<OrderExecutionResult> {
    // Check token balance
    let position = portfolio.getPosition(tokenAddress);
    
    // Handle "-1" as "sell all tokens"
    let actualTokenAmount = tokenAmount;
    if (tokenAmount === -1) {
      if (!position || position.amount === 0) {
        this.log(sessionId, 'error', 'Cannot sell all tokens - no position exists', {
          tokenAddress,
          strategyName
        });
        return {
          success: false,
          error: 'Cannot sell all tokens - no position exists for this token',
          insufficientBalance: true,
        };
      }
      actualTokenAmount = position.amount;
      console.log(`💡 [PaperTradingEngine] Converting "sell all" (-1) to actual amount: ${actualTokenAmount} tokens`);
    }
    
      // AUTO-INITIALIZE: If this is a SELL strategy and we don't have this token yet,
      // simulate that we bought tokens earlier (mirror strategy assumption)
      if (!position && strategyName.toLowerCase().includes('sell')) {
        console.log(`🔄 [PaperTradingEngine] Auto-initializing tokens for ${tokenAddress} (SELL strategy)`);
        
        // Fetch REAL current market price for accurate auto-initialization
        const marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);
        
        if (!marketData) {
          this.log(sessionId, 'error', 'Failed to fetch market data for auto-initialization', { tokenAddress });
          return {
            success: false,
            error: 'Failed to fetch market data for token auto-initialization',
          };
        }
        
        // FIX #1: Dynamic token amount based on user config or mirror trade
        // Priority: 1) User-specified amount 2) Mirror trade amount * 10 3) Config supply 4) Default 1M
        const detectedMirrorAmount = actualTokenAmount > 0 && actualTokenAmount !== -1 
          ? actualTokenAmount 
          : (state.config as any).initialSupply;

        // Allow user to specify exact initial amount via config
        const userSpecifiedAmount = (state.config as any).initialTokenBalance;
        
        let autoInitTokens: number;
        if (userSpecifiedAmount && userSpecifiedAmount > 0) {
          // User explicitly specified amount - use it
          autoInitTokens = userSpecifiedAmount;
          console.log(`📦 [AUTO-INIT] Using user-specified amount: ${autoInitTokens.toLocaleString()}`);
        } else if (detectedMirrorAmount && detectedMirrorAmount > 0) {
          // Mirror trading - use 10x the detected amount or 1M minimum
          autoInitTokens = Math.max(detectedMirrorAmount * 10, 1000000);
          console.log(`🔄 [AUTO-INIT] Mirror mode: 10x detected amount = ${autoInitTokens.toLocaleString()}`);
        } else {
          // Fallback to default 1M
          autoInitTokens = 1000000;
          console.log(`🎯 [AUTO-INIT] Using default amount: ${autoInitTokens.toLocaleString()}`);
        }      console.log(`[AUTO-INIT] Detected mirror amount: ${actualTokenAmount}, Config supply: ${(state as any).config?.initialSupply}, Final: ${autoInitTokens.toLocaleString()}`);
      console.log(`[AUTO-INIT LOGIC] Using ${detectedMirrorAmount ? '10x detected amount' : 'default 1M'} for flexible mirror trading`);

      const marketPrice = marketData.price; // Real token price in SOL
      const priceUSD = marketData.priceUSD; // Real token price in USD
      const solPriceUSD = marketData.solPrice; // Real SOL price in USD
      const costBasisSOL = autoInitTokens * marketPrice; // Cost = current value (neutral P&L)
      const costBasisUSD = autoInitTokens * priceUSD; // Cost = current value in USD
      
      const now = Date.now();
      const mockBuyTrade: PaperTrade = {
        id: uuidv4(),
        strategyId: strategyId || 'auto-init',
        strategyName: 'Auto-initialized for SELL',
        timestamp: now,
        type: 'buy',
        tokenAddress: tokenAddress,
        tokenSymbol: marketData.tokenSymbol || 'TOKEN',
        orderType: 'market',
        requestedAmount: costBasisSOL,
        executedAmount: costBasisSOL,
        marketPrice: marketPrice, // Current price at auto-init
        executionPrice: marketPrice, // Current price at auto-init
        priceUSD: priceUSD, // Current price in USD
        solPriceUSD: solPriceUSD, // SOL price in USD
        amountSOL: costBasisSOL, // Total cost in SOL
        amountTokens: autoInitTokens,
        tradingFee: 0,
        networkFee: 0,
        slippage: 0,
        totalCost: costBasisSOL,
        // CRITICAL: Virtual ownership - we OWN tokens but didn't SPEND SOL
        // Think of it as: "User deposited 100K tokens worth X SOL into the portfolio"
        balanceSOL: state.portfolio.balanceSOL, // Keep SOL unchanged
        balanceUSDC: state.portfolio.balanceUSDC,
        balanceTokens: autoInitTokens, // Now holding 100K tokens
        realizedPnL: 0, // Neutral position (cost = value)
        trigger: 'auto_init_for_sell_strategy',
      };
      
      portfolio.addTrade(mockBuyTrade);
      state.trades.push(mockBuyTrade);
      
      // Update state portfolio
      state.portfolio = portfolio.getPortfolio();
      
      // Refresh position reference
      position = portfolio.getPosition(tokenAddress);
      
      console.log(`\n✅ [AUTO-INIT] Virtual position created for ${marketData.tokenSymbol || 'TOKEN'}`);
      console.log(`📦 Tokens: ${autoInitTokens.toLocaleString()}`);
      console.log(`💰 Current Price: ${marketPrice.toFixed(10)} SOL/token`);
      console.log(`📊 Cost Basis: ${costBasisSOL.toFixed(6)} SOL ($${costBasisUSD.toFixed(2)} USD)`);
      console.log(`💎 Current Value: ${costBasisSOL.toFixed(6)} SOL ($${costBasisUSD.toFixed(2)} USD)`);
      console.log(`📈 Initial P&L: $0.00 (cost = value, neutral position)`);
      console.log(`🎯 This means: When price moves, P&L will reflect actual gains/losses\n`);
      
      // Emit balance update to UI immediately after auto-init
      if (this.io) {
        const positions = Array.from((portfolio as any).Positioins?.values() || []);
        const tokenSymbols = marketData.tokenSymbol || 'TOKEN';
        
        const balanceUpdateEvent = {
          sessionId,
          timestamp: Date.now(),
          balanceSOL: state.portfolio.balanceSOL,
          balanceUSDC: state.portfolio.balanceUSDC,
          balanceTokens: autoInitTokens,

          // NEW: Primary token info
          primaryToken: {
            address: tokenAddress,
            symbol: tokenSymbols,
            balance: autoInitTokens
          },

          // NEW: TOKEN positions
          tokenPositions: positions.map((pos: any) => ({
            tokenAddress: pos.tokenAddress,
            tokenSymbol: pos.tokenSymbol || pos.tokenSymbol,
            amount: pos.amount,
            valueSOL: pos.currentValueSOL || 0,
            valueUSD: pos.currentValueUSD || 0,
            unrealizedPnL: pos.unrealizedPnL || 0,
          })),
          
          totalValueUSD: state.portfolio.balanceSOL * solPriceUSD,
          positions: positions,
          isAutoInit: true 
        };
        this.io.emit('paper:balance:update', balanceUpdateEvent);
        console.log(`📡 [WebSocket] Emitted balance update after auto-init`);
      }
    }
    
    if (!position || position.amount < actualTokenAmount) {
      this.log(sessionId, 'error', 'Insufficient token balance for sell order', {
        required: actualTokenAmount,
        available: position?.amount || 0,
        tokenAddress,
      });

      return {
        success: false,
        error: `Insufficient token balance. Required: ${actualTokenAmount}, Available: ${position?.amount || 0}`,
        insufficientBalance: true,
      };
    }

    try {
      // FIX #10: Fetch real-time token price with retry logic
      let marketData = null;
      let lastError = '';
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);
          if (marketData) break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          console.warn(`[PaperTradingEngine] Market data fetch attempt ${attempt}/${maxRetries} failed: ${lastError}`);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      
      if (!marketData) {
        this.log(sessionId, 'error', 'Failed to fetch market data after retries', { tokenAddress, lastError });
        return {
          success: false,
          error: `Failed to fetch market data: ${lastError}. Please try again.`,
        };
      }

      const tokensToSell = actualTokenAmount;
      const basePrice = marketData.price; // Token price in SOL
      
      // Calculate slippage (price drops when selling)
      const slippageAmount = state.config.enableSlippage
        ? basePrice * (state.config.slippagePercentage / 100)
        : 0;
      const executionPrice = basePrice - slippageAmount; // Lower price due to slippage
      
      // Calculate SOL received (before fees)
      const solBeforeFees = tokensToSell * executionPrice;
      
      // Calculate fees (in SOL)
      const tradingFee = state.config.enableFees
        ? solBeforeFees * (state.config.tradingFeePercentage / 100)
        : 0;
      const networkFee = state.config.enableFees 
        ? state.config.networkFeeSOL 
        : 0;
      const totalFees = tradingFee + networkFee;
      
      // Final SOL received after fees
      const solReceived = solBeforeFees - totalFees;
      
      // TODO #2: Capture balance BEFORE trade for real-time tracking
      const balanceBefore = {
        sol: state.portfolio.balanceSOL,
        usdc: state.portfolio.balanceUSDC,
        tokens: position.amount,
        totalValueUSD: state.portfolio.totalValueUSD,
      };
      
      // Calculate realized P&L (in SOL)
      const costBasisSOL = tokensToSell * position.averageEntryPrice;
      const realizedPnL = solReceived - costBasisSOL;
      const realizedPnLUSD = realizedPnL * marketData.solPrice;
      
      // Create trade record
      const trade: PaperTrade = {
        id: uuidv4(),
        strategyId,
        strategyName,
        timestamp: Date.now(),
        type: 'sell',
        tokenAddress,
        tokenSymbol: marketData.tokenSymbol || 'TOKEN',
        orderType: 'market',
        requestedAmount: actualTokenAmount,
        executedAmount: actualTokenAmount,
        marketPrice: basePrice,
        executionPrice,
        priceUSD: marketData.priceUSD,
        solPriceUSD: marketData.solPrice,
        amountSOL: solReceived,
        amountTokens: tokensToSell,
        tradingFee,
        networkFee,
        slippage: slippageAmount,
        totalCost: solBeforeFees,
        balanceSOL: state.portfolio.balanceSOL + solReceived, // ADD SOL received
        balanceUSDC: state.portfolio.balanceUSDC,
        balanceTokens: position.amount - tokensToSell, // SUBTRACT tokens sold
        realizedPnL,
        trigger,
      };
      
      // Update portfolio
      portfolio.addTrade(trade);
      state.portfolio = portfolio.getPortfolio();
      state.lastTradeTime = trade.timestamp;
      state.metrics = await portfolio.calculateMetrics(strategyId, strategyName);
      
      // Emit real-time balance update IMMEDIATELY after SELL trade
      if (this.io) {
        const balanceAfter = {
          sol: state.portfolio.balanceSOL,
          usdc: state.portfolio.balanceUSDC,
          tokens: portfolio.getPosition(tokenAddress)?.amount || 0,
          totalValueUSD: state.metrics.totalValueUSD,
        };

        // ENHANCED: Get token-specific data (may be null if fully closed)
        const position = portfolio.getPosition(tokenAddress);
        const tokenSymbol = marketData.tokenSymbol || 'TOKEN';

        const balanceUpdateEvent = {
          sessionId,
          timestamp: Date.now(),
          tradeId: trade.id,
          tradeType: 'sell',
          
          // Before/After snapshots with millisecond precision
          before: {
            balanceSOL: balanceBefore.sol,
            balanceUSDC: balanceBefore.usdc,
            balanceTokens: balanceBefore.tokens,
            totalValueUSD: balanceBefore.totalValueUSD,
          },
          after: {
            balanceSOL: balanceAfter.sol,
            balanceUSDC: balanceAfter.usdc,
            balanceTokens: balanceAfter.tokens,
            totalValueUSD: balanceAfter.totalValueUSD,
          },
          
          // Deltas with millisecond precision
          deltas: {
            solDelta: balanceAfter.sol - balanceBefore.sol,
            usdcDelta: balanceAfter.usdc - balanceBefore.usdc,
            tokenDelta: balanceAfter.tokens - balanceBefore.tokens,
            totalValueDeltaUSD: balanceAfter.totalValueUSD - balanceBefore.totalValueUSD,
          },

          // NEW: Primiary token info for UI
          primaryToken: {
            address: tokenAddress,
            symbol: tokenSymbol,
            balance: balanceAfter.tokens,
            balanceBefore: balanceBefore.tokens,
            balanceDelta: balanceAfter.tokens - balanceBefore.tokens,
          },
          
          // Available capital
          availableCapital: {
            sol: balanceAfter.sol,
            usdc: balanceAfter.usdc,
            totalUSD: (balanceAfter.sol * marketData.solPrice) + balanceAfter.usdc,
            marginUsed: 0, // For future margin trading
          },
          
          // Trade execution details
          executionDetails: {
            tokensSold: tokensToSell,
            solReceived: solReceived,
            fees: tradingFee + networkFee,
            slippage: slippageAmount,
            realizedPnL: realizedPnL,
            realizedPnLUSD: realizedPnLUSD,
            tokenSymbol: tokenSymbol,
            executionPrice: executionPrice,
          },

          // NEW: Token position (empty if fully closed)
          tokenPositions: position ? [{
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol || tokenSymbol,
            amount: position.amount,
            valueSOL: position.currentValueSOL,
            valueUSD: position.currentValueUSD,
            unrealizedPnL: position.unrealizedPnL,
            unrealizedPnLPercentage: position.unrealizedPnLPercentage,
          }] : [], // Empty array if no position
        };

        this.io.emit('paper:balance:update', balanceUpdateEvent);
        console.log('💰 [Balance Update] SOL: %s → %s, Tokens: %s → %s, P&L: $%s', 
          balanceBefore.sol.toFixed(6), balanceAfter.sol.toFixed(6),
          balanceBefore.tokens.toFixed(2), balanceAfter.tokens.toFixed(2),
          realizedPnLUSD.toFixed(4)
        );
      }
      
      this.log(
        sessionId, 
        'trade', 
        `Sell TOKEN executed: ${tokensToSell.toFixed(4)} tokens for ${solReceived.toFixed(6)} SOL`,
        { 
          trade,
          realizedPnL,
          realizedPnLUSD,
          tokenAddress 
        }
      );
      
      await awsLogger.info('Paper trade executed (SELL TOKEN→SOL)', {
        metadata: {
          sessionId,
          tokenAddress,
          tokensAmount: tokensToSell,
          solReceived,
          executionPrice,
          realizedPnL,
          realizedPnLUSD,
          trigger,
        }
      });
      
      // Emit WebSocket event
      if (this.io) {
        // Standardize event structure to match BUY events (comprehensive metrics, proper formatting)
        const sessionDuration = (Date.now() - state.startTime) / 60000; // in minutes
        const tradesPerMinute = sessionDuration > 0 ? state.trades.length / sessionDuration : 0;
        const allocationPercentage = state.metrics.totalValueUSD > 0 
          ? ((state.portfolio.balanceTokens * marketData.priceUSD) / state.metrics.totalValueUSD) * 100 
          : 0;
        
        const eventData = {
          sessionId,
          side: 'sell',
          type: 'sell', // Add type for compatibility with frontend
          amount: tokensToSell, // Keep for backward compatibility
          amountTokens: tokensToSell, // Consistent naming with BUY
          amountSOL: solReceived,
          amountUSD: realizedPnLUSD, // USD value received (P&L)
          price: basePrice, // Token price in SOL
          priceUSD: marketData.priceUSD, // Token price in USD
          tokenSymbol: marketData.tokenSymbol || 'TOKEN', // Consistent with BUY event
          solPriceUSD: marketData.solPrice,
          baseToken: marketData.tokenSymbol || 'TOKEN',
          quoteToken: 'SOL',
          pnl: realizedPnL, // Realized P&L in SOL
          pnlUSD: realizedPnLUSD, // Realized P&L in USD
          timestamp: trade.timestamp,
          executionTimeMs: Date.now() - trade.timestamp, // Execution latency
          tradeId: trade.id,
          totalTrades: state.trades.length,
          
          // Enhanced fee breakdown (consistent with BUY)
          fees: {
            tradingFee: tradingFee,
            tradingFeeUSD: tradingFee * marketData.solPrice,
            networkFee: networkFee,
            networkFeeUSD: networkFee * marketData.solPrice,
            totalFees: totalFees,
            totalFeesUSD: totalFees * marketData.solPrice,
            feePercentage: (totalFees / solReceived) * 100
          },
          
          // Slippage impact (consistent with BUY)
          slippage: {
            amount: slippageAmount,
            amountUSD: slippageAmount * marketData.solPrice,
            percentage: state.config.slippagePercentage,
            impactOnPrice: (slippageAmount / basePrice) * 100
          },
          
          // Position details (consistent with BUY)
          position: {
            tokenAddress: tokenAddress,
            tokenSymbol: marketData.tokenSymbol || 'TOKEN',
            size: state.portfolio.balanceTokens, // Remaining position
            sizeUSD: state.portfolio.balanceTokens * marketData.priceUSD,
            averageEntryPrice: position?.averageEntryPrice || basePrice,
            costBasis: position?.totalInvestedSOL || 0,
            costBasisUSD: position?.totalInvestedUSD || 0,
            realizedPnL: realizedPnL,
            realizedPnLUSD: realizedPnLUSD,
            allocationPercentage: allocationPercentage,
            totalPositionSize: state.portfolio.balanceTokens
          },
          
          // Balance changes (consistent with BUY)
          balanceDeltas: {
            solDelta: solReceived - totalFees, // Positive (received SOL)
            usdcDelta: 0,
            tokenDelta: -tokensToSell, // Negative (sold tokens)
            totalValueDelta: realizedPnLUSD
          },
          
          // Current balances after trade (consistent with BUY)
          balances: {
            solBalance: state.portfolio.balanceSOL,
            usdcBalance: state.portfolio.balanceUSDC,
            tokenBalance: state.portfolio.balanceTokens,
            totalValueUSD: state.metrics.totalValueUSD,
            availableCash: state.portfolio.balanceSOL + state.portfolio.balanceUSDC / marketData.solPrice
          },
          
          // Execution details (consistent with BUY)
          execution: {
            orderType: 'market',
            requestedAmount: tokensToSell,
            executedAmount: tokensToSell,
            executionPrice: executionPrice,
            marketPrice: basePrice,
            priceDeviation: ((executionPrice - basePrice) / basePrice) * 100,
            fillRate: 100
          },
          
          // Trading velocity (consistent with BUY)
          velocity: {
            tradesPerMinute: tradesPerMinute,
            sessionDuration: sessionDuration,
            averageTradeInterval: sessionDuration > 0 ? sessionDuration / state.trades.length : 0
          },
          
          strategyInfo: {
            strategyId: strategyId,
            strategyName: strategyName,
            trigger: trigger
          },
          
          // Comprehensive metrics (consistent with BUY)
          metrics: {
            totalTrades: state.metrics.totalTrades,
            roi: state.metrics.roi,
            totalPnLPercentage: state.metrics.totalPnLPercentage,
            totalPnL: state.metrics.totalPnL,
            totalPnLUSD: state.metrics.totalPnLUSD,
            winRate: state.metrics.winRate,
            profitFactor: state.metrics.profitFactor || 0,
            sharpeRatio: state.metrics.sharpeRatio || 0,
            maxDrawdown: state.metrics.maxDrawdown || 0,
            averageWin: state.metrics.averageWin || 0,
            averageLoss: state.metrics.averageLoss || 0,
            winningTrades: state.metrics.winningTrades || 0,
            losingTrades: state.metrics.losingTrades || 0,
            totalFeesUSD: state.metrics.totalFeesUSD || 0,
            executionsPerMin: state.metrics.duration > 0 
              ? (state.metrics.totalTrades / (state.metrics.duration / 60000)) 
              : 0,
            realizedPnL: state.metrics.realizedPnL,
            realizedPnLUSD: state.metrics.realizedPnLUSD
          },
          
          // FLATTENED METRICS AT TOP LEVEL - for frontend compatibility (consistent with BUY)
          winningTrades: state.metrics.winningTrades || 0,
          losingTrades: state.metrics.losingTrades || 0,
          winRate: state.metrics.winRate,
          profitFactor: state.metrics.profitFactor || 0,
          sharpeRatio: state.metrics.sharpeRatio || 0,
          maxDrawdown: state.metrics.maxDrawdown || 0,
          roi: state.metrics.roi,
          avgWin: state.metrics.averageWin || 0,
          avgLoss: state.metrics.averageLoss || 0,
          tokenAddress: tokenAddress
        };
        
        console.log('📡 Emitting paper:trade:executed (SELL TOKEN→SOL) - FLATTENED METRICS:', {
          'TOP_LEVEL.winRate': eventData.winRate,
          'TOP_LEVEL.profitFactor': eventData.profitFactor,
          'TOP_LEVEL.sharpeRatio': eventData.sharpeRatio,
          'NESTED.metrics.winRate': eventData.metrics.winRate,
          'NESTED.metrics.profitFactor': eventData.metrics.profitFactor,
          tokensToSell: tokensToSell.toFixed(4),
          solReceived: solReceived.toFixed(6),
          realizedPnL: realizedPnLUSD.toFixed(4)
        });
        
        this.io.emit('paper:trade:executed', eventData);
        console.log(`📊 [PaperTradingEngine] Emitted SELL TOKEN→SOL trade execution to UI (total trades: ${state.trades.length})`);
        
        const simulationData = {
          sessionId,
          type: 'sell_executed',
          timestamp: Date.now(),
          portfolioSnapshot: {
            balanceSOL: state.portfolio.balanceSOL,
            balanceUSDC: state.portfolio.balanceUSDC,
            balanceTokens: state.portfolio.balanceTokens,
            totalValueUSD: state.metrics.totalValueUSD,
            totalPnL: state.metrics.totalPnL,
            totalPnLUSD: state.metrics.totalPnLUSD,
            totalPnLPercentage: state.metrics.totalPnLPercentage,
            winRate: state.metrics.winRate,
            totalTrades: state.trades.length,
            winningTrades: state.metrics.winningTrades,
            losingTrades: state.metrics.losingTrades,
            realizedPnL: state.metrics.realizedPnL,
            realizedPnLUSD: state.metrics.realizedPnLUSD
          },
          currentPrice: basePrice,
          currentPriceUSD: marketData.priceUSD,
          solPriceUSD: marketData.solPrice,
          tokenSymbol: marketData.tokenSymbol || 'TOKEN',
          tokenAddress,
          strategyInfo: {
            strategyId: strategyId,
            strategyName: strategyName,
            executionCount: state.trades.length
          },
          tradeDetails: {
            tradeId: trade.id,
            type: 'sell',
            amountTokens: tokensToSell,
            solReceived: solReceived,
            executionPrice: basePrice,
            marketPrice: basePrice,
            fees: {
              tradingFee,
              networkFee,
              totalFees,
              slippage: slippageAmount
            },
            realizedPnL,
            realizedPnLUSD,
            timestamp: trade.timestamp
          }
        };
        
        this.io.emit('paper:simulation:update', simulationData);
      }
      
      return {
        success: true,
        trade,
      };
    } catch (error) {
      this.log(sessionId, 'error', 'Sell TOKEN order execution failed', {
        error: error instanceof Error ? error.message : String(error),
        tokenAddress,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get metrics for a session
   */
  async getMetrics(sessionId: string): Promise<PaperTradingMetrics | null> {
    const state = this.sessions.get(sessionId);
    
    if (!state) {
      return null;
    }

    return state.metrics;
  }

  /**
   * Get all trades for a session
   */
  getTrades(sessionId: string): PaperTrade[] {
    const state = this.sessions.get(sessionId);
    return state ? state.trades : [];
  }

  /**
   * Get logs for a session
   */
  getLogs(sessionId: string): PaperTradingLog[] {
    return this.logs.get(sessionId) || [];
  }

  /**
   * Pause a paper trading session
   */
  pauseSession(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    
    if (state) {
      state.isActive = false;
      this.log(sessionId, 'info', 'Session paused');
      return true;
    }
    
    return false;
  }

  /**
   * Resume a paper trading session
   */
  resumeSession(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    
    if (state) {
      state.isActive = true;
      this.log(sessionId, 'info', 'Session resumed');
      return true;
    }
    
    return false;
  }

  /**
   * End a paper trading session
   */
  async endSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    
    if (state) {
      state.isActive = false;
      
      const portfolio = new PaperTradingPortfolio(0, 0);
      portfolio.importState({ portfolio: state.portfolio, trades: state.trades, startTime: state.startTime });
      
      state.metrics = await portfolio.calculateMetrics(state.metrics.strategyId, state.metrics.strategyName);
      
      this.log(sessionId, 'info', 'Session ended', {
        metrics: state.metrics,
      });

      await awsLogger.info('Paper trading session ended', {
        metadata: {
          sessionId,
          totalTrades: state.trades.length,
          totalPnL: state.metrics.totalPnL,
          roi: state.metrics.roi,
        }
      });

      return true;
    }
    
    return false;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): PaperTradingState[] {
    return Array.from(this.sessions.values()).filter(s => s.isActive);
  }

  /**
   * Check if paper trading is enabled for a session
   */
  isEnabled(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return state?.config.enabled || false;
  }

  /**
   * Update session configuration
   */
  updateConfig(sessionId: string, config: Partial<PaperTradingConfig>): boolean {
    const state = this.sessions.get(sessionId);
    
    if (state) {
      state.config = { ...state.config, ...config };
      this.log(sessionId, 'info', 'Configuration updated', { config });
      return true;
    }
    
    return false;
  }

  /**
   * Reset a session to initial state
   */
  async resetSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    
    if (state) {
      const portfolio = new PaperTradingPortfolio(
        state.config.initialBalanceSOL,
        state.config.initialBalanceUSDC
      );

      state.portfolio = portfolio.getPortfolio();
      state.trades = [];
      state.metrics = await portfolio.calculateMetrics();
      state.startTime = Date.now();
      state.lastTradeTime = undefined;

      // Clear logs
      this.logs.set(sessionId, []);
      
      this.log(sessionId, 'info', 'Session reset');
      return true;
    }
    
    return false;
  }

  /**
   * Log an event
   */
  private log(
    sessionId: string,
    level: 'info' | 'warning' | 'error' | 'trade',
    message: string,
    metadata?: Record<string, any>
  ): void {
    const logs = this.logs.get(sessionId) || [];
    
    logs.push({
      timestamp: Date.now(),
      level,
      message,
      metadata,
    });

    this.logs.set(sessionId, logs);

    // Keep only last 1000 logs per session
    if (logs.length > 1000) {
      logs.shift();
    }
  }

  /**
   * Get default configuration
   */
  getDefaultConfig(): PaperTradingConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      this.logs.delete(sessionId);
      //console.log(`Paper trading session deleted: ${sessionId}`);
    }
    return deleted;
  }

  /**
   * Stream trade history with pagination
   * Get paginated trade history for a session
   */
  getTradeHistory(sessionId: string, limit: number = 100, offset: number = 0): PaperTrade[] {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return [];
    }

    // Return trades in reverse chronological order (newest first)
    const sortedTrades = [...state.trades].reverse();
    return sortedTrades.slice(offset, offset + limit);
  }

  /**
   * Emit trade history on WebSocket connection
   * Call this when a client connects to stream recent trades
   */
  async emitTradeHistory(sessionId: string, limit: number = 100): Promise<void> {
    if (!this.io) {
      return;
    }

    const trades = this.getTradeHistory(sessionId, limit);
    const state = this.sessions.get(sessionId);
    
    if (!state) {
      return;
    }

    const tradeHistoryEvent = {
      sessionId,
      timestamp: Date.now(),
      totalTrades: state.trades.length,
      trades: trades.map(trade => ({
        tradeId: trade.id,
        timestamp: trade.timestamp,
        side: trade.type,
        quantity: trade.type === 'buy' ? trade.amountSOL : trade.amountTokens,
        price: trade.executionPrice,
        priceUSD: trade.priceUSD,
        totalValue: trade.totalCost,
        fees: {
          tradingFee: trade.tradingFee,
          networkFee: trade.networkFee,
          total: trade.tradingFee + trade.networkFee,
        },
        pnl: trade.realizedPnL || 0,
        runningBalance: {
          sol: trade.balanceSOL,
          usdc: trade.balanceUSDC,
          tokens: trade.balanceTokens,
        },
        trigger: trade.trigger,
        strategyName: trade.strategyName,
      })),
    };

    this.io.emit('paper:trade:history', tradeHistoryEvent);
    console.log(`📜 [Trade History] Emitted ${trades.length} trades for session ${sessionId}`);
  }

  /**
   * Calculate and emit real-time risk metrics
   */
  async calculateRiskMetrics(sessionId: string): Promise<any> {
    const state = this.sessions.get(sessionId);
    if (!state || state.trades.length === 0) {
      return null;
    }

    const metrics = state.metrics;
    const trades = state.trades;
    
    // Calculate Sharpe Ratio (simplified - assuming daily returns)
    const returns = trades
      .filter(t => t.realizedPnL !== undefined)
      .map(t => t.realizedPnL || 0);
    
    const avgReturn = returns.length > 0 
      ? returns.reduce((sum, r) => sum + r, 0) / returns.length 
      : 0;
    
    const variance = returns.length > 1
      ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1)
      : 0;
    
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized
    
    // Win/Loss analysis
    const profitableTrades = trades.filter(t => (t.realizedPnL || 0) > 0);
    const losingTrades = trades.filter(t => (t.realizedPnL || 0) < 0);
    
    const totalWins = profitableTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
    const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0));
    
    const winLossRatio = profitableTrades.length > 0 && losingTrades.length > 0
      ? profitableTrades.length / losingTrades.length
      : profitableTrades.length > 0 ? Infinity : 0;
    
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;
    
    const averageWin = profitableTrades.length > 0 
      ? totalWins / profitableTrades.length 
      : 0;
    
    const averageLoss = losingTrades.length > 0 
      ? totalLosses / losingTrades.length 
      : 0;
    
    // Largest win/loss
    const largestWin = profitableTrades.length > 0
      ? Math.max(...profitableTrades.map(t => t.realizedPnL || 0))
      : 0;
    
    const largestLoss = losingTrades.length > 0
      ? Math.min(...losingTrades.map(t => t.realizedPnL || 0))
      : 0;
    
    // Consecutive wins/losses
    let consecutiveWins = 0;
    let consecutiveLosses = 0;
    let currentStreak = 0;
    let isWinStreak = false;
    
    for (const trade of trades) {
      const isWin = (trade.realizedPnL || 0) > 0;
      
      if (currentStreak === 0) {
        currentStreak = 1;
        isWinStreak = isWin;
      } else if ((isWinStreak && isWin) || (!isWinStreak && !isWin)) {
        currentStreak++;
      } else {
        if (isWinStreak) {
          consecutiveWins = Math.max(consecutiveWins, currentStreak);
        } else {
          consecutiveLosses = Math.max(consecutiveLosses, currentStreak);
        }
        currentStreak = 1;
        isWinStreak = isWin;
      }
    }
    
    // Update final streak
    if (isWinStreak) {
      consecutiveWins = Math.max(consecutiveWins, currentStreak);
    } else {
      consecutiveLosses = Math.max(consecutiveLosses, currentStreak);
    }
    
    // Risk-Reward Ratio
    const riskRewardRatio = averageLoss > 0 ? averageWin / averageLoss : 0;
    
    // Volatility (standard deviation of returns)
    const volatility = stdDev;

    const riskMetrics = {
      sessionId,
      timestamp: Date.now(),
      maxDrawdown: metrics.maxDrawdown,
      sharpeRatio,
      winLossRatio,
      profitFactor,
      averageWin,
      averageLoss,
      largestWin,
      largestLoss,
      consecutiveWins,
      consecutiveLosses,
      riskRewardRatio,
      volatility,
      totalTrades: trades.length,
      winningTrades: profitableTrades.length,
      losingTrades: losingTrades.length,
      winRate: metrics.winRate,
    };

    return riskMetrics;
  }

  /**
   * Start emitting risk metrics every 2 seconds
   */
  startRiskMetricsEmission(sessionId: string): NodeJS.Timeout {
    const interval = setInterval(async () => {
      const riskMetrics = await this.calculateRiskMetrics(sessionId);
      if (riskMetrics && this.io) {
        this.io.emit('paper:risk:metrics', riskMetrics);
      }
    }, 2000); // Every 2 seconds

    return interval;
  }
  /**
   * Track trade execution performance
   */
  async calculateExecutionStats(sessionId: string): Promise<any> {
    const state = this.sessions.get(sessionId);
    if (!state || state.trades.length === 0) {
      return null;
    }

    const trades = state.trades;
    const now = Date.now();
    const sessionDuration = now - state.startTime;
    
    // Calculate average execution time (simplified - would need actual tracking)
    const avgExecutionTime = 150; // ms (placeholder)
    
    // Calculate slippage statistics
    const slippages = trades.map(t => {
      const expectedPrice = t.marketPrice;
      const actualPrice = t.executionPrice;
      return Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;
    });
    
    const avgSlippage = slippages.length > 0
      ? slippages.reduce((sum, s) => sum + s, 0) / slippages.length
      : 0;
    
    const maxSlippage = slippages.length > 0 ? Math.max(...slippages) : 0;
    
    // Failed trades (would need actual tracking)
    const failedTrades = 0; // Placeholder
    
    // Success rate
    const successRate = trades.length > 0
      ? ((trades.length - failedTrades) / trades.length) * 100
      : 100;
    
    // API response times (placeholder)
    const avgApiResponseTime = 250; // ms
    
    const executionStats = {
      sessionId,
      timestamp: now,
      orderFillTime: avgExecutionTime,
      avgSlippage,
      maxSlippage,
      executionLatency: avgExecutionTime,
      failedTrades,
      retryAttempts: 0, // Placeholder
      avgApiResponseTime,
      successRate,
      totalExecutions: trades.length,
      tradesPerMinute: (trades.length / (sessionDuration / 60000)) || 0,
    };

    return executionStats;
  }

  /**
   * Start emitting execution stats every 5 seconds
   */
  startExecutionStatsEmission(sessionId: string): NodeJS.Timeout {
    const interval = setInterval(async () => {
      const executionStats = await this.calculateExecutionStats(sessionId);
      if (executionStats && this.io) {
        this.io.emit('paper:execution:stats', executionStats);
      }
    }, 5000); // Every 5 seconds

    return interval;
  }

  /**
   * Calculate position-level P&L tracking
   */
  async calculatePositionUpdates(sessionId: string, tokenAddress: string): Promise<any> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }

    const portfolio = new PaperTradingPortfolio(
      state.config.initialBalanceSOL,
      state.config.initialBalanceUSDC
    );
    
    // Restore portfolio state
    for (const trade of state.trades) {
      portfolio.addTrade(trade);
    }

    const position = portfolio.getPosition(tokenAddress);
    if (!position) {
      return null;
    }

    // Fetch current market price
    const marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);
    if (!marketData) {
      return null;
    }

    const currentPrice = marketData.price;
    const currentPriceUSD = marketData.priceUSD;
    const solPriceUSD = marketData.solPrice;
    
    // Calculate days held
    const positionAge = Date.now() - position.firstTradeTimestamp;
    const daysHeld = positionAge / (1000 * 60 * 60 * 24);
    
    // Mark-to-market value
    const markToMarketValue = position.amount * currentPrice;
    const markToMarketValueUSD = markToMarketValue * solPriceUSD;
    
    // Calculate cost basis
    const costBasis = position.totalInvestedSOL;
    const realizedPnL = 0; // Position doesn't track realized P&L, need to calculate from trades
    
    const positionUpdate = {
      sessionId,
      tokenAddress,
      timestamp: Date.now(),
      
      currentMarketValue: markToMarketValue,
      currentMarketValueUSD: markToMarketValueUSD,
      
      unrealizedPnL: position.unrealizedPnL,
      unrealizedPnLUSD: position.unrealizedPnL * solPriceUSD,
      unrealizedPnLPercentage: position.unrealizedPnLPercentage,
      
      realizedPnL,
      realizedPnLUSD: realizedPnL * solPriceUSD,
      
      averageEntryPrice: position.averageEntryPrice,
      currentPrice,
      currentPriceUSD,
      
      positionSize: position.amount,
      costBasis,
      
      daysHeld,
      markToMarketValue,
      markToMarketValueUSD,
      
      priceChange: ((currentPrice - position.averageEntryPrice) / position.averageEntryPrice) * 100,
    };

    return positionUpdate;
  }

  /**
   * Emit position updates on price changes
   */
  async emitPositionUpdate(sessionId: string, tokenAddress: string): Promise<void> {
    if (!this.io) {
      return;
    }

    const positionUpdate = await this.calculatePositionUpdates(sessionId, tokenAddress);
    if (positionUpdate) {
      this.io.emit('paper:position:update', positionUpdate);
    }
  }

  /**
   * Calculate comprehensive session statistics
   */
  async calculateSessionStats(sessionId: string): Promise<any> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }

    const now = Date.now();
    const sessionDuration = now - state.startTime;
    const trades = state.trades;
    
    // Total volume
    const totalVolumeUSD = trades.reduce((sum, t) => {
      return sum + (t.amountSOL * t.solPriceUSD);
    }, 0);
    
    // Average trade size
    const avgTradeSize = trades.length > 0 
      ? totalVolumeUSD / trades.length 
      : 0;
    
    // Trading frequency
    const tradesPerHour = (trades.length / (sessionDuration / 3600000)) || 0;
    
    // Busiest trading hour (simplified)
    const hourlyTrades = new Map<number, number>();
    trades.forEach(trade => {
      const hour = new Date(trade.timestamp).getHours();
      hourlyTrades.set(hour, (hourlyTrades.get(hour) || 0) + 1);
    });
    
    let busiestHour = 0;
    let maxTradesInHour = 0;
    hourlyTrades.forEach((count, hour) => {
      if (count > maxTradesInHour) {
        maxTradesInHour = count;
        busiestHour = hour;
      }
    });
    
    // Portfolio turnover (total traded / average portfolio value)
    const avgPortfolioValue = state.metrics.totalValueUSD;
    const portfolioTurnover = avgPortfolioValue > 0 
      ? (totalVolumeUSD / avgPortfolioValue) * 100 
      : 0;
    
    // Capital utilization
    const initialCapitalUSD = state.config.initialBalanceSOL * 200 + state.config.initialBalanceUSDC;
    const currentCashUSD = state.portfolio.balanceSOL * 200 + state.portfolio.balanceUSDC;
    const capitalUtilization = initialCapitalUSD > 0
      ? ((initialCapitalUSD - currentCashUSD) / initialCapitalUSD) * 100
      : 0;
    
    // Idle time (time without trades)
    let idleTime = 0;
    for (let i = 1; i < trades.length; i++) {
      const timeBetween = trades[i].timestamp - trades[i - 1].timestamp;
      if (timeBetween > 300000) { // More than 5 minutes
        idleTime += timeBetween;
      }
    }
    const idleTimePercentage = (idleTime / sessionDuration) * 100;

    const sessionStats = {
      sessionId,
      timestamp: now,
      totalTrades: trades.length,
      totalVolumeUSD,
      avgTradeSize,
      tradingFrequency: tradesPerHour,
      sessionDuration,
      sessionDurationHours: sessionDuration / 3600000,
      tradesPerHour,
      busiestTradingHour: busiestHour,
      maxTradesInHour,
      portfolioTurnover,
      capitalUtilization,
      availableCash: currentCashUSD,
      idleTime,
      idleTimePercentage,
      
      // Additional metrics
      buyTrades: trades.filter(t => t.type === 'buy').length,
      sellTrades: trades.filter(t => t.type === 'sell').length,
      avgTimeBetweenTrades: trades.length > 1 
        ? sessionDuration / (trades.length - 1) 
        : 0,
    };

    return sessionStats;
  }

  /**
   * Start emitting session stats every 10 seconds
   */
  startSessionStatsEmission(sessionId: string): NodeJS.Timeout {
    const interval = setInterval(async () => {
      const sessionStats = await this.calculateSessionStats(sessionId);
      if (sessionStats && this.io) {
        this.io.emit('paper:session:stats', sessionStats);
      }
    }, 10000); // Every 10 seconds

    return interval;
  }

  /**
   * Start all monitoring intervals for a strategy
   */
  startComprehensiveMonitoring(sessionId: string): {
    riskMetrics: NodeJS.Timeout;
    executionStats: NodeJS.Timeout;
    sessionStats: NodeJS.Timeout;
  } {
    console.log(`🎯 [Comprehensive Monitoring] Started for session ${sessionId}`);
    
    return {
      riskMetrics: this.startRiskMetricsEmission(sessionId),
      executionStats: this.startExecutionStatsEmission(sessionId),
      sessionStats: this.startSessionStatsEmission(sessionId),
    };
  }

  /**
   * Stop all monitoring intervals
   */
  stopComprehensiveMonitoring(intervals: {
    riskMetrics: NodeJS.Timeout;
    executionStats: NodeJS.Timeout;
    sessionStats: NodeJS.Timeout;
  }): void {
    clearInterval(intervals.riskMetrics);
    clearInterval(intervals.executionStats);
    clearInterval(intervals.sessionStats);
    console.log(`🛑 [Comprehensive Monitoring] Stopped`);
  }
}

// Singleton instance
export const paperTradingEngine = new PaperTradingEngine();
