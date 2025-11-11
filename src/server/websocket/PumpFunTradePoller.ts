/**
 * Pump.fun Trade Poller
 * 
 * Polls pump.fun frontend API to get REAL recent trades
 * More reliable than WebSocket for public RPC endpoints
 */

import { Server as SocketServer } from 'socket.io';
import { EventEmitter } from 'events';

export interface PumpFunTrade {
  signature: string;
  sol_amount: number;
  token_amount: number;
  is_buy: boolean;
  user: string;
  timestamp: number;
  slot: number;
}

export interface RealPumpTrade {
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

/**
 * Pump.fun Trade Poller
 * Fetches real trades from pump.fun frontend API
 */
export class PumpFunTradePoller extends EventEmitter {
  private io: SocketServer;
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private lastSeenSignatures: Map<string, Set<string>> = new Map();
  private isRunning: boolean = false;
  private readonly MAX_TOTAL_SIGNATURES = 10000;
  private readonly MAX_TOKENS = 20;

  private readonly POLL_INTERVAL_MS = 3000; // Poll every 3 seconds
  private readonly API_BASE = 'https://frontend-api.pump.fun';
  
  private stats = {
    totalTokensMonitored: 0,
    totalTradesDetected: 0,
    tradesPerToken: new Map<string, number>(),
  };

  constructor(io: SocketServer) {
    super(); // Call EventEmitter constructor
    this.io = io;
    console.log('[PumpFunTradePoller] Initialized with EventEmitter');
  }

  /**
   * Start monitoring a token for real trades
   */
  async startMonitoring(tokenAddress: string): Promise<boolean> {
    if (this.pollingIntervals.has(tokenAddress)) {
      console.log(`[PumpFunTradePoller] Already monitoring ${tokenAddress}`);
      return true;
    }

    // FIX #1: Enforce max token limit to prevent memory leak
    if (this.pollingIntervals.size >= this.MAX_TOKENS) {
      console.warn(`[PumpFunTradePoller] ⚠️ Max token limit (${this.MAX_TOKENS}) reached. Cannot monitor ${tokenAddress.substring(0, 8)}...`);
      return false;
    }

    // Check global signature count before adding new token
    const totalSignatures = Array.from(this.lastSeenSignatures.values())
      .reduce((sum, set) => sum + set.size, 0);
    
    if (totalSignatures >= this.MAX_TOTAL_SIGNATURES) {
      console.warn(`[PumpFunTradePoller] ⚠️ Global signature limit (${this.MAX_TOTAL_SIGNATURES}) reached. Cleaning up old data...`);
      this.cleanupOldestToken();
    }

    console.log(`[PumpFunTradePoller] 🔴 Starting REAL trade polling for ${tokenAddress.substring(0, 8)}...`);

    // Initialize tracking
    this.lastSeenSignatures.set(tokenAddress, new Set());
    this.stats.tradesPerToken.set(tokenAddress, 0);
    this.stats.totalTokensMonitored++;

    // Initial fetch
    await this.fetchAndEmitTrades(tokenAddress);

    // Start polling
    const interval = setInterval(async () => {
      await this.fetchAndEmitTrades(tokenAddress);
    }, this.POLL_INTERVAL_MS);

    this.pollingIntervals.set(tokenAddress, interval);
    this.isRunning = true;

    console.log(`[PumpFunTradePoller] Monitoring REAL trades every ${this.POLL_INTERVAL_MS / 1000}s`);
    return true;
  }

  /**
   * Stop monitoring a token
   */
  stopMonitoring(tokenAddress: string): void {
    const interval = this.pollingIntervals.get(tokenAddress);
    
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(tokenAddress);
      this.lastSeenSignatures.delete(tokenAddress);
      
      console.log(`[PumpFunTradePoller] Stopped monitoring ${tokenAddress}`);
      
      if (this.pollingIntervals.size === 0) {
        this.isRunning = false;
      }
    }
  }

  /**
   * Fetch recent trades from pump.fun API
   */
  private async fetchAndEmitTrades(tokenAddress: string): Promise<void> {
    try {
      // Fetch trades from pump.fun frontend API
      const url = `${this.API_BASE}/trades/latest/${tokenAddress}`;
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (!response.ok) {
        if (response.status === 530 || response.status === 503) {
          console.warn(`[PumpFunTradePoller] Pump.fun API temporarily unavailable (${response.status}) for ${tokenAddress.substring(0, 8)}... (Cloudflare/rate limit)`);
        } else {
          console.error(`[PumpFunTradePoller] API error ${response.status} for ${tokenAddress.substring(0, 8)}...`);
        }
        return;
      }

      const trades = await response.json() as PumpFunTrade[];
      
      if (!Array.isArray(trades) || trades.length === 0) {
        return;
      }

      const seenSignatures = this.lastSeenSignatures.get(tokenAddress) || new Set();
      const newTrades: RealPumpTrade[] = [];

      // Process trades in order (oldest first)
      for (const trade of trades) {
        // Skip if we've already seen this trade
        if (seenSignatures.has(trade.signature)) {
          continue;
        }

        // Mark as seen
        seenSignatures.add(trade.signature);

        // Calculate price
        const price = trade.token_amount > 0 ? trade.sol_amount / trade.token_amount : 0;

        // Create real trade object
        const realTrade: RealPumpTrade = {
          tokenAddress,
          type: trade.is_buy ? 'buy' : 'sell',
          solAmount: trade.sol_amount,
          tokenAmount: trade.token_amount,
          trader: trade.user,
          signature: trade.signature,
          timestamp: trade.timestamp * 1000, // Convert to ms
          price,
          isRealTrade: true,
        };

        newTrades.push(realTrade);

        // Update stats
        this.stats.totalTradesDetected++;
        const tokenStats = this.stats.tradesPerToken.get(tokenAddress) || 0;
        this.stats.tradesPerToken.set(tokenAddress, tokenStats + 1);
      }

      // Emit new trades
      if (newTrades.length > 0) {
        for (const trade of newTrades) {
          // CRITICAL FIX: Emit internal EventEmitter event for RealTradeFeedService
          this.emit('real_trade', trade);
          
          // Also emit to Socket.IO for UI clients
          this.io.emit('pumpfun:real_trade', trade);
          
          // Emit to live feed
          this.io.emit('pumpfun:live_trade_detected', {
            tokenAddress: trade.tokenAddress,
            type: trade.type,
            solAmount: trade.solAmount,
            tokenAmount: trade.tokenAmount,
            price: trade.price,
            trader: trade.trader,
            signature: trade.signature,
            timestamp: trade.timestamp,
            isRealBlockchain: true,
          });

          console.log(`[PumpFunTradePoller] 🔥 REAL ${trade.type.toUpperCase()}: ${trade.solAmount.toFixed(4)} SOL (${tokenAddress.substring(0, 8)}...) - Sig: ${trade.signature.substring(0, 8)}...`);
        }
      }

      // Keep only last 500 signatures to prevent memory issues (FIX #1: Reduced from 1000)
      if (seenSignatures.size > 500) {
        const sigArray = Array.from(seenSignatures);
        const toKeep = sigArray.slice(-250);
        this.lastSeenSignatures.set(tokenAddress, new Set(toKeep));
      }

    } catch (error) {
      console.error(`[PumpFunTradePoller] Error fetching trades for ${tokenAddress.substring(0, 8)}...:`, error);
    }
  }

  /**
   * FIX #1: Cleanup oldest token when memory limit reached
   */
  private cleanupOldestToken(): void {
    if (this.pollingIntervals.size === 0) return;

    // Find token with oldest/least recent activity
    let oldestToken: string | null = null;
    let minTradeCount = Infinity;

    for (const [token, count] of this.stats.tradesPerToken.entries()) {
      if (count < minTradeCount) {
        minTradeCount = count;
        oldestToken = token;
      }
    }

    if (oldestToken) {
      console.log(`[PumpFunTradePoller] 🧹 Cleaning up least active token: ${oldestToken.substring(0, 8)}...`);
      this.stopMonitoring(oldestToken);
    }
  }

  /**
   * Get monitoring stats
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      tokensMonitored: this.pollingIntervals.size,
      totalTradesDetected: this.stats.totalTradesDetected,
      tradesPerToken: Object.fromEntries(this.stats.tradesPerToken),
      pollIntervalMs: this.POLL_INTERVAL_MS,
    };
  }

  /**
   * Check if monitoring a token
   */
  isMonitoring(tokenAddress: string): boolean {
    return this.pollingIntervals.has(tokenAddress);
  }

  /**
   * Stop all monitoring
   */
  async stopAll(): Promise<void> {
    console.log('[PumpFunTradePoller] Stopping all monitoring...');
    
    for (const tokenAddress of this.pollingIntervals.keys()) {
      this.stopMonitoring(tokenAddress);
    }
    
    this.isRunning = false;
    console.log('[PumpFunTradePoller] Stopped');
  }
}

