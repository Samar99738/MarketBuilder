/**
 * WebSocket Module Exports
 * Central export point for all WebSocket functionality
 */

export * from './types';
export { PriceService } from './priceService';
export { StrategyMonitor } from './strategyMonitor';
export { WebSocketHandlers } from './handlers';
export { SolanaTradeMonitor } from './SolanaTradeMonitor';
export { PumpFunTradePoller } from './PumpFunTradePoller';
export { RealTradeFeedService, RealTradeEvent } from './RealTradeFeedService';

// Global instance accessor (set by server.ts)
let webSocketHandlersInstance: any = null;

export function setWebSocketHandlers(instance: any): void {
  webSocketHandlersInstance = instance;
}

export function getWebSocketHandlers(): any {
  return webSocketHandlersInstance;
}

