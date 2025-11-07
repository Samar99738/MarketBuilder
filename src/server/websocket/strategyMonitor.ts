/**
 * Strategy State Monitoring Service
 * Tracks and broadcasts strategy execution state changes in real-time
 */

import { Server as SocketServer } from 'socket.io';
import {
  IStrategyMonitor,
  StrategyStateUpdate,
  StrategyStatus,
  WS_EVENTS,
} from './types';

export class StrategyMonitor implements IStrategyMonitor {
  private io: SocketServer;
  private trackedStrategies: Set<string> = new Set();
  private strategyStates: Map<string, StrategyStateUpdate> = new Map();
  private isRunning: boolean = false;

  constructor(io: SocketServer) {
    this.io = io;
  }

  /**
   * Start the monitoring service
   */
  start(): void {
    if (this.isRunning) {
      console.log('[StrategyMonitor] Already running');
      return;
    }

    console.log('[StrategyMonitor] Starting strategy monitoring service...');
    this.isRunning = true;
  }

  /**
   * Stop the monitoring service
   */
  stop(): void {
    if (!this.isRunning) {
      console.log('[StrategyMonitor] Not running');
      return;
    }

    console.log('[StrategyMonitor] Stopping strategy monitoring service...');
    this.isRunning = false;
    this.trackedStrategies.clear();
    this.strategyStates.clear();
  }

  /**
   * Start tracking a strategy
   */
  trackStrategy(strategyId: string): void {
    if (this.trackedStrategies.has(strategyId)) {
      console.log(`[StrategyMonitor] Already tracking strategy: ${strategyId}`);
      return;
    }

    this.trackedStrategies.add(strategyId);
    console.log(`[StrategyMonitor] Now tracking strategy: ${strategyId} (Total: ${this.trackedStrategies.size})`);

    // Start service if this is the first strategy
    if (!this.isRunning) {
      this.start();
    }
  }

  /**
   * Stop tracking a strategy
   */
  untrackStrategy(strategyId: string): void {
    if (!this.trackedStrategies.has(strategyId)) {
      console.log(`[StrategyMonitor] Not tracking strategy: ${strategyId}`);
      return;
    }

    this.trackedStrategies.delete(strategyId);
    this.strategyStates.delete(strategyId);
    console.log(`[StrategyMonitor] Stopped tracking strategy: ${strategyId} (Remaining: ${this.trackedStrategies.size})`);

    // Stop service if no more strategies
    if (this.trackedStrategies.size === 0) {
      this.stop();
    }
  }

  /**
   * Get list of actively tracked strategies
   */
  getActiveStrategies(): string[] {
    return Array.from(this.trackedStrategies);
  }

  /**
   * Emit strategy state change to all connected clients
   */
  emitStateChange(update: StrategyStateUpdate): void {
    if (!this.isRunning) {
      console.warn('[StrategyMonitor] Cannot emit - service not running');
      return;
    }

    // Store latest state
    this.strategyStates.set(update.strategyId, update);

    // Broadcast to all clients
    this.io.emit(WS_EVENTS.STRATEGY_STATE, update);

    console.log(`[StrategyMonitor] Broadcasted state for ${update.strategyId}: ${update.status}${update.progress ? ` (${update.progress.percentage}%)` : ''}`);

    // Emit specific lifecycle events
    this.emitLifecycleEvent(update);
  }

  /**
   * Emit specific lifecycle events based on status
   */
  private emitLifecycleEvent(update: StrategyStateUpdate): void {
    const eventMap: Record<StrategyStatus, string> = {
      'created': WS_EVENTS.STRATEGY_CREATED,
      'ready': WS_EVENTS.STRATEGY_CREATED,
      'executing': WS_EVENTS.STRATEGY_STARTED,
      'paused': WS_EVENTS.STRATEGY_PAUSED,
      'completed': WS_EVENTS.STRATEGY_COMPLETED,
      'failed': WS_EVENTS.STRATEGY_FAILED,
      'cancelled': WS_EVENTS.STRATEGY_DELETED,
    };

    const eventName = eventMap[update.status];
    if (eventName) {
      this.io.emit(eventName, {
        strategyId: update.strategyId,
        strategyType: update.strategyType,
        status: update.status,
        timestamp: update.timestamp,
        error: update.error,
        metadata: update.metadata,
      });
    }
  }

  /**
   * Emit progress update for a strategy
   */
  emitProgress(
    strategyId: string,
    strategyType: string,
    current: number,
    total: number,
    estimatedCompletion?: string
  ): void {
    const percentage = Math.round((current / total) * 100);

    const update: StrategyStateUpdate = {
      strategyId,
      strategyType,
      status: 'executing',
      progress: {
        current,
        total,
        percentage,
        estimatedCompletion,
      },
      timestamp: new Date().toISOString(),
    };

    this.emitStateChange(update);

    // Emit specific progress event
    this.io.emit(WS_EVENTS.STRATEGY_PROGRESS, {
      strategyId,
      current,
      total,
      percentage,
      timestamp: update.timestamp,
    });
  }

  /**
   * Emit trade execution for a strategy
   */
  emitTrade(
    strategyId: string,
    strategyType: string,
    tradeType: 'buy' | 'sell',
    amount: number,
    price: number,
    signature?: string
  ): void {
    const update: StrategyStateUpdate = {
      strategyId,
      strategyType,
      status: 'executing',
      lastTrade: {
        type: tradeType,
        amount,
        price,
        signature,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };

    this.emitStateChange(update);

    console.log(`[StrategyMonitor] Strategy ${strategyId} executed ${tradeType}: ${amount} @ $${price}`);
  }

  /**
   * Emit strategy error
   */
  emitError(
    strategyId: string,
    strategyType: string,
    errorMessage: string
  ): void {
    const update: StrategyStateUpdate = {
      strategyId,
      strategyType,
      status: 'failed',
      error: errorMessage,
      timestamp: new Date().toISOString(),
    };

    this.emitStateChange(update);
  }

  /**
   * Emit strategy completion
   */
  emitCompletion(
    strategyId: string,
    strategyType: string,
    metadata?: Record<string, any>
  ): void {
    const update: StrategyStateUpdate = {
      strategyId,
      strategyType,
      status: 'completed',
      timestamp: new Date().toISOString(),
      metadata,
    };

    this.emitStateChange(update);
  }

  /**
   * Get current state of a strategy
   */
  getStrategyState(strategyId: string): StrategyStateUpdate | undefined {
    return this.strategyStates.get(strategyId);
  }

  /**
   * Get all strategy states
   */
  getAllStates(): Map<string, StrategyStateUpdate> {
    return new Map(this.strategyStates);
  }

  /**
   * Get monitoring stats
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      trackedStrategies: this.trackedStrategies.size,
      totalStates: this.strategyStates.size,
      activeStrategies: this.getActiveStrategies(),
    };
  }

  /**
   * Helper: Emit strategy created event
   */
  emitStrategyCreated(
    strategyId: string,
    strategyType: string,
    config: Record<string, any>
  ): void {
    this.trackStrategy(strategyId);

    const update: StrategyStateUpdate = {
      strategyId,
      strategyType,
      status: 'created',
      timestamp: new Date().toISOString(),
      metadata: { config },
    };

    this.emitStateChange(update);

    this.io.emit(WS_EVENTS.STRATEGY_CREATED, {
      strategyId,
      strategyType,
      config,
      createdAt: update.timestamp,
    });
  }

  /**
   * Helper: Emit strategy updated event
   */
  emitStrategyUpdated(
    strategyId: string,
    strategyType: string,
    updates: Record<string, any>
  ): void {
    const currentState = this.strategyStates.get(strategyId);

    const update: StrategyStateUpdate = {
      strategyId,
      strategyType,
      status: currentState?.status || 'ready',
      timestamp: new Date().toISOString(),
      metadata: { updates },
    };

    this.emitStateChange(update);

    this.io.emit(WS_EVENTS.STRATEGY_UPDATED, {
      strategyId,
      strategyType,
      updates,
      updatedAt: update.timestamp,
    });
  }

  /**
   * Helper: Emit strategy deleted event
   */
  emitStrategyDeleted(
    strategyId: string,
    reason?: string
  ): void {
    this.io.emit(WS_EVENTS.STRATEGY_DELETED, {
      strategyId,
      deletedAt: new Date().toISOString(),
      reason,
    });

    this.untrackStrategy(strategyId);
  }
}

