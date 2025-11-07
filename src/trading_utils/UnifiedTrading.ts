/**
 * Unified Trading Interface
 * 
 * Single interface for trading any token - automatically routes to
 * the appropriate trading engine (Jupiter or Pump.fun)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getTokenRouter, TokenType, TradingRoute } from './TokenRouter';
import { getPumpFunAPI, PumpFunTradeResult } from './PumpFunAPI';
import { buyTokens as jupiterBuy, sellTokens as jupiterSell } from './TokenUtils';
import { TRADING_CONFIG } from './config';

/**
 * Trade parameters
 */
export interface UnifiedTradeParams {
  /** Token to trade (mint address or symbol) */
  token: string;
  /** Amount to trade */
  amount: number;
  /** Whether amount is in SOL (for buy) or tokens (for sell) */
  amountInSol?: boolean;
  /** Slippage tolerance in percentage (e.g., 10 = 10%) */
  slippage?: number;
  /** Priority fee in SOL */
  priorityFee?: number;
  /** Custom connection (optional) */
  connection?: Connection;
}

/**
 * Unified trade result
 */
export interface UnifiedTradeResult {
  success: boolean;
  signature?: string;
  error?: string;
  route?: TradingRoute;
  engine: 'jupiter' | 'pumpfun';
  tokenAmount?: number;
  solAmount?: number;
}

/**
 * Unified Trading Class
 */
export class UnifiedTrading {
  private connection: Connection;
  private tokenRouter: ReturnType<typeof getTokenRouter>;
  private pumpFunAPI: ReturnType<typeof getPumpFunAPI>;

  constructor(connection?: Connection) {
    this.connection = connection || new Connection(
      TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.tokenRouter = getTokenRouter(this.connection);
    this.pumpFunAPI = getPumpFunAPI(this.connection);
  }

  /**
   * Buy any token - automatically routes to correct engine
   */
  async buy(params: UnifiedTradeParams): Promise<UnifiedTradeResult> {
    try {
      console.log(`\n [UnifiedTrading] Buy request for: ${params.token}`);
      console.log(`Amount: ${params.amount} SOL`);

      // Step 1: Route the token
      const route = await this.tokenRouter.route(params.token);
      console.log(`\n Routing decision:`);
      console.log(`  Engine: ${route.engine}`);
      console.log(`  Reason: ${route.reason}`);
      console.log(`  Token Type: ${route.tokenInfo.type}`);

      // Validate token
      if (!route.tokenInfo.isValid) {
        return {
          success: false,
          error: 'Invalid token address or token not found',
          engine: route.engine,
          route,
        };
      }

      // Step 2: Execute trade based on routing decision
      if (route.engine === 'pumpfun') {
        return await this.buyViaPumpFun(route, params);
      } else {
        return await this.buyViaJupiter(route, params);
      }
    } catch (error) {
      console.error(` Unified buy failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        engine: 'jupiter',
      };
    }
  }

  /**
   * Sell any token - automatically routes to correct engine
   */
  async sell(params: UnifiedTradeParams): Promise<UnifiedTradeResult> {
    try {
      console.log(`\n [UnifiedTrading] Sell request for: ${params.token}`);
      console.log(`Amount: ${params.amount} tokens`);

      // Step 1: Route the token
      const route = await this.tokenRouter.route(params.token);
      console.log(`\n Routing decision:`);
      console.log(`  Engine: ${route.engine}`);
      console.log(`  Reason: ${route.reason}`);
      console.log(`  Token Type: ${route.tokenInfo.type}`);

      // Validate token
      if (!route.tokenInfo.isValid) {
        return {
          success: false,
          error: 'Invalid token address or token not found',
          engine: route.engine,
          route,
        };
      }

      // Step 2: Execute trade based on routing decision
      if (route.engine === 'pumpfun') {
        return await this.sellViaPumpFun(route, params);
      } else {
        return await this.sellViaJupiter(route, params);
      }
    } catch (error) {
      console.error(`Unified sell failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        engine: 'jupiter',
      };
    }
  }

  /**
   * Buy via Pump.fun API
   */
  private async buyViaPumpFun(
    route: TradingRoute,
    params: UnifiedTradeParams
  ): Promise<UnifiedTradeResult> {
    console.log(`\n Executing buy via Pump.fun`);

    const slippage = params.slippage || 10; // 10% default for pump tokens
    const priorityFee = params.priorityFee || 0.00001;

    const result = await this.pumpFunAPI.buyToken(
      route.tokenInfo.mintAddress,
      params.amount,
      slippage,
      priorityFee
    );

    return {
      ...result,
      engine: 'pumpfun',
      route,
    };
  }

  /**
   * Sell via Pump.fun API
   */
  private async sellViaPumpFun(
    route: TradingRoute,
    params: UnifiedTradeParams
  ): Promise<UnifiedTradeResult> {
    console.log(`\n Executing sell via Pump.fun`);

    const slippage = params.slippage || 10;
    const priorityFee = params.priorityFee || 0.00001;

    const result = await this.pumpFunAPI.sellToken(
      route.tokenInfo.mintAddress,
      params.amount,
      slippage,
      priorityFee
    );

    return {
      ...result,
      engine: 'pumpfun',
      route,
    };
  }

  /**
   * Buy via Jupiter
   */
  private async buyViaJupiter(
    route: TradingRoute,
    params: UnifiedTradeParams
  ): Promise<UnifiedTradeResult> {
    //console.log(`\n Executing buy via Jupiter`);

    try {
      // Use existing Jupiter buy function
      // Note: You'll need to update TokenUtils to accept token mint parameter
      const signature = await jupiterBuy(params.amount, this.connection);

      return {
        success: true,
        signature,
        engine: 'jupiter',
        route,
        solAmount: params.amount,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Jupiter trade failed',
        engine: 'jupiter',
        route,
      };
    }
  }

  /**
   * Sell via Jupiter
   */
  private async sellViaJupiter(
    route: TradingRoute,
    params: UnifiedTradeParams
  ): Promise<UnifiedTradeResult> {
    //console.log(`\n Executing sell via Jupiter`);

    try {
      // Use existing Jupiter sell function
      const signature = await jupiterSell(params.amount, this.connection);

      return {
        success: true,
        signature,
        engine: 'jupiter',
        route,
        tokenAmount: params.amount,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Jupiter trade failed',
        engine: 'jupiter',
        route,
      };
    }
  }

  /**
   * Get token info - useful for displaying token details
   */
  async getTokenInfo(tokenMintOrSymbol: string) {
    const route = await this.tokenRouter.route(tokenMintOrSymbol);
    return route.tokenInfo;
  }

  /**
   * Validate token before trading
   */
  async validateToken(tokenMint: string) {
    return await this.tokenRouter.validateToken(tokenMint);
  }

  /**
   * Get token price
   */
  async getTokenPrice(tokenMint: string): Promise<number | null> {
    try {
      const route = await this.tokenRouter.route(tokenMint);

      if (route.engine === 'pumpfun') {
        return await this.pumpFunAPI.getTokenPrice(route.tokenInfo.mintAddress);
      } else {
        // For Jupiter tokens, you'd use your existing price fetching
        // This is a placeholder - implement based on your TokenUtils
        return null;
      }
    } catch (error) {
      console.error(`Error getting token price:`, error);
      return null;
    }
  }

  /**
   * Get trending pump.fun tokens
   */
  async getTrendingPumpTokens(limit: number = 10) {
    return await this.pumpFunAPI.getTrendingTokens(limit);
  }

  /**
   * Clear routing cache
   */
  clearCache() {
    this.tokenRouter.clearCache();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.tokenRouter.getCacheStats();
  }
}

/**
 * Singleton instance for easy access throughout the app
 */
let unifiedTradingInstance: UnifiedTrading | null = null;

export function getUnifiedTrading(connection?: Connection): UnifiedTrading {
  if (!unifiedTradingInstance) {
    unifiedTradingInstance = new UnifiedTrading(connection);
  }
  return unifiedTradingInstance;
}

export function resetUnifiedTrading(): void {
  unifiedTradingInstance = null;
}

/**
 * Convenience functions for backward compatibility
 */

/**
 * Buy any token with automatic routing
 */
export async function buyAnyToken(
  tokenMintOrSymbol: string,
  amountInSol: number,
  options?: {
    slippage?: number;
    priorityFee?: number;
    connection?: Connection;
  }
): Promise<UnifiedTradeResult> {
  const trading = getUnifiedTrading(options?.connection);
  return await trading.buy({
    token: tokenMintOrSymbol,
    amount: amountInSol,
    amountInSol: true,
    slippage: options?.slippage,
    priorityFee: options?.priorityFee,
    connection: options?.connection,
  });
}

/**
 * Sell any token with automatic routing
 */
export async function sellAnyToken(
  tokenMintOrSymbol: string,
  tokenAmount: number,
  options?: {
    slippage?: number;
    priorityFee?: number;
    connection?: Connection;
  }
): Promise<UnifiedTradeResult> {
  const trading = getUnifiedTrading(options?.connection);
  return await trading.sell({
    token: tokenMintOrSymbol,
    amount: tokenAmount,
    amountInSol: false,
    slippage: options?.slippage,
    priorityFee: options?.priorityFee,
    connection: options?.connection,
  });
}