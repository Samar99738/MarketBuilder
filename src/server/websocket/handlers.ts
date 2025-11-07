/**
 * WebSocket Event Handlers
 * Central handler for all WebSocket events
 */

import { Server as SocketServer, Socket } from 'socket.io';
import { PriceService } from './priceService';
import { StrategyMonitor } from './strategyMonitor';
import { RealTradeFeedService } from './RealTradeFeedService';
import {
  ExtendedSocket,
  WS_EVENTS,
  TradeBuyRequest,
  TradeSellRequest,
  TradePriceRequest,
  SystemStatus,
} from './types';
import { strategyExecutionTracker } from '../../trading_utils/StrategyExecutionTracker';

export class WebSocketHandlers {
  private io: SocketServer;
  private priceService: PriceService;
  private strategyMonitor: StrategyMonitor;
  private realTradeFeedService: RealTradeFeedService;
  private startTime: Date;
  private stats = {
    totalConnections: 0,
    activeConnections: 0,
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0,
  };

  constructor(io: SocketServer) {
    this.io = io;
    this.priceService = new PriceService(io);
    this.strategyMonitor = new StrategyMonitor(io);
    this.realTradeFeedService = new RealTradeFeedService(io);
    this.startTime = new Date();
  }

  /**
   * Initialize all WebSocket handlers
   */
  initialize(): void {
    console.log('[WebSocket] Initializing handlers...');

    // Start services
    this.strategyMonitor.start();
    this.realTradeFeedService.start();

    // Setup connection handler
    this.io.on(WS_EVENTS.CONNECTION, (socket: Socket) => {
      this.handleConnection(socket as ExtendedSocket);
    });

    console.log('[WebSocket] Handlers initialized successfully');
    console.log('[WebSocket] Real blockchain trade monitoring ACTIVE');
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(socket: ExtendedSocket): void {
    // Enhance socket with metadata
    socket.connectedAt = new Date();
    socket.priceSubscriptions = new Set();
    socket.strategySubscriptions = new Set();
    socket.paperTradingSubscriptions = new Set();

    this.stats.totalConnections++;
    this.stats.activeConnections++;

    console.log(`[WebSocket] Client connected: ${socket.id} (Total: ${this.stats.activeConnections})`);

    // Send welcome message with system status
    this.sendSystemStatus(socket);

    // Setup event listeners
    this.setupPriceHandlers(socket);
    this.setupTradeHandlers(socket);
    this.setupRealTradeHandlers(socket);
    this.setupSystemHandlers(socket);
    this.setupDisconnectHandler(socket);
  }

  /**
   * Setup price-related event handlers
   */
  private setupPriceHandlers(socket: ExtendedSocket): void {
    // Subscribe to price updates
    socket.on(WS_EVENTS.PRICE_SUBSCRIBE, (data: { token?: string } = {}) => {
      try {
        this.stats.messagesReceived++;
        const token = data.token || 'SOL';
        
        socket.priceSubscriptions?.add(token);
        this.priceService.subscribe(socket.id, token);

        socket.emit('price:subscribed', {
          token,
          subscribedAt: new Date().toISOString(),
        });

        console.log(`[WebSocket] ${socket.id} subscribed to ${token} prices`);
      } catch (error: any) {
        this.handleError(socket, 'price:subscribe', error);
      }
    });

    // Unsubscribe from price updates
    socket.on(WS_EVENTS.PRICE_UNSUBSCRIBE, (data: { token?: string } = {}) => {
      try {
        this.stats.messagesReceived++;
        const token = data.token || 'SOL';

        socket.priceSubscriptions?.delete(token);
        this.priceService.unsubscribe(socket.id, token);

        socket.emit('price:unsubscribed', {
          token,
          unsubscribedAt: new Date().toISOString(),
        });

        console.log(`[WebSocket] ${socket.id} unsubscribed from ${token} prices`);
      } catch (error: any) {
        this.handleError(socket, 'price:unsubscribe', error);
      }
    });
  }

  /**
   * Setup trade-related event handlers (existing functionality)
   */
  private setupTradeHandlers(socket: ExtendedSocket): void {
    // These handlers will be implemented later or kept from existing server.ts
    // For now, we'll add placeholders that can be integrated

    socket.on(WS_EVENTS.TRADE_BUY, async (data: TradeBuyRequest) => {
      try {
        this.stats.messagesReceived++;
        console.log(`[WebSocket] ${socket.id} requested buy: ${data.amountInSol} SOL`);
        
        // This will be connected to actual trading logic in integration step
        socket.emit('trade:pending', {
          type: 'buy',
          conversationId: data.conversationId,
        });
      } catch (error: any) {
        this.handleError(socket, 'trade:buy', error);
      }
    });

    socket.on(WS_EVENTS.TRADE_SELL, async (data: TradeSellRequest) => {
      try {
        this.stats.messagesReceived++;
        console.log(`[WebSocket] ${socket.id} requested sell: ${data.amountToSell}`);

        // This will be connected to actual trading logic in integration step
        socket.emit('trade:pending', {
          type: 'sell',
          conversationId: data.conversationId,
        });
      } catch (error: any) {
        this.handleError(socket, 'trade:sell', error);
      }
    });

    socket.on(WS_EVENTS.TRADE_PRICE, async (data: TradePriceRequest) => {
      try {
        this.stats.messagesReceived++;
        
        // Get current price from service
        const priceData = await this.priceService.getCurrentPrice();
        
        socket.emit(WS_EVENTS.TRADE_PRICE, {
          price: priceData?.priceUSD || 0,
          conversationId: data.conversationId,
        });
      } catch (error: any) {
        this.handleError(socket, 'trade:price', error);
      }
    });
  }

  /**
   * Setup real trade monitoring handlers
   */
  private setupRealTradeHandlers(socket: ExtendedSocket): void {
    // Subscribe to real pump.fun trades for a token
    socket.on('pumpfun:subscribe', async (data: { tokenAddress: string }) => {
      try {
        this.stats.messagesReceived++;
        const { tokenAddress } = data;

        console.log(`[WebSocket] ${socket.id} subscribing to REAL trades: ${tokenAddress}`);

        const success = await this.realTradeFeedService.subscribeToToken(tokenAddress, socket.id);

        if (success) {
          socket.emit('pumpfun:subscribed', {
            tokenAddress,
            subscribedAt: new Date().toISOString(),
            isRealBlockchain: true,
          });
          
          // Send recent trades immediately
          const recentTrades = this.realTradeFeedService.getRecentTrades(tokenAddress, 10);
          if (recentTrades.length > 0) {
            socket.emit('pumpfun:recent_trades', {
              tokenAddress,
              trades: recentTrades,
              count: recentTrades.length,
            });
          }
          
          console.log(`[WebSocket] ${socket.id} subscribed to REAL blockchain trades for ${tokenAddress}`);
        } else {
          socket.emit('pumpfun:subscribe_error', {
            tokenAddress,
            error: 'Failed to subscribe to real trades',
          });
        }
      } catch (error: any) {
        this.handleError(socket, 'pumpfun:subscribe', error);
      }
    });

    // Unsubscribe from real trades
    socket.on('pumpfun:unsubscribe', async (data: { tokenAddress: string }) => {
      try {
        this.stats.messagesReceived++;
        const { tokenAddress } = data;

        await this.realTradeFeedService.unsubscribeFromToken(tokenAddress, socket.id);

        socket.emit('pumpfun:unsubscribed', {
          tokenAddress,
          unsubscribedAt: new Date().toISOString(),
        });

        console.log(`[WebSocket] ${socket.id} unsubscribed from ${tokenAddress}`);
      } catch (error: any) {
        this.handleError(socket, 'pumpfun:unsubscribe', error);
      }
    });

    // Get real-time stats for a token
    socket.on('pumpfun:stats', (data: { tokenAddress: string }) => {
      try {
        this.stats.messagesReceived++;
        const { tokenAddress } = data;

        const stats = this.realTradeFeedService.getTokenStats(tokenAddress);
        const volume = this.realTradeFeedService.getVolumeInWindow(tokenAddress, 5);

        socket.emit('pumpfun:stats_data', {
          tokenAddress,
          stats,
          volumeLast5Min: volume,
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        this.handleError(socket, 'pumpfun:stats', error);
      }
    });

    // Get real trade feed service stats
    socket.on('pumpfun:service_stats', () => {
      try {
        this.stats.messagesReceived++;
        const stats = this.realTradeFeedService.getStats();

        socket.emit('pumpfun:service_stats_data', {
          ...stats,
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        this.handleError(socket, 'pumpfun:service_stats', error);
      }
    });
  }

  /**
   * Setup system-related event handlers
   */
  private setupSystemHandlers(socket: ExtendedSocket): void {
    // Request system status
    socket.on('system:status:request', () => {
      try {
        this.stats.messagesReceived++;
        this.sendSystemStatus(socket);
      } catch (error: any) {
        this.handleError(socket, 'system:status', error);
      }
    });

    // Request performance data for a specific strategy
    socket.on('performance:request', (data: { strategyId: string }) => {
      try {
        this.stats.messagesReceived++;
        const performance = strategyExecutionTracker.getPerformance(data.strategyId);
        
        if (performance) {
          socket.emit('performance:data', {
            strategyId: data.strategyId,
            data: performance,
            timestamp: new Date().toISOString(),
          });
        } else {
          socket.emit('performance:error', {
            strategyId: data.strategyId,
            error: 'Strategy not found or not being tracked',
          });
        }
      } catch (error: any) {
        this.handleError(socket, 'performance:request', error);
      }
    });

    // Request performance summary
    socket.on('performance:summary:request', (data: { strategyId: string }) => {
      try {
        this.stats.messagesReceived++;
        const summary = strategyExecutionTracker.generateSummary(data.strategyId);
        
        if (summary) {
          socket.emit('performance:summary', {
            strategyId: data.strategyId,
            data: summary,
            timestamp: new Date().toISOString(),
          });
        } else {
          socket.emit('performance:error', {
            strategyId: data.strategyId,
            error: 'Strategy not found or not being tracked',
          });
        }
      } catch (error: any) {
        this.handleError(socket, 'performance:summary', error);
      }
    });

    // Request all performances
    socket.on('performances:request', () => {
      try {
        this.stats.messagesReceived++;
        const performances = strategyExecutionTracker.getAllPerformances();
        
        socket.emit('performances:data', {
          count: performances.length,
          data: performances,
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        this.handleError(socket, 'performances:request', error);
      }
    });

    // Subscribe to performance updates for a strategy
    socket.on('performance:subscribe', (data: { strategyId: string }) => {
      try {
        this.stats.messagesReceived++;
        if (!socket.performanceSubscriptions) {
          socket.performanceSubscriptions = new Set();
        }
        socket.performanceSubscriptions.add(data.strategyId);
        
        socket.emit('performance:subscribed', {
          strategyId: data.strategyId,
          subscribedAt: new Date().toISOString(),
        });
        
        console.log(`[WebSocket] ${socket.id} subscribed to performance updates for ${data.strategyId}`);
      } catch (error: any) {
        this.handleError(socket, 'performance:subscribe', error);
      }
    });

    // Unsubscribe from performance updates
    socket.on('performance:unsubscribe', (data: { strategyId: string }) => {
      try {
        this.stats.messagesReceived++;
        socket.performanceSubscriptions?.delete(data.strategyId);
        
        socket.emit('performance:unsubscribed', {
          strategyId: data.strategyId,
          unsubscribedAt: new Date().toISOString(),
        });
        
        console.log(`[WebSocket] ${socket.id} unsubscribed from performance updates for ${data.strategyId}`);
      } catch (error: any) {
        this.handleError(socket, 'performance:unsubscribe', error);
      }
    });

    // Subscribe to paper trading simulation updates
    socket.on('paper:subscribe', (data: { sessionId?: string } = {}) => {
      try {
        this.stats.messagesReceived++;
        const sessionId = data.sessionId;

        if (sessionId) {
          socket.paperTradingSubscriptions?.add(sessionId);
          socket.emit('paper:subscribed', {
            sessionId,
            subscribedAt: new Date().toISOString(),
          });
          console.log(`[WebSocket] ${socket.id} subscribed to paper trading updates for ${sessionId}`);
        } else {
          // Subscribe to all paper trading updates
          socket.paperTradingSubscriptions?.add('all');
          socket.emit('paper:subscribed', {
            type: 'all',
            subscribedAt: new Date().toISOString(),
          });
          console.log(`[WebSocket] ${socket.id} subscribed to all paper trading updates`);
        }
      } catch (error: any) {
        this.handleError(socket, 'paper:subscribe', error);
      }
    });

    // Unsubscribe from paper trading updates
    socket.on('paper:unsubscribe', (data: { sessionId?: string } = {}) => {
      try {
        this.stats.messagesReceived++;
        const sessionId = data.sessionId;

        if (sessionId) {
          socket.paperTradingSubscriptions?.delete(sessionId);
          socket.emit('paper:unsubscribed', {
            sessionId,
            unsubscribedAt: new Date().toISOString(),
          });
          console.log(`[WebSocket] ${socket.id} unsubscribed from paper trading updates for ${sessionId}`);
        } else {
          socket.paperTradingSubscriptions?.delete('all');
          socket.emit('paper:unsubscribed', {
            type: 'all',
            unsubscribedAt: new Date().toISOString(),
          });
          console.log(`[WebSocket] ${socket.id} unsubscribed from all paper trading updates`);
        }
      } catch (error: any) {
        this.handleError(socket, 'paper:unsubscribe', error);
      }
    });

    // Request paper trading session data
    socket.on('paper:session:request', (data: { sessionId: string }) => {
      try {
        this.stats.messagesReceived++;
        // This will be handled by the paper trading engine and broadcasted back
        socket.emit('paper:session:pending', {
          sessionId: data.sessionId,
          requestedAt: new Date().toISOString(),
        });
      } catch (error: any) {
        this.handleError(socket, 'paper:session:request', error);
      }
    });

    // Ping/Pong for connection health
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: new Date().toISOString() });
    });
  }

  /**
   * Setup disconnect handler
   */
  private setupDisconnectHandler(socket: ExtendedSocket): void {
    socket.on(WS_EVENTS.DISCONNECT, (reason: string) => {
      this.stats.activeConnections--;

      console.log(`[WebSocket] Client disconnected: ${socket.id} (Reason: ${reason}, Remaining: ${this.stats.activeConnections})`);

      // Cleanup price subscriptions
      if (socket.priceSubscriptions) {
        socket.priceSubscriptions.forEach(token => {
          this.priceService.unsubscribe(socket.id, token);
        });
      }

      // Cleanup strategy subscriptions
      socket.priceSubscriptions?.clear();
      socket.strategySubscriptions?.clear();
      socket.paperTradingSubscriptions?.clear();
    });
  }

  /**
   * Send system status to client
   */
  private sendSystemStatus(socket: ExtendedSocket): void {
    const uptime = Date.now() - this.startTime.getTime();
    
    const status: SystemStatus = {
      status: 'healthy',
      uptime: Math.floor(uptime / 1000),
      timestamp: new Date().toISOString(),
      connections: this.stats.activeConnections,
      activeStrategies: this.strategyMonitor.getActiveStrategies().length,
      rpcStatus: 'connected',
      lastPriceUpdate: this.priceService.getStats().lastPrice?.timestamp,
      metrics: {
        totalTrades: 0,
        successRate: 100,
        avgResponseTime: 50,
      },
    };

    socket.emit(WS_EVENTS.SYSTEM_STATUS, status);
    this.stats.messagesSent++;
  }

  /**
   * Handle errors and emit to client
   */
  private handleError(socket: ExtendedSocket, context: string, error: any): void {
    this.stats.errors++;

    console.error(`[WebSocket] Error in ${context}:`, error.message);

    socket.emit(WS_EVENTS.SYSTEM_ERROR, {
      code: context,
      message: error.message || 'An error occurred',
      severity: 'medium',
      timestamp: new Date().toISOString(),
    });

    socket.emit(WS_EVENTS.TRADE_ERROR, {
      type: context.split(':')[0],
      error: error.message || 'An error occurred',
    });
  }

  /**
   * Get WebSocket statistics
   */
  getStats() {
    return {
      ...this.stats,
      priceService: this.priceService.getStats(),
      strategyMonitor: this.strategyMonitor.getStats(),
      uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
    };
  }

  /**
   * Get price service instance
   */
  getPriceService(): PriceService {
    return this.priceService;
  }

  /**
   * Get strategy monitor instance
   */
  getStrategyMonitor(): StrategyMonitor {
    return this.strategyMonitor;
  }

  /**
   * Broadcast performance update to subscribed clients
   * Enhanced with detailed metrics and minimal latency
   */
  broadcastPerformanceUpdate(strategyId: string): void {
    try {
      const performance = strategyExecutionTracker.getPerformance(strategyId);
      if (!performance) return;

      // Calculate additional real-time metrics
      const now = Date.now();
      const durationMs = now - performance.startTime;
      const durationMinutes = durationMs / (1000 * 60);
      const durationHours = durationMinutes / 60;
      
      // Enhanced performance data with detailed metrics
      const enhancedData = {
        ...performance,
        
        // Execution timing
        timing: {
          startTime: performance.startTime,
          currentTime: now,
          durationMs,
          durationMinutes: Math.round(durationMinutes * 100) / 100,
          durationHours: Math.round(durationHours * 100) / 100,
          averageExecutionTime: performance.averageExecutionTime,
          executionsPerMinute: durationMinutes > 0 ? performance.totalExecutions / durationMinutes : 0,
          executionsPerHour: durationHours > 0 ? performance.totalExecutions / durationHours : 0,
        },
        
        // Financial breakdown
        financials: {
          initialBalanceSOL: performance.initialBalanceSOL,
          currentBalanceSOL: performance.currentBalanceSOL,
          totalInvestedSOL: performance.totalInvestedSOL,
          totalReturnedSOL: performance.totalReturnedSOL,
          currentTokenBalance: performance.currentTokenBalance,
          
          // Realized vs Unrealized
          realizedProfitSOL: performance.realizedProfitSOL,
          realizedProfitUSD: performance.realizedProfitUSD,
          unrealizedProfitSOL: performance.unrealizedProfitSOL,
          unrealizedProfitUSD: performance.unrealizedProfitUSD,
          
          // Total profit
          totalProfitSOL: performance.totalProfitSOL,
          totalProfitUSD: performance.totalProfitUSD,
          profitPercentage: performance.profitPercentage,
          
          // Fees
          totalFeesSOL: performance.totalFeesSOL,
          totalFeesUSD: performance.totalFeesUSD,
          feesPercentage: performance.totalInvestedSOL > 0 
            ? (performance.totalFeesSOL / performance.totalInvestedSOL) * 100 
            : 0,
        },
        
        // Trade statistics
        tradeStats: {
          totalExecutions: performance.totalExecutions,
          buyExecutions: performance.buyExecutions,
          sellExecutions: performance.sellExecutions,
          successRate: performance.successRate,
          failedExecutions: performance.failedExecutions,
          buyToSellRatio: performance.sellExecutions > 0 
            ? performance.buyExecutions / performance.sellExecutions 
            : performance.buyExecutions,
        },
        
        // ROI metrics
        roiMetrics: {
          roi: performance.roi,
          dailyROI: performance.dailyROI,
          hourlyROI: durationHours > 0 ? performance.roi / durationHours : 0,
          projectedMonthlyROI: performance.dailyROI * 30,
          projectedYearlyROI: performance.dailyROI * 365,
        },
        
        // Recent trade info
        recentTrade: performance.trades.length > 0 
          ? {
              ...performance.trades[performance.trades.length - 1],
              timeSinceLastTrade: now - performance.trades[performance.trades.length - 1].timestamp,
            }
          : null,
      };

      // Get all connected sockets
      const sockets = Array.from(this.io.sockets.sockets.values()) as ExtendedSocket[];
      
      // Send to subscribed clients with enhanced data
      sockets.forEach((socket) => {
        if (socket.performanceSubscriptions?.has(strategyId)) {
          socket.emit('performance:update', {
            strategyId,
            data: enhancedData,
            timestamp: new Date().toISOString(),
            latency: 0, // Instant broadcast
          });
          this.stats.messagesSent++;
        }
      });
    } catch (error) {
      console.error('[WebSocket] Error broadcasting performance update:', error);
    }
  }

  /**
   * Broadcast performance update to all clients
   * Enhanced with detailed metrics for maximum information
   */
  broadcastPerformanceUpdateToAll(strategyId: string): void {
    try {
      const performance = strategyExecutionTracker.getPerformance(strategyId);
      if (!performance) return;

      // Calculate additional real-time metrics
      const now = Date.now();
      const durationMs = now - performance.startTime;
      const durationMinutes = durationMs / (1000 * 60);
      const durationHours = durationMinutes / 60;
      
      // Enhanced performance data
      const enhancedData = {
        ...performance,
        
        // Execution timing
        timing: {
          startTime: performance.startTime,
          currentTime: now,
          durationMs,
          durationMinutes: Math.round(durationMinutes * 100) / 100,
          durationHours: Math.round(durationHours * 100) / 100,
          averageExecutionTime: performance.averageExecutionTime,
          executionsPerMinute: durationMinutes > 0 ? performance.totalExecutions / durationMinutes : 0,
          executionsPerHour: durationHours > 0 ? performance.totalExecutions / durationHours : 0,
        },
        
        // Financial breakdown
        financials: {
          initialBalanceSOL: performance.initialBalanceSOL,
          currentBalanceSOL: performance.currentBalanceSOL,
          totalInvestedSOL: performance.totalInvestedSOL,
          totalReturnedSOL: performance.totalReturnedSOL,
          currentTokenBalance: performance.currentTokenBalance,
          realizedProfitSOL: performance.realizedProfitSOL,
          realizedProfitUSD: performance.realizedProfitUSD,
          unrealizedProfitSOL: performance.unrealizedProfitSOL,
          unrealizedProfitUSD: performance.unrealizedProfitUSD,
          totalProfitSOL: performance.totalProfitSOL,
          totalProfitUSD: performance.totalProfitUSD,
          profitPercentage: performance.profitPercentage,
          totalFeesSOL: performance.totalFeesSOL,
          totalFeesUSD: performance.totalFeesUSD,
          feesPercentage: performance.totalInvestedSOL > 0 
            ? (performance.totalFeesSOL / performance.totalInvestedSOL) * 100 
            : 0,
        },
        
        // Trade statistics
        tradeStats: {
          totalExecutions: performance.totalExecutions,
          buyExecutions: performance.buyExecutions,
          sellExecutions: performance.sellExecutions,
          successRate: performance.successRate,
          failedExecutions: performance.failedExecutions,
          buyToSellRatio: performance.sellExecutions > 0 
            ? performance.buyExecutions / performance.sellExecutions 
            : performance.buyExecutions,
        },
        
        // ROI metrics
        roiMetrics: {
          roi: performance.roi,
          dailyROI: performance.dailyROI,
          hourlyROI: durationHours > 0 ? performance.roi / durationHours : 0,
          projectedMonthlyROI: performance.dailyROI * 30,
          projectedYearlyROI: performance.dailyROI * 365,
        },
        
        // Recent trade info
        recentTrade: performance.trades.length > 0 
          ? {
              ...performance.trades[performance.trades.length - 1],
              timeSinceLastTrade: now - performance.trades[performance.trades.length - 1].timestamp,
            }
          : null,
      };

      this.io.emit('performance:update', {
        strategyId,
        data: enhancedData,
        timestamp: new Date().toISOString(),
        latency: 0,
      });
      
      this.stats.messagesSent++;
    } catch (error) {
      console.error('[WebSocket] Error broadcasting performance update to all:', error);
    }
  }

  /**
   * Broadcast strategy status change with detailed context
   */
  broadcastStrategyStatusChange(strategyId: string, status: 'paused' | 'running' | 'stopped', runningId?: string): void {
    try {
      // Get performance data if available
      const performance = runningId ? strategyExecutionTracker.getPerformance(runningId) : null;
      
      const statusEvent = {
        strategyId,
        runningId,
        status,
        timestamp: new Date().toISOString(),
        
        // Additional context
        context: performance ? {
          totalExecutions: performance.totalExecutions,
          currentProfitUSD: performance.totalProfitUSD,
          roi: performance.roi,
          durationMs: Date.now() - performance.startTime,
          lastTradeTime: performance.trades.length > 0 
            ? performance.trades[performance.trades.length - 1].timestamp 
            : null,
        } : null,
        
        // Status metadata
        metadata: {
          statusChangedAt: Date.now(),
          previousStatus: status === 'paused' ? 'running' : status === 'running' ? 'paused' : 'running',
          canResume: status === 'paused',
          isFinal: status === 'stopped',
        }
      };

      this.io.emit('strategy:status', statusEvent);
      
      this.stats.messagesSent++;
      console.log(`[WebSocket] Broadcasted strategy status change: ${strategyId} -> ${status}`);
    } catch (error) {
      console.error('[WebSocket] Error broadcasting strategy status change:', error);
    }
  }

  /**
   * Get real trade feed service instance
   */
  getRealTradeFeedService(): RealTradeFeedService {
    return this.realTradeFeedService;
  }

  /**
   * Shutdown all services
   */
  async shutdown(): Promise<void> {
    console.log('[WebSocket] Shutting down services...');
    this.priceService.stop();
    this.strategyMonitor.stop();
    await this.realTradeFeedService.stop();
    console.log('[WebSocket] Services shut down');
  }
}

