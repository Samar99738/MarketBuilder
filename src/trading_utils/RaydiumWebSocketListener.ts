import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { PoolDiscovery, PoolInfo } from '../utils/PoolDiscovery';

const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
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
        // Raydium patterns (V4 AMM + CPMM)
        logString.includes('Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke') ||
        logString.includes('Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke') ||
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
      
      // ✅ Better cleanup - keep only last 500 signatures
      if (this.processedSignatures.size > this.MAX_PROCESSED_SIGNATURES) {
        const sigArray = Array.from(this.processedSignatures);
        const toKeep = sigArray.slice(-500); // Keep newest 500
        this.processedSignatures = new Set(toKeep);
        
        console.log(`[RaydiumWS] Trimmed processed signatures: ${sigArray.length} → ${toKeep.length}`);
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
      let usedPoolVaultFallback = false; // Track if we used pool vault signal (means userAccount is POOL, not real user)

      // Find the ACTUAL token being traded (largest balance change)
      // CRITICAL FIX: Skip pool vault accounts, only track USER wallet accounts
      // Pool reserves show INVERTED signals (pool loses tokens when user buys)
      
      // Debug: Show ALL token accounts first
      console.log(`    [DEBUG] Total preTokenBalances: ${preTokenBalances.length}`);
      console.log(`    [DEBUG] Looking for token: ${poolInfo.tokenMint.substring(0, 8)}...`);
      
      // Count how many match our token
      const matchingTokenAccounts = preTokenBalances.filter((b: any) => 
        b.mint?.toLowerCase() === poolInfo.tokenMint.toLowerCase()
      );
      console.log(`    [DEBUG] Found ${matchingTokenAccounts.length} accounts with monitored token`);
      
      // CRITICAL FIX: Don't use balance threshold alone - it fails for whales!
      // A user with 28K tokens gets wrongly classified as "pool vault"
      // Instead, identify pool vaults by checking if they're the LARGEST account
      // Pool vaults are typically 100x-1000x larger than user wallets
      const POOL_VAULT_MULTIPLIER = 50; // Pool vault should be 50x larger than next largest
      
      // Build a list of ALL token accounts (both pre and post)
      // This handles BOTH existing accounts (SELL) and newly created accounts (BUY)
      const allAccounts = new Map<number, {pre: any, post: any}>();
      
      // First, add all accounts from preTokenBalances
      for (const pre of preTokenBalances) {
        if (pre.mint?.toLowerCase() === poolInfo.tokenMint.toLowerCase()) {
          allAccounts.set(pre.accountIndex, { pre, post: null });
        }
      }
      
      // Then, add or merge accounts from postTokenBalances
      for (const post of postTokenBalances) {
        if (post.mint?.toLowerCase() === poolInfo.tokenMint.toLowerCase()) {
          const existing = allAccounts.get(post.accountIndex);
          if (existing) {
            existing.post = post; // Merge with existing
          } else {
            // NEW ACCOUNT! This is likely a BUY (user receives tokens to new account)
            allAccounts.set(post.accountIndex, { pre: null, post });
          }
        }
      }
      
      console.log(`    [DEBUG] Total token accounts to process: ${allAccounts.size}`);
      
      // STEP 1: Collect all accounts with their balances (for intelligent filtering)
      const accountsWithBalances: Array<{
        index: number;
        pre: any;
        post: any;
        owner: string;
        preAmount: number;
        postAmount: number;
        change: number;
        maxBalance: number;
      }> = [];
      
      for (const [accountIndex, {pre, post}] of allAccounts.entries()) {
        const owner = pre?.owner || post?.owner || '';
        const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
        const postAmount = post ? parseFloat(post.uiTokenAmount.uiAmountString || '0') : 0;
        const change = Math.abs(postAmount - preAmount);
        const maxBalance = Math.max(preAmount, postAmount);
        
        accountsWithBalances.push({
          index: accountIndex,
          pre,
          post,
          owner,
          preAmount,
          postAmount,
          change,
          maxBalance
        });
      }
      
      // STEP 2: Sort by max balance to identify pool vaults (they're MUCH larger)
      accountsWithBalances.sort((a, b) => b.maxBalance - a.maxBalance);
      
      // STEP 3: Identify pool vault (largest account, typically 50x+ bigger than #2)
      let poolVaultIndex = -1;
      if (accountsWithBalances.length >= 2) {
        const largest = accountsWithBalances[0];
        const secondLargest = accountsWithBalances[1];
        
        // If largest is 50x bigger than second, it's the pool vault
        if (largest.maxBalance > secondLargest.maxBalance * POOL_VAULT_MULTIPLIER) {
          poolVaultIndex = largest.index;
          console.log(`    [DEBUG] 🏦 POOL VAULT DETECTED: Account ${poolVaultIndex} (${largest.maxBalance.toFixed(0)} tokens, ${(largest.maxBalance / secondLargest.maxBalance).toFixed(0)}x larger than #2)`);
        }
      }
      
      // STEP 4: Process accounts, skipping pool vault
      for (const acc of accountsWithBalances) {
        console.log(`    [DEBUG] Account ${acc.index}: ${(acc.pre?.mint || acc.post?.mint).substring(0, 8)}... | ${acc.preAmount.toFixed(2)} → ${acc.postAmount.toFixed(2)} (${acc.change > 0 ? (acc.postAmount > acc.preAmount ? '⬆️ UP' : '⬇️ DOWN') : '='} ${acc.change.toFixed(2)})`);
        console.log(`    [DEBUG] Owner: ${acc.owner.substring(0, 16)}...`);
        
        // Skip pool's own vault (owner is pool address)
        if (acc.owner.toLowerCase() === poolInfo.poolAddress.toLowerCase()) {
          console.log(`    [DEBUG] ❌ SKIP pool's own vault (owner IS pool address)`);
          continue;
        }
        
        // Skip identified pool vault
        if (acc.index === poolVaultIndex) {
          console.log(`    [DEBUG] ❌ SKIP pool vault (detected as largest account)`);
          continue;
        }
        
        // Skip dust changes
        if (acc.change < 0.01) {
          console.log(`    [DEBUG] ❌ SKIP dust change (${acc.change.toFixed(4)} < 0.01)`);
          continue;
        }
        
        console.log(`    [DEBUG] ✅ VALID user account (balance: ${acc.maxBalance.toFixed(2)}, change: ${acc.change.toFixed(2)})`);
        
        // Find LARGEST change among USER wallets
        if (acc.change > tokenAmount) {
          tokenAmount = acc.change;
          tokenIncreased = acc.postAmount > acc.preAmount;
          userAccount = acc.owner;
          actualTokenMint = acc.pre?.mint || acc.post?.mint;
          
          console.log(`    [DEBUG] 🎯 LARGEST USER CHANGE: ${acc.change.toFixed(2)} tokens`);
          console.log(`    [DEBUG] 🎯 Balance: ${acc.preAmount.toFixed(2)} → ${acc.postAmount.toFixed(2)}`);
          console.log(`    [DEBUG] 🎯 Direction: ${acc.postAmount > acc.preAmount ? '⬆️ INCREASED' : '⬇️ DECREASED'}`);
          console.log(`    [DEBUG] 🎯 tokenIncreased=${tokenIncreased} → ${tokenIncreased ? '🟢 BUY' : '🔴 SELL'}`);
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

      // FALLBACK: If no user wallet found, use INVERTED pool vault signal
      // This happens in aggregator swaps where user's token account doesn't appear
      if (!actualTokenMint) {
        console.log(`⚠️ [RaydiumWS] No user wallet found - using INVERTED pool vault signal`);
        
        // Find the SMALLEST pool vault (most accurate for price)
        let smallestVault: any = null;
        let smallestBalance = Infinity;
        
        for (const pre of preTokenBalances) {
          if (pre.mint?.toLowerCase() !== poolInfo.tokenMint.toLowerCase()) continue;
          
          const post = postTokenBalances.find((p: any) => 
            p.accountIndex === pre.accountIndex && p.mint === pre.mint
          );
          
          if (post) {
            const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
            const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
            const change = Math.abs(postAmount - preAmount);
            
            // Only consider accounts that actually changed
            // Don't use threshold - just find any account with significant balance
            if (change > 0.01 && preAmount < smallestBalance && preAmount > 1000) {
              smallestBalance = preAmount;
              smallestVault = {
                pre,
                post,
                preAmount,
                postAmount,
                change,
                owner: pre.owner || ''
              };
            }
          }
        }
        
        if (smallestVault) {
          // CRITICAL UNDERSTANDING: We're looking at POOL's token vault
          // Pool token vault change tells us what happened from POOL's perspective
          // 
          // USER BUYS:  User gives SOL → Pool gains SOL | User takes tokens → Pool LOSES tokens
          // USER SELLS: User gives tokens → Pool GAINS tokens | User takes SOL → Pool loses SOL
          //
          // So pool vault token change is OPPOSITE of user's action:
          // Pool GAINED tokens = User SOLD (gave tokens away)
          // Pool LOST tokens = User BOUGHT (took tokens)
          tokenAmount = smallestVault.change;
          
          // Pool gained tokens means user gave tokens away (SOLD)
          // Pool lost tokens means user took tokens (BOUGHT)
          const poolGainedTokens = smallestVault.postAmount > smallestVault.preAmount;
          tokenIncreased = !poolGainedTokens; // INVERT: Pool gained = user lost (SOLD)
          
          userAccount = smallestVault.owner;
          actualTokenMint = smallestVault.pre.mint;
          usedPoolVaultFallback = true; // Mark that we used pool vault (userAccount is POOL's account!)
          
          console.log(`    [DEBUG] 🔄 Using INVERTED pool vault signal:`);
          console.log(`    [DEBUG] Pool vault: ${smallestVault.preAmount.toFixed(0)} → ${smallestVault.postAmount.toFixed(0)}`);
          console.log(`    [DEBUG] Pool ${poolGainedTokens ? 'GAINED' : 'LOST'} ${smallestVault.change.toFixed(2)} tokens`);
          console.log(`    [DEBUG] ⚠️ User ${tokenIncreased ? 'BOUGHT (took from pool)' : 'SOLD (gave to pool)'} ${smallestVault.change.toFixed(2)} tokens`);
        } else {
          console.log(`⚠️ [RaydiumWS] parseTransfers - No valid pool vault found either`);
          
          // Emit heartbeat to show listener is alive
          this.emit('heartbeat', { 
            processed: true, 
            matched: false, 
            reason: 'no_token_found'
          });
          
          return null;
        }
      }

      // Get SOL balance changes (lamports to SOL)
      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      
      let maxSolChange = 0;
      let solSignerIndex = -1;
      let userWalletIndex = -1;

      // CRITICAL: Find the user's wallet address (from token account owner)
      // BUT: If we used pool vault fallback, userAccount is the POOL's account, not the real user!
      // In that case, we should NOT try to match it as "user wallet"
      
      if (userAccount && accountKeys.length > 0 && !usedPoolVaultFallback) {
        userWalletIndex = accountKeys.findIndex((key: any) => {
          const keyStr = typeof key === 'string' ? key : key.pubkey?.toString() || '';
          return keyStr.toLowerCase() === userAccount.toLowerCase();
        });
        
        if (userWalletIndex >= 0) {
          console.log(`    [DEBUG] ✅ Found user wallet at index ${userWalletIndex}: ${userAccount.substring(0, 16)}...`);
        } else {
          console.log(`    [DEBUG] ⚠️ User wallet not found in accountKeys, will detect largest SOL change`);
        }
      } else if (usedPoolVaultFallback) {
        console.log(`    [DEBUG] ⚠️ Used pool vault fallback - userAccount is POOL's account (${userAccount.substring(0, 16)}...), not real user`);
        console.log(`    [DEBUG] ⚠️ Will NOT match as 'user wallet' - will find actual user's SOL change instead`);
        userWalletIndex = -1; // Force it to NOT match
      }

      // Find ALL accounts with significant SOL changes and check their direction
      const solChanges: Array<{
        index: number, 
        change: number, 
        decreased: boolean,
        isUserWallet: boolean,
        preBalance: number,
        postBalance: number
      }> = [];
      
      for (let i = 0; i < preBalances.length; i++) {
        if (!preBalances[i] || !postBalances[i]) continue;
        
        const changeInLamports = Math.abs(postBalances[i] - preBalances[i]);
        
        // Skip only very tiny changes (fees/rent) - lowered to catch more trades
        if (changeInLamports < 1000000) continue; // < 0.001 SOL
        
        solChanges.push({
          index: i,
          change: changeInLamports / 1e9,
          decreased: postBalances[i] < preBalances[i],
          isUserWallet: i === userWalletIndex,
          preBalance: preBalances[i] / 1e9,
          postBalance: postBalances[i] / 1e9
        });
      }
      
      // Sort by change amount (largest first)
      solChanges.sort((a, b) => b.change - a.change);
      
      console.log(`    [DEBUG] Found ${solChanges.length} accounts with significant SOL changes`);
      for (let i = 0; i < Math.min(3, solChanges.length); i++) {
        const sc = solChanges[i];
        console.log(`    [DEBUG] Account ${sc.index}: ${sc.preBalance.toFixed(4)} → ${sc.postBalance.toFixed(4)} SOL (${sc.decreased ? 'DECREASED ⬇️' : 'INCREASED ⬆️'} ${sc.change.toFixed(4)}) ${sc.isUserWallet ? '← USER WALLET ✅' : ''}`);
      }
      
      // PRIORITY: Use matched user wallet if available
      const userWalletChange = solChanges.find(c => c.isUserWallet);
      if (userWalletChange) {
        maxSolChange = userWalletChange.change;
        solSignerIndex = userWalletChange.index;
        console.log(`    [DEBUG] 🎯 USING MATCHED USER WALLET (index ${solSignerIndex}): ${maxSolChange.toFixed(6)} SOL`);
      } 
      // FALLBACK: Smart selection based on token direction
      // If tokens INCREASED (user bought) → find SOL that DECREASED (user spent SOL)
      // If tokens DECREASED (user sold) → find SOL that INCREASED (user received SOL)
      else if (solChanges.length > 0) {
        const targetDirection = tokenIncreased ? 'decreased' : 'increased';
        
        // Find account matching the expected pattern
        const matchingAccount = solChanges.find(sc => 
          tokenIncreased ? sc.decreased : !sc.decreased
        );
        
        if (matchingAccount) {
          maxSolChange = matchingAccount.change;
          solSignerIndex = matchingAccount.index;
          console.log(`    [DEBUG] 🎯 SMART MATCH: Tokens ${tokenIncreased ? 'UP' : 'DOWN'} → Using SOL that ${matchingAccount.decreased ? 'DECREASED' : 'INCREASED'} (index ${solSignerIndex}): ${maxSolChange.toFixed(6)} SOL`);
        } else {
          // Fallback to largest if no pattern match
          maxSolChange = solChanges[0].change;
          solSignerIndex = solChanges[0].index;
          console.log(`    [DEBUG] ⚠️ NO PATTERN MATCH, using largest SOL change (index ${solSignerIndex}): ${maxSolChange.toFixed(6)} SOL`);
        }
      }

      const solAmount = maxSolChange;

      //   FINAL DETERMINATION: Cross-validate BOTH token AND SOL signals
      //   USER perspective (what we want):
      //   BUY:  tokens UP ⬆️ + SOL DOWN ⬇️ (user spent SOL, got tokens)
      //   SELL: tokens DOWN ⬇️ + SOL UP ⬆️ (user spent tokens, got SOL)
      //   POOL perspective (inverted - what we DON'T want):
      //   User BUY:  pool tokens DOWN ⬇️ + pool SOL UP ⬆️ (pool gave tokens, got SOL)
      //   User SELL: pool tokens UP ⬆️ + pool SOL DOWN ⬇️ (pool got tokens, gave SOL)
      
      let isBuy: boolean;
      
      if (solSignerIndex >= 0 && preBalances[solSignerIndex] && postBalances[solSignerIndex]) {
        const solDecreased = postBalances[solSignerIndex] < preBalances[solSignerIndex];
        
        console.log(`\n💰 [RaydiumWS] BUY/SELL Detection:`);
        console.log(`   Token Balance Change: ${tokenIncreased ? '⬆️ INCREASED' : '⬇️ DECREASED'} by ${tokenAmount.toFixed(2)} tokens`);
        console.log(`   SOL Balance Before: ${(preBalances[solSignerIndex] / 1e9).toFixed(6)} SOL`);
        console.log(`   SOL Balance After:  ${(postBalances[solSignerIndex] / 1e9).toFixed(6)} SOL`);
        console.log(`   SOL Change: ${solAmount.toFixed(6)} SOL (${solDecreased ? 'decreased ⬇️' : 'increased ⬆️'})`);
        console.log(`   Using account index: ${solSignerIndex} ${solSignerIndex === userWalletIndex ? '(MATCHED USER WALLET ✅)' : '(LARGEST CHANGE)'}`);
        
        // CROSS-VALIDATE: Token and SOL should move in opposite directions for USER
        // USER BUY: Tokens UP ⬆️ + SOL DOWN ⬇️ (user spent SOL, got tokens)
        // USER SELL: Tokens DOWN ⬇️ + SOL UP ⬆️ (user spent tokens, got SOL)
        const signalsAgree = (tokenIncreased && solDecreased) || (!tokenIncreased && !solDecreased);
        
        if (signalsAgree) {
          // Signals agree - use SOL as primary (most reliable)
          isBuy = solDecreased;
          console.log(`   ✅ Signals AGREE: Tokens ${tokenIncreased ? 'UP' : 'DOWN'} + SOL ${solDecreased ? 'DOWN' : 'UP'}`);
        } else {
          // Signals DISAGREE - we likely have pool account, use token direction
          isBuy = tokenIncreased;
          console.log(`   ⚠️ Signals DISAGREE: Tokens ${tokenIncreased ? 'UP' : 'DOWN'} + SOL ${solDecreased ? 'DOWN' : 'UP'}`);
          console.log(`   🔄 Using TOKEN direction (likely pool SOL account detected)`);
        }
        
        console.log(`   Final determination: ${isBuy ? '🟢 BUY' : '🔴 SELL'}`);
        console.log(`   ✅ Final Determination: ${isBuy ? 'BUY' : 'SELL'}\n`);
      } else {
        // Fallback to token balance change if SOL info not available
        isBuy = tokenIncreased;
        console.log(`\n⚠️ [RaydiumWS] No SOL info, using token change: ${isBuy ? 'BUY' : 'SELL'}\n`);
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
        // VALIDATION: Check if SOL amount seems reasonable
        const impliedPrice = solAmount / tokenAmount;
        const usdValue = solAmount * 140; // Approximate SOL price
        
        console.log(`🔍 [RaydiumWS] ===== FINAL TRADE DETERMINATION =====`);
        console.log(`   tokenIncreased: ${tokenIncreased} (user's token balance ${tokenIncreased ? 'INCREASED' : 'DECREASED'})`);
        console.log(`   isBuy: ${isBuy} (this means user ${isBuy ? 'BOUGHT tokens' : 'SOLD tokens'})`);
        console.log(`   tokenAmount: ${tokenAmount.toFixed(2)}`);
        console.log(`   solAmount: ${solAmount.toFixed(6)}`);
        console.log(`   Implied price: ${impliedPrice.toFixed(9)} SOL/token`);
        console.log(`   USD value: ~$${usdValue.toFixed(2)}`);
        
        // Warn if SOL amount seems too small (< $1 for > 1000 tokens)
        if (tokenAmount > 1000 && usdValue < 1) {
          console.warn(`   ⚠️ WARNING: SOL amount seems too small for ${tokenAmount.toFixed(0)} tokens!`);
          console.warn(`   ⚠️ This might be a fee or rent payment, not the actual trade`);
          console.warn(`   ⚠️ Consider checking all SOL changes to find the real trade amount`);
        }
        
        console.log(`   Returning isBuy=${isBuy} to RealTradeFeedService`);
        console.log(`===========================================\n`);
        
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