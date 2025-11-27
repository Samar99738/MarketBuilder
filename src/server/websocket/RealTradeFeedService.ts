/**
 * Real Trade Feed Service
 * 
 * Provides REAL pump.fun trade data to strategies
 * Replaces the Math.random() simulation with actual blockchain monitoring
 */

import { EventEmitter } from 'events';
import { SolanaTradeMonitor } from './SolanaTradeMonitor';
import { PumpFunWebSocketListener } from '../../trading_utils/PumpFunWebSocketListener';
import { RaydiumWebSocketListener } from '../../trading_utils/RaydiumWebSocketListener';
import { JupiterWebSocketListener } from '../../trading_utils/JupiterWebSocketListener';
import { TokenRouter, getTokenRouter } from '../../trading_utils/TokenRouter';
import { Connection } from '@solana/web3.js';
import { Server as SocketServer } from 'socket.io';
import { IDL } from '../../idl/pump.idl';
import type { Idl } from '@coral-xyz/anchor';

export interface RealTradeEvent {
  tokenAddress: string;
  type: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  trader: string;
  signature: string;
  timestamp: number;
  price: number;
  isRealTrade: true;
}

export interface TradeStats {
  tokenAddress: string;
  totalBuys: number;
  totalSells: number;
  totalVolumeSol: number;
  avgBuySize: number;
  avgSellSize: number;
  lastTradeTime: number;
  tradeCount: number;
}

/**
 * Real Trade Feed Service
 * 
 * Manages real-time trade monitoring and provides aggregated data
 * for strategy execution
 */
export class RealTradeFeedService extends EventEmitter {
  private tradeMonitor: SolanaTradeMonitor;
  private webSocketListener?: PumpFunWebSocketListener;
  private raydiumListener?: RaydiumWebSocketListener;
  private jupiterListener?: JupiterWebSocketListener;
  private tokenRouter: TokenRouter;
  private io: SocketServer;
  private rpcUrl: string;
  
  // Trade statistics per token
  private tradeStats: Map<string, TradeStats> = new Map();
  
  // Recent trades buffer (last 100 trades per token)
  private recentTrades: Map<string, RealTradeEvent[]> = new Map();
  private readonly MAX_TRADES_PER_TOKEN = 100;
  
  // Token activity tracking
  private tokenActivity: Map<string, {
    buyVolumeLast5Min: number;
    sellVolumeLast5Min: number;
    lastCheck: number;
  }> = new Map();
  
  // Connection health monitoring
  private lastTradeTimestamp: number = Date.now();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly CONNECTION_TIMEOUT_MS = 120000; // 2 minutes
  private connectionStale: boolean = false;
  
  // Token metadata cache (symbol, name, etc.)
  private tokenMetadata: Map<string, { symbol?: string; name?: string }> = new Map();

  constructor(io: SocketServer, rpcUrl?: string) {
    super();
    this.io = io;
    this.rpcUrl = rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.tradeMonitor = new SolanaTradeMonitor(io, rpcUrl);
    
    // Initialize token router for smart routing
    const connection = new Connection(this.rpcUrl, 'confirmed');
    this.tokenRouter = getTokenRouter(connection);
    
    // Initialize PumpFun WebSocket Listener (bonding curve tokens only)
    this.webSocketListener = new PumpFunWebSocketListener(
      this.rpcUrl,
      IDL as Idl
    );

    // Initialize Raydium WebSocket Listener (graduated tokens)
    this.raydiumListener = new RaydiumWebSocketListener(this.rpcUrl);

    // Initialize Jupiter WebSocket Listener (aggregator trades - captures most DexScreener trades)
    this.jupiterListener = new JupiterWebSocketListener(this.rpcUrl);
    
    this.setupEventHandlers();
    this.setupEventForwarding();
    this.startHealthMonitoring();
  }

  // Event forwarding from monitors to service
  private setupEventForwarding(): void {
    // Listen for real trades from the poller (pump.fun API) via socket events
    // The PumpFunTradePoller emits 'pumpfun:real_trade' events via socket.io
  }

  // Store active strategy filters per token
  private strategyFilters: Map<string, { trigger: string; side: string }> = new Map();

  public registerStrategyFilter(tokenAddress: string, trigger: string, side: string): void {
    const normalized = tokenAddress.toLowerCase();
    this.strategyFilters.set(normalized, { trigger, side });
    console.log(`🎯 [RealTradeFeedService] Registered filter for ${tokenAddress.substring(0, 8)}...`);
    console.log(`   - Trigger: ${trigger}`);
    console.log(`   - Side: ${side}`);
    console.log(`   - Will only forward ${trigger.includes('buy') ? 'BUY' : 'SELL'} trades to strategy`);
  }

  /**
   * Unregister strategy filter
   */
  public unregisterStrategyFilter(tokenAddress: string): void {
    const normalized = tokenAddress.toLowerCase();
    this.strategyFilters.delete(normalized);
    console.log(`🗑️ [RealTradeFeedService] Removed filter for ${tokenAddress.substring(0, 8)}...`);
  }

  /**
   * Check if trade should be forwarded based on strategy filters
   * FIX #4: Corrected filter logic - mirror_buy_activity means "watch for BUYs to trigger SELL"
   */
  private shouldForwardTrade(trade: RealTradeEvent): boolean {
    const normalized = trade.tokenAddress.toLowerCase();
    const filter = this.strategyFilters.get(normalized);
    
    console.log(`\n🔍 [FILTER CHECK] Token: ${normalized.substring(0, 8)}...`);
    console.log(`🔍 [FILTER CHECK] Trade Type: ${trade.type}`);
    console.log(`🔍 [FILTER CHECK] Filter Exists: ${!!filter}`);
    
    if (!filter) {
      // No filter = forward all trades (for UI display)
      console.log(`🔍 [FILTER CHECK] No filter registered - forwarding all trades`);
      console.log(`🔍 [FILTER CHECK] Current filters:`, Array.from(this.strategyFilters.keys()).map(k => k.substring(0, 8)));
      return true;
    }
    
    console.log(`🔍 [FILTER CHECK] Filter trigger: ${filter.trigger}, side: ${filter.side}`);
    
    // FIX #4: Correct reactive strategy logic
    // mirror_buy_activity = watching for BUYs (strategy will execute SELL when detected)
    // mirror_sell_activity = watching for SELLs (strategy will execute BUY when detected)
    // So we forward the SAME type that the trigger is watching for
    const watchingFor = filter.trigger.includes('buy') ? 'buy' : 'sell';
    
    console.log(`🔍 [FILTER CHECK] Watching for: ${watchingFor}, Trade type: ${trade.type}`);
    
    const matches = trade.type === watchingFor;
    
    if (!matches) {
      console.log(`🔇 [FILTER] ${trade.type.toUpperCase()} trade FILTERED OUT (watching for ${watchingFor.toUpperCase()}, strategy will ${filter.side.toUpperCase()})`);
    } else {
      console.log(`✅ [FILTER] ${trade.type.toUpperCase()} trade MATCHES filter (watching for ${watchingFor.toUpperCase()}, strategy will ${filter.side.toUpperCase()})`);
    }
    
    return matches;
  }

  // Unified trade handler - THIS IS WHERE REAL TRADES ENTER THE SYSTEM
  private async handleRealTrade(trade: RealTradeEvent): Promise<void> {
    try {
      const { tokenAddress } = trade;
      
      // Update health check timestamp
      this.updateLastTradeTimestamp();
      
      // Get token metadata if available
      const metadata = this.tokenMetadata.get(tokenAddress.toLowerCase());
      const tokenDisplay = metadata?.symbol || metadata?.name || tokenAddress.substring(0, 8) + '...';
      
      // Calculate USD price (fetch SOL price and multiply)
      let priceUSD = trade.price * 133.52; // Default assumption
      let totalUSD = trade.solAmount * 133.52;
      
      try {
        // Try to get accurate SOL price
        const solPriceResponse = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
        if (solPriceResponse.ok) {
          const solData: any = await solPriceResponse.json();
          if (solData?.pairs?.[0]?.priceUsd) {
            const solPrice = parseFloat(solData.pairs[0].priceUsd);
            priceUSD = trade.price * solPrice;
            totalUSD = trade.solAmount * solPrice;
          }
        }
      } catch (error) {
        // Use default if fetch fails
      }
      
      console.log(`[Trade] ${trade.type.toUpperCase()} | ${tokenDisplay} | ${trade.tokenAmount.toFixed(2)} tokens for ${trade.solAmount.toFixed(4)} SOL (~$${totalUSD.toFixed(2)}) | ${trade.signature.substring(0, 12)}`);
      
      // Store in recent trades (all trades for historical data)
      this.addToRecentTrades(trade);

      // Update statistics (all trades)
      this.updateTradeStats(trade);

      // Create enhanced trade object for strategy consumption
      const enhancedTrade = {
        ...trade,
        tokenSymbol: metadata?.symbol,
        tokenName: metadata?.name
      };
      
      // CRITICAL FIX: ALWAYS send trades to UI for display (users need to see all market activity)
      // But only forward to strategy execution if trade matches filter
      const shouldForwardToStrategy = this.shouldForwardTrade(trade);
      
      // ALWAYS broadcast to WebSocket clients for UI display
      console.log(`🔍 [RealTradeFeedService] ===== EMITTING TO UI =====`);
      console.log(`   trade.type: ${trade.type}`);
      console.log(`   tokenAmount: ${trade.tokenAmount}`);
      console.log(`   solAmount: ${trade.solAmount}`);
      console.log(`   Sending to frontend with type: ${trade.type}`);
      console.log(`=======================================\n`);
      
      this.io.emit('pumpfun:live_trade_detected', {
        tokenAddress,
        type: trade.type,
        solAmount: trade.solAmount,
        tokenAmount: trade.tokenAmount,
        price: priceUSD,
        priceUSD: priceUSD,
        priceSOL: trade.price,
        trader: trade.trader,
        signature: trade.signature,
        timestamp: trade.timestamp,
        isRealBlockchain: true,
        filtered: shouldForwardToStrategy,
        tokenSymbol: metadata?.symbol,
        tokenName: metadata?.name,
        tokenDisplay: metadata?.symbol || metadata?.name || `${tokenAddress.substring(0, 8)}...`,
        totalUSD: totalUSD
      });
      
      // Only forward to strategy if trade matches the filter
      if (shouldForwardToStrategy) {
        console.log(`\n🚀🚀🚀 [STRATEGY TRIGGER] ${trade.type.toUpperCase()} MATCH -> FORWARDING TO STRATEGY 🚀🚀🚀`);
        console.log(`🚀 Token: ${tokenAddress}`);
        console.log(`🚀 Event: trade:${tokenAddress.toLowerCase()}`);
        console.log(`🚀 Trade data:`, { type: trade.type, solAmount: trade.solAmount, tokenAmount: trade.tokenAmount });
        
        const normalizedAddress = tokenAddress.toLowerCase();
        
        // Emit with timestamp to measure latency
        const emitStartTime = Date.now();
        this.emit(`trade:${normalizedAddress}`, enhancedTrade);
        console.log(`🚀 Event emission took: ${Date.now() - emitStartTime}ms`);
        
        const listenerCount = this.listenerCount(`trade:${normalizedAddress}`);
        console.log(`🚀 Event emitted! Listener count: ${listenerCount}`);
        
        if (listenerCount === 0) {
          console.error(`⚠️⚠️⚠️ WARNING: NO LISTENERS registered for trade:${normalizedAddress}!`);
          console.error(`⚠️ Strategy may not be subscribed to this token!`);
          console.error(`⚠️ All registered events:`, this.eventNames());
        }

        this.emit('real_trade', enhancedTrade);
      } else {
        console.log(`[Filter] ${trade.type.toUpperCase()} filtered out (UI only, not triggering strategy)`);
        console.log(`[Filter] Filter for this token:`, this.strategyFilters.get(tokenAddress.toLowerCase()));
      }

      console.log(`✅ [RealTradeFeedService] Trade fully processed`);
    } catch (error) {
      // Don't let one bad trade kill the entire feed
      console.error('[RealTradeFeedService] ❌ Error handling trade:', error);
      console.error('[RealTradeFeedService] Failed trade data:', trade);
    }
  }

  // Helper to store recent trades
  private addToRecentTrades(trade: RealTradeEvent): void {
    if (!this.recentTrades.has(trade.tokenAddress)) {
      this.recentTrades.set(trade.tokenAddress, []);
    }
    
    const trades = this.recentTrades.get(trade.tokenAddress)!;
    trades.push(trade);
    
    // Keep only last MAX_TRADES_PER_TOKEN
    if (trades.length > this.MAX_TRADES_PER_TOKEN) {
      trades.shift();
    }
  }

  // Helper to update stats
  private updateTradeStats(trade: RealTradeEvent): void {
    if (!this.tradeStats.has(trade.tokenAddress)) {
      this.tradeStats.set(trade.tokenAddress, {
        tokenAddress: trade.tokenAddress,
        totalBuys: 0,
        totalSells: 0,
        totalVolumeSol: 0,
        avgBuySize: 0,
        avgSellSize: 0,
        lastTradeTime: 0,
        tradeCount: 0,
      });
    }
    
    const stats = this.tradeStats.get(trade.tokenAddress)!;
    stats.tradeCount++;
    stats.totalVolumeSol += trade.solAmount;
    stats.lastTradeTime = trade.timestamp;
    
    if (trade.type === 'buy') {
      stats.totalBuys++;
      stats.avgBuySize = (stats.avgBuySize * (stats.totalBuys - 1) + trade.solAmount) / stats.totalBuys;
    } else {
      stats.totalSells++;
      stats.avgSellSize = (stats.avgSellSize * (stats.totalSells - 1) + trade.solAmount) / stats.totalSells;
    }
  }


  /**
   * Setup event handlers for trade monitor
   * This connects PumpFunWebSocketListener events to our service
   */
  private setupEventHandlers(): void {
    // Listen for real trades from PumpFun WebSocket Listener (bonding curve only)
    if (this.webSocketListener) {
      this.webSocketListener.on('trade', (tradeData: any) => {
        // Convert PumpFun trade format to RealTradeEvent format
        // CRITICAL: Normalize tokenAddress to lowercase for consistent event matching
        const trade: RealTradeEvent = {
          tokenAddress: tradeData.mint.toLowerCase(),
          type: tradeData.isBuy ? 'buy' : 'sell',
          solAmount: tradeData.solAmount,
          tokenAmount: tradeData.tokenAmount,
          trader: tradeData.user,
          signature: 'pumpfun-' + Date.now(),
          timestamp: tradeData.timestamp * 1000, // Convert to milliseconds
          price: tradeData.solAmount / tradeData.tokenAmount,
          isRealTrade: true,
        };
        
        console.log(`🚀 [RealTradeFeedService] Pump.fun trade detected (bonding curve)`);
        
        this.handleRealTrade(trade);
      });
      
      console.log('[RealTradeFeedService] ✅ Event handlers connected to PumpFunWebSocketListener');
      console.log('[RealTradeFeedService] 🔥 Monitoring pump.fun bonding curve tokens');
    }

    // Listen for real trades from Raydium WebSocket Listener (graduated tokens)
    if (this.raydiumListener) {
      this.raydiumListener.on('trade', (tradeData: any) => {
        const trade: RealTradeEvent = {
          tokenAddress: tradeData.tokenMint.toLowerCase(),
          type: tradeData.isBuy ? 'buy' : 'sell',
          solAmount: tradeData.solAmount,
          tokenAmount: tradeData.tokenAmount,
          trader: tradeData.user,
          signature: tradeData.signature || 'raydium-' + Date.now(),
          timestamp: tradeData.timestamp * 1000,
          price: tradeData.price,
          isRealTrade: true,
        };
        
        this.handleRealTrade(trade);
      });
      
      // Listen for heartbeat events (listener is processing transactions, even if rejecting them)
      this.raydiumListener.on('heartbeat', (data: any) => {
        this.lastTradeTimestamp = Date.now();
      });
      
      console.log('[RealTradeFeedService] ✅ Event handlers connected to RaydiumWebSocketListener');
      console.log('[RealTradeFeedService] 🌊 Monitoring Raydium graduated tokens');
    }

    // Listen for Jupiter aggregator trades (captures most DexScreener trades!)
    if (this.jupiterListener) {
      this.jupiterListener.on('trade', (tradeData: any) => {
        console.log(`\n🔍 [RealTradeFeedService] ===== JUPITER TRADE RECEIVED =====`);
        console.log(`   tradeData.isBuy: ${tradeData.isBuy}`);
        console.log(`   Converting to type: ${tradeData.isBuy ? 'buy' : 'sell'}`);
        console.log(`   tokenAmount: ${tradeData.tokenAmount}`);
        console.log(`   solAmount: ${tradeData.solAmount}`);
        
        const trade: RealTradeEvent = {
          tokenAddress: tradeData.tokenMint.toLowerCase(),
          type: tradeData.isBuy ? 'buy' : 'sell',
          solAmount: tradeData.solAmount,
          tokenAmount: tradeData.tokenAmount,
          trader: tradeData.user,
          signature: tradeData.signature || 'jupiter-' + Date.now(),
          timestamp: tradeData.timestamp * 1000,
          price: tradeData.price,
          isRealTrade: true,
        };
        
        console.log(`   RealTradeEvent.type: ${trade.type}`);
        console.log(`================================================\n`);
        
        this.handleRealTrade(trade);
      });
      
      // Listen for heartbeat events
      this.jupiterListener.on('heartbeat', (data: any) => {
        this.lastTradeTimestamp = Date.now();
      });
      
      console.log('[RealTradeFeedService] ✅ Event handlers connected to JupiterWebSocketListener');
      console.log('[RealTradeFeedService] ⚡ Monitoring Jupiter aggregator routes (CAPTURES MOST DEXSCREENER TRADES)');
    }
  }

  /**
   * Start the service
   */
  start(): void {
    console.log('[RealTradeFeedService] Starting real trade feed service...');
    console.log('[RealTradeFeedService] Service started (using WebSocket real-time monitoring)');
    console.log('[RealTradeFeedService] 🚀 Ready to monitor ANY pump.fun token');
  }

  /**
   * Start monitoring WebSocket connection health
   * Detects if trades stop coming in (connection may be dead)
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, 60000); // Check every minute
    
    console.log('[RealTradeFeedService] 💓 Health monitoring started');
  }

  /**
   * Check if we're still receiving trades
   */
  private checkConnectionHealth(): void {
    // Get monitored tokens from all listeners
    const pumpTokens = this.webSocketListener?.getMonitoredTokens() || [];
    const raydiumTokens = this.raydiumListener?.getMonitoredTokens() || [];
    const jupiterTokens = this.jupiterListener?.getMonitoredTokens() || [];
    const monitoredTokens = [...pumpTokens, ...raydiumTokens, ...jupiterTokens];
    
    if (monitoredTokens.length === 0) {
      return;
    }
    
    const timeSinceLastTrade = Date.now() - this.lastTradeTimestamp;
    const minutesSinceLastTrade = Math.floor(timeSinceLastTrade / 60000);
    
    if (timeSinceLastTrade > this.CONNECTION_TIMEOUT_MS) {
      if (!this.connectionStale) {
        // First time detecting stale connection
        console.error(`❌ [Health Check] No trades received in ${minutesSinceLastTrade} minutes`);
        console.error(`❌ [Health Check] WebSocket connection may be dead`);
        console.error(`❌ [Health Check] Monitored tokens: ${monitoredTokens.join(', ')}`);
        
        this.connectionStale = true;
        this.emit('connection_stale', {
          minutesSinceLastTrade,
          monitoredTokens: monitoredTokens
        });
        
        // Broadcast to UI
        this.io.emit('websocket:health:warning', {
          status: 'stale',
          minutesSinceLastTrade,
          pumpFunActive: this.webSocketListener?.isActive() || false,
          raydiumActive: this.raydiumListener?.isActive() || false,
          jupiterActive: this.jupiterListener?.isActive() || false,
          message: 'No trades detected recently. Connection may be dead.',
          timestamp: Date.now()
        });
        
        // Attempt reconnection
        this.attemptReconnection();
      }
    } else if (this.connectionStale && timeSinceLastTrade < 60000) {
      // Connection recovered (received trade in last minute)
      console.log(`✅ [Health Check] Connection recovered - trades flowing again`);
      this.connectionStale = false;
      
      this.io.emit('websocket:health:recovered', {
        status: 'healthy',
        message: 'Real-time trade detection recovered',
        timestamp: Date.now()
      });
    }
  }

  /**
   * Attempt to reconnect WebSocket
   */
  private async attemptReconnection(): Promise<void> {
    try {
      console.log('[RealTradeFeedService] 🔄 Attempting WebSocket reconnection...');
      
      // Reconnect PumpFun listener
      if (this.webSocketListener) {
        const pumpTokens = this.webSocketListener.getMonitoredTokens();
        if (pumpTokens.length > 0) {
          await this.webSocketListener.stop();
          for (const token of pumpTokens) {
            await this.webSocketListener.start(token);
          }
          console.log(`[RealTradeFeedService] ✅ PumpFun reconnected: ${pumpTokens.length} tokens`);
        }
      }

      // Reconnect Raydium listener
      if (this.raydiumListener) {
        const raydiumTokens = this.raydiumListener.getMonitoredTokens();
        if (raydiumTokens.length > 0) {
          await this.raydiumListener.stop();
          for (const token of raydiumTokens) {
            await this.raydiumListener.start(token);
          }
          console.log(`[RealTradeFeedService] ✅ Raydium reconnected: ${raydiumTokens.length} tokens`);
        }
      }

      // Reconnect Jupiter listener
      if (this.jupiterListener) {
        const jupiterTokens = this.jupiterListener.getMonitoredTokens();
        if (jupiterTokens.length > 0) {
          await this.jupiterListener.stop();
          for (const token of jupiterTokens) {
            await this.jupiterListener.start(token);
          }
          console.log(`[RealTradeFeedService] ✅ Jupiter reconnected: ${jupiterTokens.length} tokens`);
        }
      }
    } catch (error) {
      console.error('[RealTradeFeedService] ❌ Reconnection failed:', error);
    }
  }

  /**
   * Update last trade timestamp (call from handleRealTrade)
   */
  private updateLastTradeTimestamp(): void {
    this.lastTradeTimestamp = Date.now();
    
    if (this.connectionStale) {
      console.log(`✅ [Health Check] Trade received - connection is alive`);
    }
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
  /**
   * Fetch token metadata (symbol, name) from DexScreener
   */
  private async fetchTokenMetadata(tokenAddress: string): Promise<{ symbol?: string; name?: string } | null> {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      if (!response.ok) return null;
      
      const data: any = await response.json();
      if (data?.pairs && data.pairs.length > 0) {
        const pair = data.pairs[0];
        return {
          symbol: pair.baseToken?.symbol,
          name: pair.baseToken?.name
        };
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    console.log('[RealTradeFeedService] Stopping service...');
    this.stopHealthMonitoring();
    await this.tradeMonitor.stop();
    
    if (this.webSocketListener) {
      await this.webSocketListener.stop();
    }

    if (this.raydiumListener) {
      await this.raydiumListener.stop();
    }

    if (this.jupiterListener) {
      await this.jupiterListener.stop();
    }
    
    this.removeAllListeners();
    console.log('[RealTradeFeedService] Service stopped');
  }

  /**
   * Subscribe to real trades for a token
   * Intelligently routes to PumpFun or Raydium listener based on token type
   */
  async subscribeToToken(tokenAddress: string, socketId: string): Promise<boolean> {
    try {
      console.log(`\n🚀 ========== SUBSCRIBE TO TOKEN ==========`);
      console.log(`🚀 Token: ${tokenAddress}`);
      console.log(`🚀 Subscriber: ${socketId}`);
      
      // Use TokenRouter to determine token type
      const route = await this.tokenRouter.route(tokenAddress);
      
      console.log(`🔍 [RealTradeFeedService] Token Type: ${route.tokenInfo.type}`);
      console.log(`� [RealTradeFeedService] Routing: ${route.reason}`);
      
      // Determine which listener to use
      let success = false;
      
      if (route.tokenInfo.metadata?.isPumpToken && !route.tokenInfo.metadata?.isGraduated) {
        // Use PumpFun listener for active bonding curve tokens
        console.log(`🚀 [RealTradeFeedService] Token on bonding curve - Using PumpFun WebSocket listener`);
        if (this.webSocketListener) {
          await this.webSocketListener.start(tokenAddress);
          success = true;
        }
      } else if (route.tokenInfo.metadata?.isPumpToken && route.tokenInfo.metadata?.isGraduated) {
        // Graduated pump.fun token - Use BOTH Raydium + Jupiter (most DexScreener trades use Jupiter!)
        console.log(`🎓 [RealTradeFeedService] Graduated Pump.fun token detected`);
        console.log(`⚠️ [RealTradeFeedService] IMPORTANT: Graduated tokens don't trade on PumpFun bonding curve anymore!`);
        console.log(`📌 [RealTradeFeedService] Strategy: MULTI-DEX (Raydium + Jupiter) for maximum coverage`);
        
        // Start Raydium listener (direct pool swaps)
        if (this.raydiumListener) {
          console.log(`🌊 [RealTradeFeedService] Starting Raydium WebSocket listener...`);
          try {
            await this.raydiumListener.start(tokenAddress);
            success = true;
            console.log(`✅ [RealTradeFeedService] Raydium listener started successfully`);
          } catch (error) {
            console.log(`⚠️ [RealTradeFeedService] Raydium listener failed (this is OK if token uses Jupiter):`, error instanceof Error ? error.message : error);
          }
        }
        
        // CRITICAL: Also start Jupiter listener (captures aggregator trades - 70-80% of DexScreener trades!)
        if (this.jupiterListener) {
          console.log(`⚡ [RealTradeFeedService] Starting Jupiter WebSocket listener...`);
          try {
            await this.jupiterListener.start(tokenAddress);
            success = true; // Jupiter success is enough for graduated tokens
            console.log(`✅ [RealTradeFeedService] Jupiter listener started successfully`);
            console.log(`🎯 [RealTradeFeedService] MULTI-DEX MONITORING ACTIVE (Raydium + Jupiter)`);
            console.log(`📊 [RealTradeFeedService] Will capture BOTH direct Raydium swaps AND Jupiter aggregator routes`);
          } catch (error) {
            console.error(`❌ [RealTradeFeedService] Jupiter listener failed:`, error instanceof Error ? error.message : error);
          }
        }
        
        if (!success) {
          console.error(`❌ [RealTradeFeedService] Failed to start any listener for graduated token!`);
          console.error(`⚠️ [RealTradeFeedService] Cannot monitor this token - please verify pool exists`);
        }
      } else {
        // Use BOTH Raydium and Jupiter for standard/graduated tokens
        console.log(`📝 [RealTradeFeedService] Standard/graduated token - Using MULTI-DEX monitoring`);
        
        // Start Raydium listener (direct pool swaps)
        if (this.raydiumListener) {
          try {
            await this.raydiumListener.start(tokenAddress);
            success = true;
            console.log(`✅ [RealTradeFeedService] Raydium listener started`);
          } catch (error) {
            console.log(`⚠️ [RealTradeFeedService] Raydium listener failed (this is OK if token uses Jupiter):`, error instanceof Error ? error.message : error);
          }
        }

        // CRITICAL: Also start Jupiter listener (captures aggregator trades)
        if (this.jupiterListener) {
          try {
            await this.jupiterListener.start(tokenAddress);
            success = true; // Jupiter success is enough
            console.log(`✅ [RealTradeFeedService] Jupiter listener started (will capture aggregator trades)`);
            console.log(`🎯 [RealTradeFeedService] MULTI-DEX MONITORING ACTIVE (Raydium + Jupiter)`);
          } catch (error) {
            console.error(`❌ [RealTradeFeedService] Jupiter listener failed:`, error instanceof Error ? error.message : error);
          }
        }
      }
      
      if (success) {
        // Fetch token metadata (symbol, name)
        try {
          const metadata = await this.fetchTokenMetadata(tokenAddress);
          if (metadata) {
            this.tokenMetadata.set(tokenAddress.toLowerCase(), metadata);
            console.log(`[Subscribe] Monitoring ${metadata.symbol || metadata.name || tokenAddress.substring(0, 8)} for real-time trades`);
          }
        } catch (error) {
          // Non-critical, continue without metadata
        }
        
        // Initialize stats
        if (!this.tradeStats.has(tokenAddress)) {
          this.tradeStats.set(tokenAddress, {
            tokenAddress,
            totalBuys: 0,
            totalSells: 0,
            totalVolumeSol: 0,
            avgBuySize: 0,
            avgSellSize: 0,
            lastTradeTime: 0,
            tradeCount: 0,
          });
        }
        
        if (!this.recentTrades.has(tokenAddress)) {
          this.recentTrades.set(tokenAddress, []);
        }
      } else {
        console.error('[Subscribe] Failed - no listener available');
      }
      
      return success;
    } catch (error) {
      console.error(`❌ [RealTradeFeedService] Error subscribing to token:`, error);
      return false;
    }
  }

  /**
   * Unsubscribe from token trades
   */
  async unsubscribeFromToken(tokenAddress: string, socketId: string): Promise<void> {
    // Try all listeners
    if (this.webSocketListener && this.webSocketListener.isMonitoringToken(tokenAddress)) {
      await this.webSocketListener.stopToken(tokenAddress);
      console.log(`🛑 [RealTradeFeedService] Unsubscribed from PumpFun: ${tokenAddress}`);
    }
    
    if (this.raydiumListener && this.raydiumListener.isMonitoringToken(tokenAddress)) {
      await this.raydiumListener.stopToken(tokenAddress);
      console.log(`🛑 [RealTradeFeedService] Unsubscribed from Raydium: ${tokenAddress}`);
    }

    if (this.jupiterListener && this.jupiterListener.isMonitoringToken(tokenAddress)) {
      await this.jupiterListener.stopToken(tokenAddress);
      console.log(`🛑 [RealTradeFeedService] Unsubscribed from Jupiter: ${tokenAddress}`);
    }
  }

  /**
   * Check for recent buy activity (for SELL strategies)
   * Returns the most recent buy volume if detected in last N seconds
   */
  checkRecentBuyActivity(tokenAddress: string, windowSeconds: number = 30): number | null {
    const trades = this.recentTrades.get(tokenAddress) || [];
    const now = Date.now();
    const cutoff = now - (windowSeconds * 1000);
    
    // Find recent buy trades
    const recentBuys = trades.filter(t => 
      t.type === 'buy' && 
      t.timestamp >= cutoff
    );
    
    if (recentBuys.length === 0) {
      return null;
    }
    
    // Return the most recent buy volume
    const latestBuy = recentBuys[recentBuys.length - 1];
    return latestBuy.solAmount;
  }

  /**
   * Check for recent sell activity (for BUY strategies)
   * Returns the most recent sell volume if detected in last N seconds
   */
  checkRecentSellActivity(tokenAddress: string, windowSeconds: number = 30): number | null {
    const trades = this.recentTrades.get(tokenAddress) || [];
    const now = Date.now();
    const cutoff = now - (windowSeconds * 1000);
    
    // Find recent sell trades
    const recentSells = trades.filter(t => 
      t.type === 'sell' && 
      t.timestamp >= cutoff
    );
    
    if (recentSells.length === 0) {
      return null;
    }
    
    // Return the most recent sell volume
    const latestSell = recentSells[recentSells.length - 1];
    return latestSell.tokenAmount;
  }

  /**
   * Get aggregated volume for last N minutes
   */
  getVolumeInWindow(tokenAddress: string, windowMinutes: number = 5): { buyVolume: number; sellVolume: number } {
    const trades = this.recentTrades.get(tokenAddress) || [];
    const now = Date.now();
    const cutoff = now - (windowMinutes * 60 * 1000);
    
    let buyVolume = 0;
    let sellVolume = 0;
    
    for (const trade of trades) {
      if (trade.timestamp >= cutoff) {
        if (trade.type === 'buy') {
          buyVolume += trade.solAmount;
        } else {
          sellVolume += trade.solAmount;
        }
      }
    }
    
    return { buyVolume, sellVolume };
  }

  /**
   * Get statistics for a token
   */
  getTokenStats(tokenAddress: string): TradeStats | undefined {
    return this.tradeStats.get(tokenAddress);
  }

  /**
   * Get recent trades for a token
   */
  getRecentTrades(tokenAddress: string, limit: number = 20): RealTradeEvent[] {
    const trades = this.recentTrades.get(tokenAddress) || [];
    return trades.slice(-limit);
  }

  /**
   * Check if a token is being monitored
   */
  isMonitoring(tokenAddress: string): boolean {
    const isPumpMonitoring = this.webSocketListener?.isMonitoringToken(tokenAddress) || false;
    const isRaydiumMonitoring = this.raydiumListener?.isMonitoringToken(tokenAddress) || false;
    const isJupiterMonitoring = this.jupiterListener?.isMonitoringToken(tokenAddress) || false;
    return isPumpMonitoring || isRaydiumMonitoring || isJupiterMonitoring;
  }

  /**
   * Get service statistics
   */
  getStats() {
    const pumpTokens = this.webSocketListener?.getMonitoredTokens() || [];
    const raydiumTokens = this.raydiumListener?.getMonitoredTokens() || [];
    const jupiterTokens = this.jupiterListener?.getMonitoredTokens() || [];
    const totalMonitored = pumpTokens.length + raydiumTokens.length + jupiterTokens.length;
    
    return {
      tokensMonitored: totalMonitored,
      pumpFunTokens: pumpTokens.length,
      raydiumTokens: raydiumTokens.length,
      jupiterTokens: jupiterTokens.length,
      tokensWithStats: this.tradeStats.size,
      totalTradesBuffered: Array.from(this.recentTrades.values())
        .reduce((sum, trades) => sum + trades.length, 0),
      method: 'Multi-DEX WebSocket monitoring (PumpFun + Raydium + Jupiter)',
      pumpFunConnected: this.webSocketListener?.isActive() || false,
      raydiumConnected: this.raydiumListener?.isActive() || false,
      jupiterConnected: this.jupiterListener?.isActive() || false,
      isConnected: totalMonitored > 0,
    };
  }

  /**
   * Get the underlying trade monitor instance (for advanced use)
   */
  getTradeMonitor(): SolanaTradeMonitor {
    return this.tradeMonitor;
  }
}

