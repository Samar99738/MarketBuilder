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
    
    this.setupEventHandlers();
    this.setupEventForwarding();
    this.startHealthMonitoring();
  }

  // Event forwarding from monitors to service
  private setupEventForwarding(): void {
    // Listen for real trades from the poller (pump.fun API) via socket events
    // The PumpFunTradePoller emits 'pumpfun:real_trade' events via socket.io
  }

  // Unified trade handler - THIS IS WHERE REAL TRADES ENTER THE SYSTEM
  private handleRealTrade(trade: RealTradeEvent): void {
    try {
      const { tokenAddress } = trade;
      
      // Update health check timestamp
      this.updateLastTradeTimestamp();
      
      console.log(`\n🔥 ========== REAL TRADE DETECTED ==========`);
      console.log(`🔥 Token: ${tokenAddress.substring(0, 8)}...`);
      console.log(`🔥 Type: ${trade.type.toUpperCase()}`);
      console.log(`🔥 SOL Amount: ${trade.solAmount.toFixed(6)} SOL`);
      console.log(`🔥 Token Amount: ${trade.tokenAmount.toLocaleString()} tokens`);
      console.log(`🔥 Trader: ${trade.trader.substring(0, 8)}...`);
      console.log(`🔥 Signature: ${trade.signature.substring(0, 12)}...`);
      console.log(`🔥 ===========================================\n`);
      
      // Store in recent trades
      this.addToRecentTrades(trade);

      // Update statistics
      this.updateTradeStats(trade);

      // Emit to token-specific listeners (for strategies)
      // CRITICAL: Emit with BOTH original case AND lowercase for maximum compatibility
      // Strategies listen with lowercase, but we want to support both
      this.emit(`trade:${tokenAddress}`, trade);
      
      // Also emit lowercase version for consistent event matching
      const lowercaseAddress = tokenAddress.toLowerCase();
      if (lowercaseAddress !== tokenAddress) {
        this.emit(`trade:${lowercaseAddress}`, trade);
      }
      
      console.log(`📡 [RealTradeFeedService] Emitted event: trade:${tokenAddress}`);
      console.log(`📡 [RealTradeFeedService] Emitted event: trade:${lowercaseAddress}`);
      console.log(`📡 [RealTradeFeedService] Listeners (original): ${this.listenerCount(`trade:${tokenAddress}`)}`);
      console.log(`📡 [RealTradeFeedService] Listeners (lowercase): ${this.listenerCount(`trade:${lowercaseAddress}`)}`);

      // Emit event for strategies to consume
      this.emit('real_trade', trade);
      console.log(`📡 [RealTradeFeedService] Emitted global event: real_trade`);
      
      // Broadcast to WebSocket clients for UI updates
      this.io.emit('pumpfun:live_trade_detected', {
        tokenAddress,
        type: trade.type,
        solAmount: trade.solAmount,
        tokenAmount: trade.tokenAmount,
        price: trade.price,
        trader: trade.trader,
        signature: trade.signature,
        timestamp: trade.timestamp,
        isRealBlockchain: true,
      });
      console.log(`📡 [RealTradeFeedService] Broadcasted to WebSocket: pumpfun:live_trade_detected`);

      console.log(`✅ [RealTradeFeedService] Trade fully processed and distributed`);
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
   * CRITICAL: This connects PumpFunWebSocketListener events to our service
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
        // Convert Raydium trade format to RealTradeEvent format
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
        
        console.log(`🌊 [RealTradeFeedService] Raydium trade detected (graduated token)`);
        
        this.handleRealTrade(trade);
      });
      
      console.log('[RealTradeFeedService] ✅ Event handlers connected to RaydiumWebSocketListener');
      console.log('[RealTradeFeedService] 🌊 Monitoring Raydium graduated tokens');
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
    // Get monitored tokens from both listeners
    const pumpTokens = this.webSocketListener?.getMonitoredTokens() || [];
    const raydiumTokens = this.raydiumListener?.getMonitoredTokens() || [];
    const monitoredTokens = [...pumpTokens, ...raydiumTokens];
    
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
        if (this.webSocketListener) {
          console.log(`� [RealTradeFeedService] Using PumpFun WebSocket listener`);
          await this.webSocketListener.start(tokenAddress);
          success = true;
        }
      } else {
        // Use Raydium listener for graduated or standard tokens
        if (this.raydiumListener) {
          console.log(`🌊 [RealTradeFeedService] Using Raydium WebSocket listener`);
          try {
            await this.raydiumListener.start(tokenAddress);
            success = true;
          } catch (error) {
            console.error(`⚠️ [RealTradeFeedService] Raydium listener failed, falling back to PumpFun`, error);
            // Fallback to PumpFun if Raydium fails
            if (this.webSocketListener) {
              await this.webSocketListener.start(tokenAddress);
              success = true;
            }
          }
        }
      }
      
      if (success) {
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
        
        console.log(`✅ [RealTradeFeedService] Subscribed to real-time trades for ${tokenAddress.substring(0, 8)}...`);
        console.log(`🔥 ==========================================\n`);
      } else {
        console.error(`❌ [RealTradeFeedService] No listener available`);
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
    // Try both listeners (one will be monitoring this token)
    if (this.webSocketListener && this.webSocketListener.isMonitoringToken(tokenAddress)) {
      await this.webSocketListener.stopToken(tokenAddress);
      console.log(`🛑 [RealTradeFeedService] Unsubscribed from PumpFun: ${tokenAddress}`);
    }
    
    if (this.raydiumListener && this.raydiumListener.isMonitoringToken(tokenAddress)) {
      await this.raydiumListener.stopToken(tokenAddress);
      console.log(`🛑 [RealTradeFeedService] Unsubscribed from Raydium: ${tokenAddress}`);
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
    return isPumpMonitoring || isRaydiumMonitoring;
  }

  /**
   * Get service statistics
   */
  getStats() {
    const pumpTokens = this.webSocketListener?.getMonitoredTokens() || [];
    const raydiumTokens = this.raydiumListener?.getMonitoredTokens() || [];
    const totalMonitored = pumpTokens.length + raydiumTokens.length;
    
    return {
      tokensMonitored: totalMonitored,
      pumpFunTokens: pumpTokens.length,
      raydiumTokens: raydiumTokens.length,
      tokensWithStats: this.tradeStats.size,
      totalTradesBuffered: Array.from(this.recentTrades.values())
        .reduce((sum, trades) => sum + trades.length, 0),
      method: 'Dual WebSocket monitoring (PumpFun + Raydium)',
      pumpFunConnected: this.webSocketListener?.isActive() || false,
      raydiumConnected: this.raydiumListener?.isActive() || false,
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

