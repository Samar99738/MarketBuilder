/**
 * Token Validation Service
 * Validates and enriches token information for strategies
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { PumpFunAPI } from './PumpFunAPI';

export interface TokenInfo {
  address: string;
  symbol?: string;
  name?: string;
  decimals: number;
  supply: number;
  isPumpFun: boolean;
  isValid: boolean;
  bondingCurve?: string;
  createdAt?: number;
}

export class TokenValidationService {
  private connection: Connection;
  private pumpFunAPI: PumpFunAPI;
  private tokenCache: Map<string, TokenInfo & { cachedAt: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(connection: Connection) {
    this.connection = connection;
    this.pumpFunAPI = new PumpFunAPI(connection);
  }

  /**
   * Validate and get token information
   */
  async validateToken(tokenAddress: string): Promise<TokenInfo> {
    // Check cache first
    const cached = this.tokenCache.get(tokenAddress);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL) {
      return cached;
    }

    try {
      const tokenPubkey = new PublicKey(tokenAddress);
      
      // First, check if the account exists on-chain
      const accountInfo = await this.connection.getAccountInfo(tokenPubkey);
      if (!accountInfo) {
        console.error(`[TokenValidationService] Token account not found: ${tokenAddress}`);
        return {
          address: tokenAddress,
          decimals: 0,
          supply: 0,
          isPumpFun: false,
          isValid: false,
        };
      }

      console.log(`[TokenValidationService] Token account found, owner: ${accountInfo.owner.toString()}`);
      
      // Try to get mint info from standard SPL token first
      let mintInfo: any = null;
      let isPumpFun = false;
      let decimals = 6; // Default for most Solana tokens
      let supply = 0;
      
      try {
        mintInfo = await getMint(this.connection, tokenPubkey);
        decimals = mintInfo.decimals;
        supply = Number(mintInfo.supply) / Math.pow(10, decimals);
        console.log(`[TokenValidationService] Standard SPL token detected: ${tokenAddress}`);
      } catch (error) {
        // Not a standard SPL token - might be Pump.fun token
        console.log(`[TokenValidationService] Not a standard SPL token, checking if Pump.fun: ${tokenAddress}`);
        
        // Check if it's owned by Pump.fun program
        const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
        if (accountInfo.owner.toString() === PUMP_FUN_PROGRAM) {
          isPumpFun = true;
          console.log(`[TokenValidationService] ✅ Pump.fun token detected: ${tokenAddress}`);
          
          // Try to get info from Pump.fun API
          try {
            const pumpData = await this.pumpFunAPI.getTokenMetadata(tokenAddress);
            if (pumpData) {
              decimals = 6; // Pump.fun tokens typically use 6 decimals
              supply = pumpData.supply || 0;
            }
          } catch (apiError) {
            console.log(`[TokenValidationService] Could not fetch Pump.fun data, using defaults`);
            decimals = 6;
            supply = 0;
          }
        } else {
          // Account exists but is neither SPL token nor Pump.fun token
          // Still mark as valid to allow trading (let the actual trading logic handle validation)
          console.log(`[TokenValidationService] ⚠️ Unknown token type (owner: ${accountInfo.owner.toString()}), marking as valid for trading`);
          isPumpFun = false;
          decimals = 6; // Assume default decimals
          supply = 0;
        }
      }
      
      const tokenInfo: TokenInfo = {
        address: tokenAddress,
        decimals,
        supply,
        isPumpFun,
        isValid: true, // Account exists, so mark as valid
      };
      
      // Cache with timestamp
      this.tokenCache.set(tokenAddress, { ...tokenInfo, cachedAt: Date.now() });
      
      return tokenInfo;
      
    } catch (error) {
      console.error(`[TokenValidationService] Token validation error for ${tokenAddress}:`, error);
      return {
        address: tokenAddress,
        decimals: 0,
        supply: 0,
        isPumpFun: false,
        isValid: false,
      };
    }
  }

  /**
   * Batch validate multiple tokens
   */
  async validateTokens(tokenAddresses: string[]): Promise<Map<string, TokenInfo>> {
    const results = new Map<string, TokenInfo>();
    
    await Promise.all(
      tokenAddresses.map(async (address) => {
        const info = await this.validateToken(address);
        results.set(address, info);
      })
    );
    
    return results;
  }

  /**
   * Check if token is tradeable
   */
  async isTokenTradeable(tokenAddress: string): Promise<boolean> {
    const info = await this.validateToken(tokenAddress);
    return info.isValid && info.supply > 0;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.tokenCache.clear();
  }
}
