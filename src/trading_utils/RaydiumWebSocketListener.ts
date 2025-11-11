import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { PoolDiscovery, PoolInfo } from '../utils/PoolDiscovery';

const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/**
 * Raydium trade event data structure
 */
export interface RaydiumTradeEvent {
  poolAddress: string;
  tokenMint: string;
  solAmount: number;
  tokenAmount: number;
  isBuy: boolean;
  user: string;
  signature: string;
  timestamp: number;
  price: number;
}

/**
 * Real-time WebSocket listener for Raydium AMM V4 trades
 * Monitors graduated pump.fun tokens and standard Solana tokens on Raydium
 */
export class RaydiumWebSocketListener extends EventEmitter {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private isMonitoring = false;
  private monitoredPools: Map<string, PoolInfo> = new Map(); // poolAddress → PoolInfo
  private poolDiscovery: PoolDiscovery;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    super();
    this.rpcUrl = rpcUrl;
    
    // Create WebSocket connection
    const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    this.connection = new Connection(rpcUrl, {
      wsEndpoint: wsUrl,
      commitment: 'confirmed'
    });
    
    // Initialize pool discovery utility
    this.poolDiscovery = new PoolDiscovery(this.connection);
  }

  /**
   * Start monitoring trades for a specific token
   * Finds the Raydium pool and subscribes to it
   */
  async start(tokenAddress: string): Promise<void> {
    console.log(`🌊 [RaydiumWS] Starting monitoring for token: ${tokenAddress.substring(0, 8)}...`);

    // Find Raydium pool for this token
    const poolInfo = await this.poolDiscovery.findPoolForToken(tokenAddress);

    if (!poolInfo) {
      console.error(`❌ [RaydiumWS] No Raydium pool found for ${tokenAddress}`);
      throw new Error(`No Raydium pool found for token ${tokenAddress}`);
    }

    console.log(`✅ [RaydiumWS] Found pool: ${poolInfo.poolAddress.substring(0, 8)}...`);

    // Store pool info
    this.monitoredPools.set(poolInfo.poolAddress, poolInfo);

    console.log(`📊 [RaydiumWS] Now monitoring ${this.monitoredPools.size} pool(s)`);

    // Subscribe to program logs if not already subscribed
    if (!this.isMonitoring) {
      await this.subscribe();
    }
  }

  /**
   * Stop monitoring trades for a specific token
   */
  async stopToken(tokenAddress: string): Promise<void> {
    // Find and remove pool for this token
    for (const [poolAddress, poolInfo] of this.monitoredPools.entries()) {
      if (poolInfo.tokenMint.toLowerCase() === tokenAddress.toLowerCase()) {
        this.monitoredPools.delete(poolAddress);
        console.log(`🛑 [RaydiumWS] Stopped monitoring pool: ${poolAddress.substring(0, 8)}...`);
        break;
      }
    }

    console.log(`📊 [RaydiumWS] Remaining pools: ${this.monitoredPools.size}`);

    // If no pools left, close subscription
    if (this.monitoredPools.size === 0) {
      await this.stop();
    }
  }

  /**
   * Subscribe to Raydium AMM V4 program logs
   */
  private async subscribe(): Promise<void> {
    try {
      const programId = new PublicKey(RAYDIUM_AMM_V4_PROGRAM_ID);

      console.log(`🔌 [RaydiumWS] Connecting to Solana WebSocket...`);
      console.log(`🎯 [RaydiumWS] Monitoring program: ${RAYDIUM_AMM_V4_PROGRAM_ID}`);

      // Subscribe to ALL logs from Raydium AMM V4 program
      this.subscriptionId = this.connection.onLogs(
        programId,
        (logs: Logs, context: Context) => {
          this.handleLogs(logs, context);
        },
        'confirmed'
      );

      this.isMonitoring = true;
      this.reconnectAttempts = 0;
      console.log(`✅ [RaydiumWS] Connected! Subscription ID: ${this.subscriptionId}`);
      console.log(`🎧 [RaydiumWS] Listening for swaps on ${this.monitoredPools.size} pool(s)`);

      // Emit connection event
      this.emit('connected');

    } catch (error) {
      console.error(`❌ [RaydiumWS] Subscription failed:`, error);
      this.emit('error', error);

      // Attempt reconnection
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming logs from Solana
   * Parse and filter for swap events on monitored pools
   */
  private handleLogs(logs: Logs, context: Context): void {
    try {
      // Raydium logs contain instruction data
      // We need to parse the logs to detect swap events
      
      // Check if this transaction involves any of our monitored pools
      const logString = logs.logs.join(' ');
      
      // Look for monitored pool addresses in logs
      for (const [poolAddress, poolInfo] of this.monitoredPools.entries()) {
        if (logString.includes(poolAddress)) {
          // This is a transaction on one of our monitored pools
          this.processSwapTransaction(logs, context, poolAddress, poolInfo);
          break;
        }
      }
      
    } catch (error) {
      // Silently ignore parsing errors (not all logs are swap events)
      if (error instanceof Error && !error.message.includes('Could not find')) {
        console.error('[RaydiumWS] Error handling logs:', error.message);
      }
    }
  }

  /**
   * Process a swap transaction on a monitored pool
   */
  private async processSwapTransaction(
    logs: Logs,
    context: Context,
    poolAddress: string,
    poolInfo: PoolInfo
  ): Promise<void> {
    try {
      // Parse transaction to extract swap details
      // In production, you would parse the actual instruction data
      // For now, we'll use a simplified approach based on logs
      
      const logString = logs.logs.join('\n');
      
      // Raydium logs contain: "Program log: ray_log: ..."
      // Extract swap data from logs
      const swapLogMatch = logString.match(/ray_log: ([A-Za-z0-9+/=]+)/);
      
      if (!swapLogMatch) {
        return; // No swap data found
      }

      // In production, decode the base64 log data
      // For now, we'll detect buy/sell from log patterns
      const isBuy = logString.includes('SwapBaseIn') || logString.includes('swap in');
      
      // Fetch the actual transaction to get precise amounts
      const signature = logs.signature;
      if (!signature) return;

      console.log(`🔍 [RaydiumWS] Fetching transaction details: ${signature.substring(0, 12)}...`);

      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx || tx.meta?.err) {
        return; // Failed transaction
      }

      // Parse token transfers from transaction
      const transfers = this.parseTransfersFromTransaction(tx, poolInfo);
      
      if (!transfers) {
        return; // Couldn't parse transfers
      }

      const trade: RaydiumTradeEvent = {
        poolAddress,
        tokenMint: poolInfo.tokenMint,
        solAmount: transfers.solAmount,
        tokenAmount: transfers.tokenAmount,
        isBuy: transfers.isBuy,
        user: transfers.user,
        signature: signature,
        timestamp: Date.now() / 1000,
        price: 0
      };

      trade.price = trade.solAmount / trade.tokenAmount;

      console.log(`\n🌊 [RaydiumWS] RAYDIUM SWAP DETECTED:`);
      console.log(`   Token: ${trade.tokenMint.substring(0, 8)}...`);
      console.log(`   Pool: ${poolAddress.substring(0, 8)}...`);
      console.log(`   Type: ${trade.isBuy ? '🟢 BUY' : '🔴 SELL'}`);
      console.log(`   SOL: ${trade.solAmount.toFixed(4)}`);
      console.log(`   Tokens: ${trade.tokenAmount.toFixed(2)}`);
      console.log(`   Price: ${trade.price.toFixed(9)} SOL/token`);
      console.log(`   Signature: ${signature.substring(0, 12)}...\n`);

      // Emit trade event (RealTradeFeedService will catch this)
      this.emit('trade', trade);

    } catch (error) {
      console.error('[RaydiumWS] Error processing swap:', error);
    }
  }

  /**
   * Parse token transfers from parsed transaction
   */
  private parseTransfersFromTransaction(tx: any, poolInfo: PoolInfo): {
    solAmount: number;
    tokenAmount: number;
    isBuy: boolean;
    user: string;
  } | null {
    try {
      const meta = tx.meta;
      if (!meta) return null;

      // Parse pre and post token balances
      const preBalances = meta.preTokenBalances || [];
      const postBalances = meta.postTokenBalances || [];

      // Find SOL and token transfers
      let solAmount = 0;
      let tokenAmount = 0;
      let user = '';

      // Check SOL balance changes (lamports)
      const solChange = meta.postBalances[0] - meta.preBalances[0];
      solAmount = Math.abs(solChange) / 1e9; // Convert lamports to SOL

      // Check token balance changes
      for (let i = 0; i < preBalances.length; i++) {
        const pre = preBalances[i];
        const post = postBalances.find((p: any) => p.accountIndex === pre.accountIndex);

        if (post && pre.mint === poolInfo.tokenMint) {
          const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
          const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
          tokenAmount = Math.abs(postAmount - preAmount);
          user = pre.owner || '';
        }
      }

      // Determine if buy or sell based on balance changes
      const isBuy = solChange < 0; // User sent SOL = BUY

      if (solAmount > 0 && tokenAmount > 0) {
        return {
          solAmount,
          tokenAmount,
          isBuy,
          user: user || tx.transaction.message.accountKeys[0].pubkey.toString()
        };
      }

      return null;
    } catch (error) {
      console.error('[RaydiumWS] Error parsing transfers:', error);
      return null;
    }
  }

  /**
   * Stop all monitoring and close WebSocket connection
   */
  async stop(): Promise<void> {
    console.log('[RaydiumWS] Stopping...');

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Remove subscription
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
        console.log(`✅ [RaydiumWS] Unsubscribed (ID: ${this.subscriptionId})`);
      } catch (error) {
        console.error('[RaydiumWS] Error unsubscribing:', error);
      }
      this.subscriptionId = null;
    }

    this.isMonitoring = false;
    this.monitoredPools.clear();
    console.log('[RaydiumWS] Stopped');

    // Emit disconnection event
    this.emit('disconnected');
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`❌ [RaydiumWS] Max reconnection attempts reached`);
      this.emit('max-reconnect-attempts');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`🔄 [RaydiumWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      console.log(`🔄 [RaydiumWS] Attempting reconnection...`);
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
   * Get list of monitored token mints
   */
  getMonitoredTokens(): string[] {
    return Array.from(this.monitoredPools.values()).map(pool => pool.tokenMint);
  }

  /**
   * Check if a specific token is being monitored
   */
  isMonitoringToken(tokenAddress: string): boolean {
    for (const poolInfo of this.monitoredPools.values()) {
      if (poolInfo.tokenMint.toLowerCase() === tokenAddress.toLowerCase()) {
        return true;
      }
    }
    return false;
  }
}