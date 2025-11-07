/**
 * Trading Provider Interface
 * This interface abstracts trading functions to allow dependency injection
 * and testing without wallet initialization dependencies.
 */

export interface TradingResult {
  success: boolean;
  data?: any;
  message: string;
}

export interface PriceResult {
  price: number;
  source: string;
  timestamp: number;
}

/**
 * Abstract trading provider interface
 * Allows for real trading implementation or mock implementation for testing
 */
export interface TradingProvider {
  /**
   * Buy tokens with SOL
   * @param amountInSol Amount of SOL to spend
   * @param context Optional context with strategy variables (e.g., tokenAddress)
   */
  buyTokens(amountInSol: number, context?: any): Promise<string>;
  
  /**
   * Sell tokens
   * @param amountToSell Amount to sell (-1 for all tokens)
   * @param context Optional context with strategy variables
   */
  sellTokens(amountToSell: number, context?: any): Promise<string>;
  
  /**
   * Get current token price in USD
   */
  getTokenPriceUSD(): Promise<PriceResult>;
  
  /**
   * Initialize the provider
   */
  initialize(): Promise<boolean>;
  
  // Optional methods (for backward compatibility)
  getProviderName?(): string;
  isInitialized?(): boolean;
  getJupiterTokenPrice?(): Promise<PriceResult>;
  getSolPriceUSD?(): Promise<PriceResult>;
  waitForPriceAbove?(targetPrice: number, timeoutMs: number): Promise<TradingResult>;
  waitForPriceBelow?(targetPrice: number, timeoutMs: number): Promise<TradingResult>;
}

// Alias for backward compatibility
export type ITradingProvider = TradingProvider;

/**
 * Trading provider factory
 * Returns appropriate provider based on environment
 */
export class TradingProviderFactory {
  private static instance: TradingProvider | null = null;
  
  static getInstance(forceType?: 'real' | 'mock'): TradingProvider {
    if (!this.instance || forceType) {
      const providerType = forceType || this.determineProviderType();

      if (providerType === 'mock') {
        this.instance = new MockTradingProvider();
      } else {
        // Lazy load the real trading provider to avoid circular dependencies
        const TokenUtils = require('./TokenUtils');
        this.instance = new RealTradingProvider(TokenUtils);
      }
    }

    return this.instance;
  }
  
  private static determineProviderType(): 'real' | 'mock' {
    // Use mock provider in test environment or when no wallet is configured
    if (process.env.NODE_ENV === 'test' ||
        process.env.USE_MOCK_TRADING === 'true' ||
        !process.env.WALLET_PRIVATE_KEY ||
        process.env.WALLET_PRIVATE_KEY === 'your_wallet_private_key_here') {
      return 'mock';
    }

    return 'real';
  }
  
  // Allow manual provider injection for testing
  static setProvider(provider: TradingProvider): void {
    this.instance = provider;
  }
  
  // Reset provider (useful for testing)
  static reset(): void {
    this.instance = null;
  }
}

/**
 * Mock Trading Provider for Testing
 * Provides realistic responses without blockchain dependencies
 */
export class MockTradingProvider implements TradingProvider {
  private mockPrice = 1.25;
  private mockTrend = 1; // 1 for up, -1 for down
  private initialized = true;
  
  // Test control flags
  private shouldFailBuy = false;
  private shouldFailSell = false;
  
  getProviderName(): string {
    return 'MockTradingProvider';
  }
  
  isInitialized(): boolean {
    return this.initialized;
  }
  
  async initialize(): Promise<boolean> {
    this.initialized = true;
    return true;
  }
  
  async buyTokens(amountInSol: number, context?: any): Promise<string> {
    // Simulate network delay
    await this.delay(100 + Math.random() * 200);
    
    if (amountInSol <= 0) {
      throw new Error('Invalid buy amount: must be positive');
    }
    
    if (amountInSol > 10) {
      throw new Error('Buy amount too large: exceeds safety limits');
    }
    
    // Check for forced failure first
    if (this.shouldFailBuy) {
      throw new Error('Mock buy failure: Testing error handling');
    }
    
    // Simulate occasional failures (5% chance)
    if (Math.random() < 0.05) {
      throw new Error('Simulated network error: Transaction failed');
    }
    
    // Generate mock transaction signature
    const signature = `mock_buy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return signature;
  }
  
  async sellTokens(amountToSell: number, context?: any): Promise<string> {
    await this.delay(100 + Math.random() * 200);
    
    if (amountToSell === 0 || amountToSell < -1) {
      throw new Error('Invalid sell amount: use -1 for all tokens or positive number');
    }
    
    // Check for forced failure first
    if (this.shouldFailSell) {
      throw new Error('Mock sell failure: Testing error handling');
    }
    
    // Simulate occasional failures (5% chance)
    if (Math.random() < 0.05) {
      throw new Error('Simulated network error: Transaction failed');
    }
    
    const signature = `mock_sell_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sellDescription = amountToSell === -1 ? 'ALL tokens' : `${amountToSell} tokens`;
    
    //console.log(` MOCK SELL: ${sellDescription} → SOL (${signature})`);
    return signature;
  }
  
  async getTokenPriceUSD(): Promise<PriceResult> {
    await this.delay(50 + Math.random() * 100);
    
    // Simulate realistic price movement
    this.mockPrice += (Math.random() - 0.5) * 0.1 * this.mockTrend;
    this.mockPrice = Math.max(0.1, this.mockPrice); // Prevent negative prices
    
    // Occasionally change trend direction
    if (Math.random() < 0.1) {
      this.mockTrend *= -1;
    }
    
    return {
      price: Number(this.mockPrice.toFixed(4)),
      source: 'Mock Exchange',
      timestamp: Date.now()
    };
  }
  
  async getJupiterTokenPrice(): Promise<PriceResult> {
    await this.delay(30 + Math.random() * 70);
    
    // Jupiter price slightly different from main price
    const jupiterPrice = this.mockPrice * (0.995 + Math.random() * 0.01);
    
    return {
      price: Number(jupiterPrice.toFixed(4)),
      source: 'Mock Jupiter',
      timestamp: Date.now()
    };
  }
  
  async getSolPriceUSD(): Promise<PriceResult> {
    await this.delay(40 + Math.random() * 80);
    
    // Mock SOL price around $150 with realistic movement
    const baseSolPrice = 150;
    const solPrice = baseSolPrice + (Math.random() - 0.5) * 20;
    
    return {
      price: Number(solPrice.toFixed(2)),
      source: 'Mock SOL Exchange',
      timestamp: Date.now()
    };
  }
  
  async waitForPriceAbove(targetPrice: number, checkIntervalMs = 1000, timeoutMs = 60000): Promise<TradingResult> {
    const startTime = Date.now();
    //console.log(` MOCK: Waiting for price above $${targetPrice}`);
    
    while (Date.now() - startTime < timeoutMs) {
      const currentPrice = await this.getTokenPriceUSD();
      
      if (currentPrice.price >= targetPrice) {
        //console.log(` MOCK: Price target reached: $${currentPrice.price} >= $${targetPrice}`);
        return {
          success: true,
          data: { price: currentPrice.price, targetPrice },
          message: `Price reached $${currentPrice.price}`
        };
      }
      
      await this.delay(checkIntervalMs);
    }
    
    //console.log(` MOCK: Price wait timeout after ${timeoutMs}ms`);
    return {
      success: false,
      message: `Timeout waiting for price above $${targetPrice}`
    };
  }
  
  async waitForPriceBelow(targetPrice: number, checkIntervalMs = 1000, timeoutMs = 60000): Promise<TradingResult> {
    const startTime = Date.now();
    //console.log(` MOCK: Waiting for price below $${targetPrice}`);
    
    while (Date.now() - startTime < timeoutMs) {
      const currentPrice = await this.getTokenPriceUSD();
      
      if (currentPrice.price <= targetPrice) {
        console.log(` MOCK: Price target reached: $${currentPrice.price} <= $${targetPrice}`);
        return {
          success: true,
          data: { price: currentPrice.price, targetPrice },
          message: `Price dropped to $${currentPrice.price}`
        };
      }
      
      await this.delay(checkIntervalMs);
    }
    
    //console.log(` MOCK: Price wait timeout after ${timeoutMs}ms`);
    return {
      success: false,
      message: `Timeout waiting for price below $${targetPrice}`
    };
  }
  
  clearPriceCache(): void {
    //console.log('MOCK: Price cache cleared');
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // Additional mock utilities for testing
  setMockPrice(price: number): void {
    this.mockPrice = price;
  }
  
  setMockTrend(trend: 1 | -1): void {
    this.mockTrend = trend;
  }
  
  getMockPrice(): number {
    return this.mockPrice;
  }
  
  // Test control methods
  setShouldFailBuy(shouldFail: boolean): void {
    this.shouldFailBuy = shouldFail;
  }
  
  setShouldFailSell(shouldFail: boolean): void {
    this.shouldFailSell = shouldFail;
  }
}

/**
 * Real Trading Provider
 * Uses actual TokenUtils functions for live trading
 */
class RealTradingProvider implements TradingProvider {
  private tokenUtils: any;
  
  constructor(tokenUtils: any) {
    this.tokenUtils = tokenUtils;
  }
  
  getProviderName(): string {
    return 'RealTradingProvider';
  }
  
  isInitialized(): boolean {
    return true;
  }
  
  async initialize(): Promise<boolean> {
    return true;
  }
  
  async buyTokens(amountInSol: number, context?: any): Promise<string> {
    return this.tokenUtils.buyTokens(amountInSol);
  }
  
  async sellTokens(amountToSell: number, context?: any): Promise<string> {
    return this.tokenUtils.sellTokens(amountToSell);
  }
  
  async getTokenPriceUSD(): Promise<PriceResult> {
    const price = await this.tokenUtils.getTokenPriceUSD();
    return {
      price,
      source: 'Jupiter/CoinGecko',
      timestamp: Date.now()
    };
  }
  
  async getJupiterTokenPrice(): Promise<PriceResult> {
    const price = await this.tokenUtils.getJupiterTokenPrice();
    return {
      price,
      source: 'Jupiter',
      timestamp: Date.now()
    };
  }
  
  async getSolPriceUSD(): Promise<PriceResult> {
    const price = await this.tokenUtils.getSolPriceUSD();
    return {
      price,
      source: 'CoinGecko',
      timestamp: Date.now()
    };
  }
  
  async waitForPriceAbove(targetPrice: number, checkIntervalMs = 1000, timeoutMs = 60000): Promise<TradingResult> {
    const result = await this.tokenUtils.waitForPriceAbove(targetPrice, checkIntervalMs, timeoutMs);
    return {
      success: result.success,
      data: result,
      message: result.message || (result.success ? 'Price target reached' : 'Timeout')
    };
  }
  
  async waitForPriceBelow(targetPrice: number, checkIntervalMs = 1000, timeoutMs = 60000): Promise<TradingResult> {
    const result = await this.tokenUtils.waitForPriceBelow(targetPrice, checkIntervalMs, timeoutMs);
    return {
      success: result.success,
      data: result,
      message: result.message || (result.success ? 'Price target reached' : 'Timeout')
    };
  }
  
  clearPriceCache(): void {
    if (this.tokenUtils.clearPriceCache) {
      this.tokenUtils.clearPriceCache();
    }
  }
}