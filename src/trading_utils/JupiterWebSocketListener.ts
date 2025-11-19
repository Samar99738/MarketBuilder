import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { EventEmitter } from 'events';

const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS2jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/**
 * Jupiter trade event data structure
 */
export interface JupiterTradeEvent {
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
 * Real-time WebSocket listener for Jupiter aggregator swaps
 * Captures trades that go through Jupiter (most DexScreener trades)
 */
export class JupiterWebSocketListener extends EventEmitter {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private isMonitoring = false;
  private monitoredTokens: Set<string> = new Set();
  private rpcUrl: string;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastActivityTimestamp: number = Date.now();
  private readonly HEALTH_CHECK_INTERVAL_MS = 30000;
  private readonly MAX_INACTIVITY_MS = 120000;
  private processedSignatures: Set<string> = new Set();
  private readonly MAX_PROCESSED_SIGNATURES = 1000;

  constructor(rpcUrl: string) {
    super();
    this.rpcUrl = rpcUrl;
    
    const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    this.connection = new Connection(rpcUrl, {
      wsEndpoint: wsUrl,
      commitment: 'processed'
    });
  }

  async start(tokenAddress: string): Promise<void> {
    console.log(`⚡ [JupiterWS] Starting monitoring for token: ${tokenAddress.substring(0, 8)}...`);
    
    // Add to monitored tokens
    this.monitoredTokens.add(tokenAddress.toLowerCase());
    
    console.log(`📊 [JupiterWS] Now monitoring ${this.monitoredTokens.size} token(s)`);

    // Subscribe to program logs if not already subscribed
    if (!this.isMonitoring) {
      await this.subscribe();
    }
  }

  async stopToken(tokenAddress: string): Promise<void> {
    this.monitoredTokens.delete(tokenAddress.toLowerCase());
    console.log(`🛑 [JupiterWS] Stopped monitoring token: ${tokenAddress.substring(0, 8)}...`);
    console.log(`📊 [JupiterWS] Remaining tokens: ${this.monitoredTokens.size}`);

    if (this.monitoredTokens.size === 0) {
      await this.stop();
    }
  }

  private async subscribe(): Promise<void> {
    try {
      const programId = new PublicKey(JUPITER_V6_PROGRAM_ID);

      console.log(`🔌 [JupiterWS] Connecting to Solana WebSocket...`);
      console.log(`🎯 [JupiterWS] Monitoring program: ${JUPITER_V6_PROGRAM_ID} (Jupiter V6)`);

      this.subscriptionId = this.connection.onLogs(
        programId,
        (logs: Logs, context: Context) => {
          this.handleLogs(logs, context);
        },
        'processed'
      );

      this.isMonitoring = true;
      this.lastActivityTimestamp = Date.now();
      console.log(`✅ [JupiterWS] Connected! Subscription ID: ${this.subscriptionId}`);
      console.log(`🎧 [JupiterWS] Listening for Jupiter swaps on ${this.monitoredTokens.size} token(s)`);

      this.startHealthMonitoring();
      this.emit('connected');

    } catch (error) {
      console.error(`❌ [JupiterWS] Subscription failed:`, error);
      this.emit('error', error);
    }
  }

  private handleLogs(logs: Logs, context: Context): void {
    try {
      this.lastActivityTimestamp = Date.now();
      
      const signature = logs.signature;
      if (!signature) return;

      // Check if this is a Jupiter swap
      const logString = logs.logs.join('\n');
      const isJupiterSwap = 
        logString.includes('Program JUP6LkbZbjS2jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke') ||
        logString.includes('Program log: Instruction: Route') ||
        logString.includes('Program log: Instruction: SharedAccountsRoute') ||
        /swap|trade|route/i.test(logString);
      
      if (!isJupiterSwap) {
        // Emit heartbeat even for non-Jupiter transactions to keep health check alive
        this.emit('heartbeat', {
          processed: true,
          matched: false,
          reason: 'not_jupiter_program'
        });
        return;
      }

      console.log(`⚡ [JupiterWS] Jupiter swap detected (sig: ${signature.substring(0, 12)}...), fetching transaction...`);
      
      this.processJupiterTransaction(signature, logs, context);
      
    } catch (error) {
      if (error instanceof Error) {
        if (!error.message.includes('Could not find') && !error.message.includes('not found')) {
          console.error('[JupiterWS] Error handling logs:', error.message);
        }
      }
    }
  }

  private async processJupiterTransaction(
    signature: string,
    logs: Logs,
    context: Context
  ): Promise<void> {
    try {
      // Prevent duplicate processing
      if (this.processedSignatures.has(signature)) {
        return;
      }
      
      this.processedSignatures.add(signature);
      
      // Better cleanup - keep only last 500 signatures
      if (this.processedSignatures.size > this.MAX_PROCESSED_SIGNATURES) {
        const sigArray = Array.from(this.processedSignatures);
        const toKeep = sigArray.slice(-500); // Keep newest 500
        this.processedSignatures = new Set(toKeep);
        
        console.log(`[JupiterWS] Trimmed processed signatures: ${sigArray.length} → ${toKeep.length}`);
      }

      // Fetch full transaction
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx || tx.meta?.err) {
        console.log(`⚠️ [JupiterWS] Transaction not available or failed: ${signature.substring(0, 12)}...`);
        return;
      }

      // Check if any of our monitored tokens are involved
      console.log(`🔍 [JupiterWS] Checking Jupiter transaction ${signature.substring(0, 12)}...`);
      console.log(`📋 [JupiterWS] Monitoring ${this.monitoredTokens.size} token(s): ${Array.from(this.monitoredTokens).map(t => t.substring(0, 8)).join(', ')}`);
      
      let foundMatch = false;
      
      for (const targetToken of this.monitoredTokens) {
        // Check token mint in balance changes
        if (tx.meta) {
          const allTokenMints = [
            ...(tx.meta.preTokenBalances || []).map((b: any) => b.mint?.toLowerCase()),
            ...(tx.meta.postTokenBalances || []).map((b: any) => b.mint?.toLowerCase())
          ];
          
          const tokenMatch = allTokenMints.some((mint: string) => 
            mint === targetToken
          );
          
          if (tokenMatch) {
            console.log(`\n✅ [JupiterWS] MATCH! Found ${targetToken.substring(0, 8)}... in Jupiter transaction`);
            foundMatch = true;
            
            await this.processSwapForToken(tx, signature, targetToken);
            break;
          } else if (allTokenMints.length > 0) {
            console.log(`🔍 [JupiterWS] Checked ${signature.substring(0, 12)}... - ${allTokenMints.length} token(s) found`);
            console.log(`   Target: ${targetToken.substring(0, 8)}...`);
            console.log(`   Found: ${allTokenMints.slice(0, 3).join(', ')}${allTokenMints.length > 3 ? '...' : ''}`);
            
            // Emit heartbeat
            this.emit('heartbeat', {
              processed: true,
              matched: false,
              reason: 'token_not_in_transaction',
              expected: targetToken,
              found: allTokenMints
            });
          }
        }
      }
    } catch (error) {
      console.error(`❌ [JupiterWS] Error processing transaction ${signature.substring(0, 12)}:`, error instanceof Error ? error.message : error);
    }
  }

  private async processSwapForToken(
    tx: any,
    signature: string,
    targetToken: string
  ): Promise<void> {
    try {
      console.log(`🔧 [JupiterWS] Parsing Jupiter swap for ${targetToken.substring(0, 8)}...`);
      
      const transfers = this.parseTransfersFromTransaction(tx, targetToken);
      
      if (!transfers) {
        console.log(`⚠️ [JupiterWS] Failed to parse transfers from transaction`);
        return;
      }
      
      console.log(`✅ [JupiterWS] Parsed transfers successfully:`, {
        solAmount: transfers.solAmount,
        tokenAmount: transfers.tokenAmount,
        isBuy: transfers.isBuy,
        user: transfers.user.substring(0, 8) + '...'
      });

      const trade: JupiterTradeEvent = {
        tokenMint: targetToken,
        solAmount: transfers.solAmount,
        tokenAmount: transfers.tokenAmount,
        isBuy: transfers.isBuy,
        user: transfers.user,
        signature: signature,
        timestamp: Date.now() / 1000,
        price: 0
      };

      trade.price = trade.tokenAmount > 0 ? trade.solAmount / trade.tokenAmount : 0;

      console.log(`\n⚡ [JupiterWS] JUPITER SWAP DETECTED:`);
      console.log(`   Token: ${trade.tokenMint.substring(0, 8)}...${trade.tokenMint.substring(trade.tokenMint.length - 4)}`);
      console.log(`   Type: ${trade.isBuy ? '🟢 BUY' : '🔴 SELL'}`);
      console.log(`   SOL: ${trade.solAmount.toFixed(4)}`);
      console.log(`   Tokens: ${trade.tokenAmount.toFixed(2)}`);
      console.log(`   Price: ${trade.price.toFixed(9)} SOL/token`);
      console.log(`   User: ${trade.user.substring(0, 8)}...`);
      console.log(`   Signature: ${signature.substring(0, 12)}...\n`);

      // Emit trade event
      this.emit('trade', trade);

    } catch (error) {
      console.error('[JupiterWS] Error processing swap:', error);
    }
  }

  private parseTransfersFromTransaction(tx: any, targetToken: string): {
    solAmount: number;
    tokenAmount: number;
    isBuy: boolean;
    user: string;
  } | null {
    try {
      const meta = tx.meta;
      if (!meta || meta.err) return null;

      const preTokenBalances = meta.preTokenBalances || [];
      const postTokenBalances = meta.postTokenBalances || [];

      let tokenAmount = 0;
      let userAccount = '';
      let tokenIncreased = false;

      // FIX: Check BOTH pre and post balances to catch new accounts
      const POOL_VAULT_THRESHOLD = 100000;
      
      console.log(`[JupiterWS] Parsing ${targetToken.substring(0, 8)}... transaction`);
      console.log(`[JupiterWS] Pre-token accounts: ${preTokenBalances.length}, Post-token accounts: ${postTokenBalances.length}`);
      
      // Build map of ALL token accounts (handles NEW accounts)
      const allAccounts = new Map<number, {pre: any, post: any}>();
      
      // Add accounts from preTokenBalances
      for (const pre of preTokenBalances) {
        if (pre.mint?.toLowerCase() === targetToken) {
          allAccounts.set(pre.accountIndex, { pre, post: null });
        }
      }
      
      // CRITICAL: Add accounts from postTokenBalances (catches NEW accounts in BUYs)
      for (const post of postTokenBalances) {
        if (post.mint?.toLowerCase() === targetToken) {
          const existing = allAccounts.get(post.accountIndex);
          if (existing) {
            existing.post = post;
          } else {
            // NEW ACCOUNT! This is likely a BUY
            allAccounts.set(post.accountIndex, { pre: null, post });
            console.log(`[JupiterWS] ✅ Found NEW token account (likely BUY): index ${post.accountIndex}`);
          }
        }
      }
      
      console.log(`[JupiterWS] Total accounts to analyze: ${allAccounts.size}`);
      
      // Process ALL accounts to find largest USER wallet change
      for (const [accountIndex, {pre, post}] of allAccounts.entries()) {
        const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
        const postAmount = post ? parseFloat(post.uiTokenAmount.uiAmountString || '0') : 0;
        const change = Math.abs(postAmount - preAmount);
        
        console.log(`[JupiterWS]   Account ${accountIndex}: ${preAmount.toFixed(2)} → ${postAmount.toFixed(2)} (${change > 0 ? (postAmount > preAmount ? '↑ UP' : '↓ DOWN') : '='} ${change.toFixed(2)})`);
        
        // Skip pool vault accounts (> 100K tokens)
        if (preAmount > POOL_VAULT_THRESHOLD || postAmount > POOL_VAULT_THRESHOLD) {
          console.log(`[JupiterWS]   ❌ SKIP pool vault (balance: ${Math.max(preAmount, postAmount).toFixed(0)} > ${POOL_VAULT_THRESHOLD})`);
          continue;
        }
        
        // Skip dust changes
        if (change < 0.01) {
          console.log(`[JupiterWS]   ❌ SKIP dust change (${change.toFixed(4)} < 0.01)`);
          continue;
        }
        
        console.log(`[JupiterWS]   ✅ Valid user account`);
        
        // Find account with LARGEST change (user's primary account)
        if (change > tokenAmount) {
          tokenAmount = change;
          tokenIncreased = postAmount > preAmount; // TRUE = balance increased = BUY
          userAccount = pre?.owner || post?.owner || '';
          
          console.log(`[JupiterWS]   🎯 LARGEST USER CHANGE: ${change.toFixed(2)} tokens`);
          console.log(`[JupiterWS]   🎯 Direction: ${postAmount > preAmount ? '↑ INCREASED' : '↓ DECREASED'}`);
          console.log(`[JupiterWS]   🎯 tokenIncreased=${tokenIncreased} → ${tokenIncreased ? '🟢 BUY' : '🔴 SELL'}`);
        }
      }

      // FALLBACK: If no user wallet found, use INVERTED pool vault signal
      if (tokenAmount === 0) {
        console.log(`[JupiterWS] ⚠️ No user wallet found - trying INVERTED pool vault signal`);
        
        for (const [accountIndex, {pre, post}] of allAccounts.entries()) {
          if (!pre || !post) continue;
          
          const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
          const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
          const change = Math.abs(postAmount - preAmount);
          
          // Find pool vaults (> threshold)
          if (preAmount > POOL_VAULT_THRESHOLD || postAmount > POOL_VAULT_THRESHOLD) {
            if (change > tokenAmount) {
              tokenAmount = change;
              // INVERT: Pool gained tokens = user sold, Pool lost tokens = user bought
              const poolGained = postAmount > preAmount;
              tokenIncreased = !poolGained; // Invert pool signal
              userAccount = pre.owner || post.owner || '';
              
              console.log(`[JupiterWS]   🔄 Using INVERTED pool vault signal`);
              console.log(`[JupiterWS]   🔄 Pool ${poolGained ? 'GAINED' : 'LOST'} ${change.toFixed(2)} tokens`);
              console.log(`[JupiterWS]   🔄 User ${tokenIncreased ? 'BOUGHT' : 'SOLD'} (inverted signal)`);
            }
          }
        }
      }

      if (tokenAmount === 0) {
        console.log(`[JupiterWS] ❌ No token changes found`);
        return null;
      }

      // Get SOL balance changes for CROSS-VALIDATION
      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      
      let maxSolChange = 0;
      let solSignerIndex = -1;
      let solDecreased = false;

      console.log(`[JupiterWS] Analyzing SOL balance changes (${preBalances.length} accounts)...`);
      
      for (let i = 0; i < preBalances.length; i++) {
        const changeInLamports = Math.abs(postBalances[i] - preBalances[i]);
        const changeInSOL = changeInLamports / 1e9;
        
        if (changeInLamports < 1000000) continue; // Skip < 0.001 SOL
        
        console.log(`[JupiterWS]   SOL Account ${i}: ${(preBalances[i] / 1e9).toFixed(6)} → ${(postBalances[i] / 1e9).toFixed(6)} (${changeInSOL.toFixed(6)} SOL change)`);
        
        // FIX: Compare lamports to lamports (not lamports to SOL * 1e9)
        if (changeInLamports > (maxSolChange * 1e9)) {
          maxSolChange = changeInSOL;
          solSignerIndex = i;
          solDecreased = postBalances[i] < preBalances[i];
          console.log(`[JupiterWS]   🎯 NEW LARGEST SOL change: ${changeInSOL.toFixed(6)} SOL (${solDecreased ? '↓ DECREASED' : '↑ INCREASED'})`);
        }
      }
      
      console.log(`[JupiterWS] Selected SOL account index: ${solSignerIndex}, amount: ${maxSolChange.toFixed(6)} SOL`)

      const solAmount = maxSolChange;
      
      // CROSS-VALIDATE: Token and SOL should move in OPPOSITE directions
      // USER BUY: Tokens UP ↑ + SOL DOWN ↓ (user spent SOL, got tokens)
      // USER SELL: Tokens DOWN ↓ + SOL UP ↑ (user spent tokens, got SOL)
      if (solAmount > 0.001) {
        const signalsAgree = (tokenIncreased && solDecreased) || (!tokenIncreased && !solDecreased);
        console.log(`[JupiterWS] Cross-validation: Tokens ${tokenIncreased ? 'UP' : 'DOWN'} + SOL ${solDecreased ? 'DOWN' : 'UP'} → ${signalsAgree ? '✅ AGREE' : '⚠️ DISAGREE'}`);
        
        // If signals disagree, prefer SOL direction (more reliable)
        if (!signalsAgree) {
          console.log(`[JupiterWS] ⚠️ Using SOL direction as primary signal`);
          tokenIncreased = solDecreased; // SOL decreased = bought tokens
        }
      }
      
      const isBuy = tokenIncreased;
      console.log(`[JupiterWS] ✅ Final determination: ${isBuy ? '🟢 BUY' : '🔴 SELL'}`);
      console.log(`[JupiterWS]   SOL: ${solAmount.toFixed(4)}, Tokens: ${tokenAmount.toFixed(2)}\n`);
      
      if (!userAccount && tx.transaction?.message?.accountKeys) {
        const accounts = tx.transaction.message.accountKeys;
        if (solSignerIndex >= 0 && solSignerIndex < accounts.length) {
          userAccount = accounts[solSignerIndex]?.pubkey?.toString() || '';
        } else if (accounts.length > 0) {
          userAccount = accounts[0]?.pubkey?.toString() || '';
        }
      }

      if (solAmount > 0.0001 && tokenAmount > 0) {
        return {
          solAmount,
          tokenAmount,
          isBuy,
          user: userAccount || 'unknown'
        };
      }

      return null;
    } catch (error) {
      console.error('[JupiterWS] Error parsing transfers:', error);
      return null;
    }
  }

  private startHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, this.HEALTH_CHECK_INTERVAL_MS);

    console.log(`💓 [JupiterWS] Health monitoring started`);
  }

  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      console.log(`💓 [JupiterWS] Health monitoring stopped`);
    }
  }

  private checkConnectionHealth(): void {
    const timeSinceLastActivity = Date.now() - this.lastActivityTimestamp;
    const minutesSinceActivity = Math.floor(timeSinceLastActivity / 60000);

    if (timeSinceLastActivity > this.MAX_INACTIVITY_MS && this.isMonitoring) {
      console.error(`❌ [JupiterWS] CONNECTION DEAD - No activity for ${minutesSinceActivity} minutes`);
      console.error(`❌ [JupiterWS] WebSocket silently died - forcing reconnection...`);
      
      this.emit('connection_stale', {
        minutesSinceActivity,
        monitoredTokens: Array.from(this.monitoredTokens)
      });

      this.forceReconnect();
    } else {
      const secondsSinceActivity = Math.floor(timeSinceLastActivity / 1000);
      console.log(`💓 [JupiterWS] Health check - Connection alive (last activity: ${secondsSinceActivity}s ago)`);
    }
  }

  private async forceReconnect(): Promise<void> {
    console.log(`🔄 [JupiterWS] FORCE RECONNECTING...`);
    
    const tokensToRestore = new Set(this.monitoredTokens);
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    this.monitoredTokens = tokensToRestore;
    
    if (this.monitoredTokens.size > 0) {
      console.log(`🔄 [JupiterWS] Restoring ${this.monitoredTokens.size} monitored token(s)`);
      await this.subscribe();
    }
  }

  async stop(): Promise<void> {
    console.log('[JupiterWS] Stopping...');

    this.stopHealthMonitoring();

    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
        console.log(`✅ [JupiterWS] Unsubscribed (ID: ${this.subscriptionId})`);
      } catch (error) {
        console.error('[JupiterWS] Error unsubscribing:', error);
      }
      this.subscriptionId = null;
    }

    this.isMonitoring = false;
    this.monitoredTokens.clear();
    console.log('[JupiterWS] Stopped');

    this.emit('disconnected');
  }

  isActive(): boolean {
    return this.isMonitoring && this.subscriptionId !== null;
  }

  getMonitoredTokens(): string[] {
    return Array.from(this.monitoredTokens);
  }

  isMonitoringToken(tokenAddress: string): boolean {
    return this.monitoredTokens.has(tokenAddress.toLowerCase());
  }
}
