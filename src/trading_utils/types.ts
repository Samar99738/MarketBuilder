// ============================================================================
// JUPITER DEX API TYPES
// ============================================================================

/** Response from Jupiter quote API - provides swap route information */
export interface JupiterQuoteResponse {
  data?: {
    swapMode?: string;
    [key: string]: any;
  };
  outAmount?: string;
  [key: string]: any;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  [key: string]: any;
}

// Price API response types
export interface JupiterPriceResponse {
  data: {
    [key: string]: {
      price: number;
    };
  };}

export interface BirdeyePriceResponse {
  data: {
    value: number;
  };
}

export interface DexscreenerPriceResponse {
  pairs: Array<{
    priceUsd: string;
  }>;
}

// Trading request types
export interface BuyRequest {
  targetWalletAddress: string;
  amountInSol?: number;
  conversationId?: string;
}

export interface SellRequest {
  targetWalletAddress: string;
  reason: string;
  amountToSell?: number;
  conversationId?: string;
}

export interface PriceRequest {
  conversationId?: string;
}

// Response types
export interface TradeResponse {
  success: boolean;
  signature?: string;
  error?: string;
  conversationId?: string;
}

export interface PriceResponse {
  price: number;
  conversationId?: string;
}

export interface ErrorResponse {
  error: string;
  conversationId?: string;
}
