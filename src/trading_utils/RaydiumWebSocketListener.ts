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
  async start(tokenAddressOrPoolInfo: string | PoolInfo): Promise<void> {
    // Handle both string (token address) and PoolInfo inputs
    let poolInfo: PoolInfo;

    if (typeof tokenAddressOrPoolInfo === 'string') {
      // Token address provided - discover pool
      const tokenAddress = tokenAddressOrPoolInfo;
      console.log(`🌊 [RaydiumWS] Starting monitoring for token: ${tokenAddress.substring(0, 8)}...`);

      // Find Raydium pool for this token
      const discovered = await this.poolDiscovery.findPoolForToken(tokenAddress);

      if (!discovered) {
        console.error(`❌ [RaydiumWS] No Raydium pool found for ${tokenAddress}`);
        throw new Error(`No Raydium pool found for token ${tokenAddress}`);
      }

      poolInfo = discovered;
      console.log(`✅ [RaydiumWS] Found pool: ${poolInfo.poolAddress.substring(0, 8)}...`);
    } else {
      // PoolInfo provided directly - use it
      poolInfo = tokenAddressOrPoolInfo;
      console.log(`🌊 [RaydiumWS] Starting monitoring for pool: ${poolInfo.poolAddress.substring(0, 8)}...`);
    }

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
      const signature = logs.signature;
      if (!signature) return;

      // Check if this is a Raydium transaction
      const logString = logs.logs.join('\n');
      
      // Raydium swap logs contain specific patterns
      const isRaydiumSwap = logString.includes('Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke') ||
                           logString.includes('Program log: ray_log:');
      
      if (!isRaydiumSwap) return;

      // Check for token transfers (indicates a swap happened)
      const hasTransfer = logString.includes('Transfer');
      if (!hasTransfer) return;

      // CRITICAL FIX: Process ALL Raydium swaps, then filter by pool in transaction
      // Pool addresses often don't appear in logs, but in transaction accounts
      console.log(`🔍 [RaydiumWS] Potential Raydium swap detected, fetching transaction...`);
      
      // This is a Raydium swap - fetch transaction to check if it's on our monitored pools
      this.processRaydiumTransaction(signature, logs, context);
      
    } catch (error) {
      // Silently ignore parsing errors
      if (error instanceof Error && !error.message.includes('Could not find')) {
        console.error('[RaydiumWS] Error handling logs:', error.message);
      }
    }
  }

  /**
   * Process a potential Raydium transaction
   */
  private async processRaydiumTransaction(
    signature: string,
    logs: Logs,
    context: Context
  ): Promise<void> {
    try {
      // Fetch full transaction to check which pool it belongs to
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx || tx.meta?.err) {
        console.log(`⚠️ [RaydiumWS] Transaction not available or failed: ${signature.substring(0, 12)}...`);
        return;
      }

      // Check if any of our monitored pools are involved
      const accountKeys = tx.transaction.message.accountKeys;
      console.log(`🔍 [RaydiumWS] Checking transaction ${signature.substring(0, 12)}... with ${accountKeys.length} accounts`);
      console.log(`📋 [RaydiumWS] Monitoring ${this.monitoredPools.size} pool(s): ${Array.from(this.monitoredPools.keys()).map(p => p.substring(0, 8)).join(', ')}`);
      
      for (const [poolAddress, poolInfo] of this.monitoredPools.entries()) {
        // Check if pool address is in the transaction accounts
        const poolInvolved = accountKeys.some((key: any) => {
          const pubkey = typeof key === 'string' ? key : key.pubkey?.toString();
          const match = pubkey === poolAddress;
          if (match) {
            console.log(`✅ [RaydiumWS] FOUND MATCHING POOL: ${poolAddress.substring(0, 8)}...`);
          }
          return match;
        });

        if (poolInvolved) {
          console.log(`🎯 [RaydiumWS] Processing swap for pool: ${poolAddress.substring(0, 8)}...`);
          // This transaction involves our monitored pool
          await this.processSwapForPool(tx, signature, poolAddress, poolInfo);
          break;
        } else {
          console.log(`❌ [RaydiumWS] Pool ${poolAddress.substring(0, 8)}... NOT in transaction accounts`);
        }
      }
    } catch (error) {
      console.error(`❌ [RaydiumWS] Error processing transaction ${signature.substring(0, 12)}:`, error);
    }
  }

  /**
   * Process a swap for a specific pool (already fetched transaction)
   */
  private async processSwapForPool(
    tx: any,
    signature: string,
    poolAddress: string,
    poolInfo: PoolInfo
  ): Promise<void> {
    try {
      console.log(`🔧 [RaydiumWS] Parsing transaction for pool ${poolAddress.substring(0, 8)}...`);
      // Parse token transfers from transaction
      const transfers = this.parseTransfersFromTransaction(tx, poolInfo);
      
      if (!transfers) {
        console.log(`⚠️ [RaydiumWS] Failed to parse transfers from transaction`);
        return; // Couldn't parse transfers
      }
      
      console.log(`✅ [RaydiumWS] Parsed transfers successfully:`, {
        solAmount: transfers.solAmount,
        tokenAmount: transfers.tokenAmount,
        isBuy: transfers.isBuy,
        user: transfers.user.substring(0, 8) + '...'
      });

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

      trade.price = trade.tokenAmount > 0 ? trade.solAmount / trade.tokenAmount : 0;

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
      if (!meta || meta.err) return null;

      // Get token balance changes
      const preTokenBalances = meta.preTokenBalances || [];
      const postTokenBalances = meta.postTokenBalances || [];

      let tokenAmount = 0;
      let userAccount = '';

      // Find token mint balance changes (for the specific token we're monitoring)
      for (const pre of preTokenBalances) {
        if (pre.mint === poolInfo.tokenMint) {
          const post = postTokenBalances.find((p: any) => 
            p.accountIndex === pre.accountIndex && p.mint === pre.mint
          );

          if (post) {
            const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
            const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
            const change = Math.abs(postAmount - preAmount);
            
            if (change > tokenAmount) {
              tokenAmount = change;
              userAccount = pre.owner || post.owner || '';
            }
          }
        }
      }

      // Get SOL balance changes (lamports to SOL)
      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      
      let maxSolChange = 0;
      let solSignerIndex = -1;

      // Find the account with largest SOL change (usually the user)
      for (let i = 0; i < preBalances.length; i++) {
        const change = Math.abs(postBalances[i] - preBalances[i]);
        if (change > maxSolChange * 1e9) { // Compare in lamports
          maxSolChange = change / 1e9;
          solSignerIndex = i;
        }
      }

      const solAmount = maxSolChange;

      // Determine buy vs sell
      // If SOL decreased, user bought tokens (BUY)
      // If SOL increased, user sold tokens (SELL)
      const isBuy = solSignerIndex >= 0 && postBalances[solSignerIndex] < preBalances[solSignerIndex];

      // Get user public key
      if (!userAccount && tx.transaction?.message?.accountKeys) {
        const accounts = tx.transaction.message.accountKeys;
        if (solSignerIndex >= 0 && solSignerIndex < accounts.length) {
          userAccount = accounts[solSignerIndex]?.pubkey?.toString() || '';
        } else if (accounts.length > 0) {
          userAccount = accounts[0]?.pubkey?.toString() || '';
        }
      }

      if (solAmount > 0.0001 && tokenAmount > 0) { // Minimum threshold
        return {
          solAmount,
          tokenAmount,
          isBuy,
          user: userAccount || 'unknown'
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