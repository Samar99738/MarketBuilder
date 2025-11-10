import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { BorshCoder, EventParser, Event, Idl } from '@coral-xyz/anchor';
import { EventEmitter } from 'events';

const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * Trade event data structure from pump.fun program
 */
export interface PumpFunTradeEvent {
  mint: string;           // Token address
  solAmount: number;      // Amount in SOL
  tokenAmount: number;    // Amount in tokens
  isBuy: boolean;         // true = buy, false = sell
  user: string;           // Trader wallet address
  timestamp: number;      // Unix timestamp
  virtualSolReserves: number;
  realTokenReserves: number;
}

/**
 * Real-time WebSocket listener for pump.fun trades
 * Listens to Solana blockchain events directly - works for ANY token
 */
export class PumpFunWebSocketListener extends EventEmitter {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private eventParser: EventParser;
  private isMonitoring = false;
  private monitoredTokens: Set<string> = new Set(); // Track multiple tokens
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private rpcUrl: string;

  constructor(rpcUrl: string, idl: Idl) {
    super();
    this.rpcUrl = rpcUrl;
    
    // Create WebSocket connection
    const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    this.connection = new Connection(rpcUrl, {
      wsEndpoint: wsUrl,
      commitment: 'confirmed'
    });
    
    // Initialize event parser for pump.fun program
    const coder = new BorshCoder(idl);
    this.eventParser = new EventParser(new PublicKey(PUMPFUN_PROGRAM_ID), coder);
  }

  /**
   * Start monitoring trades for a specific token
   * Can be called multiple times for different tokens
   */
  async start(tokenAddress: string): Promise<void> {
    // Add token to monitored set
    this.monitoredTokens.add(tokenAddress.toLowerCase());
    console.log(`🔥 [PumpFunWebSocket] Added token to monitoring: ${tokenAddress}`);
    console.log(`📊 [PumpFunWebSocket] Total tokens monitored: ${this.monitoredTokens.size}`);

    // If already subscribed, no need to create new subscription
    if (this.isMonitoring && this.subscriptionId !== null) {
      console.log(`✅ [PumpFunWebSocket] Already subscribed, token will be monitored`);
      return;
    }

    // Create new subscription
    await this.subscribe();
  }

  /**
   * Stop monitoring trades for a specific token
   */
  async stopToken(tokenAddress: string): Promise<void> {
    this.monitoredTokens.delete(tokenAddress.toLowerCase());
    console.log(`🛑 [PumpFunWebSocket] Removed token from monitoring: ${tokenAddress}`);
    console.log(`📊 [PumpFunWebSocket] Remaining tokens: ${this.monitoredTokens.size}`);

    // If no tokens left, close subscription
    if (this.monitoredTokens.size === 0) {
      await this.stop();
    }
  }

  /**
   * Subscribe to pump.fun program logs
   */
  private async subscribe(): Promise<void> {
    try {
      const programId = new PublicKey(PUMPFUN_PROGRAM_ID);

      console.log(`🔌 [PumpFunWebSocket] Connecting to Solana WebSocket...`);
      console.log(`🎯 [PumpFunWebSocket] Monitoring program: ${PUMPFUN_PROGRAM_ID}`);

      // Subscribe to ALL logs from pump.fun program
      this.subscriptionId = this.connection.onLogs(
        programId,
        (logs: Logs, context: Context) => {
          this.handleLogs(logs, context);
        },
        'confirmed'
      );

      this.isMonitoring = true;
      this.reconnectAttempts = 0;
      console.log(`✅ [PumpFunWebSocket] Connected! Subscription ID: ${this.subscriptionId}`);
      console.log(`🎧 [PumpFunWebSocket] Listening for trades on ${this.monitoredTokens.size} token(s)`);
      
      // Emit connection event
      this.emit('connected');

    } catch (error) {
      console.error(`❌ [PumpFunWebSocket] Subscription failed:`, error);
      this.emit('error', error);
      
      // Attempt reconnection
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming logs from Solana
   */
  private handleLogs(logs: Logs, context: Context): void {
    try {
      // Parse events from transaction logs (convert generator to array)
      const events: Event[] = Array.from(this.eventParser.parseLogs(logs.logs));
      
      // Log received events for debugging
      if (events.length > 0) {
        console.log(`🔔 [PumpFunWebSocket] Received ${events.length} event(s) from blockchain`);
      }
      
      for (const event of events) {
        console.log(`📋 [PumpFunWebSocket] Event type: ${event.name}`);
        
        // Only process tradeEvent (buy/sell transactions)
        if (event.name === 'tradeEvent') {
          this.processTradeEvent(event);
        }
      }
    } catch (error) {
      // Silently ignore parsing errors (not all logs are trade events)
      // Only log if it's a critical error
      if (error instanceof Error && !error.message.includes('Could not find event')) {
        console.error('[PumpFunWebSocket] Error parsing logs:', error.message);
      }
    }
  }

  /**
   * Process a trade event and emit if it matches monitored tokens
   */
  private processTradeEvent(event: Event): void {
    try {
      const data = event.data as any;
      
      // CRITICAL: Ensure mint is properly converted to string
      // PublicKey.toString() returns base58 string
      const mintStr = typeof data.mint === 'string' ? data.mint : data.mint.toString();
      const mintAddress = mintStr.toLowerCase();

      console.log(`🔍 [PumpFunWebSocket] Trade detected for token: ${mintAddress.substring(0, 8)}...`);
      console.log(`🔍 [PumpFunWebSocket] data.mint type: ${typeof data.mint}, value: ${mintStr}`);
      console.log(`🔍 [PumpFunWebSocket] Full address (lowercase): ${mintAddress}`);
      console.log(`🔍 [PumpFunWebSocket] Monitoring ${this.monitoredTokens.size} token(s): ${Array.from(this.monitoredTokens).map(t => t.substring(0, 8)).join(', ')}`);
      console.log(`🔍 [PumpFunWebSocket] Full monitored addresses: ${Array.from(this.monitoredTokens).join(', ')}`);
      console.log(`🔍 [PumpFunWebSocket] Has token in set? ${this.monitoredTokens.has(mintAddress)}`);

      // Check if this token is being monitored
      if (!this.monitoredTokens.has(mintAddress)) {
        console.log(`⏭️ [PumpFunWebSocket] Skipping unmonitored token: ${mintAddress.substring(0, 8)}...`);
        return; // Skip unmonitored tokens
      }

      // Parse trade data
      const trade: PumpFunTradeEvent = {
        mint: data.mint.toString(),
        solAmount: this.convertLamportsToSol(data.solAmount),
        tokenAmount: this.convertToTokenAmount(data.tokenAmount),
        isBuy: data.isBuy,
        user: data.user.toString(),
        timestamp: data.timestamp.toNumber(),
        virtualSolReserves: this.convertLamportsToSol(data.virtualSolReserves),
        realTokenReserves: this.convertToTokenAmount(data.realTokenReserves)
      };

      // Log trade details
      console.log(`\n💰 [PumpFunWebSocket] REAL TRADE DETECTED:`);
      console.log(`   Token: ${trade.mint}`);
      console.log(`   Type: ${trade.isBuy ? '🟢 BUY' : '🔴 SELL'}`);
      console.log(`   SOL: ${trade.solAmount.toFixed(4)}`);
      console.log(`   Tokens: ${trade.tokenAmount.toFixed(2)}`);
      console.log(`   User: ${trade.user.slice(0, 8)}...`);
      console.log(`   Time: ${new Date(trade.timestamp * 1000).toISOString()}\n`);

      // Emit trade event (RealTradeFeedService will catch this)
      this.emit('trade', trade);

    } catch (error) {
      console.error('[PumpFunWebSocket] Error processing trade event:', error);
    }
  }

  /**
   * Convert lamports to SOL (1 SOL = 1e9 lamports)
   */
  private convertLamportsToSol(lamports: any): number {
    try {
      if (typeof lamports === 'number') return lamports / 1e9;
      if (lamports.toNumber) return lamports.toNumber() / 1e9;
      return Number(lamports) / 1e9;
    } catch {
      return 0;
    }
  }

  /**
   * Convert token amount (usually 1e6 decimals for pump.fun tokens)
   */
  private convertToTokenAmount(amount: any): number {
    try {
      if (typeof amount === 'number') return amount / 1e6;
      if (amount.toNumber) return amount.toNumber() / 1e6;
      return Number(amount) / 1e6;
    } catch {
      return 0;
    }
  }

  /**
   * Stop all monitoring and close WebSocket connection
   */
  async stop(): Promise<void> {
    console.log('[PumpFunWebSocket] Stopping...');
    
    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Remove subscription
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
        console.log(`✅ [PumpFunWebSocket] Unsubscribed (ID: ${this.subscriptionId})`);
      } catch (error) {
        console.error('[PumpFunWebSocket] Error unsubscribing:', error);
      }
      this.subscriptionId = null;
    }

    this.isMonitoring = false;
    this.monitoredTokens.clear();
    console.log('[PumpFunWebSocket] Stopped');
    
    // Emit disconnection event
    this.emit('disconnected');
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`❌ [PumpFunWebSocket] Max reconnection attempts reached`);
      this.emit('max-reconnect-attempts');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s
    this.reconnectAttempts++;

    console.log(`🔄 [PumpFunWebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      console.log(`🔄 [PumpFunWebSocket] Attempting reconnection...`);
      await this.subscribe();
    }, delay);
  }

  /**
   * Check if actively monitoring
   */
  isActive(): boolean {
    return this.isMonitoring && this.subscriptionId !== null;
  }

  /**
   * Get list of monitored tokens
   */
  getMonitoredTokens(): string[] {
    return Array.from(this.monitoredTokens);
  }

  /**
   * Check if a specific token is being monitored
   */
  isMonitoringToken(tokenAddress: string): boolean {
    return this.monitoredTokens.has(tokenAddress.toLowerCase());
  }
}