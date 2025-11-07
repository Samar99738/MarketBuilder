/**
 * Paper Trading Types & Interfaces
 * 
 * Comprehensive type definitions for the paper trading system
 */

export type PaperTradingMode = 'paper' | 'live';

export interface PaperTradingConfig {
  enabled: boolean;
  initialBalanceSOL: number;
  initialBalanceUSDC: number;
  enableSlippage: boolean;
  slippagePercentage: number;
  enableFees: boolean;
  tradingFeePercentage: number;
  networkFeeSOL: number;
  enableLiquiditySimulation: boolean;
  dataSource: 'coingecko' | 'jupiter' | 'birdeye' | 'dexscreener';
}

export interface PaperTrade {
  id: string;
  strategyId: string;
  strategyName: string;
  timestamp: number;
  type: 'buy' | 'sell';
  tokenAddress: string;
  tokenSymbol?: string;
  
  // Order details
  orderType: 'market' | 'limit';
  requestedAmount: number; // Amount user wanted to trade
  executedAmount: number; // Actual amount after slippage/liquidity
  
  // Pricing
  marketPrice: number; // Real market price at execution time
  executionPrice: number; // Actual execution price (after slippage)
  priceUSD: number;
  solPriceUSD: number;
  
  // Trade amounts
  amountSOL: number;
  amountTokens: number;
  
  // Fees
  tradingFee: number;
  networkFee: number;
  slippage: number;
  totalCost: number;
  
  // Balances after trade
  balanceSOL: number;
  balanceUSDC: number;
  balanceTokens: number;
  
  // Performance
  unrealizedPnL?: number;
  realizedPnL?: number;
  
  // Metadata
  trigger?: string; // What triggered this trade (e.g., "DCA interval", "Price spike", "Stop loss")
  notes?: string;
}

export interface PaperPosition {
  tokenAddress: string;
  tokenSymbol: string;
  amount: number;
  averageEntryPrice: number;
  totalInvestedSOL: number;
  totalInvestedUSD: number;
  currentPrice: number;
  currentValueSOL: number;
  currentValueUSD: number;
  unrealizedPnL: number;
  unrealizedPnLPercentage: number;
  firstTradeTimestamp: number;
  lastTradeTimestamp: number;
  tradeCount: number;
}

export interface PaperPortfolio {
  balanceSOL: number;
  balanceUSDC: number;
  balanceTokens: number;
  positions: Map<string, PaperPosition>;
  totalValueSOL: number;
  totalValueUSD: number;
  initialBalanceSOL: number;
  initialBalanceUSD: number;
}

export interface PaperTradingMetrics {
  // Overall performance
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  
  // Financial metrics
  initialBalanceSOL: number;
  initialBalanceUSD: number;
  currentBalanceSOL: number;
  currentBalanceUSD: number;
  totalValueSOL: number;
  totalValueUSD: number;
  
  // Profit/Loss
  realizedPnL: number;
  realizedPnLUSD: number;
  unrealizedPnL: number;
  unrealizedPnLUSD: number;
  totalPnL: number;
  totalPnLUSD: number;
  
  // Percentages
  realizedPnLPercentage: number;
  unrealizedPnLPercentage: number;
  totalPnLPercentage: number;
  
  // Fees
  totalFees: number;
  totalFeesUSD: number;
  totalSlippage: number;
  
  // Performance metrics
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  sharpeRatio?: number;
  maxDrawdown: number;
  
  // Timing
  startTime: number;
  endTime?: number;
  duration: number;
  averageTradeInterval: number;
  
  // ROI metrics
  roi: number;
  roiAnnualized?: number;
  dailyROI?: number;
  
  // Strategy-specific
  strategyId?: string;
  strategyName?: string;
}

export interface MarketData {
  tokenAddress: string;
  tokenSymbol?: string;
  price: number;
  priceUSD: number;
  solPrice: number;
  timestamp: number;
  source: string;

  // Optional market depth data
  liquidity?: number;
  volume24h?: number;
  priceChange24h?: number;
  high24h?: number;
  low24h?: number;
  marketCap?: number;
}

export interface PaperTradingState {
  sessionId: string;
  userId?: string;
  mode: PaperTradingMode;
  config: PaperTradingConfig;
  portfolio: PaperPortfolio;
  trades: PaperTrade[];
  metrics: PaperTradingMetrics;
  startTime: number;
  lastTradeTime?: number;
  isActive: boolean;
}

export interface PaperTradingSession {
  id: string;
  userId?: string;
  strategyId?: string;
  startTime: number;
  endTime?: number;
  initialConfig: PaperTradingConfig;
  finalMetrics?: PaperTradingMetrics;
  status: 'active' | 'completed' | 'paused';
}

export interface OrderExecutionResult {
  success: boolean;
  trade?: PaperTrade;
  error?: string;
  insufficientBalance?: boolean;
  insufficientLiquidity?: boolean;
}

export interface PaperTradingLog {
  timestamp: number;
  level: 'info' | 'warning' | 'error' | 'trade';
  message: string;
  metadata?: Record<string, any>;
}
