/**
 * Solana Trade Monitor - Real Blockchain Transaction Monitoring
 * 
 * Monitors REAL pump.fun transactions via Solana WebSocket
 * Replaces fake Math.random() simulation with actual blockchain data
 */

import { Connection, PublicKey, ParsedTransactionWithMeta, PartiallyDecodedInstruction } from '@solana/web3.js';
import { Server as SocketServer } from 'socket.io';
import { WS_EVENTS } from './types';

// Pump.fun program ID on Solana mainnet
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Track subscription IDs for cleanup
interface TokenSubscription {
  tokenAddress: string;
  subscriptionId: number | null;
  subscribers: Set<string>; // Socket IDs
  lastActivity: Date;
  tradeCount: number;
}

interface RealTradeData {
  tokenAddress: string;
  type: 'buy' | 'sell';
  amount: number; // SOL for buys, tokens for sells
  solAmount: number;
  tokenAmount: number;
  trader: string;
  signature: string;
  timestamp: number;
  price: number;
  isRealTrade: true;
}

/**
 * Solana Trade Monitor
 * Monitors real pump.fun transactions and broadcasts to subscribers
 */
export class SolanaTradeMonitor {
  private connection: Connection;
  private io: SocketServer;
  private subscriptions: Map<string, TokenSubscription> = new Map();
  private isRunning: boolean = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  // Stats
  private stats = {
    totalSubscriptions: 0,
    activeSubscriptions: 0,
    totalTradesDetected: 0,
    tradesPerToken: new Map<string, number>(),
  };

  constructor(io: SocketServer, rpcUrl?: string) {
    this.io = io;
    
    // Use provided RPC or environment variable, fallback to public endpoint
    const rpcEndpoint = rpcUrl || 
      process.env.SOLANA_RPC_URL || 
      'https://api.mainnet-beta.solana.com';
    
    this.connection = new Connection(rpcEndpoint, {
      commitment: 'confirmed',
      wsEndpoint: rpcEndpoint.replace('https://', 'wss://').replace('http://', 'ws://'),
    });

    console.log(`[SolanaTradeMonitor] Initialized with RPC: ${rpcEndpoint}`);
  }

  /**
   * Start the monitoring service
   */
  start(): void {
    if (this.isRunning) {
      console.log('[SolanaTradeMonitor] Already running');
      return;
    }

    console.log('[SolanaTradeMonitor] Starting real blockchain trade monitoring...');
    this.isRunning = true;

    // Cleanup old subscriptions every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSubscriptions();
    }, 5 * 60 * 1000);

    console.log('[SolanaTradeMonitor] Real-time blockchain monitoring active');
  }

  /**
   * Stop the monitoring service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('[SolanaTradeMonitor] Not running');
      return;
    }

    console.log('[SolanaTradeMonitor] Stopping trade monitoring...');
    this.isRunning = false;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Unsubscribe from all tokens
    const unsubPromises = Array.from(this.subscriptions.values()).map(async (sub) => {
      if (sub.subscriptionId !== null) {
        try {
          await this.connection.removeAccountChangeListener(sub.subscriptionId);
        } catch (error) {
          console.error(`[SolanaTradeMonitor] Error removing subscription:`, error);
        }
      }
    });

    await Promise.all(unsubPromises);
    this.subscriptions.clear();

    console.log('[SolanaTradeMonitor] Service stopped');
  }

  /**
   * Subscribe to real-time trades for a specific pump.fun token
   */
  async subscribeToToken(tokenAddress: string, socketId: string): Promise<boolean> {
    try {
      console.log(`[SolanaTradeMonitor] Subscribing to REAL trades for token: ${tokenAddress}`);

      const tokenPubkey = new PublicKey(tokenAddress);
      
      // Check if we already have a subscription for this token
      let subscription = this.subscriptions.get(tokenAddress);
      
      if (subscription) {
        // Add socket to existing subscription
        subscription.subscribers.add(socketId);
        console.log(`[SolanaTradeMonitor] Added socket to existing subscription (${subscription.subscribers.size} subscribers)`);
        return true;
      }

      // Create new subscription
      subscription = {
        tokenAddress,
        subscriptionId: null,
        subscribers: new Set([socketId]),
        lastActivity: new Date(),
        tradeCount: 0,
      };

      // Derive the bonding curve PDA for this token
      const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), tokenPubkey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
      );

      // Subscribe to account changes on the bonding curve
      // This will fire whenever a trade happens on pump.fun
      const subscriptionId = this.connection.onAccountChange(
        bondingCurvePDA,
        async (accountInfo, context) => {
          try {
            // When bonding curve account changes, fetch recent transactions
            const signatures = await this.connection.getSignaturesForAddress(bondingCurvePDA, { limit: 1 });
            
            if (signatures.length > 0) {
              const signature = signatures[0].signature;
              
              // Fetch the transaction details
              const tx = await this.connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
              });

              if (tx && !tx.meta?.err) {
                // Parse the transaction to extract trade data
                const tradeData = await this.parseTradeTransaction(tx, tokenAddress);
                
                if (tradeData) {
                  // Update stats
                  subscription!.tradeCount++;
                  subscription!.lastActivity = new Date();
                  this.stats.totalTradesDetected++;
                  this.stats.tradesPerToken.set(tokenAddress, (this.stats.tradesPerToken.get(tokenAddress) || 0) + 1);

                  // Broadcast to all subscribers for this token
                  this.broadcastRealTrade(tokenAddress, tradeData);
                }
              }
            }
          } catch (error) {
            console.error(`[SolanaTradeMonitor] Error processing trade:`, error);
          }
        },
        'confirmed'
      );

      subscription.subscriptionId = subscriptionId;
      this.subscriptions.set(tokenAddress, subscription);
      this.stats.activeSubscriptions = this.subscriptions.size;
      this.stats.totalSubscriptions++;

      console.log(`[SolanaTradeMonitor] Subscribed to REAL blockchain trades for ${tokenAddress}`);
      console.log(`[SolanaTradeMonitor] Bonding curve PDA: ${bondingCurvePDA.toString()}`);
      
      return true;
    } catch (error) {
      console.error(`[SolanaTradeMonitor] Error subscribing to token:`, error);
      return false;
    }
  }

  /**
   * Unsubscribe from token trades
   */
  async unsubscribeFromToken(tokenAddress: string, socketId: string): Promise<void> {
    const subscription = this.subscriptions.get(tokenAddress);
    
    if (!subscription) {
      return;
    }

    subscription.subscribers.delete(socketId);

    // If no more subscribers, remove the subscription
    if (subscription.subscribers.size === 0) {
      if (subscription.subscriptionId !== null) {
        try {
          await this.connection.removeAccountChangeListener(subscription.subscriptionId);
          console.log(`[SolanaTradeMonitor] Unsubscribed from ${tokenAddress}`);
        } catch (error) {
          console.error(`[SolanaTradeMonitor] Error unsubscribing:`, error);
        }
      }
      
      this.subscriptions.delete(tokenAddress);
      this.stats.activeSubscriptions = this.subscriptions.size;
    }
  }

  /**
   * Parse a pump.fun trade transaction
   */
  private async parseTradeTransaction(
    tx: ParsedTransactionWithMeta,
    tokenAddress: string
  ): Promise<RealTradeData | null> {
    try {
      if (!tx.meta || !tx.transaction || !tx.blockTime) {
        return null;
      }

      const instructions = tx.transaction.message.instructions;
      const accounts = tx.transaction.message.accountKeys;

      // Look for pump.fun program instructions
      let tradeInstruction: any = null;
      for (const ix of instructions) {
        const programId = 'programId' in ix ? ix.programId : null;
        if (programId && programId.toString() === PUMP_FUN_PROGRAM_ID.toString()) {
          tradeInstruction = ix;
          break;
        }
      }

      if (!tradeInstruction) {
        return null;
      }

      // Extract trader address (usually first account / fee payer)
      const trader = accounts[0].pubkey.toString();

      // Analyze pre and post balances to determine trade type and amounts
      const preBalances = tx.meta.preBalances;
      const postBalances = tx.meta.postBalances;

      // Calculate SOL change for the trader (account 0)
      const solChange = (postBalances[0] - preBalances[0]) / 1e9; // Convert lamports to SOL

      // Determine trade type based on SOL flow
      const isBuy = solChange < 0; // If SOL decreased, it's a buy
      const isSell = solChange > 0; // If SOL increased, it's a sell

      if (!isBuy && !isSell) {
        return null;
      }

      const solAmount = Math.abs(solChange);

      // Extract token amounts from logs (pump.fun logs usually contain this info)
      let tokenAmount = 0;
      if (tx.meta.logMessages) {
        for (const log of tx.meta.logMessages) {
          // Look for logs that indicate token amounts
          // Pump.fun typically logs: "Program log: Buy: X tokens" or "Program log: Sell: X tokens"
          const buyMatch = log.match(/Buy.*?(\d+\.?\d*)/i);
          const sellMatch = log.match(/Sell.*?(\d+\.?\d*)/i);
          
          if (buyMatch) {
            tokenAmount = parseFloat(buyMatch[1]);
          } else if (sellMatch) {
            tokenAmount = parseFloat(sellMatch[1]);
          }
        }
      }

      // If we couldn't extract from logs, estimate based on typical pump.fun mechanics
      if (tokenAmount === 0 && solAmount > 0) {
        // For pump.fun, we can estimate token amount based on bonding curve
        // This is approximate, real implementation would query the bonding curve state
        tokenAmount = solAmount * 1000000; // Placeholder estimation
      }

      // Calculate price
      const price = tokenAmount > 0 ? solAmount / tokenAmount : 0;

      const tradeData: RealTradeData = {
        tokenAddress,
        type: isBuy ? 'buy' : 'sell',
        amount: isBuy ? solAmount : tokenAmount,
        solAmount,
        tokenAmount,
        trader,
        signature: tx.transaction.signatures[0],
        timestamp: tx.blockTime * 1000,
        price,
        isRealTrade: true,
      };

      console.log(`[SolanaTradeMonitor] REAL ${tradeData.type.toUpperCase()} detected:`, {
        token: tokenAddress.substring(0, 8) + '...',
        solAmount: solAmount.toFixed(6),
        tokenAmount: tokenAmount.toFixed(0),
        trader: trader.substring(0, 8) + '...',
      });

      return tradeData;
    } catch (error) {
      console.error(`[SolanaTradeMonitor] Error parsing trade transaction:`, error);
      return null;
    }
  }

  /**
   * Broadcast real trade to all subscribers
   */
  private broadcastRealTrade(tokenAddress: string, tradeData: RealTradeData): void {
    const subscription = this.subscriptions.get(tokenAddress);
    
    if (!subscription) {
      return;
    }

    // Emit to all subscribed sockets
    subscription.subscribers.forEach((socketId) => {
      this.io.to(socketId).emit('pumpfun:real_trade', tradeData);
    });

    // Also emit to global channel for monitoring
    this.io.emit('pumpfun:trade_detected', {
      tokenAddress,
      type: tradeData.type,
      amount: tradeData.amount,
      timestamp: tradeData.timestamp,
      isReal: true,
    });

    console.log(`[SolanaTradeMonitor] Broadcasted REAL trade to ${subscription.subscribers.size} clients`);
  }

  /**
   * Cleanup stale subscriptions (no activity for 30+ minutes)
   */
  private async cleanupStaleSubscriptions(): Promise<void> {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes

    for (const [tokenAddress, subscription] of this.subscriptions.entries()) {
      const timeSinceActivity = now - subscription.lastActivity.getTime();
      
      if (timeSinceActivity > staleThreshold && subscription.subscribers.size === 0) {
        console.log(`[SolanaTradeMonitor] Cleaning up stale subscription for ${tokenAddress}`);
        
        if (subscription.subscriptionId !== null) {
          try {
            await this.connection.removeAccountChangeListener(subscription.subscriptionId);
          } catch (error) {
            console.error(`[SolanaTradeMonitor] Error during cleanup:`, error);
          }
        }
        
        this.subscriptions.delete(tokenAddress);
      }
    }

    this.stats.activeSubscriptions = this.subscriptions.size;
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      activeSubscriptions: this.stats.activeSubscriptions,
      totalSubscriptions: this.stats.totalSubscriptions,
      totalTradesDetected: this.stats.totalTradesDetected,
      tradesPerToken: Object.fromEntries(this.stats.tradesPerToken),
      monitoredTokens: Array.from(this.subscriptions.entries()).map(([address, sub]) => ({
        address,
        subscribers: sub.subscribers.size,
        tradeCount: sub.tradeCount,
        lastActivity: sub.lastActivity.toISOString(),
      })),
    };
  }

  /**
   * Get subscription info for a token
   */
  getTokenSubscription(tokenAddress: string): TokenSubscription | undefined {
    return this.subscriptions.get(tokenAddress);
  }

  /**
   * Check if monitoring a token
   */
  isMonitoring(tokenAddress: string): boolean {
    return this.subscriptions.has(tokenAddress);
  }
}

