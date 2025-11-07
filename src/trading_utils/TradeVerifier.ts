/**
 * Trade Verification System
 * Post-trade verification to ensure expected outcomes
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { awsLogger } from '../aws/logger';

export interface TradeVerification {
  signature: string;
  verified: boolean;
  expectedTokens?: number;
  actualTokens?: number;
  expectedSlippage?: number;
  actualSlippage?: number;
  issues: string[];
  timestamp: number;
}

export interface VerificationConfig {
  maxSlippageDeviation: number; // Max acceptable deviation from expected slippage (%)
  maxPriceImpact: number; // Max acceptable price impact (%)
  requireBalanceCheck: boolean;
  verificationTimeoutMs: number;
}

/**
 * Trade Verifier - Ensures trades executed as expected
 */
export class TradeVerifier {
  private connection: Connection;
  private config: VerificationConfig;

  constructor(connection: Connection, config?: Partial<VerificationConfig>) {
    this.connection = connection;
    this.config = {
      maxSlippageDeviation: 5, // 5% deviation allowed
      maxPriceImpact: 15, // 15% max price impact
      requireBalanceCheck: true,
      verificationTimeoutMs: 10000, // 10 seconds
      ...config
    };
  }

  /**
   * Verify buy transaction executed correctly
   */
  async verifyBuy(
    signature: string,
    expectedParams: {
      amountInSOL: number;
      expectedMinTokens: number;
      tokenMint: string;
      walletAddress: string;
    }
  ): Promise<TradeVerification> {
    const issues: string[] = [];
    const startTime = Date.now();

    try {
      // Get transaction details
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx) {
        issues.push('Transaction not found on chain');
        return {
          signature,
          verified: false,
          issues,
          timestamp: Date.now()
        };
      }

      // Check if transaction was not successful
      if (tx.meta?.err) {
        issues.push(`Transaction failed on chain: ${JSON.stringify(tx.meta.err)}`);
        return {
          signature,
          verified: false,
          issues,
          timestamp: Date.now()
        };
      }

      // Get actual tokens received (if balance check enabled)
      let actualTokens: number | undefined;
      if (this.config.requireBalanceCheck) {
        try {
          const tokenAccount = await this.getTokenAccount(
            new PublicKey(expectedParams.tokenMint),
            new PublicKey(expectedParams.walletAddress)
          );
          
          if (tokenAccount) {
            actualTokens = Number(tokenAccount.amount);
            
            // Verify we got at least minimum expected
            if (actualTokens < expectedParams.expectedMinTokens) {
              issues.push(
                `Received less tokens than expected: ${actualTokens} < ${expectedParams.expectedMinTokens}`
              );
            }
          }
        } catch (error) {
          issues.push(`Could not verify token balance: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Calculate slippage
      let actualSlippage: number | undefined;
      if (actualTokens && expectedParams.expectedMinTokens > 0) {
        const deviation = ((expectedParams.expectedMinTokens - actualTokens) / expectedParams.expectedMinTokens) * 100;
        actualSlippage = Math.abs(deviation);

        if (actualSlippage > this.config.maxSlippageDeviation) {
          issues.push(
            `Slippage exceeded acceptable range: ${actualSlippage.toFixed(2)}% > ${this.config.maxSlippageDeviation}%`
          );
        }
      }

      const verification: TradeVerification = {
        signature,
        verified: issues.length === 0,
        expectedTokens: expectedParams.expectedMinTokens,
        actualTokens,
        actualSlippage,
        issues,
        timestamp: Date.now()
      };

      // Log verification result
      if (verification.verified) {
        awsLogger.info('Trade verified successfully', {
          metadata: { signature, actualTokens, actualSlippage }
        });
      } else {
        awsLogger.warn('Trade verification issues detected', {
          metadata: { signature, issues }
        });
      }

      return verification;

    } catch (error) {
      issues.push(`Verification error: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        signature,
        verified: false,
        issues,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Verify sell transaction executed correctly
   */
  async verifySell(
    signature: string,
    expectedParams: {
      tokensSold: number;
      expectedMinSOL: number;
      tokenMint: string;
      walletAddress: string;
    }
  ): Promise<TradeVerification> {
    const issues: string[] = [];

    try {
      // Get transaction details
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx) {
        issues.push('Transaction not found on chain');
        return {
          signature,
          verified: false,
          issues,
          timestamp: Date.now()
        };
      }

      // Check if transaction was successful
      if (tx.meta?.err) {
        issues.push(`Transaction failed on chain: ${JSON.stringify(tx.meta.err)}`);
        return {
          signature,
          verified: false,
          issues,
          timestamp: Date.now()
        };
      }

      // Get pre/post balances to calculate SOL received
      const preBalance = tx.meta?.preBalances?.[0] || 0;
      const postBalance = tx.meta?.postBalances?.[0] || 0;
      const actualSOLReceived = (postBalance - preBalance) / 1e9;

      let actualSlippage: number | undefined;
      if (actualSOLReceived < expectedParams.expectedMinSOL) {
        const deviation = ((expectedParams.expectedMinSOL - actualSOLReceived) / expectedParams.expectedMinSOL) * 100;
        actualSlippage = Math.abs(deviation);
        
        issues.push(
          `Received less SOL than expected: ${actualSOLReceived.toFixed(6)} < ${expectedParams.expectedMinSOL.toFixed(6)}`
        );
      }

      const verification: TradeVerification = {
        signature,
        verified: issues.length === 0,
        actualSlippage,
        issues,
        timestamp: Date.now()
      };

      if (verification.verified) {
        awsLogger.info('Sell trade verified successfully', {
          metadata: { signature, actualSOLReceived }
        });
      } else {
        awsLogger.warn('Sell trade verification issues detected', {
          metadata: { signature, issues }
        });
      }

      return verification;

    } catch (error) {
      issues.push(`Verification error: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        signature,
        verified: false,
        issues,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get token account for verification
   */
  private async getTokenAccount(tokenMint: PublicKey, owner: PublicKey) {
    try {
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(owner, {
        mint: tokenMint
      });

      if (tokenAccounts.value.length === 0) {
        return null;
      }

      // Get the first token account
      return await getAccount(this.connection, tokenAccounts.value[0].pubkey);
    } catch (error) {
      return null;
    }
  }
}

// Export singleton instance
let tradeVerifierInstance: TradeVerifier | null = null;

export function getTradeVerifier(connection: Connection): TradeVerifier {
  if (!tradeVerifierInstance) {
    tradeVerifierInstance = new TradeVerifier(connection);
  }
  return tradeVerifierInstance;
}

