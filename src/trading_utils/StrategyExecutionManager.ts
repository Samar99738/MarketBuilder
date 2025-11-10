import {
  strategyBuilder,
  StrategyExecutionResult,
  StrategyContext,
} from "./StrategyBuilder";
import { awsLogger } from "../aws/logger";
import { AWS_CONFIG } from "../aws/config";
import { 
  strategyExecutionTracker, 
  TradeExecution 
} from "./StrategyExecutionTracker";
import { getTokenPriceUSD, getSolPriceUSD } from "./TokenUtils";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { paperTradingEngine } from "./paper-trading/PaperTradingEngine";
import { PaperTradingMode } from "./paper-trading/types";
import { PaperTradingProvider } from "./paper-trading/PaperTradingProvider";
import { Server as SocketServer } from "socket.io";
import { DebugLogger } from "../utils/logger"; 
import { RealTradeFeedService } from "../server/websocket/RealTradeFeedService";
import { TokenValidationService } from "./TokenValidationService";
import { exec } from "child_process";
import e from "cors";
import { timeStamp } from "console";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol";

export interface RunningStrategy {
  id: string;
  strategyId: string;
  userId?: string; // User identification for multi-user isolation
  walletAddress?: string; // Wallet address for this strategy
  status: "running" | "stopped" | "paused" | "error";
  startTime: number;
  lastExecutionTime?: number;
  executionCount: number;
  currentContext?: StrategyContext;
  lastResult?: StrategyExecutionResult;
  error?: string;
  intervalId?: NodeJS.Timeout;
  restartDelay: number; // ms between strategy restarts
  trackingEnabled?: boolean; // Whether to track analytics for this strategy
  initialBalanceSOL?: number; // Initial SOL balance when strategy started
  paperTradingMode?: PaperTradingMode; // 'paper' or 'live'
  paperTradingSessionId?: string; // Paper trading session ID if in paper mode
  abortController?: AbortController; // Abort controller for cancelling operations
  isExecuting?: boolean; // Flag to prevent concurrent executions
  retryCount?: number; // Track retry attempts
  maxRetries?: number; // Maximum retry attempts before giving up
  resourceLimits?: {
    maxConcurrentStrategies: number;
    maxDailyExecutions: number;
    maxPositionSize: number;
  };
}

export class StrategyExecutionManager {
  private realTradeFeed?: RealTradeFeedService;
  private eventSubscriptions: Map<string, any> = new Map();
  private runningStrategies: Map<string, RunningStrategy> = new Map();
  private isShuttingDown = false;
  private io: any = null;
  private tokenValidator?: TokenValidationService;
  
  // User-level tracking for multi-user isolation
  private userStrategies: Map<string, Set<string>> = new Map(); // userId -> Set<runningId>
  private userExecutionCount: Map<string, number> = new Map(); // userId -> daily count
  private lastResetDate: Date = new Date();
  
  // Event queue for immediate execution
  private executionQueue: Map<string, Array<{
    runningId: string;
    event: any;
    timestamp: number;
  }>> = new Map();
  private processingQueue: boolean = false;

  // FIX: Rate Limiting (prevents runaway strategies)
  private executionRateLimiter: Map<string, number[]> = new Map();
  private readonly RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
  private readonly MAX_EXECUTIONS_PER_MINUTE = 100;

  // FIX: Circuit Breaker (stops repeatedly failing strategies)
  private failureCount: Map<string, number> = new Map();
  private circuitBreakerTripped: Set<string> = new Set();
  private readonly CIRCUIT_BREAKER_THRESHOLD = 10; // Failures before tripping

  // FIX: Dead Letter Queue (failed trades for manual review)
  private deadLetterQueue: Array<{
    strategyId: string;
    runningId: string;
    event: any;
    error: string;
    timestamp: number;
  }> = [];
  private readonly MAX_DLQ_SIZE = 1000; 

  // Method to set real trade feed service
  setRealTradeFeed(service: RealTradeFeedService): void {
    this.realTradeFeed = service;
    console.log('[StrategyExecutionManager] Real trade feed service connected');
  }

  /**
   * Set token validator for validation before strategy execution
   */
  setTokenValidator(validator: TokenValidationService): void {
    this.tokenValidator = validator;
    console.log('[StrategyExecutionManager] Token validator service connected');
  }

/**
   * Set WebSocket server for real-time updates
   */
  setWebSocketServer(io: any): void {
    this.io = io;
    console.log('✅ StrategyExecutionManager: WebSocket IO configured');
  }

  // Start a strategy for continuous execution
  async startStrategy(
    strategyId: string,
    restartDelay: number = AWS_CONFIG.defaultRestartDelayMs,
    enableTracking: boolean = true,
    initialBalanceSOL?: number,
    paperTradingMode: PaperTradingMode = 'live',
    existingPaperSessionId?: string,
    userId?: string, // User identification for multi-user support
    walletAddress?: string, // Wallet address for strategy
    resourceLimits?: Partial<RunningStrategy['resourceLimits']>
  ): Promise<string> {

    const strategy = strategyBuilder.getStrategy(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const runningId = `${strategyId}-${Date.now()}`;

    // Validate token if strategy uses one
    const tokenAddress = (strategy as any).tokenAddress || strategy.variables?.tokenAddress;
    if (tokenAddress && this.tokenValidator) {
      const tokenInfo = await this.tokenValidator.validateToken(tokenAddress);
      
      if (!tokenInfo.isValid) {
        throw new Error(`Invalid token address: ${tokenAddress}`);
      }
      
      if (!tokenInfo.isPumpFun && strategy.name.includes('PumpFun')) {
        console.warn(`[StrategyExecutionManager] Token ${tokenAddress} may not be a pump.fun token`);
      }
      
      console.log(`[StrategyExecutionManager] Token validated:`, {
        address: tokenAddress,
        symbol: tokenInfo.symbol || 'Unknown',
        supply: tokenInfo.supply,
        isPumpFun: tokenInfo.isPumpFun
      });
    }

    // Stop all old reactive strategies before starting a new one
    // This prevents multiple strategies from monitoring different tokens simultaneously
    if (strategy.name.includes('Reactive') || strategy.name.includes('Mirror')) {
      const oldReactiveStrategies = Array.from(this.runningStrategies.entries())
        .filter(([id, exec]) => {
          const isReactive = exec.strategyId.includes('reactive') || 
                           (strategyBuilder.getStrategy(exec.strategyId)?.name || '').includes('Reactive') ||
                           (strategyBuilder.getStrategy(exec.strategyId)?.name || '').includes('Mirror');
          return isReactive && exec.status === 'running';
        })
        .map(([id]) => id);
      
      if (oldReactiveStrategies.length > 0) {
        console.log(`\n🧹 [CLEANUP] Stopping ${oldReactiveStrategies.length} old reactive strategies before starting new one...`);
        for (const oldId of oldReactiveStrategies) {
          console.log(`🛑 [CLEANUP] Stopping old strategy: ${oldId}`);
          await this.stopStrategy(oldId);
        }
        console.log(`✅ [CLEANUP] All old reactive strategies stopped\n`);
      }
    }

    // Check user limits if userId provided
    if (userId && resourceLimits) {
      const userLimits = {
        maxConcurrentStrategies: resourceLimits.maxConcurrentStrategies || 5,
        maxDailyExecutions: resourceLimits.maxDailyExecutions || 100,
        maxPositionSize: resourceLimits.maxPositionSize || 10,
      };
      
      // Check concurrent strategy limit
      const userStrategySet = this.userStrategies.get(userId) || new Set();
      if (userStrategySet.size >= userLimits.maxConcurrentStrategies) {
        throw new Error(`User limit reached: ${userLimits.maxConcurrentStrategies} concurrent strategies max`);
      }
      
      // Check daily execution limit
      this.checkAndResetDailyLimits();
      const dailyCount = this.userExecutionCount.get(userId) || 0;
      if (dailyCount >= userLimits.maxDailyExecutions) {
        throw new Error(`Daily execution limit reached: ${userLimits.maxDailyExecutions} max`);
      }
    }

    // Subscribe to blockchain events if strategy is reactive
    if (strategy.name.includes('Reactive') || strategy.name.includes('Mirror')) {
      // AWAIT the subscription since it's now async
      await this.subscribeToBlockchainEvents(runningId, strategy);
    }

    if (this.isStrategyRunning(strategyId)) {
      throw new Error(`Strategy ${strategyId} is already running`);
    }

    // Check max concurrent strategies limit
    const runningCount = this.listRunningStrategies().filter(
      (s) => s.status === "running").length;
    if (runningCount >= AWS_CONFIG.maxConcurrentStrategies) {
      throw new Error(
        `Maximum concurrent strategies limit reached (${AWS_CONFIG.maxConcurrentStrategies})`
      );
    }

    // Initialize paper trading session if in paper mode
    let paperTradingSessionId: string | undefined;
    if (paperTradingMode === 'paper') {
      // Check if this is a SELL strategy - if so, we need to start with tokens
      const isSellStrategy = strategy.name.toLowerCase().includes('sell') || 
                             strategy.description.toLowerCase().includes('sell');
      
      // Extract tokenAddress from strategy - check first step's context initialization
      let tokenAddress: string | undefined;
      const initStep = strategy.steps.find(step => 
        step.type === 'condition' && 
        step.id.includes('initialize')
      ) as any;
      
      // Try to extract tokenAddress from strategy context by executing init step temporarily
      if (initStep && initStep.customCondition) {
        const tempContext: any = { variables: {} };
        try {
          initStep.customCondition(tempContext);
          tokenAddress = tempContext.variables.tokenAddress;
        } catch (e) {
          console.log('[StrategyExecutionManager] Could not extract tokenAddress from init step');
        }
      }
      
      // FALLBACK: If tokenAddress is still SOL default and strategy config has a tokenAddress, use it
      if ((!tokenAddress || tokenAddress === 'So11111111111111111111111111111111111111112') && (strategy as any).tokenAddress) {
        console.log(`[StrategyExecutionManager] Using tokenAddress from strategy config: ${(strategy as any).tokenAddress}`);
        tokenAddress = (strategy as any).tokenAddress;
      }
      
      console.log(`[StrategyExecutionManager] Token address for session: ${tokenAddress || 'using ENV default'}`);
      console.log(`[StrategyExecutionManager] Strategy tokenAddress: ${(strategy as any).tokenAddress}`);
      console.log(`[StrategyExecutionManager] Is SOL address: ${tokenAddress === 'So11111111111111111111111111111111111111112'}`);
      
      const initialConfig = {
        initialBalanceSOL: initialBalanceSOL || 10,
        initialBalanceUSDC: 0,
        // For SELL strategies, simulate buying tokens first so we have something to sell
        initialBalanceTokens: isSellStrategy ? 100000 : 0, // Start with 100k tokens for sell strategies
        tokenAddress: tokenAddress, // Pass the token address to the session
      };

      // Check if existing session is provided and actually exists
      if (existingPaperSessionId) {
        const sessionExists = paperTradingEngine.getSession(existingPaperSessionId);
        if (sessionExists) {
          paperTradingSessionId = existingPaperSessionId;
          awsLogger.info('✅ Using existing paper trading session', {
            metadata: { strategyId, runningId, sessionId: paperTradingSessionId }
          });
        } else {
          // Session ID provided but doesn't exist - create it with FIX #7: timeout
          console.log(`⚠️ [StrategyExecutionManager] Provided session ${existingPaperSessionId} doesn't exist, creating it...`);
          
          const sessionPromise = paperTradingEngine.createSession(
            existingPaperSessionId, // Use the provided ID
            undefined,
            strategyId,
            initialConfig
          );
          
          // FIX #7/#9: Add 15 second timeout to handle rate-limited APIs (increased from 8s)
          // Market data APIs (CoinGecko, pump.fun) often have rate limits
          // Strategy should still start even if initial price fetch fails - it will retry
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Session creation timeout after 15s. Market data sources may be temporarily unavailable.')), 15000)
          );
          
          try {
            const paperSession = await Promise.race([sessionPromise, timeoutPromise]) as any;
            paperTradingSessionId = paperSession.sessionId;
            
            awsLogger.info(`📝 Paper trading session created with provided ID (${isSellStrategy ? 'SELL strategy - initialized with tokens' : 'BUY strategy'})`, {
              metadata: { strategyId, runningId, sessionId: paperTradingSessionId, initialTokens: initialConfig.initialBalanceTokens }
            });
          } catch (error) {
            // Allow strategy to start even if price fetch fails
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            if (errorMsg.includes('timeout')) {
              // Don't fail - create session without initial price (will retry later)
              awsLogger.warn(`⚠️ Session creation timed out, creating session without initial price`, {
                metadata: { strategyId, runningId }
              });
              
              // Create minimal session without waiting for market data
              paperTradingSessionId = existingPaperSessionId;
              
              // Log warning but continue
              console.warn(`⚠️ [STRATEGY START] Market data temporarily unavailable, starting with cached/fallback prices`);
              console.warn(`⚠️ [STRATEGY START] Prices will be refreshed on first trade execution`);
            } else if (errorMsg.includes('Market data unavailable')) {
              // Same relaxed handling for market data errors
              awsLogger.warn(`⚠️ Market data unavailable, starting with fallback prices`, {
                metadata: { strategyId, runningId }
              });
              paperTradingSessionId = existingPaperSessionId;
              console.warn(`⚠️ [STRATEGY START] Using fallback prices, will refresh on execution`);
            } else {
              // Only throw for non-timeout, non-market-data errors
              throw error;
            }
          }
        }
      } else {
        // No session ID provided, create a new one with FIX #7: timeout
        const sessionPromise = paperTradingEngine.createSession(
          runningId,
          undefined,
          strategyId,
          initialConfig
        );
        
        // FIX #7/#9: Add 15 second timeout to handle rate-limited APIs (increased from 8s)
        // Market data APIs (CoinGecko, pump.fun) often have rate limits
        // Strategy should still start even if initial price fetch fails - it will retry
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Session creation timeout after 15s. Market data sources may be temporarily unavailable.')), 15000)
        );
        
        try {
          const paperSession = await Promise.race([sessionPromise, timeoutPromise]) as any;
          paperTradingSessionId = paperSession.sessionId;
          
          awsLogger.info(`🆕 Paper trading session created (${isSellStrategy ? 'SELL strategy - initialized with tokens' : 'BUY strategy'})`, {
            metadata: { strategyId, runningId, sessionId: paperTradingSessionId, initialTokens: initialConfig.initialBalanceTokens }
          });
        } catch (error) {
          // RELAXED ERROR HANDLING: Allow strategy to start even if price fetch fails
          const errorMsg = error instanceof Error ? error.message : String(error);
          
          if (errorMsg.includes('timeout')) {
            // Don't fail - create session without initial price (will retry later)
            awsLogger.warn(`⚠️ Session creation timed out, creating session without initial price`, {
              metadata: { strategyId, runningId }
            });
            
            // Create minimal session without waiting for market data
            paperTradingSessionId = runningId;
            
            // Log warning but continue
            console.warn(`⚠️ [STRATEGY START] Market data temporarily unavailable, starting with cached/fallback prices`);
            console.warn(`⚠️ [STRATEGY START] Prices will be refreshed on first trade execution`);
          } else if (errorMsg.includes('Market data unavailable')) {
            // Same relaxed handling for market data errors
            awsLogger.warn(`⚠️ Market data unavailable, starting with fallback prices`, {
              metadata: { strategyId, runningId }
            });
            paperTradingSessionId = runningId;
            console.warn(`⚠️ [STRATEGY START] Using fallback prices, will refresh on execution`);
          } else {
            // Only throw for non-timeout, non-market-data errors
            throw error;
          }
        }
      }

      // Configure StrategyBuilder to use Paper Trading Provider
      const paperProvider = new PaperTradingProvider(
        paperTradingSessionId!, // Non-null assertion since we just created it
        strategyId,
        strategy.name,
        tokenAddress // Pass the token address to the provider
      );
      strategyBuilder.setTradingProvider(paperProvider);
      
  // StrategyBuilder configured for PAPER trading
    } else {
      // Ensure we're using live trading provider
      const { TradingProviderFactory } = require('./TradingProvider');
      strategyBuilder.setTradingProvider(TradingProviderFactory.getInstance());
      
    }

    // Initialize tracking if enabled
    if (enableTracking) {
      try {
        // Use provided balance or default to 0 (will be updated on first execution)
        const initialBalance = initialBalanceSOL || 0;
        
        // Initialize tracker
        await strategyExecutionTracker.initializeStrategy(
          runningId,
          strategy.name,
          initialBalance
        );
        
        awsLogger.info('Analytics tracking initialized', {
          metadata: { strategyId, runningId, initialBalanceSOL: initialBalance, mode: paperTradingMode }
        });
      } catch (error) {
        awsLogger.warn('Failed to initialize analytics tracking', {
          metadata: { strategyId, error: error instanceof Error ? error.message : String(error) }
        });
        enableTracking = false;
      }
    }

    const runningStrategy: RunningStrategy = {
      id: runningId,
      strategyId,
      userId,
      walletAddress: walletAddress || 'unknown',
      status: "running",
      startTime: Date.now(),
      executionCount: 0,
      restartDelay,
      trackingEnabled: enableTracking,
      initialBalanceSOL,
      paperTradingMode,
      paperTradingSessionId,
      abortController: new AbortController(), // Create abort controller
      retryCount: 0, // Initialize retry count
      maxRetries: 3, // Default max retries
      resourceLimits: resourceLimits ? {
        maxConcurrentStrategies: resourceLimits.maxConcurrentStrategies || 5,
        maxDailyExecutions: resourceLimits.maxDailyExecutions || 100,
        maxPositionSize: resourceLimits.maxPositionSize || 10,
      } : undefined,
    };

    this.runningStrategies.set(runningId, runningStrategy);
    
    // Track user's strategies if userId provided
    if (userId) {
      if (!this.userStrategies.has(userId)) {
        this.userStrategies.set(userId, new Set());
      }
      this.userStrategies.get(userId)!.add(runningId);
      
      // Increment daily count
      const dailyCount = this.userExecutionCount.get(userId) || 0;
      this.userExecutionCount.set(userId, dailyCount + 1);
    }
    
    this.executeStrategyContinuously(runningId);

    awsLogger.strategyStarted(strategyId, runningId);
    awsLogger.info(`Strategy started in ${paperTradingMode} mode`, {
      metadata: { strategyId, runningId, paperTradingMode }
    });
    
    return runningId;
  }

  // Stop a running strategy
  async stopStrategy(runningId: string): Promise<boolean> {
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Called for runningId: ${runningId}`);
    
    const runningStrategy = this.runningStrategies.get(runningId);
    if (!runningStrategy) {
      DebugLogger.debug(`❌ [DEBUG stopStrategy] Strategy ${runningId} NOT FOUND in runningStrategies map`);
      DebugLogger.debug(`🔍 [DEBUG stopStrategy] Available strategies: ${Array.from(this.runningStrategies.keys()).join(', ')}`);
      return false;
    }

    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Current strategy state: status=${runningStrategy.status}, isExecuting=${runningStrategy.isExecuting}`);

    // Unsubscribe from blockchain events
    const subscription = this.eventSubscriptions.get(runningId);
    if (subscription && this.realTradeFeed) {
      // Stop polling the token
      await this.realTradeFeed.unsubscribeFromToken(subscription.tokenAddress, runningId);
      // Remove event listener
      this.realTradeFeed.off(`trade:${subscription.tokenAddress}`, subscription.handler);
      this.eventSubscriptions.delete(runningId);
      console.log(`[StrategyExecutionManager] ✅ Unsubscribed ${runningId} from ${subscription.tokenAddress} events`);
    }

    // Remove from user's strategy set
    const userId = runningStrategy.userId;
    if (userId) {
      const userStrategySet = this.userStrategies.get(userId);
      if (userStrategySet) {
        userStrategySet.delete(runningId);
        if (userStrategySet.size === 0) {
          this.userStrategies.delete(userId);
        }
      }
    }

    //FIX #1: ABORT the running execution immediately using AbortController
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Step 1: Aborting running execution`);
    if (runningStrategy.abortController) {
      runningStrategy.abortController.abort();
      console.log(`🛑 [StrategyExecutionManager] Abort signal sent for ${runningId}`);
    }

    // FIX #2: Set status to stopped to prevent new executions
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Step 2: Setting status to 'stopped'`);
    runningStrategy.status = "stopped";

    // FIX #3: Set stop flag in context to break reactive/looping strategies
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Step 3: Setting stop flag in context`);
    if (runningStrategy.currentContext) {
      runningStrategy.currentContext.variables._shouldStop = true;
      DebugLogger.debug(`🛑 [StrategyExecutionManager] Stop flag set in existing context for ${runningId}`);
    } else {
      // Context doesn't exist yet, create it with stop flag
      runningStrategy.currentContext = {
        strategyId: runningStrategy.strategyId,
        currentStepId: '',
        variables: { _shouldStop: true },
        stepResults: {},
        startTime: Date.now(),
        logs: []
      };
      DebugLogger.debug(`🛑 [StrategyExecutionManager] Created new context with stop flag for ${runningId}`);
    }

    // FIX #4: Clear any pending timeouts IMMEDIATELY
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Step 4: Clearing pending timeouts`);
    if (runningStrategy.intervalId) {
      clearTimeout(runningStrategy.intervalId);
      runningStrategy.intervalId = undefined;
      DebugLogger.debug(`✅ [DEBUG stopStrategy] Timeout cleared successfully`);
    }

    // FIX #5: Set isExecuting to false to unblock any waiting logic
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Step 5: Setting isExecuting to false`);
    runningStrategy.isExecuting = false;

    // FIX #6: EMIT WebSocket event to notify UI IMMEDIATELY
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Step 6: Emitting WebSocket event`);
    if (this.io) {
      this.io.emit('strategy:stopped', {
        strategyId: runningStrategy.strategyId,
        runningId: runningId,
        timestamp: Date.now(),
        executionCount: runningStrategy.executionCount
      });
      console.log(`📡 [StrategyExecutionManager] Broadcasted strategy:stopped event for ${runningStrategy.strategyId}`);
    }

    // FIX #7: End paper trading session ONLY if it was created by the strategy
    DebugLogger.debug(`🔍 [DEBUG stopStrategy] Step 7: Handling paper trading session`);
    if (runningStrategy.paperTradingMode === 'paper' && runningStrategy.paperTradingSessionId) {
      const isUiSession = runningStrategy.paperTradingSessionId.startsWith('paper-ui-');
      
      if (!isUiSession) {
        await paperTradingEngine.endSession(runningStrategy.paperTradingSessionId);
        awsLogger.info('Paper trading session ended', {
          metadata: { runningId, sessionId: runningStrategy.paperTradingSessionId }
        });
        DebugLogger.debug(`✅ [DEBUG stopStrategy] Paper trading session ended: ${runningStrategy.paperTradingSessionId}`);
      } else {
        awsLogger.info('Keeping UI paper trading session alive', {
          metadata: { runningId, sessionId: runningStrategy.paperTradingSessionId }
        });
        DebugLogger.debug(`ℹ️ [DEBUG stopStrategy] Keeping UI paper trading session alive`);
      }
    }

    // FIX #8: Complete tracking
    if (runningStrategy.trackingEnabled) {
      strategyExecutionTracker.completeStrategy(runningId);
      DebugLogger.debug(`✅ [DEBUG stopStrategy] Tracking completed`);
    }

    awsLogger.strategyStopped(runningStrategy.strategyId, runningId);
    
    console.log(`✅ [StrategyExecutionManager] Strategy ${runningId} STOPPED successfully`);
    
    return true;
  }

  // Stop all running strategies
  async stopAllStrategies(): Promise<void> {
    this.isShuttingDown = true;
    const stopPromises = Array.from(this.runningStrategies.keys()).map((id) =>
      this.stopStrategy(id)
    );
    await Promise.all(stopPromises);
    awsLogger.info("All strategies stopped");
  }

  // Get running strategy status
  getStrategyStatus(runningId: string): RunningStrategy | undefined {
    return this.runningStrategies.get(runningId);
  }

  // List all running strategies
  listRunningStrategies(): RunningStrategy[] {
    return Array.from(this.runningStrategies.values());
  }

  // Check if a strategy is already running
  private isStrategyRunning(strategyId: string): boolean {
    return Array.from(this.runningStrategies.values()).some(
      (rs) => rs.strategyId === strategyId && rs.status === "running"
    );
  }

  // Execute strategy continuously
  private async executeStrategyContinuously(runningId: string): Promise<void> {
    const runningStrategy = this.runningStrategies.get(runningId);
    
    // FIX #2: RACE CONDITION PROTECTION - Check stop flag FIRST before any execution
    if (runningStrategy?.currentContext?.variables._shouldStop === true) {
      console.log(`🛑 [StrategyExecutionManager] Stop flag detected for ${runningId} - ABORTING execution`);
      runningStrategy.status = 'stopped';
      runningStrategy.isExecuting = false;
      return;
    }
    
    // FIX #2: Enhanced status checks with atomic flag setting
    if (
      !runningStrategy ||
      runningStrategy.status !== "running" ||
      this.isShuttingDown
    ) {
      console.log(`⏹️ [StrategyExecutionManager] Strategy ${runningId} not running (status: ${runningStrategy?.status}), STOPPING execution loop`);
      return;
    }

    // FIX #2: Atomic compare-and-swap to prevent race condition
    if (runningStrategy.isExecuting) {
      console.log(`⚠️ [StrategyExecutionManager] Strategy ${runningId} is already executing, skipping`);
      return;
    }

    // EVENT-DERIVEN  OPTIMIZATION
    // CHECK if strategy is in event only mode
    const strategy = strategyBuilder.getStrategy(runningStrategy.strategyId);
    const isEventDriven = strategy?.name?.includes('Reactive') ||
                          strategy?.name?.includes('Mirror')||
                          runningStrategy.currentContext?.variables.eventDrivenMode === true;

    
    // For event-driven strategies, waiting for trigger, skip perodic execution
    // They will be triggered immediately by handleRealTimeEvent -> processExecutionQueue
    if (isEventDriven && runningStrategy.currentContext?.currentStepId?.includes('wait_for_trigger')) {
      console.log(`[StrategyExecutionManager] Event-driven strategy ${runningId} waiting for trigger - skipping perodic execution`);
      console.log(`Current step: ${runningStrategy.currentContext?.currentStepId}`);
      console.log(`Real trade detected: ${runningStrategy.currentContext?.variables.realTradeDetected}`);

      // Schedule next check with longer delay (event will trigger immediately anyway)
      // This periodic check is only for cleanup, stop checks, and heartbeat
      runningStrategy.intervalId = setTimeout(() => {
        this.executeStrategyContinuously(runningId);
      }, 5000); // check every 5 seconds only for cleanup/stop checks
      return;
    }

    /*
    NORMAL EXECUTION FLOW (for non-event-driven strategies or active steps) 
    */

    // Set executing flag atomically
    runningStrategy.isExecuting = true;

    try {
      awsLogger.debug("Starting strategy execution", {
        strategyId: runningStrategy.strategyId,
        runningId,
        executionCount: runningStrategy.executionCount + 1,
      });

      // FIX #3: Check stop flag again before execution
      if (runningStrategy.currentContext?.variables._shouldStop === true || runningStrategy.status !== 'running') {
        console.log(`🛑 [StrategyExecutionManager] Stop condition detected before execution - ABORTING`);
        runningStrategy.isExecuting = false;
        runningStrategy.status = 'stopped';
        return;
      }

      // Pass existing context to preserve state between executions (critical for iteration counting!)
      const result = await strategyBuilder.executeStrategy(
        runningStrategy.strategyId,
        runningStrategy.currentContext, // Preserve executionCount and other variables
        runningStrategy.abortController?.signal // CRITICAL: Pass abort signal for immediate cancellation
      );
      
      DebugLogger.debug(`🔍 [DEBUG executeStrategyContinuously] Execution result: success=${result.success}, completed=${result.completed}, subscriptionRequested=${result.subscriptionRequested}`);

      // Subscribe to real trade feed for ALL strategies that need it
      // This check happens BEFORE any stop/abort logic, ensuring subscription during normal operation
      const tokenAddress = result.context.variables.tokenAddress;
      const strategy = strategyBuilder.getStrategy(runningStrategy.strategyId);
      
      // Subscribe if:
      // 1. Strategy explicitly requested subscription (reactive strategies with _needsSubscription flag)
      // 2. OR strategy is already waiting for real trades (AI-First strategies in wait_for_trigger/detect_activity steps)
      const needsSubscription = result.subscriptionRequested === true || 
                               result.context.currentStepId?.includes('wait_for_trigger') ||
                               result.context.currentStepId?.includes('detect_activity');
      
      if (needsSubscription && !this.eventSubscriptions.has(runningId) && strategy && tokenAddress) {
        console.log(`🔥 [SUBSCRIPTION] Strategy needs real-time trade data (step: ${result.context.currentStepId})`);
        console.log(`🔥 [SUBSCRIPTION] Subscribing during iteration ${runningStrategy.executionCount + 1}`);
        await this.subscribeToBlockchainEvents(runningId, { ...strategy, tokenAddress });
        console.log(`✅ [SUBSCRIPTION] Successfully subscribed - strategy will now receive real-time trades!`);
      }

      runningStrategy.lastExecutionTime = Date.now();
      runningStrategy.executionCount++;
      runningStrategy.lastResult = result;
      
      // FIX #4: Preserve _shouldStop flag BEFORE updating context
      const shouldStopBeforeUpdate = runningStrategy.currentContext?.variables._shouldStop === true;
      DebugLogger.debug(`🔍 [DEBUG executeStrategyContinuously] Stop flag before context update: ${shouldStopBeforeUpdate}`);
      
      runningStrategy.currentContext = result.context; // Save context for next execution
      
      // CRITICAL: If stop flag was set BEFORE execution finished, restore it
      if (shouldStopBeforeUpdate) {
        runningStrategy.currentContext.variables._shouldStop = true;
        DebugLogger.debug(`🛑 [StrategyExecutionManager] Preserved stop flag in context after execution`);
      }
      
      DebugLogger.debug(`🔍 [DEBUG executeStrategyContinuously] Context updated, executionCount=${runningStrategy.executionCount}`);

      // FIX #5: Check if stop was requested during execution
      if (runningStrategy.currentContext?.variables._shouldStop === true || runningStrategy.status !== 'running') {
        console.log(`🛑 [StrategyExecutionManager] Stop condition detected after execution - STOPPING strategy`);
        runningStrategy.status = 'stopped';
        runningStrategy.isExecuting = false;
        
        // Clear any pending timeout
        if (runningStrategy.intervalId) {
          clearTimeout(runningStrategy.intervalId);
          runningStrategy.intervalId = undefined;
        }
        
        // Emit stopped event
        if (this.io) {
          this.io.emit('strategy:stopped', {
            strategyId: runningStrategy.strategyId,
            runningId: runningId,
            timestamp: Date.now(),
            executionCount: runningStrategy.executionCount
          });
          DebugLogger.debug(`📡 [StrategyExecutionManager] Emitted strategy:stopped event`);
        }
        
        return; // Exit without scheduling next execution
      }

      // Check if strategy has completed all steps
      if (result.completed) {
        console.log(`✅ [StrategyExecutionManager] Strategy ${runningId} completed all steps after ${runningStrategy.executionCount} executions`);
        awsLogger.info('Strategy completed all steps', {
          strategyId: runningStrategy.strategyId,
          runningId,
          executionCount: runningStrategy.executionCount,
          metadata: { totalTime: Date.now() - runningStrategy.startTime }
        });
        
        // Stop the strategy
        runningStrategy.status = 'stopped';
        if (runningStrategy.trackingEnabled) {
          strategyExecutionTracker.completeStrategy(runningId);
        }
        runningStrategy.isExecuting = false;
        
        // Emit completed event
        if (this.io) {
          this.io.emit('strategy:completed', {
            strategyId: runningStrategy.strategyId,
            runningId: runningId,
            timestamp: Date.now(),
            executionCount: runningStrategy.executionCount
          });
        }
        
        return; // Exit the continuous execution loop
      }

      // Track trade execution if analytics enabled
      if (runningStrategy.trackingEnabled && result.success) {
        await this.trackExecution(runningId, result);
      }

      awsLogger.strategyExecution(
        runningStrategy.strategyId,
        runningId,
        runningStrategy.executionCount,
        result.success
      );

      if (!result.success) {
        runningStrategy.error = result.error;
        
        // Record failure in tracker
        if (runningStrategy.trackingEnabled) {
          strategyExecutionTracker.recordFailure(runningId, result.error || 'Unknown error');
        }
        
        awsLogger.warn("Strategy execution failed", {
          strategyId: runningStrategy.strategyId,
          runningId,
          executionCount: runningStrategy.executionCount,
          metadata: { error: result.error },
        });
      }

      // Clear executing flag before scheduling next
      runningStrategy.isExecuting = false;
      DebugLogger.debug(`🔍 [DEBUG executeStrategyContinuously] Executing flag set to FALSE`);

      // FIX #6: COMPREHENSIVE CHECK before scheduling next execution
      const currentStrategy = this.runningStrategies.get(runningId);
      const shouldContinue = currentStrategy && 
                            currentStrategy.status === "running" && 
                            !this.isShuttingDown &&
                            !currentStrategy.currentContext?.variables._shouldStop;
      
      DebugLogger.debug(`🔍 [DEBUG executeStrategyContinuously] Should continue: ${shouldContinue}, status=${currentStrategy?.status}`);
      
      if (shouldContinue) {
        const isWaitingForEvent = runningStrategy.currentContext?.currentStepId?.includes('wait_for_trigger');
        const adaptiveDelay = isWaitingForEvent ? 5000 : runningStrategy.restartDelay;

        console.log(`[StrategyExecutionManager] Scheduling next execution in ${adaptiveDelay}ms (waiting for event: ${isWaitingForEvent})`);

        runningStrategy.intervalId = setTimeout(() => {
          // Fix #7: DOUBLE-CHECK  before executing (timeout could fire after stop)
          const strategy = this.runningStrategies.get(runningId);
          if(strategy && 
            strategy.status === 'running' && 
            !strategy.currentContext?.variables._shouldStop &&
            !this.isShuttingDown) {
              DebugLogger.debug(`[StrategyExecutionManager] Timeout fired - conditions valid - executing ${runningId}`);
              this.executeStrategyContinuously(runningId);
            }else{
              DebugLogger.debug(`[StrategyExecutionManager] Timeout fired but strategy ${runningId} stopped - NOT executing`);
            }
        }, adaptiveDelay);
      } else {
        DebugLogger.debug(`⏹️ [StrategyExecutionManager] NOT scheduling next execution for ${runningId} - strategy stopped`);
      }
    } catch (error) {
      // Always clear executing flag in catch block
      runningStrategy.isExecuting = false;
      DebugLogger.debug(`❌ [DEBUG executeStrategyContinuously] Exception caught, executing flag set to FALSE`);

      runningStrategy.status = "error";
      runningStrategy.error =
        error instanceof Error ? error.message : String(error);

      // Track retry count
      runningStrategy.retryCount = (runningStrategy.retryCount || 0) + 1;
      const maxRetries = runningStrategy.maxRetries || 3;
      
      console.log(`❌ [StrategyExecutionManager] Error in ${runningId} (retry ${runningStrategy.retryCount}/${maxRetries}):`, error);

      // Record failure in tracker
      if (runningStrategy.trackingEnabled) {
        strategyExecutionTracker.recordFailure(
          runningId, 
          error instanceof Error ? error.message : String(error)
        );
        strategyExecutionTracker.failStrategy(runningId, runningStrategy.error);
      }

      awsLogger.strategyError(
        runningStrategy.strategyId,
        runningId,
        error as Error
      );

      // FIX #8: Check stop flag even in error case
      if (runningStrategy.currentContext?.variables._shouldStop === true || this.isShuttingDown) {
        console.log(`🛑 [StrategyExecutionManager] Stop flag detected in error handler - NOT retrying`);
        runningStrategy.status = 'stopped';
        return;
      }

      // Only retry if under max retries
      if (runningStrategy.retryCount < maxRetries) {
        console.log(`🔄 [StrategyExecutionManager] Retrying strategy (attempt ${runningStrategy.retryCount}/${maxRetries})`);
        runningStrategy.intervalId = setTimeout(() => {
          // FIX #9: Check all conditions before retry
          const strategy = this.runningStrategies.get(runningId);
          if (strategy && 
              !this.isShuttingDown && 
              !strategy.currentContext?.variables._shouldStop) {
            strategy.status = "running";
            strategy.error = undefined;
            this.executeStrategyContinuously(runningId);
          } else {
            console.log(`⚠️ [StrategyExecutionManager] Strategy ${runningId} stopped or removed, skipping retry`);
          }
        }, runningStrategy.restartDelay);
      } else {
        // Give up after max retries
        console.error(`❌ [StrategyExecutionManager] Strategy ${runningId} failed after ${maxRetries} retries, STOPPING`);
        runningStrategy.status = "error";
        
        // Notify UI of permanent failure
        if (this.io) {
          this.io.emit('strategy:failed', {
            strategyId: runningStrategy.strategyId,
            runningId: runningId,
            error: runningStrategy.error,
            retryCount: runningStrategy.retryCount,
            timestamp: Date.now()
          });
          console.log(`📡 [StrategyExecutionManager] Broadcasted strategy:failed event for ${runningId}`);
        }
      }
    }
  }

  // ADD: New method for blockchain event subscription
  private async subscribeToBlockchainEvents(runningId: string, strategy: any): Promise<void> {
    if (!this.realTradeFeed) {
      console.warn(`[StrategyExecutionManager] RealTradeFeedService not available`);
      return;
    }
    const tokenAddress = strategy.tokenAddress || strategy.variables?.tokenAddress;
    if (!tokenAddress) {
      console.warn(`[StrategyExecutionManager] No token address in strategy ${strategy.id}`);
      return;
    }
    
    // CRITICAL: Normalize to lowercase for consistent event matching
    const normalizedToken = tokenAddress.toLowerCase();
    
    // Tell RealTradeFeedService to START polling this token!
    console.log(`[StrategyExecutionManager] 🚀 Starting pump.fun trade polling for ${tokenAddress.substring(0, 8)}...`);
    console.log(`[StrategyExecutionManager] 📝 Subscribing to: trade:${normalizedToken}`);
    const subscribed = await this.realTradeFeed.subscribeToToken(normalizedToken, runningId);
    
    if (!subscribed) {
      console.error(`[StrategyExecutionManager] ❌ Failed to subscribe to token ${tokenAddress}`);
      return;
    }
    
    // Now listen for the events using LOWERCASE token address
    const eventHandler = (tradeEvent: any) => {
      console.log(`[StrategyExecutionManager] 🔔 Real trade detected for ${runningId}:`, tradeEvent);
      // Trigger immediate execution
      this.handleRealTimeEvent(runningId, tradeEvent);
    };
    
    this.realTradeFeed.on(`trade:${normalizedToken}`, eventHandler);
    this.eventSubscriptions.set(runningId, { tokenAddress: normalizedToken, handler: eventHandler });
    
    console.log(`[StrategyExecutionManager] ✅ Subscribed ${runningId} to trade:${normalizedToken}`);
  }

  // Real-time event handler
  private async handleRealTimeEvent(runningId: string, tradeEvent: any): Promise<void> {
    const execution = this.runningStrategies.get(runningId);
    if (!execution || execution.status !== "running" || !execution.currentContext) {
      return;
    }
    
    // Add to execution queue for immediate processing
    if (!this.executionQueue.has(runningId)) {
      this.executionQueue.set(runningId, []);
    }
    
    this.executionQueue.get(runningId)!.push({
      runningId,
      event: tradeEvent,
      timestamp: Date.now()
    });
    
    // Start processing if not already running
    if (!this.processingQueue) {
      setImmediate(() => this.processExecutionQueue());
    }
    
    // Update strategy context with real-time data
    // This is the bridge between blockchain events and strategy logic!
    execution.currentContext.variables.lastRealTrade = tradeEvent;
    execution.currentContext.variables.realTradeDetected = true; // ← Strategy steps wait for this flag
    execution.currentContext.variables.realTradeType = tradeEvent.type;
    execution.currentContext.variables.realTradePrice = tradeEvent.price;
    execution.currentContext.variables.realTradeSolAmount = tradeEvent.solAmount ?? tradeEvent.amountInSol;
    execution.currentContext.variables.realTradeTokenAmount = tradeEvent.tokenAmount;
    execution.currentContext.variables.realTradeSignature = tradeEvent.signature;
    
    // Set detectedVolume for mirror strategies
    // Reactive mirror strategies use this variable in calculate_sell_amount step
    execution.currentContext.variables.detectedVolume = tradeEvent.solAmount;
    
    console.log(`🔥 [REAL TRADE EVENT] Strategy ${runningId} context updated:`, {
      type: tradeEvent.type,
      solAmount: tradeEvent.solAmount,
      detectedVolume: execution.currentContext.variables.detectedVolume,
      currentStep: execution.currentContext.currentStepId
    });

    // If strategy is waiting for a trigger, wake it up
    if (
      execution.currentContext.currentStepId?.includes('wait_for_trigger') ||
      execution.currentContext.currentStepId?.includes('detect_activity')
    ) {
      console.log(`[StrategyExecutionManager] Waking up strategy ${runningId} for real trade`);
      // Strategy will continue execution on next cycle
    }
  }

  /**
   * Process execution queue for immediate event-driven execution
   */
  private async processExecutionQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.executionQueue.size > 0) {
      for (const [runningId, events] of this.executionQueue.entries()) {
        if (events.length === 0) {
          this.executionQueue.delete(runningId);
          continue;
        }

        const event = events.shift()!;
        const execution = this.runningStrategies.get(runningId);
        
        if (!execution || execution.status !== 'running') {
          continue;
        }

        // Execute immediately without delay
        await this.executeImmediateAction(execution, event);
      }

      // Small yield to prevent blocking
      await new Promise(resolve => setImmediate(resolve));
    }

    this.processingQueue = false;
  }

  /**
 * Immediate action executor for real-time events
 * FIXED: Now actually executes the strategy immediately
 */
private async executeImmediateAction(
  execution: RunningStrategy,
  event: any
): Promise<void> {
  console.log(`🚀 [StrategyExecutionManager] IMMEDIATE execution triggered for ${execution.id}`);
  
  if (!execution.currentContext) {
    console.warn(`[StrategyExecutionManager] No context for ${execution.id}, cannot execute`);
    return;
  }
  
  // FIX: Check rate limit BEFORE execution
  if (!this.checkRateLimit(execution.strategyId)) {
    console.error(`🚨 [RATE LIMIT] Blocking execution for ${execution.id}`);
    this.addToDeadLetterQueue(execution.strategyId, execution.id, event, 'Rate limit exceeded');
    return;
  }

  // FIX: Check circuit breaker BEFORE execution
  if (!this.checkCircuitBreaker(execution.strategyId)) {
    console.error(`🚨 [CIRCUIT BREAKER] Blocking execution for ${execution.id}`);
    this.addToDeadLetterQueue(execution.strategyId, execution.id, event, 'Circuit breaker tripped');
    return;
  }
  
  // Prevent concurrent execution
  if (execution.isExecuting) {
    console.log(`⚠️ [StrategyExecutionManager] Strategy ${execution.id} already executing, queuing for next cycle`);
    return;
  }
  
  // Check if strategy is still running
  if (execution.status !== 'running') {
    console.log(`⚠️ [StrategyExecutionManager] Strategy ${execution.id} status is ${execution.status}, skipping execution`);
    return;
  }
  
  execution.isExecuting = true;
  const executionStartTime = Date.now();
  
  try {
    // Update context with event data
    execution.currentContext.variables.lastEvent = event;
    execution.currentContext.variables.eventTriggered = true;
    
    console.log(`⏱️ [StrategyExecutionManager] Starting immediate execution for ${execution.id} at step: ${execution.currentContext.currentStepId}`);
    
    // Actually execute the strategy NOW
    const result = await strategyBuilder.executeStrategy(
      execution.strategyId,
      execution.currentContext,
      execution.abortController?.signal
    );
    
    const executionEndTime = Date.now();
    const executionDuration = executionEndTime - executionStartTime;
    
    console.log(`✅ [StrategyExecutionManager] Immediate execution completed in ${executionDuration}ms:`, {
      runningId: execution.id,
      success: result.success,
      completed: result.completed,
      currentStep: result.context.currentStepId,
      executionCount: execution.executionCount + 1
    });
    
    // Update execution state
    execution.lastExecutionTime = Date.now();
    execution.executionCount++;
    execution.lastResult = result;
    
    // Preserve stop flag if it was set
    const shouldStopBeforeUpdate = execution.currentContext?.variables._shouldStop === true;
    execution.currentContext = result.context;
    
    if (shouldStopBeforeUpdate) {
      execution.currentContext.variables._shouldStop = true;
      console.log(`🛑 [StrategyExecutionManager] Preserved stop flag after immediate execution`);
    }
    
    // FIX: Record success/failure for circuit breaker
    if (result.success) {
      this.recordSuccess(execution.strategyId);
    } else {
      this.recordFailure(execution.strategyId);
      this.addToDeadLetterQueue(execution.strategyId, execution.id, event, result.error || 'Execution failed');
    }

    // Track execution if enabled
    if (execution.trackingEnabled && result.success) {
      await this.trackExecution(execution.id, result);
    }
    
    // Handle strategy completion
    if (result.completed) {
      console.log(`🏁 [StrategyExecutionManager] Strategy ${execution.id} completed after immediate execution`);
      execution.status = 'stopped';
      if (execution.trackingEnabled) {
        strategyExecutionTracker.completeStrategy(execution.id);
      }
      
      // Emit completed event
      if (this.io) {
        this.io.emit('strategy:completed', {
          strategyId: execution.strategyId,
          runningId: execution.id,
          timestamp: Date.now(),
          executionCount: execution.executionCount
        });
      }
    }
    
    // Check if stop was requested during execution
    if (execution.currentContext?.variables._shouldStop === true || execution.status !== 'running') {
      console.log(`🛑 [StrategyExecutionManager] Stop condition detected after immediate execution`);
      execution.status = 'stopped';
      
      // Clear any pending timeout
      if (execution.intervalId) {
        clearTimeout(execution.intervalId);
        execution.intervalId = undefined;
      }
      
      // Emit stopped event
      if (this.io) {
        this.io.emit('strategy:stopped', {
          strategyId: execution.strategyId,
          runningId: execution.id,
          timestamp: Date.now(),
          executionCount: execution.executionCount
        });
      }
    }
    
    // Warn if execution was slow
    if (executionDuration > 1000) {
      console.warn(`⚠️ [SLOW EXECUTION] Strategy ${execution.id} took ${executionDuration}ms - optimize!`);
    }
    
  } catch (error) {
    const executionEndTime = Date.now();
    const executionDuration = executionEndTime - executionStartTime;
    
    console.error(`❌ [StrategyExecutionManager] Error in immediate execution after ${executionDuration}ms:`, error);
    execution.error = error instanceof Error ? error.message : String(error);
    execution.retryCount = (execution.retryCount || 0) + 1;
    
    // FIX: Record failure and add to dead letter queue
    this.recordFailure(execution.strategyId);
    this.addToDeadLetterQueue(execution.strategyId, execution.id, event, execution.error);
    
    // Emit error event
    if (this.io) {
      this.io.emit('strategy:error', {
        strategyId: execution.strategyId,
        runningId: execution.id,
        error: execution.error,
        timestamp: Date.now()
      });
    }
    
    // If too many failures, stop the strategy
    const maxRetries = execution.maxRetries || 10;
    if (execution.retryCount >= maxRetries) {
      console.error(`❌ [StrategyExecutionManager] Strategy ${execution.id} failed ${maxRetries} times, stopping`);
      execution.status = 'error';
      
      if (this.io) {
        this.io.emit('strategy:failed', {
          strategyId: execution.strategyId,
          runningId: execution.id,
          error: execution.error,
          retryCount: execution.retryCount,
          timestamp: Date.now()
        });
      }
    }
    
  } finally {
    execution.isExecuting = false;
  }
}
  

  /**
   * Check and reset daily limits
   */
  private checkAndResetDailyLimits(): void {
    const now = new Date();
    const daysDiff = Math.floor((now.getTime() - this.lastResetDate.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysDiff >= 1) {
      this.userExecutionCount.clear();
      this.lastResetDate = now;
      console.log('[StrategyExecutionManager] Daily limits reset');
    }
  }

  /**
   * FIX: Rate Limiter - Prevents runaway strategies
   * Returns true if execution is allowed, false if rate limit exceeded
   */
  private checkRateLimit(strategyId: string): boolean {
    const now = Date.now();
    
    if (!this.executionRateLimiter.has(strategyId)) {
      this.executionRateLimiter.set(strategyId, []);
    }
    
    const executions = this.executionRateLimiter.get(strategyId)!;
    
    // Remove old executions outside window
    const recentExecutions = executions.filter(time => now - time < this.RATE_LIMIT_WINDOW_MS);
    this.executionRateLimiter.set(strategyId, recentExecutions);
    
    if (recentExecutions.length >= this.MAX_EXECUTIONS_PER_MINUTE) {
      console.error(`🚨 [RATE LIMIT] Strategy ${strategyId} exceeded ${this.MAX_EXECUTIONS_PER_MINUTE} executions per minute`);
      console.error(`🚨 [RATE LIMIT] Current rate: ${recentExecutions.length} executions in last minute`);
      
      // Emit alert
      if (this.io) {
        this.io.emit('strategy:rate-limit-exceeded', {
          strategyId,
          executionCount: recentExecutions.length,
          limit: this.MAX_EXECUTIONS_PER_MINUTE,
          timestamp: now
        });
      }
      
      return false;
    }
    
    recentExecutions.push(now);
    return true;
  }

  /**
   * FIX: Circuit Breaker - Stops repeatedly failing strategies
   * Returns true if execution is allowed, false if circuit breaker tripped
   */
  private checkCircuitBreaker(strategyId: string): boolean {
    if (this.circuitBreakerTripped.has(strategyId)) {
      console.error(`🚨 [CIRCUIT BREAKER] Strategy ${strategyId} is disabled due to repeated failures`);
      console.error(`🚨 [CIRCUIT BREAKER] Manual intervention required to re-enable`);
      
      return false;
    }
    
    const failures = this.failureCount.get(strategyId) || 0;
    
    if (failures >= this.CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreakerTripped.add(strategyId);
      console.error(`🚨 [CIRCUIT BREAKER] Tripping circuit breaker for strategy ${strategyId}`);
      console.error(`🚨 [CIRCUIT BREAKER] ${failures} consecutive failures detected`);
      
      // Emit alert
      if (this.io) {
        this.io.emit('strategy:circuit-breaker-tripped', {
          strategyId,
          failureCount: failures,
          threshold: this.CIRCUIT_BREAKER_THRESHOLD,
          timestamp: Date.now()
        });
      }
      
      // Stop the strategy
      const runningId = Array.from(this.runningStrategies.entries())
        .find(([_, rs]) => rs.strategyId === strategyId)?.[0];
      
      if (runningId) {
        this.stopStrategy(runningId).catch(err => 
          console.error(`Failed to stop strategy after circuit breaker: ${err}`)
        );
      }
      
      return false;
    }
    
    return true;
  }

  /**
   * FIX: Record successful execution (resets failure count)
   */
  private recordSuccess(strategyId: string): void {
    this.failureCount.set(strategyId, 0);
  }

  /**
   * FIX: Record failed execution (increments failure count)
   */
  private recordFailure(strategyId: string): void {
    const currentFailures = this.failureCount.get(strategyId) || 0;
    this.failureCount.set(strategyId, currentFailures + 1);
    
    console.warn(`⚠️ [FAILURE TRACKING] Strategy ${strategyId} failure count: ${currentFailures + 1}/${this.CIRCUIT_BREAKER_THRESHOLD}`);
  }

  /**
   * FIX: Dead Letter Queue - Store failed trades for manual review
   */
  private addToDeadLetterQueue(strategyId: string, runningId: string, event: any, error: string): void {
    // Prevent DLQ from growing unbounded
    if (this.deadLetterQueue.length >= this.MAX_DLQ_SIZE) {
      const removed = this.deadLetterQueue.shift();
      console.warn(`⚠️ [DLQ] Dead letter queue full, removed oldest entry: ${removed?.strategyId}`);
    }
    
    this.deadLetterQueue.push({
      strategyId,
      runningId,
      event,
      error,
      timestamp: Date.now()
    });
    
    console.error(`🚨 [DEAD LETTER] Failed trade for ${strategyId}:`, {
      runningId,
      eventType: event?.type,
      error: error.substring(0, 200) // Truncate long errors
    });
    
    // Emit alert
    if (this.io) {
      this.io.emit('strategy:dead-letter', {
        strategyId,
        runningId,
        error,
        timestamp: Date.now()
      });
    }
    
    // TODO: Send to external monitoring system (Datadog, Sentry, etc.)
  }

  /**
   * Get dead letter queue entries for review
   */
  getDeadLetterQueue(limit: number = 100): typeof this.deadLetterQueue {
    return this.deadLetterQueue.slice(-limit);
  }

  /**
   * Clear dead letter queue
   */
  clearDeadLetterQueue(): void {
    const count = this.deadLetterQueue.length;
    this.deadLetterQueue = [];
    console.log(`🧹 [DLQ] Cleared ${count} entries from dead letter queue`);
  }

  /**
   * Reset circuit breaker for a strategy (manual intervention)
   */
  resetCircuitBreaker(strategyId: string): void {
    this.circuitBreakerTripped.delete(strategyId);
    this.failureCount.set(strategyId, 0);
    console.log(`✅ [CIRCUIT BREAKER] Reset circuit breaker for ${strategyId}`);
    
    if (this.io) {
      this.io.emit('strategy:circuit-breaker-reset', {
        strategyId,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Get user's strategies
   */
  getUserStrategies(userId: string): string[] {
    const userStrategySet = this.userStrategies.get(userId);
    return userStrategySet ? Array.from(userStrategySet) : [];
  }



  /**
   * Track trade execution for analytics
   */
  private async trackExecution(
    runningId: string,
    result: StrategyExecutionResult
  ): Promise<void> {
    try {
      // Extract trade information from result
      const stepResults = result.finalResult as Record<string, any> | undefined;
      if (!stepResults) return;

      // Get latest SOL price
      const solPriceData = await getSolPriceUSD();
      const solPrice = typeof solPriceData === 'number' ? solPriceData : (solPriceData as any).price;

      // Get token price
      const tokenPriceData = await getTokenPriceUSD();
      const tokenPrice = typeof tokenPriceData === 'number' ? tokenPriceData : (tokenPriceData as any).price;

      // Look for buy/sell steps in results
      for (const [stepId, stepResult] of Object.entries(stepResults)) {
        if (!stepResult || typeof stepResult !== 'object') continue;
        
        const result = stepResult as any;
        if (!result.success) continue;

        const data = result.data;
        if (!data) continue;

        // Track buy execution
        if (data.signature && data.amountInSol) {
          const tradeExecution: TradeExecution = {
            tradeId: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            strategyId: runningId,
            timestamp: Date.now(),
            type: 'buy',
            tokenAddress: result.context?.variables?.tokenAddress || 'unknown',
            amountSOL: data.amountInSol,
            amountTokens: data.tokensReceived || 0,
            priceUSD: tokenPrice,
            solPriceUSD: solPrice,
            txSignature: data.signature,
            fees: {
              priorityFee: data.priorityFee || 0,
              networkFee: data.networkFee || 5000,
              totalFeeSOL: ((data.priorityFee || 0) + (data.networkFee || 5000)) / 1e9,
            },
          };

          await strategyExecutionTracker.recordTrade(tradeExecution);
        }

        // Track sell execution
        if (data.signature && data.amountToSell !== undefined) {
          const tradeExecution: TradeExecution = {
            tradeId: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            strategyId: runningId,
            timestamp: Date.now(),
            type: 'sell',
            tokenAddress: result.context?.variables?.tokenAddress || 'unknown',
            amountSOL: data.receivedSOL || 0,
            amountTokens: data.amountToSell,
            priceUSD: tokenPrice,
            solPriceUSD: solPrice,
            txSignature: data.signature,
            fees: {
              priorityFee: data.priorityFee || 0,
              networkFee: data.networkFee || 5000,
              totalFeeSOL: ((data.priorityFee || 0) + (data.networkFee || 5000)) / 1e9,
            },
          };

          await strategyExecutionTracker.recordTrade(tradeExecution);
        }
      }
    } catch (error) {
      awsLogger.warn('Failed to track execution', {
        metadata: { runningId, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    awsLogger.info("Starting graceful shutdown of StrategyExecutionManager");
    await this.stopAllStrategies();
    this.runningStrategies.clear();
    awsLogger.info("StrategyExecutionManager shutdown complete");
  }

  // Health check for AWS
  getHealthStatus(): {
    healthy: boolean;
    runningCount: number;
    errorCount: number;
    details: Array<{ id: string; status: string; executionCount: number }>;
  } {
    const strategies = this.listRunningStrategies();
    const errorCount = strategies.filter((s) => s.status === "error").length;

    return {
      healthy: !this.isShuttingDown && errorCount === 0,
      runningCount: strategies.filter((s) => s.status === "running").length,
      errorCount,
      details: strategies.map((s) => ({
        id: s.id,
        status: s.status,
        executionCount: s.executionCount,
      })),
    };
  }

  /**
   * Get paper trading metrics for a running strategy
   */
  async getPaperTradingMetrics(runningId: string) {
    const runningStrategy = this.runningStrategies.get(runningId);
    
    if (!runningStrategy || !runningStrategy.paperTradingSessionId) {
      return null;
    }

    return await paperTradingEngine.getMetrics(runningStrategy.paperTradingSessionId);
  }

  /**
   * Get paper trading trades for a running strategy
   */
  getPaperTradingTrades(runningId: string) {
    const runningStrategy = this.runningStrategies.get(runningId);
    
    if (!runningStrategy || !runningStrategy.paperTradingSessionId) {
      return [];
    }

    return paperTradingEngine.getTrades(runningStrategy.paperTradingSessionId);
  }

  /**
   * Get paper trading logs for a running strategy
   */
  getPaperTradingLogs(runningId: string) {
    const runningStrategy = this.runningStrategies.get(runningId);
    
    if (!runningStrategy || !runningStrategy.paperTradingSessionId) {
      return [];
    }

    return paperTradingEngine.getLogs(runningStrategy.paperTradingSessionId);
  }

  /**
   * Check if a strategy is in paper trading mode
   */
  isPaperTradingMode(runningId: string): boolean {
    const runningStrategy = this.runningStrategies.get(runningId);
    return runningStrategy?.paperTradingMode === 'paper';
  }
}

// Export singleton instance
export const strategyExecutionManager = new StrategyExecutionManager();
