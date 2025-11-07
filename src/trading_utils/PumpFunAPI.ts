/**
 * Pump.fun API Wrapper
 * 
 * Wrapper for PumpPortal.fun API - handles buy/sell operations for pump.fun tokens
 * Uses the free trade-local API that returns serialized transactions
 */

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { mpcWalletManager } from './MPCWallet';
import { MPC_CONFIG } from './config';

/**
 * PumpPortal API configuration
 */
const PUMPPORTAL_API = {
  TRADE_LOCAL: 'https://pumpportal.fun/api/trade-local',
  TRADE_LIGHTNING: 'https://pumpportal.fun/api/trade', // Requires API key
};

/**
 * Buy/Sell parameters
 */
export interface PumpPortalTradeParams {
  /** Wallet public key */
  publicKey: string;
  /** Trade action */
  action: 'buy' | 'sell';
  /** Token mint address */
  mint: string;
  /** Amount to trade */
  amount: number;
  /** Whether amount is denominated in SOL (true) or tokens (false) */
  denominatedInSol: 'true' | 'false';
  /** Slippage percentage (e.g., 10 = 10%) */
  slippage: number;
  /** Priority fee in SOL */
  priorityFee: number;
  /** Pool to trade on (default: 'pump') */
  pool?: string;
}

/**
 * API Response
 */
interface PumpPortalResponse {
  success?: boolean;
  error?: string;
  // The serialized transaction in base64 (for trade-local)
  transaction?: string;
  // The transaction signature (for lightning API)
  signature?: string;
}

/**
 * Trade result
 */
export interface PumpFunTradeResult {
  success: boolean;
  signature?: string;
  error?: string;
  tokenAmount?: number;
  solAmount?: number;
}

/**
 * Pump.fun API Client
 */
export class PumpFunAPI {
  private connection: Connection;
  private useLocalAPI: boolean = true; // Use free API by default

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Buy tokens from pump.fun
   */
  async buyToken(
    tokenMint: string,
    solAmount: number,
    slippage: number = 10,
    priorityFee: number = 0.00001
  ): Promise<PumpFunTradeResult> {
    try {
  // Buying token (logging removed for production)

      // Get wallet public key
      let walletPublicKey: PublicKey;
      let signTransaction: (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;

      if (MPC_CONFIG.ENABLED && mpcWalletManager.isMPCEnabled()) {
        // MPC wallet mode
        walletPublicKey = await mpcWalletManager.getPublicKey();
        signTransaction = async (tx) => {
          const response = await mpcWalletManager.signTransaction({
            transaction: tx,
            description: `Buy ${solAmount} SOL of token ${tokenMint}`,
            metadata: {
              type: 'buy',
              amount: solAmount,
              token: tokenMint,
            }
          });
          // Return the signed transaction (the signature is already applied by MPC)
          return tx;
        };
      } else {
        // Traditional wallet mode
        if (!process.env.WALLET_PRIVATE_KEY) {
          throw new Error('Wallet private key not configured');
        }
        const wallet = Keypair.fromSecretKey(
          Buffer.from(process.env.WALLET_PRIVATE_KEY, 'base64')
        );
        walletPublicKey = wallet.publicKey;
        signTransaction = async (tx) => {
          if (tx instanceof VersionedTransaction) {
            tx.sign([wallet]);
            return tx;
          } else {
            tx.sign(wallet);
            return tx;
          }
        };
      }

      // Prepare API parameters
      const params: PumpPortalTradeParams = {
        publicKey: walletPublicKey.toString(),
        action: 'buy',
        mint: tokenMint,
        amount: solAmount,
        denominatedInSol: 'true',
        slippage: slippage,
        priorityFee: priorityFee,
        pool: 'pump',
      };

      // Call PumpPortal API
  // Requesting transaction from PumpPortal (logging removed)
      const response = await fetch(PUMPPORTAL_API.TRADE_LOCAL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as PumpPortalResponse;

      // Check for errors
      if (data.error) {
        throw new Error(`PumpPortal API error: ${data.error}`);
      }

      if (!data.transaction) {
        throw new Error('No transaction returned from PumpPortal API');
      }

  // Deserialize transaction
      const transactionBuffer = Buffer.from(data.transaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

  // Sign transaction
      const signedTransaction = await signTransaction(transaction);

  // Send transaction
      const signature = await this.connection.sendRawTransaction(
        (signedTransaction as VersionedTransaction).serialize(),
        {
          skipPreflight: false,
          maxRetries: 3,
        }
      );

  // Confirming transaction

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction(
        signature,
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

  // Buy successful

      return {
        success: true,
        signature,
        solAmount,
      };
    } catch (error) {
  // Buy failed
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Sell tokens on pump.fun
   */
  async sellToken(
    tokenMint: string,
    tokenAmount: number | string, // Can be number or percentage like "100%"
    slippage: number = 10,
    priorityFee: number = 0.00001
  ): Promise<PumpFunTradeResult> {
    try {
  // Selling token (logging removed for production)

      // Get wallet public key
      let walletPublicKey: PublicKey;
      let signTransaction: (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;

      if (MPC_CONFIG.ENABLED && mpcWalletManager.isMPCEnabled()) {
        walletPublicKey = await mpcWalletManager.getPublicKey();
        signTransaction = async (tx) => {
          const response = await mpcWalletManager.signTransaction({
            transaction: tx,
            description: `Sell ${tokenAmount} tokens of ${tokenMint}`,
            metadata: {
              type: 'sell',
              amount: typeof tokenAmount === 'string' ? parseFloat(tokenAmount) : tokenAmount,
              token: tokenMint,
            }
          });
          // Return the signed transaction (the signature is already applied by MPC)
          return tx;
        };
      } else {
        if (!process.env.WALLET_PRIVATE_KEY) {
          throw new Error('Wallet private key not configured');
        }
        const wallet = Keypair.fromSecretKey(
          Buffer.from(process.env.WALLET_PRIVATE_KEY, 'base64')
        );
        walletPublicKey = wallet.publicKey;
        signTransaction = async (tx) => {
          if (tx instanceof VersionedTransaction) {
            tx.sign([wallet]);
            return tx;
          } else {
            tx.sign(wallet);
            return tx;
          }
        };
      }

      // Prepare API parameters
      const params: PumpPortalTradeParams = {
        publicKey: walletPublicKey.toString(),
        action: 'sell',
        mint: tokenMint,
        amount: typeof tokenAmount === 'string' ? parseFloat(tokenAmount) : tokenAmount,
        denominatedInSol: 'false', // Selling tokens, not SOL
        slippage: slippage,
        priorityFee: priorityFee,
        pool: 'pump',
      };

      // Call PumpPortal API
  // Requesting transaction from PumpPortal (logging removed)
      const response = await fetch(PUMPPORTAL_API.TRADE_LOCAL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as PumpPortalResponse;

      if (data.error) {
        throw new Error(`PumpPortal API error: ${data.error}`);
      }

      if (!data.transaction) {
        throw new Error('No transaction returned from PumpPortal API');
      }

  // Deserialize transaction
      const transactionBuffer = Buffer.from(data.transaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

  // Sign transaction
      const signedTransaction = await signTransaction(transaction);

  // Send transaction
      const signature = await this.connection.sendRawTransaction(
        (signedTransaction as VersionedTransaction).serialize(),
        {
          skipPreflight: false,
          maxRetries: 3,
        }
      );

  // Confirming transaction

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction(
        signature,
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

  // Sell successful

      return {
        success: true,
        signature,
        tokenAmount: typeof tokenAmount === 'string' ? 0 : tokenAmount,
      };
    } catch (error) {
  // Sell failed
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get token price from pump.fun
   */
  async getTokenPrice(tokenMint: string): Promise<number | null> {
    try {
      // Use pump.fun frontend API to get price
      const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenMint}`);
      
      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      
      // Price is typically in the 'priceUsd' or 'price' field
      return data.price || data.priceUsd || null;
    } catch (error) {
  // Error fetching token price
      return null;
    }
  }

  /**
   * Get trending pump.fun tokens
   */
  async getTrendingTokens(limit: number = 10): Promise<any[]> {
    try {
      const response = await fetch(`https://frontend-api.pump.fun/coins/trending?limit=${limit}`);
      
      if (!response.ok) {
        return [];
      }

      return await response.json() as any[];
    } catch (error) {
  // Error fetching trending tokens
      return [];
    }
  }

  /**
   * Get token metadata
   */
  async getTokenMetadata(tokenMint: string): Promise<any> {
    try {
  // Fetching metadata for token
      
      const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenMint}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      
      if (!response.ok) {
  // API returned status for token
        
        // Try to read response text to see what the error is
        try {
          const text = await response.text();
        } catch (e) {
          // Ignore
        }
        
        return null;
      }

      const text = await response.text();
      
      // Check if response is HTML (Cloudflare block or 404)
      if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
  // Received HTML instead of JSON - token may not exist or API is blocked
        return null;
      }

      try {
        const data = JSON.parse(text);
        // Successfully fetched metadata for token
        return data;
      } catch (parseError) {
  // Failed to parse JSON response
        return null;
      }
    } catch (error) {
  // Error fetching token metadata
      return null;
    }
  }
}

/**
 * Singleton instance
 */
let pumpFunAPIInstance: PumpFunAPI | null = null;

export function getPumpFunAPI(connection: Connection): PumpFunAPI {
  if (!pumpFunAPIInstance) {
    pumpFunAPIInstance = new PumpFunAPI(connection);
  }
  return pumpFunAPIInstance;
}

export function resetPumpFunAPI(): void {
  pumpFunAPIInstance = null;
}