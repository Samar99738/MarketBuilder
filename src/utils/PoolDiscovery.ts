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
    console.log(`[PoolDiscovery] Trying Raydium API...`);
    try {
      const poolInfo = await this.findPoolViaAPI(tokenMint);
      if (poolInfo) {
        console.log(`✅ [PoolDiscovery] Found pool via Raydium API: ${poolInfo.poolAddress}`);
        this.saveToCache(tokenMint, poolInfo);
        return poolInfo;
      }
      console.log(`[PoolDiscovery] No pool found via Raydium API`);
    } catch (error) {
      console.warn(`⚠️ [PoolDiscovery] Raydium API search failed:`, error instanceof Error ? error.message : error);
    }

    // Method 2: Try DexScreener API (most reliable)
    console.log(`[PoolDiscovery] Trying DexScreener API...`);
    try {
      const poolInfo = await this.findPoolViaDexScreener(tokenMint);
      if (poolInfo) {
        console.log(`✅ [PoolDiscovery] Found pool via DexScreener: ${poolInfo.poolAddress}`);
        this.saveToCache(tokenMint, poolInfo);
        return poolInfo;
      }
      console.log(`[PoolDiscovery] No pool found via DexScreener`);
    } catch (error) {
      console.warn(`⚠️ [PoolDiscovery] DexScreener search failed:`, error instanceof Error ? error.message : error);
    }

    // Method 3: On-chain search (requires special RPC - only as last resort)
    console.log(`[PoolDiscovery] Trying on-chain search...`);
    try {
      const poolInfo = await this.findPoolOnChain(tokenMint);
      if (poolInfo) {
        console.log(`✅ [PoolDiscovery] Found pool on-chain: ${poolInfo.poolAddress}`);
        this.saveToCache(tokenMint, poolInfo);
        return poolInfo;
      }
      console.log(`[PoolDiscovery] No pool found on-chain`);
    } catch (error) {
      console.warn(`⚠️ [PoolDiscovery] On-chain search failed:`, error instanceof Error ? error.message : error);
    }

    console.error(`❌ [PoolDiscovery] FAILED: No Raydium pool found for token ${tokenMint}`);
    console.error(`   This could mean:`);
    console.error(`   1. Token hasn't graduated to Raydium yet (still on bonding curve)`);
    console.error(`   2. Network/firewall blocking API calls`);
    console.error(`   3. Token has no liquidity pool on Raydium`);
    return null;
  }

  /**
   * Method 1: Find pool via Raydium API (with multiple endpoints)
   */
  private async findPoolViaAPI(tokenMint: string): Promise<PoolInfo | null> {
    // Try Raydium API with SDK v2 endpoint
    try {
      const apiUrl = `https://api.raydium.io/v2/main/pairs`;
      
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;

      if (!data || !Array.isArray(data)) {
        return null;
      }

      // Find pools for our token
      const matchingPools = data.filter((pool: any) => {
        const baseMint = pool.baseMint || pool.mintA;
        const quoteMint = pool.quoteMint || pool.mintB;
        
        // Check if token is in the pair and paired with SOL
        return (
          (baseMint === tokenMint && quoteMint === NATIVE_SOL_MINT) ||
          (quoteMint === tokenMint && baseMint === NATIVE_SOL_MINT)
        );
      });

      if (matchingPools.length > 0) {
        // Get the pool with highest liquidity
        const pool = matchingPools.sort((a: any, b: any) => 
          (b.liquidity || 0) - (a.liquidity || 0)
        )[0];

        console.log(`✅ [PoolDiscovery] Found pool via Raydium API: ${pool.ammId || pool.id}`);
        
        return {
          poolAddress: pool.ammId || pool.id,
          tokenMint: tokenMint,
          baseMint: pool.baseMint || pool.mintA || tokenMint,
          quoteMint: pool.quoteMint || pool.mintB || NATIVE_SOL_MINT,
          baseDecimals: pool.baseDecimals || 6,
          quoteDecimals: pool.quoteDecimals || 9
        };
      }
    } catch (error) {
      // Silent fail, will try DexScreener
    }

    return null;
  }

  /**
   * Method 2: Find pool via DexScreener API (most reliable)
   */
  private async findPoolViaDexScreener(tokenMint: string): Promise<PoolInfo | null> {
    try {
      const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
      
      // Retry logic for network issues
      let retries = 3;
      let data: any = null;

      while (retries > 0) {
        try {
          const response = await fetch(apiUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(10000) // 10 second timeout
          });

          if (!response.ok) {
            retries--;
            if (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
              continue;
            }
            return null;
          }

          data = await response.json();
          break; // Success
        } catch (err) {
          retries--;
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
            continue;
          }
          throw err;
        }
      }

      if (!data || !data.pairs || !Array.isArray(data.pairs) || data.pairs.length === 0) {
        return null;
      }

      // Find Raydium pools (filter out other DEXs)
      const raydiumPools = data.pairs.filter((pair: any) => 
        pair.dexId === 'raydium' && 
        (pair.quoteToken?.address === NATIVE_SOL_MINT || pair.baseToken?.address === NATIVE_SOL_MINT)
      );

      if (raydiumPools.length > 0) {
        // Get pool with highest liquidity
        const pool = raydiumPools.sort((a: any, b: any) => 
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];

        console.log(`✅ [PoolDiscovery] Found pool via DexScreener: ${pool.pairAddress}`);
        
        return {
          poolAddress: pool.pairAddress,
          tokenMint: tokenMint,
          baseMint: pool.baseToken.address === tokenMint ? pool.baseToken.address : pool.quoteToken.address,
          quoteMint: pool.baseToken.address === NATIVE_SOL_MINT ? pool.baseToken.address : pool.quoteToken.address,
          baseDecimals: 6,
          quoteDecimals: 9
        };
      }

      return null;
    } catch (error) {
      // Silent fail, will try on-chain
      return null;
    }
  }

  /**
   * Method 3: Find pool on-chain (requires special RPC endpoint)
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