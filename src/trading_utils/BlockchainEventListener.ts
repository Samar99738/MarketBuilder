/**
 * Blockchain Event Listener
 * Real-time monitoring of on-chain transactions for reactive strategies
 */

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { EventEmitter } from 'events';
import { awsLogger } from '../aws/logger';

export interface SwapEvent {
  signature: string;
  type: 'buy' | 'sell';
  tokenMint: string;
  amountTokens: number;
  amountSOL: number;
  timestamp: number;
  wallet: string;
}

/**
 * Blockchain Event Listener for reactive strategies
 */
export class BlockchainEventListener extends EventEmitter {
  private connection: Connection;
  private watchedTokens: Map<string, NodeJS.Timeout> = new Map();
  private isShuttingDown = false;
  private pollInterval = 2000; // 2 seconds

  constructor(connection: Connection) {
    super();
    this.connection = connection;
    awsLogger.info('BlockchainEventListener initialized');
  }

  /**
   * Start monitoring a token for swap events
   */
  async monitorToken(tokenMint: string): Promise<void> {
    if (this.watchedTokens.has(tokenMint)) {
      return; // Already monitoring
    }

    const poll = async () => {
      if (this.isShuttingDown || !this.watchedTokens.has(tokenMint)) {
        return;
      }

      try {
        const events = await this.fetchRecentSwaps(tokenMint);
        
        for (const event of events) {
          this.emit('swap', event);
        }
      } catch (error) {
        awsLogger.error('Error fetching swap events', {
          metadata: {
            tokenMint,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }

      // Schedule next poll
      if (!this.isShuttingDown && this.watchedTokens.has(tokenMint)) {
        const timer = setTimeout(poll, this.pollInterval);
        this.watchedTokens.set(tokenMint, timer);
      }
    };

    // Start first poll
    poll();
    
    awsLogger.info('Started monitoring token', {
      metadata: { tokenMint, pollInterval: this.pollInterval }
    });
  }

  /**
   * Stop monitoring a token
   */
  stopMonitoring(tokenMint: string): void {
    const timer = this.watchedTokens.get(tokenMint);
    if (timer) {
      clearTimeout(timer);
      this.watchedTokens.delete(tokenMint);
      
      awsLogger.info('Stopped monitoring token', {
        metadata: { tokenMint }
      });
    }
  }

  /**
   * Fetch recent swap transactions for a token
   */
  private async fetchRecentSwaps(tokenMint: string): Promise<SwapEvent[]> {
    try {
      // Get recent signatures for the token
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(tokenMint),
        { limit: 10 },
        'confirmed'
      );

      const events: SwapEvent[] = [];

      for (const sig of signatures.slice(0, 5)) { // Process last 5 transactions
        try {
          const tx = await this.connection.getParsedTransaction(
            sig.signature,
            { maxSupportedTransactionVersion: 0 }
          );

          if (tx) {
            const event = this.parseSwapTransaction(tx, tokenMint);
            if (event) {
              events.push(event);
            }
          }
        } catch (error) {
          // Skip failed transaction parsing
          continue;
        }
      }

      return events;
    } catch (error) {
      awsLogger.error('Failed to fetch recent swaps', {
        metadata: {
          tokenMint,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return [];
    }
  }

  /**
   * Parse swap transaction to extract event data
   */
  private parseSwapTransaction(
    tx: ParsedTransactionWithMeta,
    tokenMint: string
  ): SwapEvent | null {
    try {
      // Extract swap information from transaction
      const meta = tx.meta;
      if (!meta || meta.err) return null;

      // Get pre/post token balances to determine swap type and amount
      const preTokenBalances = meta.preTokenBalances || [];
      const postTokenBalances = meta.postTokenBalances || [];

      // Find token balance changes
      for (let i = 0; i < preTokenBalances.length; i++) {
        const preBal = preTokenBalances[i];
        const postBal = postTokenBalances.find(p => p.accountIndex === preBal.accountIndex);

        if (preBal.mint === tokenMint && postBal) {
          const preAmount = Number(preBal.uiTokenAmount.amount);
          const postAmount = Number(postBal.uiTokenAmount.amount);
          const change = postAmount - preAmount;

          if (Math.abs(change) > 0) {
            // Determine if buy or sell
            const type = change > 0 ? 'buy' : 'sell';
            const amountTokens = Math.abs(change);

            // Get SOL balance change
            const preSOL = meta.preBalances[preBal.accountIndex] || 0;
            const postSOL = meta.postBalances[preBal.accountIndex] || 0;
            const amountSOL = Math.abs((postSOL - preSOL) / 1e9);

            return {
              signature: tx.transaction.signatures[0],
              type,
              tokenMint,
              amountTokens,
              amountSOL,
              timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
              wallet: tx.transaction.message.accountKeys[0]?.pubkey.toString() || 'unknown'
            };
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get token account
   */
  private async getTokenAccount(tokenMint: PublicKey, owner: PublicKey) {
    try {
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(owner, {
        mint: tokenMint
      });

      if (tokenAccounts.value.length === 0) {
        return null;
      }

      return await getAccount(this.connection, tokenAccounts.value[0].pubkey);
    } catch (error) {
      return null;
    }
  }

  /**
   * Shutdown listener
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Stop all monitoring
    for (const [tokenMint, timer] of this.watchedTokens.entries()) {
      clearTimeout(timer);
    }

    this.watchedTokens.clear();

    awsLogger.info('BlockchainEventListener shutdown complete');
  }

  /**
   * Get monitoring status
   */
  getStatus(): {
    monitoring: boolean;
    watchedTokens: number;
    tokens: string[];
  } {
    return {
      monitoring: !this.isShuttingDown,
      watchedTokens: this.watchedTokens.size,
      tokens: Array.from(this.watchedTokens.keys())
    };
  }
}

// Export singleton
let blockchainEventListenerInstance: BlockchainEventListener | null = null;

export function getBlockchainEventListener(connection: Connection): BlockchainEventListener {
  if (!blockchainEventListenerInstance) {
    blockchainEventListenerInstance = new BlockchainEventListener(connection);
  }
  return blockchainEventListenerInstance;
}

