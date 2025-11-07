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
      
      // Get mint info
      const mintInfo = await getMint(this.connection, tokenPubkey);
      
      // Check if it's a pump.fun token
      let isPumpFun = false;
      let pumpFunData: any = null;
      try {
        // Check if token has pump.fun program ID or bonding curve
        // For now, we'll mark tokens as potentially pump.fun compatible
        // This can be enhanced with actual pump.fun API integration
        isPumpFun = false; // Will be set based on actual detection
      } catch (error) {
        // Not a pump.fun token
      }
      
      const tokenInfo: TokenInfo = {
        address: tokenAddress,
        symbol: pumpFunData?.symbol,
        name: pumpFunData?.name,
        decimals: mintInfo.decimals,
        supply: Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals),
        isPumpFun,
        isValid: true,
        bondingCurve: pumpFunData?.bondingCurve,
        createdAt: pumpFunData?.createdTimestamp,
      };
      
      // Cache with timestamp
      this.tokenCache.set(tokenAddress, { ...tokenInfo, cachedAt: Date.now() });
      
      return tokenInfo;
      
    } catch (error) {
      console.error(`[TokenValidationService] Invalid token ${tokenAddress}:`, error);
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
