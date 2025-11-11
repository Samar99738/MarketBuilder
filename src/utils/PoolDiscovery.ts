import { Connection, PublicKey } from '@solana/web3.js';

const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface PoolInfo {
  poolAddress: string;
  tokenMint: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
}

/**
 * Raydium API response types
 */
interface RaydiumPoolData {
  id: string;
  baseMint?: string;
  quoteMint?: string;
  baseDecimals?: number;
  quoteDecimals?: number;
}

interface RaydiumAPIResponse {
  data?: RaydiumPoolData[];
}

/**
 * Pool Discovery Utility
 * Finds Raydium liquidity pools for tokens
 */
export class PoolDiscovery {
  private connection: Connection;
  private cache: Map<string, PoolInfo> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Find Raydium pool for a token
   * Uses 3-layer fallback: API → On-chain → Cache
   */
  async findPoolForToken(tokenMint: string): Promise<PoolInfo | null> {
    // Check cache first
    const cached = this.getFromCache(tokenMint);
    if (cached) {
      console.log(`💾 [PoolDiscovery] Using cached pool for ${tokenMint.substring(0, 8)}...`);
      return cached;
    }

    console.log(`🔍 [PoolDiscovery] Searching for pool: ${tokenMint.substring(0, 8)}...`);

    // Method 1: Try Raydium API (fastest)
    try {
      const poolInfo = await this.findPoolViaAPI(tokenMint);
      if (poolInfo) {
        this.saveToCache(tokenMint, poolInfo);
        return poolInfo;
      }
    } catch (error) {
      console.warn(`⚠️ [PoolDiscovery] API search failed:`, error);
    }

    // Method 2: On-chain search (slower but reliable)
    try {
      const poolInfo = await this.findPoolOnChain(tokenMint);
      if (poolInfo) {
        this.saveToCache(tokenMint, poolInfo);
        return poolInfo;
      }
    } catch (error) {
      console.error(`❌ [PoolDiscovery] On-chain search failed:`, error);
    }

    console.log(`❌ [PoolDiscovery] No pool found for ${tokenMint}`);
    return null;
  }

  /**
   * Method 1: Find pool via Raydium API
   */
  private async findPoolViaAPI(tokenMint: string): Promise<PoolInfo | null> {
    const apiUrl = `https://api.raydium.io/v2/ammV3/ammPools?mintA=${tokenMint}&mintB=${NATIVE_SOL_MINT}`;
    
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json() as RaydiumAPIResponse;

    if (data.data && data.data.length > 0) {
      const pool = data.data[0];
      console.log(`✅ [PoolDiscovery] Found pool via API: ${pool.id}`);
      
      return {
        poolAddress: pool.id,
        tokenMint: tokenMint,
        baseMint: pool.baseMint || tokenMint,
        quoteMint: pool.quoteMint || NATIVE_SOL_MINT,
        baseDecimals: pool.baseDecimals || 6,
        quoteDecimals: pool.quoteDecimals || 9
      };
    }

    return null;
  }

  /**
   * Method 2: Find pool on-chain
   */
  private async findPoolOnChain(tokenMint: string): Promise<PoolInfo | null> {
    console.log(`🔗 [PoolDiscovery] Searching on-chain for ${tokenMint.substring(0, 8)}...`);

    const programId = new PublicKey(RAYDIUM_AMM_V4_PROGRAM_ID);
    
    // Search for pools where this token is the base mint
    const accounts = await this.connection.getProgramAccounts(programId, {
      filters: [
        { dataSize: 752 }, // Raydium AMM V4 pool state size
        {
          memcmp: {
            offset: 400, // baseMint offset in pool state
            bytes: tokenMint,
          },
        },
      ],
    });

    if (accounts.length > 0) {
      const poolAddress = accounts[0].pubkey.toString();
      console.log(`✅ [PoolDiscovery] Found pool on-chain: ${poolAddress.substring(0, 8)}...`);

      // Parse pool state to get full metadata
      // Simplified - in production, parse the full account data
      return {
        poolAddress,
        tokenMint,
        baseMint: tokenMint,
        quoteMint: NATIVE_SOL_MINT,
        baseDecimals: 6, // Default for most pump.fun tokens
        quoteDecimals: 9  // SOL decimals
      };
    }

    return null;
  }

  /**
   * Cache management
   */
  private getFromCache(tokenMint: string): PoolInfo | null {
    const expiry = this.cacheExpiry.get(tokenMint);
    if (expiry && Date.now() < expiry) {
      return this.cache.get(tokenMint) || null;
    }
    return null;
  }

  private saveToCache(tokenMint: string, poolInfo: PoolInfo): void {
    this.cache.set(tokenMint, poolInfo);
    this.cacheExpiry.set(tokenMint, Date.now() + this.CACHE_TTL);
  }

  /**
   * Clear expired cache entries
   */
  clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, expiry] of this.cacheExpiry.entries()) {
      if (now >= expiry) {
        this.cache.delete(key);
        this.cacheExpiry.delete(key);
      }
    }
  }
}