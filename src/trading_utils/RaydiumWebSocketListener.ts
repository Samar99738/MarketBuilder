import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { PoolDiscovery, PoolInfo } from '../utils/PoolDiscovery';

const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const METEORA_DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'; // Meteora Dynamic Liquidity Market Maker
const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'; // Orca Whirlpool

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
  private poolActivityTracker: Map<string, { lastActivity: number; matchCount: number }> = new Map();
  private readonly POOL_INACTIVITY_TIMEOUT = 30000; // 30 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private rpcUrl: string;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastActivityTimestamp: number = Date.now();
  private readonly HEALTH_CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
  private readonly MAX_INACTIVITY_MS = 120000; // 2 minutes without activity = reconnect

  constructor(rpcUrl: string) {
    super();
    this.rpcUrl = rpcUrl;
    
    // Create WebSocket connection
    // FIX #3: Use 'processed' commitment for minimal latency (~200-400ms vs 2-5s with 'confirmed')
    const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    this.connection = new Connection(rpcUrl, {
      wsEndpoint: wsUrl,
      commitment: 'processed' // FIX #3: Changed from 'confirmed' to 'processed' for <500ms latency
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
      console.log(`\n🌊 [RaydiumWS] Starting monitoring for token: ${tokenAddress}`);

      // Find Raydium pool for this token
      console.log(`🔍 [RaydiumWS] Calling PoolDiscovery.findPoolForToken...`);
      const discovered = await this.poolDiscovery.findPoolForToken(tokenAddress);

      if (!discovered) {
        console.error(`\n❌ [RaydiumWS] POOL DISCOVERY FAILED for ${tokenAddress}`);
        console.error(`   Token: ${tokenAddress}`);
        console.error(`   Possible reasons:`);
        console.error(`   1. Network/firewall blocking API calls (DexScreener, Raydium)`);
        console.error(`   2. Token doesn't have a Raydium pool (check DexScreener manually)`);
        console.error(`   3. Token only trades on Pump.fun bonding curve (not graduated)`);
        console.error(`   4. API rate limiting (wait and try again)\n`);
        throw new Error(`No Raydium pool found for token ${tokenAddress}. Check logs above for details.`);
      }

      console.log(`\n✅ [RaydiumWS] ==================== POOL DISCOVERED ====================`);
      console.log(`   Token Address: ${discovered.tokenMint}`);
      console.log(`   Pool Address:  ${discovered.poolAddress}`);
      console.log(`   Base Mint:     ${discovered.baseMint}`);
      console.log(`   Quote Mint:    ${discovered.quoteMint}`);
      console.log(`================================================================\n`);

      poolInfo = discovered;
    } else {
      // PoolInfo provided directly - use it
      poolInfo = tokenAddressOrPoolInfo;
      console.log(`\n🌊 [RaydiumWS] Starting monitoring for pool: ${poolInfo.poolAddress}`);
      console.log(`   Token: ${poolInfo.tokenMint}\n`);
    }

    // CRITICAL FIX: Check if we're already monitoring this pool
    if (this.monitoredPools.has(poolInfo.poolAddress)) {
      console.log(`⚠️ [RaydiumWS] Already monitoring pool ${poolInfo.poolAddress.substring(0, 8)}... - skipping duplicate`);
      return;
    }

    // CRITICAL FIX: Check if we're monitoring a different token and should stop it
    // (This happens when user switches tokens in the UI)
    for (const [existingPoolAddress, existingPoolInfo] of this.monitoredPools.entries()) {
      if (existingPoolInfo.tokenMint !== poolInfo.tokenMint) {
        console.log(`⚠️ [RaydiumWS] Switching from ${existingPoolInfo.tokenMint.substring(0, 8)}... to ${poolInfo.tokenMint.substring(0, 8)}...`);
        console.log(`   Removing old pool: ${existingPoolAddress.substring(0, 8)}...`);
        this.monitoredPools.delete(existingPoolAddress);
        this.poolActivityTracker.delete(existingPoolAddress);
      }
    }

    // Store pool info
    this.monitoredPools.set(poolInfo.poolAddress, poolInfo);
    
    // Initialize activity tracker
    this.poolActivityTracker.set(poolInfo.poolAddress, {
      lastActivity: Date.now(),
      matchCount: 0
    });

    console.log(`\n🎯 [RaydiumWS] ======================== MONITORING ACTIVE ========================`);
    console.log(`   Token Being Monitored: ${poolInfo.tokenMint}`);
    console.log(`   Pool Being Watched:    ${poolInfo.poolAddress}`);
    console.log(`   Total Pools Monitored: ${this.monitoredPools.size}`);
    console.log(`   ⚠️  CRITICAL: Transactions MUST contain BOTH pool AND token to match!`);
    console.log(`========================================================================\n`);
    
    console.log(`⏱️ [RaydiumWS] Will check pool activity... If no swaps detected in 30s, pool might be inactive`);

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
   * Subscribe to DEX program logs (Raydium, Meteora, Orca)
   * CRITICAL FIX: Subscribe to specific pool address instead of entire program
   * This reduces noise from 1000+ tx/sec to only relevant pool transactions
   */
  private async subscribe(): Promise<void> {
    try {
      console.log(`🔌 [RaydiumWS] Connecting to Solana WebSocket...`);
      
      // CRITICAL FIX: Subscribe to SPECIFIC POOL ADDRESS instead of entire program
      // This filters transactions at the RPC level, not client-side
      if (this.monitoredPools.size === 0) {
        console.warn(`⚠️ [RaydiumWS] No pools to monitor - skipping subscription`);
        return;
      }

      // Get the first pool address (we're monitoring one pool at a time in this implementation)
      const poolAddress = Array.from(this.monitoredPools.keys())[0];
      const poolInfo = this.monitoredPools.get(poolAddress)!;
      
      console.log(`🎯 [RaydiumWS] Subscribing to SPECIFIC POOL: ${poolAddress}`);
      console.log(`🎯 [RaydiumWS] Token: ${poolInfo.tokenMint}`);
      console.log(`🎯 [RaydiumWS] This will ONLY receive transactions involving this pool`);

      // Subscribe to logs mentioning the specific pool address
      // This is MUCH more efficient than subscribing to the entire Raydium program
      const poolPubkey = new PublicKey(poolAddress);
      
      this.subscriptionId = this.connection.onLogs(
        poolPubkey, // Subscribe to pool, not program!
        (logs: Logs, context: Context) => {
          this.handleLogs(logs, context);
        },
        'processed' // Use 'processed' for minimal latency
      );

      this.isMonitoring = true;
      this.reconnectAttempts = 0;
      this.lastActivityTimestamp = Date.now();
      console.log(`✅ [RaydiumWS] Connected! Subscription ID: ${this.subscriptionId}`);
      console.log(`🎧 [RaydiumWS] Listening for swaps on pool: ${poolAddress.substring(0, 8)}...`);
      console.log(`📊 [RaydiumWS] Token being tracked: ${poolInfo.tokenMint.substring(0, 8)}...`);

      // Start health monitoring
      this.startHealthMonitoring();

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
   * PRODUCTION FIX: Enhanced pattern matching and error handling
   */
  private handleLogs(logs: Logs, context: Context): void {
    try {
      // Update activity timestamp - connection is alive
      this.lastActivityTimestamp = Date.now();
      
      const signature = logs.signature;
      if (!signature) return;

      // Check if this is a Raydium transaction
      const logString = logs.logs.join('\n');
      
      // PRODUCTION FIX: Comprehensive swap detection patterns for multiple DEXs
      const isDexSwap = 
        // Raydium patterns
        logString.includes('Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke') ||
        logString.includes('Program log: ray_log:') ||
        // Meteora patterns
        logString.includes('Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke') ||
        // Orca patterns  
        logString.includes('Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke') ||
        // Generic swap patterns
        logString.includes('SwapBaseIn') ||
        logString.includes('SwapBaseOut') ||
        /Instruction: Swap/.test(logString) ||
        /swap/.test(logString.toLowerCase());
      
      if (!isDexSwap) return;

      // PRODUCTION FIX: Process ALL DEX swap transactions
      // Many DEXs (Meteora, Orca, etc.) don't include "Transfer" in logs
      // We'll validate the transaction has actual token/SOL movements when parsing
      console.log(`🔍 [RaydiumWS] Raydium swap detected (sig: ${signature.substring(0, 12)}...), fetching transaction...`);
      
      // This is a Raydium swap - fetch transaction to check if it's on our monitored pools
      this.processRaydiumTransaction(signature, logs, context);
      
    } catch (error) {
      // PRODUCTION FIX: Better error logging
      if (error instanceof Error) {
        if (!error.message.includes('Could not find') && !error.message.includes('not found')) {
          console.error('[RaydiumWS] Error handling logs:', error.message);
          console.error('[RaydiumWS] Signature:', logs.signature);
        }
      }
    }
  }

  /**
   * Process a potential Raydium transaction
   * Enhanced with deduplication, better error handling, and comprehensive logging
   */
  private processedSignatures: Set<string> = new Set(); // Prevent duplicate processing
  private readonly MAX_PROCESSED_SIGNATURES = 1000; // Limit memory usage

  private async processRaydiumTransaction(
    signature: string,
    logs: Logs,
    context: Context
  ): Promise<void> {
    try {
      // Prevent duplicate transaction processing
      if (this.processedSignatures.has(signature)) {
        return; // Already processed this transaction
      }
      
      // Add to processed set
      this.processedSignatures.add(signature);
      
      // Clean up old signatures to prevent memory leak
      if (this.processedSignatures.size > this.MAX_PROCESSED_SIGNATURES) {
        const firstSignature = this.processedSignatures.values().next().value;
        if (firstSignature) {
          this.processedSignatures.delete(firstSignature);
        }
      }

      // Fetch full transaction to check which pool it belongs to
      // FIX #3: Keep 'confirmed' for getParsedTransaction (API limitation - doesn't support 'processed')
      // The latency improvement comes from WebSocket subscription using 'processed' commitment
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx || tx.meta?.err) {
        console.log(`⚠️ [RaydiumWS] Transaction not available or failed: ${signature.substring(0, 12)}...`);
        if (tx?.meta?.err) {
          console.log(`   Error: ${JSON.stringify(tx.meta.err)}`);
        }
        return;
      }

      // PRODUCTION FIX: Check if any of our monitored pools are involved
      const accountKeys = tx.transaction.message.accountKeys;
      
      // Only log detailed info if we're monitoring pools
      if (this.monitoredPools.size > 0) {
        console.log(`🔍 [RaydiumWS] Checking transaction ${signature.substring(0, 12)}... with ${accountKeys.length} accounts`);
        console.log(`📋 [RaydiumWS] Monitoring ${this.monitoredPools.size} pool(s): ${Array.from(this.monitoredPools.keys()).map(p => p.substring(0, 8)).join(', ')}`);
        
        // Debug: Show first few account keys
        const firstAccounts = accountKeys.slice(0, 5).map((key: any) => {
          const pubkey = typeof key === 'string' ? key : key.pubkey?.toString();
          return pubkey?.substring(0, 8) || 'unknown';
        });
        console.log(`🔍 [RaydiumWS] First 5 accounts: ${firstAccounts.join(', ')}...`);
      }
      
      let foundMatch = false;
      
      for (const [poolAddress, poolInfo] of this.monitoredPools.entries()) {
        // Check MULTIPLE ways to match transactions
        // 1. Check account keys (pool address)
        // 2. Check token mint in account keys  
        // 3. Check token mint in preTokenBalances/postTokenBalances (CRITICAL for Jupiter/aggregator swaps)
        
        const allAccounts = accountKeys.map((key: any) => 
          typeof key === 'string' ? key : key.pubkey?.toString()
        );
        
        // Method 1: Direct pool address match
        const poolMatch = allAccounts.includes(poolAddress);
        
        if (poolMatch) {
          console.log(`\n✅✅✅ [RaydiumWS] POOL ADDRESS MATCH! ✅✅✅`);
          console.log(`   Pool: ${poolAddress}`);
          console.log(`   Token: ${poolInfo.tokenMint}`);
        } else {
          console.log(`⚠️ [RaydiumWS] Pool NOT in transaction`);
          console.log(`   Looking for pool: ${poolAddress}`);
          console.log(`   Transaction accounts (first 10): ${allAccounts.slice(0, 10).map(a => a?.substring(0, 8)).join(', ')}...`);
        }
        
        // Method 2: Direct token mint match in accounts
        const tokenMatch = allAccounts.includes(poolInfo.tokenMint);
        
        if (tokenMatch) {
          console.log(`✅ [RaydiumWS] Token mint MATCH! ${poolInfo.tokenMint.substring(0, 8)}... found in transaction`);
        }
        
        // Method 3: Check token mint in balance changes (WORKS FOR ALL DEX SWAPS)
        let tokenBalanceMatch = false;
        const targetTokenLower = poolInfo.tokenMint.toLowerCase();
        
        if (tx.meta) {
          const allTokenMints = [
            ...(tx.meta.preTokenBalances || []).map((b: any) => b.mint),
            ...(tx.meta.postTokenBalances || []).map((b: any) => b.mint)
          ];
          
          // CRITICAL: Case-insensitive comparison
          tokenBalanceMatch = allTokenMints.some((mint: string) => 
            mint.toLowerCase() === targetTokenLower
          );
          
          // Also check if ANY token changed at all (safety net)
          if (!tokenBalanceMatch && allTokenMints.length > 0) {
            // If we're monitoring this pool and there ARE token transfers, log details
            console.log(`🔍 [RaydiumWS] Checking ${signature.substring(0, 12)}... - ${allTokenMints.length} token(s) found`);
            console.log(`   Target: ${poolInfo.tokenMint}`);
            console.log(`   Found: ${allTokenMints.join(', ')}`);
            
            // CRITICAL: Emit heartbeat for wrong token transactions
            // This keeps the health check alive even when all transactions are filtered out
            console.log(`💓 [RaydiumWS] Heartbeat - Transaction processed but token not matched`);
            this.emit('heartbeat', {
              processed: true,
              matched: false,
              reason: 'token_not_in_transaction',
              expected: poolInfo.tokenMint,
              found: allTokenMints
            });
          }
        }
        
        // Must check BOTH pool address AND token presence!
        // Pool address alone is not enough (many pools use same program)
        // Token alone is not enough (could be in a different pool)
        // BOTH must match for this transaction to be relevant!
        const poolInvolved = poolMatch && (tokenMatch || tokenBalanceMatch);
        
        // Success logging
        if (poolInvolved) {
          const matchType = poolMatch ? 'pool address' : (tokenMatch ? 'token mint' : 'token balance');
          console.log(`\n✅ [RaydiumWS] MATCH! Found ${matchType} in transaction ${signature.substring(0, 12)}...`);
          console.log(`   Token: ${poolInfo.tokenMint.substring(0, 8)}...`);
        }

        if (poolInvolved) {
          console.log(`✅ [RaydiumWS] MATCH! Found ${poolMatch ? 'pool' : 'token'} ${poolAddress.substring(0, 8)}... in transaction`);
          foundMatch = true;
          
          // Update activity tracker
          const tracker = this.poolActivityTracker.get(poolAddress);
          if (tracker) {
            tracker.lastActivity = Date.now();
            tracker.matchCount++;
            console.log(`📊 [RaydiumWS] Pool activity: ${tracker.matchCount} swaps detected`);
          }
          
          // This transaction involves our monitored pool
          await this.processSwapForPool(tx, signature, poolAddress, poolInfo);
          break; // Only process once per transaction
        }
      }
      
      // Check for inactive pools periodically
      if (!foundMatch && this.monitoredPools.size > 0) {
        for (const [poolAddress, poolInfo] of this.monitoredPools.entries()) {
          const tracker = this.poolActivityTracker.get(poolAddress);
          if (tracker && tracker.matchCount === 0 && (Date.now() - tracker.lastActivity > this.POOL_INACTIVITY_TIMEOUT)) {
            console.warn(`🔴 [RaydiumWS] ALERT: Pool ${poolAddress.substring(0, 8)}... has NO swaps for ${Math.floor((Date.now() - tracker.lastActivity) / 1000)}s`);
            console.warn(`   Possible causes:`);
            console.warn(`   1. Wrong pool address (verify on Raydium UI or DexScreener)`);
            console.warn(`   2. Pool is inactive/abandoned`);
            console.warn(`   3. Token only trades on Pump.fun bonding curve (not graduated)`);
            console.warn(`   4. RPC connection issue (check WebSocket status)`);
            // Reset timer to avoid spamming
            tracker.lastActivity = Date.now();
          }
        }
      }
    } catch (error) {
      console.error(`❌ [RaydiumWS] Error processing transaction ${signature.substring(0, 12)}:`, error instanceof Error ? error.message : error);
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

      // CRITICAL FIX: Verify the token in the transaction matches our monitored token
      // Only emit if the specific token we're monitoring was involved
      if (transfers.actualTokenMint && transfers.actualTokenMint.toLowerCase() !== poolInfo.tokenMint.toLowerCase()) {
        console.log(`⚠️ [RaydiumWS] Token mismatch - Expected: ${poolInfo.tokenMint.substring(0, 8)}..., Got: ${transfers.actualTokenMint.substring(0, 8)}...`);
        console.log(`🔇 [RaydiumWS] Ignoring trade for different token in same pool`);
        return;
      }

      const trade: RaydiumTradeEvent = {
        poolAddress,
        tokenMint: poolInfo.tokenMint, // Always use the monitored token mint
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
      console.log(`   Token: ${trade.tokenMint.substring(0, 8)}...${trade.tokenMint.substring(trade.tokenMint.length - 4)}`);
      console.log(`   Pool: ${poolAddress.substring(0, 8)}...`);
      console.log(`   Type: ${trade.isBuy ? '🟢 BUY' : '🔴 SELL'}`);
      console.log(`   SOL: ${trade.solAmount.toFixed(4)}`);
      console.log(`   Tokens: ${trade.tokenAmount.toFixed(2)}`);
      console.log(`   Price: ${trade.price.toFixed(9)} SOL/token`);
      console.log(`   User: ${trade.user.substring(0, 8)}...`);
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
    actualTokenMint: string | null;
  } | null {
    try {
      const meta = tx.meta;
      if (!meta || meta.err) return null;

      // Get token balance changes
      const preTokenBalances = meta.preTokenBalances || [];
      const postTokenBalances = meta.postTokenBalances || [];

      let tokenAmount = 0;
      let userAccount = '';
      let tokenIncreased = false; // Track direction of token change
      let actualTokenMint: string | null = null; // Track which token was actually traded

      // Find the ACTUAL token being traded (largest balance change)
      // Then validate if it matches our monitored token
      for (const pre of preTokenBalances) {
        // Process ALL token mints to find which one is actually being traded
        const post = postTokenBalances.find((p: any) => 
          p.accountIndex === pre.accountIndex && p.mint === pre.mint
        );

        if (post) {
          const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
          const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
          const change = Math.abs(postAmount - preAmount);
          
          // Find the token with the LARGEST change (that's the one being traded)
          if (change > tokenAmount) {
            tokenAmount = change;
            tokenIncreased = postAmount > preAmount; // TRUE if user received tokens (BUY)
            userAccount = pre.owner || post.owner || '';
            actualTokenMint = pre.mint; // Store the actual token mint that was traded
          }
        }
      }

      // CRITICAL VALIDATION: Verify the token traded matches our monitored token
      if (actualTokenMint && actualTokenMint.toLowerCase() !== poolInfo.tokenMint.toLowerCase()) {
        console.log(`⚠️ [RaydiumWS] parseTransfers - Token mismatch detected!`);
        console.log(`   Expected: ${poolInfo.tokenMint.substring(0, 8)}...`);
        console.log(`   Found: ${actualTokenMint.substring(0, 8)}...`);
        console.log(`   🚫 Rejecting transaction - wrong token`);
        
        // Emit heartbeat to show listener is alive (even though trade is rejected)
        this.emit('heartbeat', { 
          processed: true, 
          matched: false, 
          reason: 'token_mismatch',
          expected: poolInfo.tokenMint,
          found: actualTokenMint
        });
        
        return null; // Wrong token - don't process this transaction
      }

      // If no token mint found at all, reject
      if (!actualTokenMint) {
        console.log(`⚠️ [RaydiumWS] parseTransfers - No token mint found in transaction`);
        
        // Emit heartbeat to show listener is alive
        this.emit('heartbeat', { 
          processed: true, 
          matched: false, 
          reason: 'no_token_found'
        });
        
        return null;
      }

      // Get SOL balance changes (lamports to SOL)
      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      
      let maxSolChange = 0;
      let solSignerIndex = -1;

      // Find the account with largest SOL change (usually the user/signer)
      // Exclude program accounts and focus on user wallet
      for (let i = 0; i < preBalances.length; i++) {
        const changeInLamports = Math.abs(postBalances[i] - preBalances[i]);
        
        // Skip if change is too small (likely fee payer, not trader)
        if (changeInLamports < 1000000) continue; // < 0.001 SOL
        
        if (changeInLamports > maxSolChange * 1e9) {
          maxSolChange = changeInLamports / 1e9;
          solSignerIndex = i;
        }
      }

      const solAmount = maxSolChange;

      // Determine buy vs sell using TOKEN balance changes (more reliable)
      // If token increased (user received tokens) = BUY
      // If token decreased (user gave away tokens) = SELL
      const isBuy = tokenIncreased;
      
      // Debug buy/sell detection
      if (solSignerIndex >= 0) {
        const solDecreased = postBalances[solSignerIndex] < preBalances[solSignerIndex];
        console.log(`\n💰 [RaydiumWS] BUY/SELL Detection:`);
        console.log(`   Token Balance Change: ${tokenIncreased ? '⬆️ INCREASED' : '⬇️ DECREASED'} by ${tokenAmount.toFixed(2)} tokens`);
        console.log(`   SOL Balance Before: ${(preBalances[solSignerIndex] / 1e9).toFixed(6)} SOL`);
        console.log(`   SOL Balance After:  ${(postBalances[solSignerIndex] / 1e9).toFixed(6)} SOL`);
        console.log(`   SOL Change: ${solAmount.toFixed(6)} SOL (${solDecreased ? 'decreased ⬇️' : 'increased ⬆️'})`);
        console.log(`   Direction: ${isBuy ? '🟢 BUY (received tokens)' : '🔴 SELL (gave away tokens)'}`);
        console.log(`   ✅ Final Determination: ${isBuy ? 'BUY' : 'SELL'}\n`);
      }

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
          user: userAccount || 'unknown',
          actualTokenMint
        };
      }

      return null;
    } catch (error) {
      console.error('[RaydiumWS] Error parsing transfers:', error);
      return null;
    }
  }

  /**
   * Start health monitoring to detect silent disconnections
   */
  private startHealthMonitoring(): void {
    // Clear any existing interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, this.HEALTH_CHECK_INTERVAL_MS);

    console.log(`💓 [RaydiumWS] Health monitoring started (checking every ${this.HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      console.log(`💓 [RaydiumWS] Health monitoring stopped`);
    }
  }

  /**
   * Check if WebSocket connection is still alive
   * Reconnect if no activity detected for MAX_INACTIVITY_MS
   */
  private checkConnectionHealth(): void {
    const timeSinceLastActivity = Date.now() - this.lastActivityTimestamp;
    const minutesSinceActivity = Math.floor(timeSinceLastActivity / 60000);

    if (timeSinceLastActivity > this.MAX_INACTIVITY_MS && this.isMonitoring) {
      console.error(`❌ [RaydiumWS] CONNECTION DEAD - No activity for ${minutesSinceActivity} minutes`);
      console.error(`❌ [RaydiumWS] WebSocket silently died - forcing reconnection...`);
      
      // Emit connection stale event
      this.emit('connection_stale', {
        minutesSinceActivity,
        monitoredTokens: this.getMonitoredTokens()
      });

      // Force reconnection
      this.forceReconnect();
    } else {
      // Connection is healthy
      const secondsSinceActivity = Math.floor(timeSinceLastActivity / 1000);
      console.log(`💓 [RaydiumWS] Health check - Connection alive (last activity: ${secondsSinceActivity}s ago)`);
    }
  }

  /**
   * Force reconnection (hard reset)
   */
  private async forceReconnect(): Promise<void> {
    console.log(`🔄 [RaydiumWS] FORCE RECONNECTING...`);
    
    // Store current monitored pools
    const poolsToRestore = new Map(this.monitoredPools);
    
    // Stop current connection
    await this.stop();
    
    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Restore monitored pools
    this.monitoredPools = poolsToRestore;
    
    // Re-subscribe
    if (this.monitoredPools.size > 0) {
      console.log(`🔄 [RaydiumWS] Restoring ${this.monitoredPools.size} monitored pool(s)`);
      await this.subscribe();
    }
  }

  /**
   * Stop all monitoring and close WebSocket connection
   */
  async stop(): Promise<void> {
    console.log('[RaydiumWS] Stopping...');

    // Stop health monitoring
    this.stopHealthMonitoring();

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