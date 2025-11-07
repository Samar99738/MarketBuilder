/**
 * Performance Broadcasting Service
 * Handles WebSocket broadcasting of performance updates
 */

class PerformanceBroadcaster {
  private wsHandlers: any = null;

  /**
   * Initialize with WebSocket handlers
   */
  initialize(wsHandlers: any): void {
    this.wsHandlers = wsHandlers;
    console.log('[PerformanceBroadcaster] Initialized');
  }

  /**
   * Broadcast performance update for a strategy
   */
  broadcast(strategyId: string): void {
    if (!this.wsHandlers) {
      return; // WebSocket not initialized yet
    }

    try {
      this.wsHandlers.broadcastPerformanceUpdate(strategyId);
    } catch (error) {
      console.error('[PerformanceBroadcaster] Error broadcasting:', error);
    }
  }

  /**
   * Broadcast to all clients
   */
  broadcastToAll(strategyId: string): void {
    if (!this.wsHandlers) {
      return;
    }

    try {
      this.wsHandlers.broadcastPerformanceUpdateToAll(strategyId);
    } catch (error) {
      console.error('[PerformanceBroadcaster] Error broadcasting to all:', error);
    }
  }
}

export const performanceBroadcaster = new PerformanceBroadcaster();
