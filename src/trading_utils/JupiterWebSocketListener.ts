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
      
      if (this.processedSignatures.size > this.MAX_PROCESSED_SIGNATURES) {
        const firstSignature = this.processedSignatures.values().next().value;
        if (firstSignature) {
          this.processedSignatures.delete(firstSignature);
        }
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

      // Find token balance change for our target token
      // CRITICAL FIX: Skip pool vault accounts, only track USER wallet accounts
      // Pool vaults show INVERTED signals (pool loses tokens when user buys)
      // Pool vaults typically have MILLIONS of tokens (100K+), user wallets typically <100K
      const POOL_VAULT_THRESHOLD = 100000; // Raised threshold - accounts with >100K tokens are pool vaults
      
      for (const pre of preTokenBalances) {
        if (pre.mint?.toLowerCase() !== targetToken) continue;

        const post = postTokenBalances.find((p: any) => 
          p.accountIndex === pre.accountIndex && p.mint?.toLowerCase() === targetToken
        );

        if (post) {
          const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
          const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
          const change = Math.abs(postAmount - preAmount);
          
          // CRITICAL: Skip pool vault accounts (they have huge balances)
          // Pool vaults show INVERTED signals, we only want USER wallets
          if (preAmount > POOL_VAULT_THRESHOLD || postAmount > POOL_VAULT_THRESHOLD) {
            continue; // Skip pool vault - balance too large for user wallet
          }
          
          const owner = pre.owner || post.owner || '';
          
          if (change > tokenAmount) {
            tokenAmount = change;
            tokenIncreased = postAmount > preAmount; // TRUE if USER wallet increased = BUY
            userAccount = owner;
          }
        }
      }

      if (tokenAmount === 0) return null;

      // Get SOL balance changes
      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      
      let maxSolChange = 0;
      let solSignerIndex = -1;

      for (let i = 0; i < preBalances.length; i++) {
        const changeInLamports = Math.abs(postBalances[i] - preBalances[i]);
        
        if (changeInLamports < 1000000) continue; // Skip small changes
        
        if (changeInLamports > maxSolChange * 1e9) {
          maxSolChange = changeInLamports / 1e9;
          solSignerIndex = i;
        }
      }

      const solAmount = maxSolChange;
      const isBuy = tokenIncreased;
      
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
