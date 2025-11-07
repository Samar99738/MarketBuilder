/**
 * Production-Grade Transaction Confirmation System
 * Handles robust transaction confirmation with retries, timeouts, and recovery
 */

import { Connection, PublicKey, ConfirmOptions, RpcResponseAndContext, SignatureResult } from '@solana/web3.js';

// Transaction confirmation status enum
export enum TransactionStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FINALIZED = 'FINALIZED',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN'
}

// Confirmation levels for different use cases
export enum ConfirmationLevel {
  PROCESSED = 'processed',    // Fastest, least secure
  CONFIRMED = 'confirmed',    // Balanced for most trading
  FINALIZED = 'finalized'     // Slowest, most secure
}

// Transaction confirmation result
export interface TransactionConfirmationResult {
  signature: string;
  status: TransactionStatus;
  confirmationLevel: ConfirmationLevel;
  slot?: number;
  blockTime?: number | null;
  confirmationTime: number; // Time taken to confirm in ms
  attempts: number;
  error?: string;
}

// Configuration for transaction confirmation
export interface TransactionConfirmationConfig {
  maxRetries: number;
  timeoutMs: number;
  confirmationLevel: ConfirmationLevel;
  retryDelayMs: number;
  exponentialBackoff: boolean;
}

// Production-ready transaction confirmer
export class TransactionConfirmer {
  private connection: Connection;
  private defaultConfig: TransactionConfirmationConfig;

  constructor(connection: Connection, config?: Partial<TransactionConfirmationConfig>) {
    this.connection = connection;
    this.defaultConfig = {
      maxRetries: 10,
      timeoutMs: 60000, // 60 seconds
      confirmationLevel: ConfirmationLevel.CONFIRMED,
      retryDelayMs: 2000, // 2 seconds
      exponentialBackoff: true,
      ...config
    };
  }

  /**
   * Confirm a transaction with production-grade reliability
   */
  async confirmTransaction(
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number,
    config?: Partial<TransactionConfirmationConfig>
  ): Promise<TransactionConfirmationResult> {
    const finalConfig = { ...this.defaultConfig, ...config };
    const startTime = Date.now();
    
    //console.log(` Starting transaction confirmation: ${signature.substring(0, 8)}...`);
    //console.log(`  Config: ${finalConfig.confirmationLevel} level, ${finalConfig.timeoutMs}ms timeout, ${finalConfig.maxRetries} max retries`);

    let attempts = 0;
    let lastError: string | undefined;

    while (attempts < finalConfig.maxRetries) {
      attempts++;
      
      try {
        // Check if we've exceeded the timeout
        const elapsed = Date.now() - startTime;
        if (elapsed > finalConfig.timeoutMs) {
          return {
            signature,
            status: TransactionStatus.TIMEOUT,
            confirmationLevel: finalConfig.confirmationLevel,
            confirmationTime: elapsed,
            attempts,
            error: `Transaction confirmation timeout after ${finalConfig.timeoutMs}ms`
          };
        }

       // console.log(` Confirmation attempt ${attempts}/${finalConfig.maxRetries} (${elapsed}ms elapsed)`);

        // Try to confirm the transaction
        const confirmation = await this.attemptConfirmation(
          signature,
          blockhash,
          lastValidBlockHeight,
          finalConfig.confirmationLevel
        );

        if (confirmation.success) {
          const confirmationTime = Date.now() - startTime;
         // console.log(` Transaction confirmed in ${confirmationTime}ms after ${attempts} attempts`);
          
          return {
            signature,
            status: TransactionStatus.CONFIRMED,
            confirmationLevel: finalConfig.confirmationLevel,
            slot: confirmation.slot,
            blockTime: confirmation.blockTime,
            confirmationTime,
            attempts
          };
        }

        // Check if transaction failed permanently
        if (confirmation.failed) {
          return {
            signature,
            status: TransactionStatus.FAILED,
            confirmationLevel: finalConfig.confirmationLevel,
            confirmationTime: Date.now() - startTime,
            attempts,
            error: confirmation.error
          };
        }

        lastError = confirmation.error;

      } catch (error: any) {
        lastError = error.message;
        console.warn(`  Confirmation attempt ${attempts} failed: ${error.message}`);
      }

      // Don't wait after the last attempt
      if (attempts < finalConfig.maxRetries) {
        const delay = finalConfig.exponentialBackoff 
          ? finalConfig.retryDelayMs * Math.pow(2, attempts - 1)
          : finalConfig.retryDelayMs;
        
        //console.log(` Waiting ${delay}ms before retry...`);
        await this.sleep(delay);
      }
    }

    // All attempts exhausted
    const finalTime = Date.now() - startTime;
    return {
      signature,
      status: TransactionStatus.FAILED,
      confirmationLevel: finalConfig.confirmationLevel,
      confirmationTime: finalTime,
      attempts,
      error: `Failed to confirm after ${attempts} attempts. Last error: ${lastError}`
    };
  }

  /**
   * Attempt a single confirmation check
   */
  private async attemptConfirmation(
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number,
    level: ConfirmationLevel
  ): Promise<{
    success: boolean;
    failed: boolean;
    slot?: number;
    blockTime?: number | null;
    error?: string;
  }> {
    try {
      // First, check if the block is still valid
      const currentBlockHeight = await this.connection.getBlockHeight('finalized');
      if (currentBlockHeight > lastValidBlockHeight) {
        return {
          success: false,
          failed: true,
          error: 'Transaction expired: block height exceeded'
        };
      }

      // Attempt confirmation with the specified level
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, level);

      // Check for transaction errors
      if (confirmation.value.err) {
        return {
          success: false,
          failed: true,
          error: `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
        };
      }

      // Get additional transaction details
      const transactionDetails = await this.connection.getTransaction(signature, {
        commitment: level as any, // Cast to avoid TypeScript enum mismatch
        maxSupportedTransactionVersion: 0
      });

      return {
        success: true,
        failed: false,
        slot: transactionDetails?.slot,
        blockTime: transactionDetails?.blockTime
      };

    } catch (error: any) {
      // Don't treat network errors as permanent failures
      if (error.message.includes('timeout') || 
          error.message.includes('network') ||
          error.message.includes('503') ||
          error.message.includes('502')) {
        return {
          success: false,
          failed: false,
          error: error.message
        };
      }

      // Permanent failure
      return {
        success: false,
        failed: true,
        error: error.message
      };
    }
  }

  /**
   * Get current transaction status without waiting
   */
  async getTransactionStatus(signature: string): Promise<{
    status: TransactionStatus;
    confirmationLevel?: ConfirmationLevel;
    slot?: number;
    blockTime?: number | null;
    error?: string;
  }> {
    try {
      // Check at different confirmation levels
      const levels: ConfirmationLevel[] = [
        ConfirmationLevel.PROCESSED,
        ConfirmationLevel.CONFIRMED,
        ConfirmationLevel.FINALIZED
      ];

      for (const level of levels) {
        try {
          const status = await this.connection.getSignatureStatus(signature, {
            searchTransactionHistory: true
          });

          if (status.value) {
            if (status.value.err) {
              return {
                status: TransactionStatus.FAILED,
                error: `Transaction failed: ${JSON.stringify(status.value.err)}`
              };
            }

            const confirmationStatus = status.value.confirmationStatus;
            if (confirmationStatus === 'finalized') {
              return {
                status: TransactionStatus.FINALIZED,
                confirmationLevel: ConfirmationLevel.FINALIZED,
                slot: status.value.slot
              };
            } else if (confirmationStatus === 'confirmed') {
              return {
                status: TransactionStatus.CONFIRMED,
                confirmationLevel: ConfirmationLevel.CONFIRMED,
                slot: status.value.slot
              };
            } else if (confirmationStatus === 'processed') {
              return {
                status: TransactionStatus.CONFIRMED,
                confirmationLevel: ConfirmationLevel.PROCESSED,
                slot: status.value.slot
              };
            }
          }
        } catch (levelError) {
          // Continue to next level
          continue;
        }
      }

      return { status: TransactionStatus.PENDING };

    } catch (error: any) {
      return {
        status: TransactionStatus.UNKNOWN,
        error: error.message
      };
    }
  }

  /**
   * Utility function for sleeping
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Monitor multiple transactions simultaneously
   */
  async monitorTransactions(
    transactions: Array<{
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
    }>,
    config?: Partial<TransactionConfirmationConfig>
  ): Promise<TransactionConfirmationResult[]> {
    //console.log(` Monitoring ${transactions.length} transactions simultaneously`);
    
    const promises = transactions.map(tx => 
      this.confirmTransaction(tx.signature, tx.blockhash, tx.lastValidBlockHeight, config)
    );
    return Promise.all(promises);
  }
}

// Factory function for easy creation
export function createTransactionConfirmer(
  connection: Connection,
  config?: Partial<TransactionConfirmationConfig>
): TransactionConfirmer {
  return new TransactionConfirmer(connection, config);
}