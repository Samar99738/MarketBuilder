/**
 * Market Data Provider
 * 
 * Fetches real-time cryptocurrency market data from public APIs
 * without relying on LLM. Supports multiple data sources with fallback.
 */

import { MarketData } from './types';
import { awsLogger } from '../../aws/logger';
import { Connection, PublicKey } from '@solana/web3.js';
import { TRADING_CONFIG } from '../config';

export interface MarketDataSource {
  name: string;
  priority: number;
  fetchPrice(tokenAddress: string): Promise<MarketData | null>;
  fetchSolPrice(): Promise<number | null>;
}

/**
 * ON-CHAIN RPC Data Source
 * Fetches prices directly from Solana blockchain using your QuikNode RPC
 * NO EXTERNAL APIs NEEDED - Uses liquidity pool data on-chain
 */
class OnChainRPCDataSource implements MarketDataSource {
  name = 'OnChainRPC';
  priority = 0; // Highest priority - use your own RPC first!
  private connection: Connection;
  private cache = new Map<string, { data: MarketData; expires: number }>();
  private cacheDuration = 30000; // 30 seconds

  // Known Raydium liquidity pool program ID
  private readonly RAYDIUM_AMM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
  
  constructor() {
    this.connection = new Connection(TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com', 'confirmed');
  }

  async fetchPrice(tokenAddress: string): Promise<MarketData | null> {
    try {
      // Check cache first
      const cached = this.cache.get(tokenAddress);
      if (cached && cached.expires > Date.now()) {
        console.log(`💾 [OnChainRPC] Using cached price for ${tokenAddress}`);
        return cached.data;
      }

      // OPTIMIZATION: Skip OnChainRPC for Pump.fun tokens (they rarely have Raydium pools)
      // Pump.fun tokens end with "pump" - let PumpToken API handle them directly
      if (tokenAddress.toLowerCase().endsWith('pump')) {
        console.log(`⏭️ [OnChainRPC] Skipping for Pump.fun token, will use PumpToken API`);
        return null;
      }

      // Add 2-second timeout - if RPC is slow, fallback to other sources quickly
      const fetchPromise = this.fetchPriceFromChain(tokenAddress);
      const timeoutPromise = new Promise<null>((resolve) => 
        setTimeout(() => {
          console.log(`⏱️ [OnChainRPC] Timeout after 2s, falling back to other sources`);
          resolve(null);
        }, 2000)
      );
      
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
      console.error(`❌ [OnChainRPC] Error fetching on-chain price:`, error);
      return null;
    }
  }

  private async fetchPriceFromChain(tokenAddress: string): Promise<MarketData | null> {
    try {
      const tokenPubkey = new PublicKey(tokenAddress);
      const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
      
      // Try to find liquidity pool for this token paired with SOL
      // Most Pump.fun tokens create Raydium pools
      const accounts = await this.connection.getProgramAccounts(
        this.RAYDIUM_AMM_PROGRAM_ID,
        {
          filters: [
            { dataSize: 752 }, // Raydium AMM state size
          ],
        }
      );

      // Find pool that contains our token
      for (const account of accounts) {
        try {
          const data = account.account.data;
          
          // Parse Raydium AMM state (simplified - basic structure)
          // Offset 400: base mint (32 bytes)
          // Offset 432: quote mint (32 bytes)
          const baseMint = new PublicKey(data.slice(400, 432));
          const quoteMint = new PublicKey(data.slice(432, 464));
          
          // Check if this pool matches our token + SOL
          if ((baseMint.equals(tokenPubkey) && quoteMint.equals(SOL_MINT)) ||
              (baseMint.equals(SOL_MINT) && quoteMint.equals(tokenPubkey))) {
            
            // Found the pool! Now get reserves
            // Offset 64: base reserve (u64 - 8 bytes)
            // Offset 72: quote reserve (u64 - 8 bytes)
            const baseReserve = data.readBigUInt64LE(64);
            const quoteReserve = data.readBigUInt64LE(72);
            
            let priceInSOL: number;
            if (baseMint.equals(tokenPubkey)) {
              // Token is base, SOL is quote
              priceInSOL = Number(quoteReserve) / Number(baseReserve);
            } else {
              // SOL is base, token is quote
              priceInSOL = Number(baseReserve) / Number(quoteReserve);
            }
            
            // Get SOL price in USD
            const solPriceUSD = await this.fetchSolPrice() || 200;
            const priceUSD = priceInSOL * solPriceUSD;
            
            const marketData: MarketData = {
              price: priceInSOL,
              priceUSD: priceUSD,
              solPrice: solPriceUSD,
              tokenAddress: tokenAddress,
              tokenSymbol: 'TOKEN',
              source: 'OnChainRPC',
              timestamp: Date.now(),
              volume24h: 0, // Not available from on-chain data
              priceChange24h: 0,
            };
            
            // Cache the result
            this.cache.set(tokenAddress, {
              data: marketData,
              expires: Date.now() + this.cacheDuration,
            });
            
            console.log(`✅ [OnChainRPC] Fetched on-chain price: ${priceInSOL.toFixed(10)} SOL ($${priceUSD.toFixed(6)} USD)`);
            return marketData;
          }
        } catch (err) {
          // Skip this account if parsing fails
          continue;
        }
      }
      
      console.log(`⚠️ [OnChainRPC] No liquidity pool found for ${tokenAddress}`);
      return null;
    } catch (error) {
      console.error(`❌ [OnChainRPC] Error in fetchPriceFromChain:`, error);
      return null;
    }
  }

  async fetchSolPrice(): Promise<number | null> {
    try {
      // For SOL price, we still need an external source (or hardcode as fallback)
      // But you can also fetch from USDC/SOL pool on-chain
      return 200; // Fallback - will be overridden by other sources
    } catch (error) {
      return 200;
    }
  }
}

/**
 * CoinGecko API Data Source
 */
class CoinGeckoDataSource implements MarketDataSource {
  name = 'CoinGecko';
  priority = 1;
  private baseUrl = 'https://api.coingecko.com/api/v3';
  private cache = new Map<string, { data: MarketData; expires: number }>();
  private cacheDuration = 30000; // 30 seconds
  private rateLimiter = new Map<string, number>(); //  Rate limiter
  private readonly MIN_REQUEST_INTERVAL = 1000; // 1 second between requests

  // Exponential backoff for rate limit errors
  // FIX #9: Reduced backoff delays from 1s/2s/4s to 500ms/1s/2s for faster session creation
  private async fetchWithBackoff(url: string, retryCount = 0): Promise<Response> {
    try {
      const response = await fetch(url);
      
      if (response.status === 429 && retryCount < 3) {
        const backoffMs = Math.pow(2, retryCount) * 500; // 500ms, 1s, 2s
        console.log(`⏳ [CoinGecko] Rate limited, backing off for ${backoffMs}ms (retry ${retryCount + 1}/3)`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.fetchWithBackoff(url, retryCount + 1);
      }
      
      return response;
    } catch (error) {
      if (retryCount < 3) {
        const backoffMs = Math.pow(2, retryCount) * 500;
        console.log(`⏳ [CoinGecko] Network error, backing off for ${backoffMs}ms (retry ${retryCount + 1}/3)`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.fetchWithBackoff(url, retryCount + 1);
      }
      throw error;
    }
  }

  async fetchPrice(tokenAddress: string): Promise<MarketData | null> {
    try {
      // Check cache first (5s TTL)
      const cached = this.cache.get(tokenAddress);
      if (cached && cached.expires > Date.now()) {
        console.log(`💾 [CoinGecko] Using cached price for ${tokenAddress}`);
        return cached.data;
      }

      // Rate limit requests
      const lastRequest = this.rateLimiter.get(tokenAddress) || 0;
      const timeSinceLastRequest = Date.now() - lastRequest;
      
      if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
        const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
        console.log(`⏱️ [CoinGecko] Rate limiting: waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // Update rate limiter
      this.rateLimiter.set(tokenAddress, Date.now());

      const response = await this.fetchWithBackoff(
        `${this.baseUrl}/simple/token_price/solana?contract_addresses=${tokenAddress}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`
      );

      if (!response.ok) {
        const errorMessage = `CoinGecko API error: ${response.status}`; 
        if (response.status === 429) { 
          console.warn(errorMessage); 
        } else { 
          throw new Error(errorMessage);
        } 
      }

      const data: any = await response.json();
      const tokenData = data[tokenAddress.toLowerCase()];

      if (!tokenData) {
        return null;
      }

      const solPrice = await this.fetchSolPrice();
      if (!solPrice || solPrice === 0) { 
        console.warn(`CoinGecko: Could not fetch SOL price or SOL price is zero. Falling back.`); 
        return null; 
      } 

      const marketData: MarketData = {
        tokenAddress,
        price: tokenData.usd / solPrice,
        priceUSD: tokenData.usd,
        solPrice,
        timestamp: Date.now(),
        source: 'CoinGecko',
        volume24h: tokenData.usd_24h_vol,
        priceChange24h: tokenData.usd_24h_change,
      };

      // Cache the result
      this.cache.set(tokenAddress, {
        data: marketData,
        expires: Date.now() + this.cacheDuration,
      });

      return marketData;
    } catch (error) {
      console.error(`CoinGecko fetch error:`, error);
      return null;
    }
  }

  async fetchSolPrice(): Promise<number | null> {
    try {
      // Rate limit SOL price requests
      const cacheKey = 'SOL_PRICE';
      const lastRequest = this.rateLimiter.get(cacheKey) || 0;
      const timeSinceLastRequest = Date.now() - lastRequest;
      
      if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
        const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      this.rateLimiter.set(cacheKey, Date.now());

      const response = await this.fetchWithBackoff(
        `${this.baseUrl}/simple/price?ids=solana&vs_currencies=usd`
      );

      if (!response.ok) {
        const errorMessage = `CoinGecko SOL price error: ${response.status}`; 
        if (response.status === 429) { 
          console.warn(errorMessage); 
        } else { 
          throw new Error(errorMessage);
        } 
      }

      const data: any = await response.json();
      return data.solana?.usd || null;
    } catch (error) {
      console.error(`CoinGecko SOL price fetch error:`, error);
      return null;
    }
  }
}

/**
 * DexScreener API Data Source
 */
class DexScreenerDataSource implements MarketDataSource {
  name = 'DexScreener';
  priority = 2;
  private baseUrl = 'https://api.dexscreener.com/latest/dex';
  private cache = new Map<string, { data: MarketData; expires: number }>();
  private cacheDuration = 30000; // 30 seconds

  async fetchPrice(tokenAddress: string): Promise<MarketData | null> {
    try {
      // Check cache
      const cached = this.cache.get(tokenAddress);
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }

      const response = await fetch(
        `${this.baseUrl}/tokens/${tokenAddress}`
      );

      if (!response.ok) {
        throw new Error(`DexScreener API error: ${response.status}`);
      }

      const data: any = await response.json();
      
      if (!data.pairs || data.pairs.length === 0) {
        return null;
      }

      // Get the most liquid pair
      const pair = data.pairs.sort((a: any, b: any) => 
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];

      const solPrice = await this.fetchSolPrice() || 0;
      const tokenPriceUSD = parseFloat(pair.priceUsd);

      const marketData: MarketData = {
        tokenAddress,
        tokenSymbol: pair.baseToken?.symbol,
        price: tokenPriceUSD / solPrice,
        priceUSD: tokenPriceUSD,
        solPrice,
        timestamp: Date.now(),
        source: 'DexScreener',
        liquidity: pair.liquidity?.usd,
        volume24h: pair.volume?.h24,
        priceChange24h: pair.priceChange?.h24,
      };

      // Cache the result
      this.cache.set(tokenAddress, {
        data: marketData,
        expires: Date.now() + this.cacheDuration,
      });

      return marketData;
    } catch (error) {
      console.error(`DexScreener fetch error:`, error);
      return null;
    }
  }

  async fetchSolPrice(): Promise<number | null> {
    try {
      const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
      const response = await fetch(
        `${this.baseUrl}/tokens/${SOL_ADDRESS}`
      );

      if (!response.ok) {
        throw new Error(`DexScreener SOL price error: ${response.status}`);
      }

      const data: any = await response.json();
      
      if (!data.pairs || data.pairs.length === 0) {
        return null;
      }

      const pair = data.pairs.sort((a: any, b: any) => 
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];

      return parseFloat(pair.priceUsd);
    } catch (error) {
      console.error(`DexScreener SOL price fetch error:`, error);
      return null;
    }
  }
}

/**
 * Jupiter API Data Source
 */
class JupiterDataSource implements MarketDataSource {
  name = 'Jupiter';
  priority = 3;
  private baseUrl = 'https://price.jup.ag/v4';
  private cache = new Map<string, { data: MarketData; expires: number }>();
  private cacheDuration = 30000; // 30 seconds

  async fetchPrice(tokenAddress: string): Promise<MarketData | null> {
    try {
      // Check cache
      const cached = this.cache.get(tokenAddress);
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }

      const response = await fetch(
        `${this.baseUrl}/price?ids=${tokenAddress}`
      );

      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status}`);
      }

      const data: any = await response.json();
      const tokenData = data.data?.[tokenAddress];

      if (!tokenData) {
        return null;
      }

      const solPrice = await this.fetchSolPrice() || 0;
      const tokenPriceUSD = tokenData.price;

      const marketData: MarketData = {
        tokenAddress,
        tokenSymbol: tokenData.symbol || this.extractSymbolFromAddress(tokenAddress),
        price: tokenPriceUSD / solPrice,
        priceUSD: tokenPriceUSD,
        solPrice,
        timestamp: Date.now(),
        source: 'Jupiter',
      };

      // Cache the result
      this.cache.set(tokenAddress, {
        data: marketData,
        expires: Date.now() + this.cacheDuration,
      });

      return marketData;
    } catch (error) {
      console.error(`Jupiter fetch error:`, error);
      return null;
    }
  }

  async fetchSolPrice(): Promise<number | null> {
    try {
      const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
      const response = await fetch(
        `${this.baseUrl}/price?ids=${SOL_ADDRESS}`
      );

      if (!response.ok) {
        throw new Error(`Jupiter SOL price error: ${response.status}`);
      }

      const data: any = await response.json();
      return data.data?.[SOL_ADDRESS]?.price || null;
    } catch (error) {
      console.error(`Jupiter SOL price fetch error:`, error);
      return null;
    }
  }

  private extractSymbolFromAddress(address: string): string {
    // For pump tokens and unknown tokens, try to extract symbol from metadata or use address prefix
    if (address.length >= 8) {
      return address.substring(0, 8).toUpperCase();
    }
    return 'UNKNOWN';
  }
}

/**
 * Pump Token Data Source (for pump.fun tokens)
 */
class PumpTokenDataSource implements MarketDataSource {
  name = 'PumpToken';
  priority = 1; // Higher priority for pump tokens (changed from 4 to 1)
  private baseUrl = 'https://frontend-api.pump.fun';
  private cache = new Map<string, { data: MarketData; expires: number }>();
  private cacheDuration = 15000; // 15 seconds (pump tokens are more volatile)

  async fetchPrice(tokenAddress: string): Promise<MarketData | null> {
    try {
      // Check cache
      const cached = this.cache.get(tokenAddress);
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }

      // Add 3-second timeout for Pump.fun API
      const fetchPromise = this.fetchFromPumpAPI(tokenAddress);
      const timeoutPromise = new Promise<null>((resolve) => 
        setTimeout(() => {
          console.log(`⏱️ [PumpToken] Pump.fun API timeout after 3s, trying alternatives`);
          resolve(null);
        }, 3000)
      );
      
      const result = await Promise.race([fetchPromise, timeoutPromise]);
      
      if (result) {
        return result;
      }
      
      // If timeout or failure, try alternatives
      return await this.fetchFromAlternativePumpSources(tokenAddress);
    } catch (error) {
      console.error(`PumpToken fetch error:`, error);
      return await this.fetchFromAlternativePumpSources(tokenAddress);
    }
  }

  private async fetchFromPumpAPI(tokenAddress: string): Promise<MarketData | null> {
    try {
      // Try to get token info from pump.fun API
      const response = await fetch(
        `${this.baseUrl}/coins/${tokenAddress}`,
        { signal: AbortSignal.timeout(2500) } // 2.5s timeout
      );

      if (!response.ok) {
        console.log(`⚠️ [PumpToken] Pump.fun API returned ${response.status}`);
        return null;
      }

      const data: any = await response.json();

      if (!data || !data.usd_market_cap) {
        console.log(`⚠️ [PumpToken] Invalid response from Pump.fun API`);
        return null;
      }

      const solPrice = await this.fetchSolPrice() || 200;
      const tokenPriceUSD = data.price || 0;

      const marketData: MarketData = {
        tokenAddress,
        tokenSymbol: data.symbol || this.extractSymbolFromAddress(tokenAddress),
        price: tokenPriceUSD / solPrice,
        priceUSD: tokenPriceUSD,
        solPrice,
        timestamp: Date.now(),
        source: 'PumpToken',
        marketCap: data.usd_market_cap,
        volume24h: data.volume_24h,
      };

      // Cache the result
      this.cache.set(tokenAddress, {
        data: marketData,
        expires: Date.now() + this.cacheDuration,
      });

      console.log(`✅ [PumpToken] Fetched from Pump.fun: $${tokenPriceUSD.toFixed(8)} USD`);
      return marketData;
    } catch (error) {
      console.error(`❌ [PumpToken] Pump.fun API error:`, error);
      return null;
    }
  }

  async fetchSolPrice(): Promise<number | null> {
    // Use Jupiter for SOL price as it's more reliable
    const jupiter = new JupiterDataSource();
    return await jupiter.fetchSolPrice();
  }

  private async fetchFromAlternativePumpSources(tokenAddress: string): Promise<MarketData | null> {
    try {
      // Try DexScreener first for pump tokens as they often get listed there
      const dexScreener = new DexScreenerDataSource();
      const dexData = await dexScreener.fetchPrice(tokenAddress);

      if (dexData) {
        return {
          ...dexData,
          source: 'DexScreener (Pump Token)',
          tokenSymbol: dexData.tokenSymbol || this.extractSymbolFromAddress(tokenAddress)
        };
      }

      // Try Jupiter as fallback
      const jupiter = new JupiterDataSource();
      const jupiterData = await jupiter.fetchPrice(tokenAddress);

      if (jupiterData) {
        return {
          ...jupiterData,
          source: 'Jupiter (Pump Token)',
          tokenSymbol: jupiterData.tokenSymbol || this.extractSymbolFromAddress(tokenAddress)
        };
      }

      return null;
    } catch (error) {
      console.error(`Alternative pump token fetch error:`, error);
      return null;
    }
  }

  private extractSymbolFromAddress(address: string): string {
    // For pump tokens, try to create a readable symbol from address
    if (address.length >= 4) {
      return `PUMP${address.substring(address.length - 4).toUpperCase()}`;
    }
    return 'PUMP';
  }
}

/**
 * Market Data Provider with fallback support
 */
export class MarketDataProvider {
  private sources: MarketDataSource[];
  private solPriceCache: { price: number; expires: number } | null = null;
  private cacheDuration = 30000; // 30 seconds

  constructor() {
    // Initialize data sources in priority order (highest priority first)
    // OnChainRPC has priority 0 (highest) - uses YOUR RPC directly!
    this.sources = [
      new OnChainRPCDataSource(),  // Priority 0 - Your RPC (NO external APIs!)
      new JupiterDataSource(),      // Priority 1
      new DexScreenerDataSource(),  // Priority 2
      new CoinGeckoDataSource(),    // Priority 3
      new PumpTokenDataSource(),    // Priority 4
    ].sort((a, b) => a.priority - b.priority);
    
    console.log(`📊 [MarketDataProvider] Initialized with ${this.sources.length} sources (OnChainRPC first)`);
  }

  /**
   * Fetch real-time token price with fallback to multiple sources
   * FIX #9: Try all sources in PARALLEL with race condition for faster results
   */
  async fetchTokenPrice(tokenAddress: string): Promise<MarketData | null> {
    // Create promises for all sources
    const fetchPromises = this.sources.map(async (source) => {
      try {
        const data = await source.fetchPrice(tokenAddress);
        if (data) {
          await awsLogger.info(`Market data fetched from ${source.name}`, {
            metadata: { tokenAddress, price: data.priceUSD, source: source.name }
          });
          return data;
        }
        return null;
      } catch (error) {
        await awsLogger.warn(`Failed to fetch from ${source.name}`, {
          metadata: { tokenAddress, error: error instanceof Error ? error.message : String(error) }
        });
        return null;
      }
    });

    // Wait for ALL sources to complete (but any success can resolve early via allSettled)
    const results = await Promise.allSettled(fetchPromises);
    
    // Find the first successful result
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        return result.value;
      }
    }

    await awsLogger.error('All market data sources failed', {
      metadata: { tokenAddress }
    });
    return null;
  }

  /**
   * Fetch SOL price with caching
   */
  async fetchSolPrice(): Promise<number> {
    // Check cache
    if (this.solPriceCache && this.solPriceCache.expires > Date.now()) {
      return this.solPriceCache.price;
    }

    for (const source of this.sources) {
      try {
        const price = await source.fetchSolPrice();
        if (price) {
          // Cache the result
          this.solPriceCache = {
            price,
            expires: Date.now() + this.cacheDuration,
          };
          return price;
        }
      } catch (error) {
        console.error(`Failed to fetch SOL price from ${source.name}:`, error);
      }
    }

    // Return default fallback price if all sources fail
    console.warn('All SOL price sources failed, using fallback price');
    return 200; // Fallback price
  }

  /**
   * Fetch multiple token prices in parallel
   */
  async fetchMultipleTokenPrices(tokenAddresses: string[]): Promise<Map<string, MarketData>> {
    const results = new Map<string, MarketData>();
    
    const promises = tokenAddresses.map(async (address) => {
      const data = await this.fetchTokenPrice(address);
      if (data) {
        results.set(address, data);
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.solPriceCache = null;
    this.sources.forEach(source => {
      if ('cache' in source) {
        (source as any).cache.clear();
      }
    });
  }
}

// Singleton instance
export const marketDataProvider = new MarketDataProvider();
