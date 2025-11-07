/**
 * Token Router
 * 
 * Intelligent routing system that detects token types and routes trades
 * to the appropriate trading engine (Jupiter for standard tokens, Pump.fun for pump tokens)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM_ID } from './PumpFunIntegration';

/**
 * Token type classification
 */
export enum TokenType {
  PUMP_FUN = 'PUMP_FUN',      // Token on pump.fun bonding curve
  JUPITER = 'JUPITER',        // Standard token (trade via Jupiter)
  SOL = 'SOL',                // Native SOL
  UNKNOWN = 'UNKNOWN'         // Unable to determine
}

/**
 * Token information result
 */
export interface TokenInfo {
  mintAddress: string;
  type: TokenType;
  name?: string;
  symbol?: string;
  decimals?: number;
  isValid: boolean;
  metadata?: {
    isPumpToken: boolean;
    bondingCurveAddress?: string;
    isGraduated?: boolean;
  };
}

/**
 * Trading route information
 */
export interface TradingRoute {
  tokenInfo: TokenInfo;
  engine: 'pumpfun' | 'jupiter';
  reason: string;
}

/**
 * Token Router Class
 * Main routing logic for determining how to trade different token types
 */
export class TokenRouter {
  private connection: Connection;
  private tokenCache: Map<string, TokenInfo>;
  private cacheExpiry: number = 5 * 60 * 1000; // 5 minutes

  constructor(connection: Connection) {
    this.connection = connection;
    this.tokenCache = new Map();
  }

  /**
   * Main routing function - determines how to trade a token
   */
  async route(tokenMintOrSymbol: string): Promise<TradingRoute> {
   // console.log(`\n [TokenRouter] Routing request for: ${tokenMintOrSymbol}`);

    // Check if it's SOL
    if (this.isSOL(tokenMintOrSymbol)) {
      const tokenInfo: TokenInfo = {
        mintAddress: 'So11111111111111111111111111111111111111112',
        type: TokenType.SOL,
        symbol: 'SOL',
        name: 'Solana',
        decimals: 9,
        isValid: true,
      };

      return {
        tokenInfo,
        engine: 'jupiter',
        reason: 'Native SOL - using Jupiter for swaps',
      };
    }

    // Try to parse as mint address
    let mintAddress: PublicKey;
    try {
      mintAddress = new PublicKey(tokenMintOrSymbol);
    } catch (error) {
      // If not a valid address, might be a symbol - need to resolve it
      return {
        tokenInfo: {
          mintAddress: tokenMintOrSymbol,
          type: TokenType.UNKNOWN,
          isValid: false,
        },
        engine: 'jupiter',
        reason: 'Invalid token address - defaulting to Jupiter',
      };
    }

    // Check cache first
    const cached = this.getFromCache(mintAddress.toString());
    if (cached) {
      return this.buildRoute(cached);
    }

    // Detect token type
    const tokenInfo = await this.detectTokenType(mintAddress);
    
    // Cache the result
    this.cacheTokenInfo(tokenInfo);

    // Build and return route
    return this.buildRoute(tokenInfo);
  }

  /**
   * Detect what type of token this is
   */
  private async detectTokenType(mintAddress: PublicKey): Promise<TokenInfo> {

    const tokenInfo: TokenInfo = {
      mintAddress: mintAddress.toString(),
      type: TokenType.UNKNOWN,
      isValid: false,
    };

    try {
      // Strategy 1: Check if token mint account exists first (fast check)
      const mintAccountInfo = await this.connection.getAccountInfo(mintAddress);
      
      if (!mintAccountInfo) {
        return tokenInfo;
      }
      //console.log(`Token mint account exists`);
      tokenInfo.isValid = true;

      // Strategy 2: Check if it's a pump.fun token via program derivation
      const isPumpToken = await this.isPumpFunToken(mintAddress);
      
      if (isPumpToken) {
        tokenInfo.type = TokenType.PUMP_FUN;
        tokenInfo.metadata = {
          isPumpToken: true,
        };

        // Try to get bonding curve info
        try {
          const bondingCurveAddress = await this.getBondingCurvePDA(mintAddress);
          tokenInfo.metadata.bondingCurveAddress = bondingCurveAddress.toString();
          
          // Check if graduated (bonding curve complete)
          const isGraduated = await this.isBondingCurveGraduated(bondingCurveAddress);
          tokenInfo.metadata.isGraduated = isGraduated;
          
          if (isGraduated) {
            tokenInfo.type = TokenType.JUPITER;
          }
        } catch (error) {
        }
        return tokenInfo;
      }

      // Strategy 3: It's a standard SPL token
      tokenInfo.type = TokenType.JUPITER;
      
      // Try to get token metadata
      try {
        const metadata = await this.getTokenMetadata(mintAddress);
        if (metadata) {
          tokenInfo.name = metadata.name;
          tokenInfo.symbol = metadata.symbol;
          tokenInfo.decimals = metadata.decimals;
        }
      } catch (error) {
      }
      return tokenInfo;
    } catch (error) {
      return tokenInfo;
    }
  }

  /**
   * Check if token is a pump.fun token by deriving bonding curve PDA
   */
  private async isPumpFunToken(mintAddress: PublicKey): Promise<boolean> {
    try {
      // Strategy 1: Check on-chain bonding curve PDA
      const bondingCurve = await this.getBondingCurvePDA(mintAddress);
      
      // Check if the bonding curve account exists
      const accountInfo = await this.connection.getAccountInfo(bondingCurve);
      
      // If account exists and is owned by pump.fun program, it's a pump token
      if (accountInfo && accountInfo.owner.equals(PUMP_FUN_PROGRAM_ID)) {
        return true;
      }

      // Strategy 2: Check pump.fun API as fallback
      try {
        const response = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress.toString()}`);
        
        if (response.ok) {
          const data = await response.json() as any;
          // If API returns data, it's a pump.fun token
          if (data && (data.mint || data.name || data.symbol)) {
            return true;
          }
        }
      } catch (apiError) {
    }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Derive bonding curve PDA for a token
   */
  private async getBondingCurvePDA(tokenMint: PublicKey): Promise<PublicKey> {
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );
    return bondingCurve;
  }

  /**
   * Check if bonding curve is complete (token graduated to Raydium)
   */
  private async isBondingCurveGraduated(bondingCurve: PublicKey): Promise<boolean> {
    try {
      const accountInfo = await this.connection.getAccountInfo(bondingCurve);
      
      if (!accountInfo) {
        return false;
      }

      // Parse bonding curve data to check 'complete' flag
      // Byte 48 in the account data indicates if curve is complete
      const data = accountInfo.data;
      if (data.length > 48) {
        const isComplete = data[48] === 1;
        return isComplete;
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get token metadata from on-chain
   */
  private async getTokenMetadata(mintAddress: PublicKey): Promise<{
    name?: string;
    symbol?: string;
    decimals?: number;
  } | null> {
    try {
      // Get mint account info to get decimals
      const mintInfo = await this.connection.getParsedAccountInfo(mintAddress);
      
      if (mintInfo.value && 'parsed' in mintInfo.value.data) {
        const decimals = mintInfo.value.data.parsed.info.decimals;
        
        // For now, return basic info
        // In production, you'd fetch from metadata program or external API
        return {
          decimals,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Build trading route from token info
   */
  private buildRoute(tokenInfo: TokenInfo): TradingRoute {
    let engine: 'pumpfun' | 'jupiter';
    let reason: string;

    switch (tokenInfo.type) {
      case TokenType.PUMP_FUN:
        if (tokenInfo.metadata?.isGraduated) {
          engine = 'jupiter';
          reason = 'Pump.fun token has graduated to Raydium - using Jupiter';
        } else {
          engine = 'pumpfun';
          reason = 'Active pump.fun bonding curve - using Pump.fun API';
        }
        break;

      case TokenType.JUPITER:
        engine = 'jupiter';
        reason = 'Standard SPL token - using Jupiter aggregator';
        break;

      case TokenType.SOL:
        engine = 'jupiter';
        reason = 'Native SOL - using Jupiter for swaps';
        break;

      case TokenType.UNKNOWN:
      default:
        engine = 'jupiter';
        reason = 'Unknown token type - defaulting to Jupiter (may fail if not liquid)';
        break;
    }

    return {
      tokenInfo,
      engine,
      reason,
    };
  }

  /**
   * Check if input is SOL
   */
  private isSOL(input: string): boolean {
    const normalized = input.toLowerCase().trim();
    return (
      normalized === 'sol' ||
      normalized === 'solana' ||
      input === 'So11111111111111111111111111111111111111112'
    );
  }

  /**
   * Cache token info
   */
  private cacheTokenInfo(tokenInfo: TokenInfo): void {
    this.tokenCache.set(tokenInfo.mintAddress, {
      ...tokenInfo,
      // Add timestamp for expiry (not in TokenInfo type, but useful internally)
    });

    // Clean old cache entries periodically
    if (this.tokenCache.size > 100) {
      this.cleanCache();
    }
  }

  /**
   * Get token info from cache
   */
  private getFromCache(mintAddress: string): TokenInfo | null {
    return this.tokenCache.get(mintAddress) || null;
  }

  /**
   * Clean expired cache entries
   */
  private cleanCache(): void {
    // Simple cleanup - remove oldest 50% of entries when cache is full
    const entries = Array.from(this.tokenCache.entries());
    const toKeep = entries.slice(-50);
    this.tokenCache.clear();
    toKeep.forEach(([key, value]) => this.tokenCache.set(key, value));
  }

  /**
   * Clear all cache
   */
  public clearCache(): void {
    this.tokenCache.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.tokenCache.size,
      keys: Array.from(this.tokenCache.keys()),
    };
  }

  /**
   * Validate a token address before trading
   */
  async validateToken(mintAddress: string): Promise<{
    valid: boolean;
    reason?: string;
    tokenInfo?: TokenInfo;
  }> {
    try {
      const pubkey = new PublicKey(mintAddress);
      const tokenInfo = await this.detectTokenType(pubkey);

      if (!tokenInfo.isValid) {
        return {
          valid: false,
          reason: 'Token not found or invalid',
          tokenInfo,
        };
      }

      // Additional validation for pump.fun tokens
      if (tokenInfo.type === TokenType.PUMP_FUN && tokenInfo.metadata?.isGraduated) {
        return {
          valid: true,
          reason: 'Token graduated - will trade on Raydium via Jupiter',
          tokenInfo,
        };
      }

      return {
        valid: true,
        tokenInfo,
      };
    } catch (error) {
      return {
        valid: false,
        reason: `Invalid token address: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

/**
 * Singleton instance for easy access
 */
let tokenRouterInstance: TokenRouter | null = null;

export function getTokenRouter(connection: Connection): TokenRouter {
  if (!tokenRouterInstance) {
    tokenRouterInstance = new TokenRouter(connection);
  }
  return tokenRouterInstance;
}

export function resetTokenRouter(): void {
  tokenRouterInstance = null;
}