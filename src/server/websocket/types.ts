/**
 * WebSocket Types and Interfaces
 * Defines all event types and data structures for real-time communication
 */

import { Socket } from 'socket.io';

// ============================================================================
// EVENT NAMES
// ============================================================================

export const WS_EVENTS = {
  // Connection events
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',
  
  // Price events
  PRICE_SUBSCRIBE: 'price:subscribe',
  PRICE_UNSUBSCRIBE: 'price:unsubscribe',
  PRICE_UPDATE: 'price:update',
  
  // Strategy events
  STRATEGY_CREATED: 'strategy:created',
  STRATEGY_UPDATED: 'strategy:updated',
  STRATEGY_DELETED: 'strategy:deleted',
  STRATEGY_STARTED: 'strategy:started',
  STRATEGY_PAUSED: 'strategy:paused',
  STRATEGY_COMPLETED: 'strategy:completed',
  STRATEGY_FAILED: 'strategy:failed',
  STRATEGY_STATE: 'strategy:state',
  STRATEGY_PROGRESS: 'strategy:progress',
  
  // Trade events (existing)
  TRADE_BUY: 'trade:buy',
  TRADE_SELL: 'trade:sell',
  TRADE_PRICE: 'trade:price',
  TRADE_RESPONSE: 'trade:response',
  TRADE_ERROR: 'trade:error',
  
  // System events
  SYSTEM_STATUS: 'system:status',
  SYSTEM_ERROR: 'system:error',
} as const;

// ============================================================================
// PRICE DATA TYPES
// ============================================================================

export interface PriceUpdate {
  token: string;
  price: number;
  priceUSD: number;
  change24h: number;
  volume24h?: number;
  marketCap?: number;
  timestamp: string;
  source: 'coingecko' | 'jupiter' | 'birdeye' | 'cache' | 'fallback';
}

export interface PriceSubscription {
  socketId: string;
  token: string;
  subscribedAt: string;
}

// ============================================================================
// STRATEGY DATA TYPES
// ============================================================================

export type StrategyStatus = 
  | 'created'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface StrategyProgress {
  current: number;
  total: number;
  percentage: number;
  estimatedCompletion?: string;
}

export interface StrategyTradeInfo {
  type: 'buy' | 'sell';
  amount: number;
  amountSOL?: number;
  price: number;
  signature?: string;
  timestamp: string;
}

export interface StrategyStateUpdate {
  strategyId: string;
  strategyType: string;
  status: StrategyStatus;
  progress?: StrategyProgress;
  lastTrade?: StrategyTradeInfo;
  error?: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface StrategyCreatedEvent {
  strategyId: string;
  strategyType: string;
  config: Record<string, any>;
  createdAt: string;
  createdBy?: string;
}

export interface StrategyDeletedEvent {
  strategyId: string;
  deletedAt: string;
  reason?: string;
}

// ============================================================================
// TRADE DATA TYPES (EXISTING)
// ============================================================================

export interface TradeBuyRequest {
  amountInSol: number;
  conversationId?: string;
}

export interface TradeSellRequest {
  amountToSell: number;
  conversationId?: string;
}

export interface TradePriceRequest {
  conversationId?: string;
}

export interface TradeResponse {
  type: 'buy' | 'sell';
  success: boolean;
  signature?: string;
  conversationId?: string;
  error?: string;
}

export interface TradeErrorResponse {
  type: 'buy' | 'sell' | 'price';
  error: string;
  conversationId?: string;
}

export interface TradePriceResponse {
  price: number;
  conversationId?: string;
}

// ============================================================================
// SYSTEM DATA TYPES
// ============================================================================

export interface SystemStatus {
  status: 'healthy' | 'degraded' | 'down';
  uptime: number;
  timestamp: string;
  connections: number;
  activeStrategies: number;
  rpcStatus: 'connected' | 'disconnected' | 'slow';
  lastPriceUpdate?: string;
  metrics?: {
    totalTrades: number;
    successRate: number;
    avgResponseTime: number;
  };
}

export interface SystemError {
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
  details?: any;
}

// ============================================================================
// WEBSOCKET CONTEXT TYPES
// ============================================================================

export interface ExtendedSocket extends Socket {
  userId?: string;
  priceSubscriptions?: Set<string>;
  strategySubscriptions?: Set<string>;
  performanceSubscriptions?: Set<string>;
  paperTradingSubscriptions?: Set<string>;
  connectedAt: Date;
}

export interface WebSocketStats {
  totalConnections: number;
  activeConnections: number;
  priceSubscribers: number;
  strategySubscribers: number;
  messagesReceived: number;
  messagesSent: number;
  errors: number;
}

// ============================================================================
// SERVICE INTERFACES
// ============================================================================

export interface IPriceService {
  start(): void;
  stop(): void;
  subscribe(socketId: string, token: string): void;
  unsubscribe(socketId: string, token: string): void;
  getCurrentPrice(): Promise<PriceUpdate | null>;
  getSubscriberCount(): number;
}

export interface IStrategyMonitor {
  start(): void;
  stop(): void;
  trackStrategy(strategyId: string): void;
  untrackStrategy(strategyId: string): void;
  getActiveStrategies(): string[];
  emitStateChange(update: StrategyStateUpdate): void;
}

// ============================================================================
// HELPER TYPES
// ============================================================================

export type EventCallback<T = any> = (data: T) => void | Promise<void>;

export interface EventHandlers {
  onConnection?: EventCallback<ExtendedSocket>;
  onDisconnect?: EventCallback<ExtendedSocket>;
  onPriceSubscribe?: EventCallback<{ socket: ExtendedSocket; token: string }>;
  onPriceUnsubscribe?: EventCallback<{ socket: ExtendedSocket; token: string }>;
  onTradeBuy?: EventCallback<{ socket: ExtendedSocket; data: TradeBuyRequest }>;
  onTradeSell?: EventCallback<{ socket: ExtendedSocket; data: TradeSellRequest }>;
  onTradePrice?: EventCallback<{ socket: ExtendedSocket; data: TradePriceRequest }>;
}

