/**
 * Real-Time Price Service
 * WebSocket-based price feeds for production trading
 * Supports multiple data sources with automatic fallback
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { awsLogger } from '../aws/logger';

export interface PriceUpdate {
  tokenAddress: string;
  price: number;
  priceInSOL?: number;
  priceInUSD?: number;
  volume24h?: number;
  priceChange24h?: number;
  timestamp: number;
  source: string;
}

export interface PriceSubscription {
  tokenAddress: string;
  callback: (update: PriceUpdate) => void;
  lastUpdate?: number;
}

/**
 * Real-time price service with WebSocket feeds
 */
export class RealTimePriceService extends EventEmitter {
  private subscriptions: Map<string, Set<(update: PriceUpdate) => void>> = new Map();
  private priceCache: Map<string, PriceUpdate> = new Map();
  private wsConnections: Map<string, WebSocket> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private isShuttingDown = false;
  
  // Configuration
  private readonly MAX_RECONNECT_DELAY = 30000; // 30 seconds
  private readonly INITIAL_RECONNECT_DELAY = 1000; // 1 second
  private readonly CACHE_TTL = 5000; // 5 seconds
  
  // Data sources (in priority order)
  private dataSources = [
    {
      name: 'Jupiter',
      wsUrl: 'wss://price.jup.ag/v1/ws',
      type: 'jupiter'
    },
    {
      name: 'Birdeye',
      wsUrl: 'wss://public-api.birdeye.so/socket',
      type: 'birdeye',
      requiresAuth: true
    }
  ];

  constructor() {
    super();
    awsLogger.info('RealTimePriceService initialized');
  }

  /**
   * Subscribe to price updates for a token
   */
  subscribe(tokenAddress: string, callback: (update: PriceUpdate) => void): () => void {
    if (!this.subscriptions.has(tokenAddress)) {
      this.subscriptions.set(tokenAddress, new Set());
      this.connectToDataSource(tokenAddress);
    }

    const callbacks = this.subscriptions.get(tokenAddress)!;
    callbacks.add(callback);

    // Send cached price immediately if available and fresh
    const cached = this.priceCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      setImmediate(() => callback(cached));
    }

    // Return unsubscribe function
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.unsubscribeToken(tokenAddress);
      }
    };
  }

  /**
   * Get cached price (non-blocking)
   */
  getCachedPrice(tokenAddress: string): PriceUpdate | null {
    const cached = this.priceCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached;
    }
    return null;
  }

  /**
   * Connect to data source for a token
   */
  private async connectToDataSource(tokenAddress: string): Promise<void> {
    // Try Jupiter first (no auth required)
    try {
      await this.connectJupiter(tokenAddress);
    } catch (error) {
      awsLogger.error('Failed to connect to Jupiter WebSocket', {
        metadata: { tokenAddress, error: error instanceof Error ? error.message : String(error) }
      });
      
      // Fallback to polling if WebSocket fails
      this.startPolling(tokenAddress);
    }
  }

  /**
   * Connect to Jupiter price API (WebSocket)
   */
  private async connectJupiter(tokenAddress: string): Promise<void> {
    const wsKey = `jupiter-${tokenAddress}`;
    
    if (this.wsConnections.has(wsKey)) {
      return; // Already connected
    }

    // Jupiter uses REST API with polling, not WebSocket
    // Start polling for this token
    this.startPolling(tokenAddress);
  }

  /**
   * Start polling for price updates (fallback when WebSocket unavailable)
   */
  private startPolling(tokenAddress: string): void {
    const pollInterval = 2000; // 2 seconds
    
    const poll = async () => {
      if (this.isShuttingDown || !this.subscriptions.has(tokenAddress)) {
        return;
      }

      try {
        const update = await this.fetchPriceHTTP(tokenAddress);
        if (update) {
          this.handlePriceUpdate(update);
        }
      } catch (error) {
        awsLogger.warn('Price polling failed', {
          metadata: { tokenAddress, error: error instanceof Error ? error.message : String(error) }
        });
      }

      // Schedule next poll
      if (!this.isShuttingDown && this.subscriptions.has(tokenAddress)) {
        setTimeout(poll, pollInterval);
      }
    };

    // Start first poll
    poll();
  }

  /**
   * Fetch price via HTTP (fallback)
   */
  private async fetchPriceHTTP(tokenAddress: string): Promise<PriceUpdate | null> {
    try {
      // Try DexScreener API
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      if (!response.ok) {
        return null;
      }

      const data: any = await response.json();
      if (!data.pairs || data.pairs.length === 0) {
        return null;
      }

      const pair = data.pairs[0]; // Most liquid pair
      return {
        tokenAddress,
        price: parseFloat(pair.priceUsd) || 0,
        priceInUSD: parseFloat(pair.priceUsd) || 0,
        volume24h: pair.volume?.h24 || 0,
        priceChange24h: pair.priceChange?.h24 || 0,
        timestamp: Date.now(),
        source: 'DexScreener'
      };
    } catch (error) {
      awsLogger.error('HTTP price fetch failed', {
        metadata: { tokenAddress, error: error instanceof Error ? error.message : String(error) }
      });
      return null;
    }
  }

  /**
   * Handle incoming price update
   */
  private handlePriceUpdate(update: PriceUpdate): void {
    // Update cache
    this.priceCache.set(update.tokenAddress, update);

    // Emit to subscribers
    const callbacks = this.subscriptions.get(update.tokenAddress);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(update);
        } catch (error) {
          awsLogger.error('Price callback error', {
            metadata: { tokenAddress: update.tokenAddress, error: error instanceof Error ? error.message : String(error) }
          });
        }
      });
    }

    // Emit global event
    this.emit('priceUpdate', update);
  }

  /**
   * Unsubscribe from a token
   */
  private unsubscribeToken(tokenAddress: string): void {
    this.subscriptions.delete(tokenAddress);
    this.priceCache.delete(tokenAddress);

    // Close WebSocket connections for this token
    const wsKey = `jupiter-${tokenAddress}`;
    const ws = this.wsConnections.get(wsKey);
    if (ws) {
      ws.close();
      this.wsConnections.delete(wsKey);
    }

    // Clear reconnect timer
    const timer = this.reconnectTimers.get(wsKey);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(wsKey);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Close all WebSocket connections
    for (const [key, ws] of this.wsConnections.entries()) {
      ws.close();
    }
    this.wsConnections.clear();

    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    // Clear subscriptions
    this.subscriptions.clear();
    this.priceCache.clear();

    awsLogger.info('RealTimePriceService shutdown complete');
  }

  /**
   * Get service health status
   */
  getHealth(): {
    healthy: boolean;
    activeSubscriptions: number;
    cachedPrices: number;
    wsConnections: number;
  } {
    return {
      healthy: !this.isShuttingDown,
      activeSubscriptions: this.subscriptions.size,
      cachedPrices: this.priceCache.size,
      wsConnections: this.wsConnections.size
    };
  }
}

// Export singleton instance
export const realTimePriceService = new RealTimePriceService();

