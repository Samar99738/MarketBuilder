/**
 * Price Broadcasting Service
 * Polls CoinGecko API and broadcasts price updates to subscribed WebSocket clients
 */

import { Server as SocketServer } from 'socket.io';
import {
  IPriceService,
  PriceUpdate,
  PriceSubscription,
  WS_EVENTS,
} from './types';

export class PriceService implements IPriceService {
  private io: SocketServer;
  private subscriptions: Map<string, PriceSubscription> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastPrice: PriceUpdate | null = null;
  private isRunning: boolean = false;
  
  // Configuration
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds
  private readonly TOKEN_SYMBOL = 'SOL';
  private readonly COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';

  constructor(io: SocketServer) {
    this.io = io;
  }

  /**
   * Start the price broadcasting service
   */
  start(): void {
    if (this.isRunning) {
      console.log('[PriceService] Already running');
      return;
    }

    console.log('[PriceService] Starting price broadcasting service...');
    this.isRunning = true;

    // Initial price fetch
    this.fetchAndBroadcastPrice();

    // Start polling interval
    this.pollingInterval = setInterval(() => {
      this.fetchAndBroadcastPrice();
    }, this.POLL_INTERVAL_MS);

    console.log(`[PriceService] Broadcasting prices every ${this.POLL_INTERVAL_MS / 1000}s`);
  }

  /**
   * Stop the price broadcasting service
   */
  stop(): void {
    if (!this.isRunning) {
      console.log('[PriceService] Not running');
      return;
    }

    console.log('[PriceService] Stopping price broadcasting service...');
    this.isRunning = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    console.log('[PriceService] Service stopped');
  }

  /**
   * Subscribe a socket to price updates
   */
  subscribe(socketId: string, token: string = 'SOL'): void {
    if (this.subscriptions.has(socketId)) {
      console.log(`[PriceService] Socket ${socketId} already subscribed`);
      return;
    }

    const subscription: PriceSubscription = {
      socketId,
      token,
      subscribedAt: new Date().toISOString(),
    };

    this.subscriptions.set(socketId, subscription);
    console.log(`[PriceService] Socket ${socketId} subscribed to ${token} prices (Total: ${this.subscriptions.size})`);

    // Send latest price immediately if available
    if (this.lastPrice) {
      this.io.to(socketId).emit(WS_EVENTS.PRICE_UPDATE, this.lastPrice);
    }

    // Start service if this is the first subscriber
    if (this.subscriptions.size === 1 && !this.isRunning) {
      this.start();
    }
  }

  /**
   * Unsubscribe a socket from price updates
   */
  unsubscribe(socketId: string, token: string = 'SOL'): void {
    if (!this.subscriptions.has(socketId)) {
      console.log(`[PriceService] Socket ${socketId} not subscribed`);
      return;
    }

    this.subscriptions.delete(socketId);
    console.log(`[PriceService] Socket ${socketId} unsubscribed (Remaining: ${this.subscriptions.size})`);

    // Stop service if no subscribers
    if (this.subscriptions.size === 0 && this.isRunning) {
      this.stop();
    }
  }

  /**
   * Get current price (for API use)
   */
  async getCurrentPrice(): Promise<PriceUpdate | null> {
    if (this.lastPrice) {
      return this.lastPrice;
    }

    // Fetch fresh price if none cached
    return await this.fetchPrice();
  }

  /**
   * Get number of active subscribers
   */
  getSubscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Fetch price from CoinGecko and broadcast to all subscribers
   */
  private async fetchAndBroadcastPrice(): Promise<void> {
    try {
      const priceData = await this.fetchPrice();
      
      if (!priceData) {
        console.error('[PriceService] Failed to fetch price data');
        return;
      }

      this.lastPrice = priceData;

      // Broadcast to all subscribers
      if (this.subscriptions.size > 0) {
        this.io.emit(WS_EVENTS.PRICE_UPDATE, priceData);
        console.log(`[PriceService] Broadcasted price $${priceData.priceUSD} to ${this.subscriptions.size} clients`);
      }
    } catch (error: any) {
      console.error('[PriceService] Error in fetch and broadcast:', error.message);
    }
  }

  /**
   * Fetch price from multiple APIs with fallbacks
   */
  private async fetchPrice(): Promise<PriceUpdate | null> {
    const solMintAddress = "So11111111111111111111111111111111111111112";

    // Try CoinGecko first (most reliable for SOL)
    try {
      const url = `${this.COINGECKO_URL}?ids=solana&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json() as any;

      if (!data.solana) {
        throw new Error('Invalid response from CoinGecko');
      }

      const priceUpdate: PriceUpdate = {
        token: this.TOKEN_SYMBOL,
        price: data.solana.usd,
        priceUSD: data.solana.usd,
        change24h: data.solana.usd_24h_change || 0,
        volume24h: data.solana.usd_24h_vol || 0,
        marketCap: data.solana.usd_market_cap || 0,
        timestamp: new Date().toISOString(),
        source: 'coingecko',
      };

      console.log(`[PriceService] Got price from CoinGecko: $${priceUpdate.priceUSD}`);
      return priceUpdate;
    } catch (coinGeckoError: any) {
      console.warn('[PriceService] CoinGecko failed:', coinGeckoError.message);
    }

    // Try Jupiter API as fallback
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const url = `https://lite-api.jup.ag/price/v2?ids=${solMintAddress}`;
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      const data = await response.json() as any;
      
      if (data?.data?.[solMintAddress]?.price) {
        const price = parseFloat(data.data[solMintAddress].price);
        const priceUpdate: PriceUpdate = {
          token: this.TOKEN_SYMBOL,
          price,
          priceUSD: price,
          change24h: 0,
          volume24h: 0,
          marketCap: 0,
          timestamp: new Date().toISOString(),
          source: 'jupiter',
        };
        
        console.log(`[PriceService] Got price from Jupiter: $${price}`);
        return priceUpdate;
      }
    } catch (jupiterError: any) {
      console.warn('[PriceService] Jupiter failed:', jupiterError.message);
    }

    // Return cached price if available
    if (this.lastPrice) {
      console.warn('[PriceService] All APIs failed, using cached price');
      return {
        ...this.lastPrice,
        timestamp: new Date().toISOString(),
        source: 'cache',
      };
    }

    // Last resort: return a reasonable fallback
    console.warn('[PriceService] No cached price, using fallback: $150');
    return {
      token: this.TOKEN_SYMBOL,
      price: 150.0,
      priceUSD: 150.0,
      change24h: 0,
      volume24h: 0,
      marketCap: 0,
      timestamp: new Date().toISOString(),
      source: 'fallback',
    };
  }

  /**
   * Clean up subscriptions for disconnected socket
   */
  handleDisconnect(socketId: string): void {
    this.unsubscribe(socketId);
  }

  /**
   * Get service stats
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      subscribers: this.subscriptions.size,
      lastPrice: this.lastPrice,
      pollInterval: this.POLL_INTERVAL_MS,
    };
  }
}

