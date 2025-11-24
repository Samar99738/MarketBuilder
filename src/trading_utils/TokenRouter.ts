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
    raydiumPoolAddress?: string;
    poolType?: 'amm-v4' | 'clmm';
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

    // CRITICAL FIX: Try to find original case-sensitive address in cache first
    // The address might have been passed as lowercase from event matching
    // but we need the original case for Base58 validation
    const cachedByLowercase = this.findInCacheByLowercase(tokenMintOrSymbol);
    if (cachedByLowercase) {
      console.log(`[TokenRouter] Found cached token (case-insensitive match)`);
      return this.buildRoute(cachedByLowercase);
    }

    // Try to parse as mint address
    let mintAddress: PublicKey;
    try {
      mintAddress = new PublicKey(tokenMintOrSymbol);
    } catch (error) {
      // If not a valid address, might be a symbol - need to resolve it
      console.log(`[TokenRouter] Invalid Base58 address: ${tokenMintOrSymbol}`);
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
    console.log(`\n🔍 [TokenRouter] Detecting token type for: ${mintAddress.toString().substring(0, 12)}...`);

    const tokenInfo: TokenInfo = {
      mintAddress: mintAddress.toString(),
      type: TokenType.UNKNOWN,
      isValid: false,
    };

    try {
      // Strategy 1: Check if token mint account exists first (fast check)
      const mintAccountInfo = await this.connection.getAccountInfo(mintAddress);
      
      if (!mintAccountInfo) {
        console.log(`❌ [TokenRouter] Mint account doesn't exist`);
        return tokenInfo;
      }
      console.log(`✅ [TokenRouter] Mint account exists`);
      tokenInfo.isValid = true;

      // PRODUCTION FIX: Strategy 2 - Check if it's a pump.fun token with comprehensive graduation detection
      const pumpTokenData = await this.isPumpFunToken(mintAddress);
      console.log(`🔍 [TokenRouter] isPumpToken check result:`, pumpTokenData);
      
      if (pumpTokenData.isPumpToken) {
        // Initialize as pump token
        tokenInfo.type = TokenType.PUMP_FUN;
        tokenInfo.metadata = {
          isPumpToken: true,
          isGraduated: pumpTokenData.isGraduated || false,
        };

        // Try to get bonding curve info
        try {
          const bondingCurveAddress = await this.getBondingCurvePDA(mintAddress);
          tokenInfo.metadata.bondingCurveAddress = bondingCurveAddress.toString();
          console.log(`🔍 [TokenRouter] Bonding curve address: ${bondingCurveAddress.toString().substring(0, 12)}...`);
          
          // FIX #9: Enhanced graduated token detection with multiple validation layers
          let isGraduated = pumpTokenData.isGraduated || false;
          
          // Layer 1: Check API graduation status
          if (pumpTokenData.fromAPI) {
            console.log(`✅ [TokenRouter] API graduation status: ${isGraduated}`);
          }
          
          // Layer 2: Always double-check with on-chain data for accuracy
          try {
            const onChainGraduated = await this.isBondingCurveGraduated(bondingCurveAddress);
            console.log(`🔗 [TokenRouter] On-chain graduation check: ${onChainGraduated}`);
            
            // If on-chain says graduated but API says not, trust on-chain (source of truth)
            if (onChainGraduated && !isGraduated) {
              console.warn(`⚠️ [TokenRouter] Graduation mismatch! API:${isGraduated} vs On-chain:${onChainGraduated} - Using on-chain`);
              isGraduated = onChainGraduated;
            } else if (!pumpTokenData.fromAPI) {
              // If no API data, use on-chain as primary
              isGraduated = onChainGraduated;
            }
          } catch (error) {
            console.error(`❌ [TokenRouter] Error checking on-chain graduation:`, error);
            // If can't verify, assume graduated to be safe (use Jupiter which supports both)
            if (!pumpTokenData.fromAPI) {
              console.warn(`⚠️ [TokenRouter] Can't verify graduation - defaulting to JUPITER (safer)`);
              isGraduated = true;
            }
          }
          
          tokenInfo.metadata.isGraduated = isGraduated;
          console.log(`🔍 [TokenRouter] isGraduated (final): ${isGraduated}`);
          
          // CRITICAL: Graduated tokens MUST use Jupiter/Raydium
          if (isGraduated) {
            console.log(`🎓 [TokenRouter] Token GRADUATED → Setting type to JUPITER`);
            console.log(`   ⚠️  IMPORTANT: Graduated tokens only trade on Raydium, NOT Pump.fun!`);
            console.log(`   🎯 This strategy will use Raydium WebSocket monitoring`);
            tokenInfo.type = TokenType.JUPITER;
          } else {
            console.log(`🚀 [TokenRouter] Token still on bonding curve → Keeping type as PUMP_FUN`);
            console.log(`   🎯 This strategy will use Pump.fun WebSocket monitoring`);
          }
        } catch (error) {
          console.error(`⚠️ [TokenRouter] Error checking graduation status:`, error);
          // If we can't check graduation, default to Jupiter to be safe
          console.warn(`⚠️ [TokenRouter] Defaulting to JUPITER due to graduation check failure`);
          tokenInfo.type = TokenType.JUPITER;
        }
        
        console.log(`✅ [TokenRouter] Final token type: ${tokenInfo.type}`);
        console.log(`📊 [TokenRouter] Metadata:`, JSON.stringify(tokenInfo.metadata, null, 2));
        return tokenInfo;
      }

      // Strategy 3: It's a standard SPL token
      console.log(`📝 [TokenRouter] Not a Pump.fun token → Setting type to JUPITER`);
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
   * PRODUCTION FIX: Returns structured data including graduation status
   */
  private async isPumpFunToken(mintAddress: PublicKey): Promise<{
    isPumpToken: boolean;
    isGraduated?: boolean;
    fromAPI: boolean;
  }> {
    try {
      console.log(`🔍 [TokenRouter] Checking if Pump.fun token...`);
      
      // PRODUCTION FIX: Strategy 1 - Check pump.fun API FIRST (most reliable for graduation status)
      try {
        console.log(`🌐 [TokenRouter] Trying Pump.fun API...`);
        const response = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress.toString()}`, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          },
          signal: AbortSignal.timeout(8000) // 8 second timeout
        });
        
        if (response.ok) {
          const data = await response.json() as any;
          // If API returns data, it's a pump.fun token
          if (data && (data.mint || data.name || data.symbol)) {
            // CRITICAL: Check 'complete' field to determine graduation
            const isGraduated = data.complete === true || data.raydium_pool !== undefined;
            
            console.log(`✅ [TokenRouter] Found in Pump.fun API:`, {
              name: data.name,
              symbol: data.symbol,
              complete: data.complete,
              isGraduated: isGraduated,
              hasRaydiumPool: !!data.raydium_pool
            });
            
            return {
              isPumpToken: true,
              isGraduated: isGraduated,
              fromAPI: true
            };
          }
        } else {
          console.log(`⚠️ [TokenRouter] Pump.fun API returned ${response.status}`);
        }
      } catch (apiError) {
        console.log(`⚠️ [TokenRouter] Pump.fun API error:`, apiError instanceof Error ? apiError.message : 'Unknown');
      }

      // PRODUCTION FIX: Strategy 2 - Check on-chain bonding curve PDA as fallback
      console.log(`🔗 [TokenRouter] Checking on-chain bonding curve...`);
      const bondingCurve = await this.getBondingCurvePDA(mintAddress);
      console.log(`🔍 [TokenRouter] Derived bonding curve PDA: ${bondingCurve.toString().substring(0, 12)}...`);
      
      // Check if the bonding curve account exists
      const accountInfo = await this.connection.getAccountInfo(bondingCurve);
      
      if (!accountInfo) {
        console.log(`❌ [TokenRouter] Bonding curve account doesn't exist`);
        return { isPumpToken: false, fromAPI: false };
      }
      
      console.log(`📊 [TokenRouter] Bonding curve account exists, owner: ${accountInfo.owner.toString().substring(0, 12)}...`);
      console.log(`📊 [TokenRouter] Expected owner (Pump.fun): ${PUMP_FUN_PROGRAM_ID.toString().substring(0, 12)}...`);
      
      // If account exists and is owned by pump.fun program, it's a pump token
      if (accountInfo.owner.equals(PUMP_FUN_PROGRAM_ID)) {
        console.log(`✅ [TokenRouter] Confirmed: Bonding curve owned by Pump.fun program`);
        
        // Check graduation status from on-chain data
        const isGraduated = await this.isBondingCurveGraduated(bondingCurve);
        
        return {
          isPumpToken: true,
          isGraduated: isGraduated,
          fromAPI: false
        };
      } else {
        console.log(`❌ [TokenRouter] Bonding curve NOT owned by Pump.fun program`);
      }

      return { isPumpToken: false, fromAPI: false };
    } catch (error) {
      console.error(`❌ [TokenRouter] Error in isPumpFunToken:`, error);
      return { isPumpToken: false, fromAPI: false };
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
   * Find token in cache by lowercase comparison
   * CRITICAL: Handles case where event matching uses lowercase but cache has original case
   */
  private findInCacheByLowercase(address: string): TokenInfo | null {
    const lowerAddress = address.toLowerCase();
    for (const [cachedAddress, tokenInfo] of this.tokenCache.entries()) {
      if (cachedAddress.toLowerCase() === lowerAddress) {
        return tokenInfo;
      }
    }
    return null;
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