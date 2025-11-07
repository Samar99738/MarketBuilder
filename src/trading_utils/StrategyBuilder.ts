import * as fs from 'fs';
import * as path from 'path';
import { awsLogger } from '../aws/logger';
import { TradingProvider, TradingProviderFactory, TradingResult, PriceResult } from './TradingProvider';

// Lazy-loaded imports for backward compatibility
let tokenUtilsModule: any = null;


async function getTokenUtils() {
  if (!tokenUtilsModule) {
    // Only import TokenUtils when actually needed
    tokenUtilsModule = await import('./TokenUtils');
  }
  return tokenUtilsModule;
}
  

// Production-ready risk management and validation
export interface RiskLimits {
  maxPositionSizeSOL: number;
  maxDailyLossSOL: number;
  maxConcurrentTrades: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
  cooldownPeriodMs: number;
}

export interface StrategyValidationError {
  stepId: string;
  errorType: 'validation' | 'risk' | 'logic';
  message: string;
  severity: 'error' | 'warning';
}

export interface StrategyMetrics {
  totalTrades: number;
  successfulTrades: number;
  totalPnL: number;
  winRate: number;
  averageTradeTime: number;
  maxDrawdown: number;
  lastExecuted: number;
}

export interface StrategyStatus {
  isActive: boolean;
  isPaused: boolean;
  lastError?: string;
  executionCount: number;
  startTime?: number;
  totalRuntime: number;
}

// Strategy step types
export type StrategyStepType =
  | "buy"
  | "sell"
  | "waitPriceAbove"
  | "waitPriceBelow"
  | "getPrice"
  | "getJupiterPrice"
  | "getSolPrice"
  | "wait"
  | "condition";

// Base strategy step interface
export interface BaseStrategyStep {
  id: string;
  type: StrategyStepType;
  description?: string;
  onSuccess?: string; // ID of next step on success
  onFailure?: string; // ID of next step on failure
}

// Specific step interfaces
export interface BuyStep extends BaseStrategyStep {
  type: "buy";
  amountInSol: number; // Required: Amount in SOL to spend on buying tokens
}

export interface SellStep extends BaseStrategyStep {
  type: "sell";
  amountToSell: number; // Required: Amount of tokens to sell (-1 for all tokens)
}

export interface WaitPriceAboveStep extends BaseStrategyStep {
  type: "waitPriceAbove";
  targetPrice: number;
  checkIntervalMs?: number;
  timeoutMs?: number;
}

export interface WaitPriceBelowStep extends BaseStrategyStep {
  type: "waitPriceBelow";
  targetPrice: number;
  checkIntervalMs?: number;
  timeoutMs?: number;
}

export interface GetPriceStep extends BaseStrategyStep {
  type: "getPrice";
}

export interface GetJupiterPriceStep extends BaseStrategyStep {
  type: "getJupiterPrice";
}

export interface GetSolPriceStep extends BaseStrategyStep {
  type: "getSolPrice";
}

export interface WaitStep extends BaseStrategyStep {
  type: "wait";
  durationMs: number;
}

export interface ConditionStep extends BaseStrategyStep {
  type: "condition";
  condition: "priceAbove" | "priceBelow" | "custom";
  targetPrice?: number;
  useJupiterPrice?: boolean; // For trading consistency
  customCondition?: (context: StrategyContext) => boolean | Promise<boolean>;
}

// Union type for all step types
export type StrategyStep =
  | BuyStep
  | SellStep
  | WaitPriceAboveStep
  | WaitPriceBelowStep
  | GetPriceStep
  | GetJupiterPriceStep
  | GetSolPriceStep
  | WaitStep
  | ConditionStep;

// Strategy definition
export interface Strategy {
  id: string;
  name: string;
  description: string;
  steps: StrategyStep[];
  startStepId: string;
  variables?: Record<string, any>; // Strategy-level variables
  riskLimits: RiskLimits;
  status: StrategyStatus;
  metrics: StrategyMetrics;
  createdAt: number;
  updatedAt: number;
  version: string;
  isProduction: boolean;
}

// Strategy execution context
export interface StrategyContext {
  strategyId: string;
  currentStepId: string;
  variables: Record<string, any>;
  stepResults: Record<string, any>;
  startTime: number;
  logs: string[];
}

// Strategy execution result
export interface StrategyExecutionResult {
  success: boolean;
  context: StrategyContext;
  error?: string;
  completedSteps: string[];
  finalResult?: any;
  completed?: boolean; // Flag to indicate strategy has completed all steps
  subscriptionRequested?: boolean; // Flag to indicate reactive strategy needs subscription
}

// Strategy builder class
export class StrategyBuilder {
  
  static generateStopLossStrategyTemplate(
    id: string,
    name: string,
    description: string,
    entryPrice: number,
    stopLossPrice: number,
    amountInSol: number,
    riskLimits?: Partial<RiskLimits>
  ): Strategy {
    if (amountInSol <= 0) {
      throw new Error('Amount must be positive');
    }
    if (stopLossPrice >= entryPrice) {
      throw new Error('Stop-loss price must be less than entry price');
    }
    const steps: StrategyStep[] = [
      {
        id: 'wait_entry',
        type: 'waitPriceBelow',
        targetPrice: entryPrice,
        description: `Wait for price to drop to entry (${entryPrice})`,
        onSuccess: 'buy_entry'
      } as WaitPriceBelowStep,
      {
        id: 'buy_entry',
        type: 'buy',
        amountInSol,
        description: `Buy ${amountInSol} SOL at entry price`,
        onSuccess: 'wait_stoploss'
      } as BuyStep,
      {
        id: 'wait_stoploss',
        type: 'waitPriceBelow',
        targetPrice: stopLossPrice,
        description: `Wait for price to hit stop-loss (${stopLossPrice})`,
        onSuccess: 'sell_stoploss'
      } as WaitPriceBelowStep,
      {
        id: 'sell_stoploss',
        type: 'sell',
        amountToSell: -1,
        description: `Sell all tokens at stop-loss`,
        onSuccess: undefined
      } as SellStep
    ];
    const now = Date.now();
    return {
      id,
      name,
      description,
      steps,
      startStepId: 'wait_entry',
      variables: {},
      riskLimits: {
        maxPositionSizeSOL: 1.0,
        maxDailyLossSOL: 0.5,
        maxConcurrentTrades: 3,
        stopLossPercentage: 20,
        takeProfitPercentage: 50,
        cooldownPeriodMs: 300000,
        ...riskLimits
      },
      status: {
        isActive: false,
        isPaused: false,
        executionCount: 0,
        totalRuntime: 0
      },
      metrics: {
        totalTrades: 0,
        successfulTrades: 0,
        totalPnL: 0,
        winRate: 0,
        averageTradeTime: 0,
        maxDrawdown: 0,
        lastExecuted: 0
      },
      createdAt: now,
      updatedAt: now,
      version: '1.0.0',
      isProduction: false
    };
  }
 
  static generateGridStrategyTemplate(
    id: string,
    name: string,
    description: string,
    gridLevels: number,
    lowerPrice: number,
    upperPrice: number,
    amountPerLevel: number,
    riskLimits?: Partial<RiskLimits>
  ): Strategy {
    if (gridLevels < 2) {
      throw new Error('Grid strategy requires at least 2 levels');
    }
    if (lowerPrice >= upperPrice) {
      throw new Error('Lower price must be less than upper price');
    }
    if (amountPerLevel <= 0) {
      throw new Error('Amount per level must be positive');
    }
    const priceStep = (upperPrice - lowerPrice) / (gridLevels - 1);
    const steps: StrategyStep[] = [];
    for (let i = 0; i < gridLevels; i++) {
      const price = lowerPrice + i * priceStep;
      const buyStepId = `buy_${i+1}`;
      const sellStepId = `sell_${i+1}`;
      // Wait for price to drop to grid level, then buy
      steps.push({
        id: `wait_buy_${i+1}`,
        type: 'waitPriceBelow',
        targetPrice: price,
        description: `Wait for price to drop to ${price}`,
        onSuccess: buyStepId
      } as WaitPriceBelowStep);
      steps.push({
        id: buyStepId,
        type: 'buy',
        amountInSol: amountPerLevel,
        description: `Buy ${amountPerLevel} SOL at grid level ${i+1} (${price})`,
        onSuccess: sellStepId
      } as BuyStep);
      // Wait for price to rise to grid level, then sell
      steps.push({
        id: `wait_sell_${i+1}`,
        type: 'waitPriceAbove',
        targetPrice: price,
        description: `Wait for price to rise to ${price}`,
        onSuccess: sellStepId
      } as WaitPriceAboveStep);
      steps.push({
        id: sellStepId,
        type: 'sell',
        amountToSell: -1,
        description: `Sell all tokens at grid level ${i+1} (${price})`,
        onSuccess: i < gridLevels - 1 ? `wait_buy_${i+2}` : undefined
      } as SellStep);
    }
    const now = Date.now();
    return {
      id,
      name,
      description,
      steps,
      startStepId: 'wait_buy_1',
      variables: {},
      riskLimits: {
        maxPositionSizeSOL: 1.0,
        maxDailyLossSOL: 0.5,
        maxConcurrentTrades: 3,
        stopLossPercentage: 20,
        takeProfitPercentage: 50,
        cooldownPeriodMs: 300000,
        ...riskLimits
      },
      status: {
        isActive: false,
        isPaused: false,
        executionCount: 0,
        totalRuntime: 0
      },
      metrics: {
        totalTrades: 0,
        successfulTrades: 0,
        totalPnL: 0,
        winRate: 0,
        averageTradeTime: 0,
        maxDrawdown: 0,
        lastExecuted: 0
      },
      createdAt: now,
      updatedAt: now,
      version: '1.0.0',
      isProduction: false
    };
  }
  private strategies: Map<string, Strategy> = new Map();
  private tradingProvider: TradingProvider;

  constructor(tradingProvider?: TradingProvider) {
    // Use provided trading provider or get from factory
    this.tradingProvider = tradingProvider || TradingProviderFactory.getInstance();
  // StrategyBuilder initialized
  }

  static generateDCAStrategyTemplate(
    id: string,
    name: string,
    description: string,
    buyIntervalsMs: number[],
    buyAmountsSol: number[],
    riskLimits?: Partial<RiskLimits>
  ): Strategy {
    if (buyIntervalsMs.length !== buyAmountsSol.length) {
      throw new Error('buyIntervalsMs and buyAmountsSol must have the same length');
    }
    const steps: StrategyStep[] = [];
    for (let i = 0; i < buyAmountsSol.length; i++) {
      const buyStepId = `buy_${i+1}`;
      const waitStepId = `wait_${i+1}`;
      // Buy step
      steps.push({
        id: buyStepId,
        type: 'buy',
        amountInSol: buyAmountsSol[i],
        description: `Buy ${buyAmountsSol[i]} SOL (DCA step ${i+1})`,
        onSuccess: i < buyAmountsSol.length - 1 ? waitStepId : undefined,
        onFailure: undefined
      } as BuyStep);
      // Wait step (skip after last buy)
      if (i < buyIntervalsMs.length - 1) {
        steps.push({
          id: waitStepId,
          type: 'wait',
          durationMs: buyIntervalsMs[i],
          description: `Wait ${buyIntervalsMs[i]/1000}s before next buy`,
          onSuccess: `buy_${i+2}`,
          onFailure: undefined
        } as WaitStep);
      }
    }
    const now = Date.now();
    return {
      id,
      name,
      description,
      steps,
      startStepId: steps[0]?.id || '',
      variables: {},
      riskLimits: {
        maxPositionSizeSOL: 1.0,
        maxDailyLossSOL: 0.5,
        maxConcurrentTrades: 3,
        stopLossPercentage: 20,
        takeProfitPercentage: 50,
        cooldownPeriodMs: 300000,
        ...riskLimits
      },
      status: {
        isActive: false,
        isPaused: false,
        executionCount: 0,
        totalRuntime: 0
      },
      metrics: {
        totalTrades: 0,
        successfulTrades: 0,
        totalPnL: 0,
        winRate: 0,
        averageTradeTime: 0,
        maxDrawdown: 0,
        lastExecuted: 0
      },
      createdAt: now,
      updatedAt: now,
      version: '1.0.0',
      isProduction: false
    };
  }

  // Set or change trading provider
  setTradingProvider(provider: TradingProvider): void {
    this.tradingProvider = provider;
  // Trading provider changed
  }

  // Get current trading provider info
  getTradingProviderInfo(): { name: string; initialized: boolean } {
    return {
      name: this.tradingProvider.getProviderName?.() || 'Unknown',
      initialized: this.tradingProvider.isInitialized?.() || false
    };
  }

  // Expose tradingProvider for testing (to set mock failure flags)
  public getTradingProvider(): TradingProvider {
    return this.tradingProvider;
  }

  // Create a new strategy
  createStrategy(
    id: string,
    name: string,
    description: string,
    variables?: Record<string, any>
  ): Strategy {
    // Check if strategy with this ID already exists
    if (this.strategies.has(id)) {
      throw new Error(
        `Strategy with ID '${id}' already exists. Use a different ID or delete the existing strategy first.`
      );
    }

    const strategy: Strategy = {
      id,
      name,
      description,
      steps: [],
      startStepId: "",
      variables: variables || {},
      riskLimits: {
        maxPositionSizeSOL: 1.0,   // Default 1 SOL max position
        maxDailyLossSOL: 0.5,     // Default 0.5 SOL max daily loss
        maxConcurrentTrades: 3,   // Default max 3 concurrent trades
        stopLossPercentage: 20,   // Default 20% stop loss
        takeProfitPercentage: 50, // Default 50% take profit
        cooldownPeriodMs: 300000  // Default 5 minutes cooldown
      },
      status: {
        isActive: false,
        isPaused: false,
        executionCount: 0,
        totalRuntime: 0
      },
      metrics: {
        totalTrades: 0,
        successfulTrades: 0,
        totalPnL: 0,
        winRate: 0,
        averageTradeTime: 0,
        maxDrawdown: 0,
        lastExecuted: 0
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: "1.0.0",
      isProduction: false
    };

    this.strategies.set(id, strategy);
    return strategy;
  }

  // Add a single step to a strategy
  addStep(strategyId: string, step: StrategyStep): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Check for duplicate step IDs within the same strategy
    const existingStep = strategy.steps.find((s) => s.id === step.id);
    if (existingStep) {
      throw new Error(
        `Step with ID '${step.id}' already exists in strategy '${strategyId}'. Each step must have a unique ID.`
      );
    }

    strategy.steps.push(step);

    // Set as start step if it's the first step
    if (strategy.steps.length === 1) {
      strategy.startStepId = step.id;
    }
  }

  // Add multiple steps to a strategy in a single operation
  addSteps(strategyId: string, steps: StrategyStep[]): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    if (!steps || steps.length === 0) {
      throw new Error("At least one step must be provided");
    }

    // Check for duplicate step IDs within the provided steps
    const stepIds = steps.map((step) => step.id);
    const duplicateIds = stepIds.filter(
      (id, index) => stepIds.indexOf(id) !== index
    );
    if (duplicateIds.length > 0) {
      throw new Error(
        `Duplicate step IDs found in provided steps: ${duplicateIds.join(
          ", "
        )}. Each step must have a unique ID.`
      );
    }

    // Check for duplicate step IDs with existing steps in the strategy
    const existingStepIds = strategy.steps.map((step) => step.id);
    const conflictingIds = stepIds.filter((id) => existingStepIds.includes(id));
    if (conflictingIds.length > 0) {
      throw new Error(
        `Step IDs already exist in strategy '${strategyId}': ${conflictingIds.join(
          ", "
        )}. Each step must have a unique ID.`
      );
    }

    // Add all steps
    const wasEmpty = strategy.steps.length === 0;
    strategy.steps.push(...steps);

    // Set the first added step as start step if strategy was empty
    if (wasEmpty && steps.length > 0) {
      strategy.startStepId = steps[0].id;
    }
  }

  // Set the starting step for a strategy
  setStartStep(strategyId: string, stepId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const stepExists = strategy.steps.some((step) => step.id === stepId);
    if (!stepExists) {
      throw new Error(`Step ${stepId} not found in strategy ${strategyId}`);
    }

    strategy.startStepId = stepId;
  }

  // Get a strategy
  getStrategy(strategyId: string): Strategy | undefined {
    return this.strategies.get(strategyId);
  }

  // List all strategies
  listStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  // Delete a strategy
  deleteStrategy(strategyId: string): boolean {
    return this.strategies.delete(strategyId);
  }

  // Execute a strategy
  async executeStrategy(
    strategyId: string, 
    existingContext?: StrategyContext,
    abortSignal?: AbortSignal  // Accept AbortSignal to enable immediate cancellation
  ): Promise<StrategyExecutionResult> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    console.log(`\n🎯 ========== STRATEGY EXECUTION START ==========`);
    console.log(`🔍 [DEBUG StrategyBuilder] executeStrategy called for ${strategyId}`);
    console.log(`🔍 [DEBUG StrategyBuilder] existingContext:`, {
      exists: !!existingContext,
      hasStopFlag: existingContext?.variables._shouldStop,
      executionCount: existingContext?.variables.executionCount,
      variables: existingContext?.variables
    });
    console.log(`🔍 [DEBUG StrategyBuilder] abortSignal:`, {
      provided: !!abortSignal,
      aborted: abortSignal?.aborted
    });

    // CHECK: Abort signal check FIRST
    if (abortSignal?.aborted) {
      console.log(`🛑 [StrategyBuilder] Abort signal detected BEFORE execution start - ABORTING`);
      return {
        success: true,
        context: existingContext || {
          strategyId,
          currentStepId: strategy.startStepId,
          variables: {},
          stepResults: {},
          startTime: Date.now(),
          logs: [],
        },
        completedSteps: [],
        finalResult: existingContext?.stepResults || {},
        completed: true,
      };
    }

    // CHECK: Stop flag check BEFORE starting execution
    if (existingContext?.variables._shouldStop === true) {
      console.log(`🛑 [StrategyBuilder] Stop flag detected BEFORE execution start - ABORTING`);
      return {
        success: true,
        context: existingContext,
        completedSteps: [],
        finalResult: existingContext.stepResults,
        completed: true,
      };
    }

    // Use existing context to preserve state, or create new one
    const context: StrategyContext = existingContext || {
      strategyId,
      currentStepId: strategy.startStepId,
      variables: strategy.variables || {}, // Use direct reference (not cloned) so stopStrategy can mutate it
      stepResults: {},
      startTime: Date.now(),
      logs: [],
    };
    
    // DON'T reset currentStepId if context exists!
    // The currentStepId should continue from where it left off (e.g. wait_for_trigger, detect_activity)
    // Only set startStepId if this is a BRAND NEW context (first execution)
    if (!existingContext) {
      context.currentStepId = strategy.startStepId;
    }
    // Always clear logs but PRESERVE currentStepId and variables from previous execution
    context.logs = [];

    const completedSteps: string[] = [];
    let loopCount = 0;
    const maxLoops = 1000; // Safety limit to prevent infinite loops

    try {
      context.logs.push(`Starting strategy execution: ${strategy.name}`);

      while (context.currentStepId) {
        loopCount++;
        
        // Safety check for infinite loops
        if (loopCount > maxLoops) {
          console.error(`❌ [StrategyBuilder] Infinite loop detected! Exceeded ${maxLoops} iterations`);
          throw new Error(`Strategy execution exceeded maximum loop count (${maxLoops}). Possible infinite loop.`);
        }

        console.log(`🔍 [DEBUG StrategyBuilder] Loop iteration ${loopCount}, currentStepId: ${context.currentStepId}`);

        // PRIORITY CHECK: Abort signal (highest priority)
        if (abortSignal?.aborted) {
          context.logs.push(`Strategy aborted via signal - exiting execution loop at iteration ${loopCount}`);
          console.log(`🛑 [StrategyBuilder] ABORT SIGNAL detected in main loop (iteration ${loopCount}) - EXITING IMMEDIATELY`);
          return {
            success: true,
            context,
            completedSteps,
            finalResult: context.stepResults,
            completed: true,
          };
        }

        // CHECK IF STRATEGY SHOULD STOP (for reactive/looping strategies)
        if (context.variables._shouldStop === true) {
          context.logs.push(`Strategy stop requested - exiting execution loop at iteration ${loopCount}`);
          console.log(`� [StrategyBuilder] Stop flag detected in main loop (iteration ${loopCount}) - EXITING`);
          return {
            success: true,
            context,
            completedSteps,
            finalResult: context.stepResults,
            completed: true, // Mark as completed when stopped
          };
        }

        const step = strategy.steps.find((s) => s.id === context.currentStepId);
        if (!step) {
          throw new Error(`Step ${context.currentStepId} not found`);
        }

        context.logs.push(`Executing step ${loopCount}: ${step.id} (${step.type})`);
        console.log(`🔍 [DEBUG StrategyBuilder] Executing step: ${step.id} (type: ${step.type}), stop flag: ${context.variables._shouldStop}`);

        try {
          const result = await this.executeStep(step, context);
          context.stepResults[step.id] = result;
          completedSteps.push(step.id);

          console.log(`🔍 [DEBUG StrategyBuilder] Step result:`, {
            stepId: step.id,
            success: result.success,
            hasData: !!result.data,
            message: result.message
          });

          // Check if this step requested subscription (reactive strategies)
          // Return IMMEDIATELY so StrategyExecutionManager can subscribe without waiting for more iterations
          if (context.variables._needsSubscription === true && context.variables.tokenAddress) {
            console.log(`🔥 [StrategyBuilder] Step ${step.id} REQUESTED SUBSCRIPTION - RETURNING EARLY for immediate activation`);
            context.variables._subscriptionReady = true;
            context.variables._needsSubscription = false; // Clear request flag
            
            // Advance to next step BEFORE returning!
            if (result.success && step.onSuccess) {
              context.currentStepId = step.onSuccess;
              console.log(`🔥 [StrategyBuilder] Advanced to next step: ${context.currentStepId}`);
            } else if (!result.success && step.onFailure) {
              context.currentStepId = step.onFailure;
              console.log(`🔥 [StrategyBuilder] Advanced to failure step: ${context.currentStepId}`);
            }
            
            // Return immediately with partial completion
            context.logs.push(`Strategy paused for subscription setup after ${loopCount} iterations`);
            return {
              success: true,
              context,
              completedSteps,
              finalResult: context.stepResults,
              completed: false, // Not completed, will continue in next execution
              subscriptionRequested: true // FLAG: Tells StrategyExecutionManager to subscribe NOW
            };
          }

          // Determine next step
          if (result.success && step.onSuccess) {
            context.currentStepId = step.onSuccess;
            console.log(`🔍 [DEBUG StrategyBuilder] Next step (onSuccess): ${context.currentStepId}`);
          } else if (!result.success && step.onFailure) {
            context.currentStepId = step.onFailure;
            console.log(`🔍 [DEBUG StrategyBuilder] Next step (onFailure): ${context.currentStepId}`);
          } else {
            // No next step defined, strategy complete
            context.currentStepId = "";
            console.log(`🔍 [DEBUG StrategyBuilder] No next step - strategy complete`);
          }

          context.logs.push(
            `Step ${step.id} completed: ${
              result.success ? "SUCCESS" : "FAILURE"
            }, next: ${context.currentStepId || 'NONE'}`
          );
        } catch (stepError) {
          context.logs.push(`Step ${step.id} failed: ${stepError}`);
          console.log(`❌ [DEBUG StrategyBuilder] Step error:`, stepError);

          if (step.onFailure) {
            context.currentStepId = step.onFailure;
            console.log(`🔍 [DEBUG StrategyBuilder] Moving to failure step: ${context.currentStepId}`);
          } else {
            console.log(`❌ [DEBUG StrategyBuilder] No failure step defined - throwing error`);
            throw stepError;
          }
        }
        
        console.log(`🔍 [DEBUG StrategyBuilder] End of loop iteration ${loopCount}, next step: ${context.currentStepId || 'NONE'}, stop flag: ${context.variables._shouldStop}`);
      }

      context.logs.push(`Strategy execution completed successfully after ${loopCount} iterations`);
      console.log(`✅ [StrategyBuilder] Strategy ${strategyId} completed successfully after ${loopCount} steps`);
      console.log(`🎯 ========== STRATEGY EXECUTION COMPLETE ==========\n`);
      return {
        success: true,
        context,
        completedSteps,
        finalResult: context.stepResults,
        completed: true, // Strategy has completed all steps
      };
    } catch (error) {
      context.logs.push(`Strategy execution failed: ${error}`);
      console.log(`❌ [StrategyBuilder] Strategy ${strategyId} failed:`, error);
      console.log(`🎯 ========== STRATEGY EXECUTION FAILED ==========\n`);
      return {
        success: false,
        context,
        error: error instanceof Error ? error.message : String(error),
        completedSteps,
      };
    }
  }

  // Execute a single step
  private async executeStep(
    step: StrategyStep,
    context: StrategyContext
  ): Promise<{ success: boolean; data?: any; message?: string }> {
    // ISSUE #2B FIX: Check stop flag BEFORE executing any step
    if (context.variables._shouldStop === true) {
      console.log(`🛑 [StrategyBuilder] Step ${step.id} cancelled - stop requested`);
      return {
        success: false,
        message: 'Step cancelled - strategy stopped'
      };
    }

    switch (step.type) {
      case "buy":
        const buyStep = step as BuyStep;
        try {
          // Get actual amount - either from step config or from context (dynamic)
          let actualAmountInSol: number;
          
          if (buyStep.amountInSol === -1) {
            // Dynamic amount from context (like mirror strategies)
            actualAmountInSol = context.variables?.solAmountToBuy;
            
            if (!actualAmountInSol || actualAmountInSol <= 0) {
              throw new Error(
                "Dynamic buy amount not set in context. Expected context.variables.solAmountToBuy to be set by previous step."
              );
            }
            
            console.log(`[BUY STEP] Using dynamic amount from context: ${actualAmountInSol.toFixed(6)} SOL`);
          } else {
            // Static amount from step configuration
            if (
              buyStep.amountInSol === undefined ||
              buyStep.amountInSol === null
            ) {
              throw new Error(
                "Buy amount in SOL is required. Please specify amountInSol."
              );
            }
            if (buyStep.amountInSol <= 0) {
              throw new Error("Buy amount must be greater than 0 SOL.");
            }
            
            actualAmountInSol = buyStep.amountInSol;
            console.log(`[BUY STEP] Using static amount from config: ${actualAmountInSol.toFixed(6)} SOL`);
          }

          const signature = await this.tradingProvider.buyTokens(actualAmountInSol, context);
          return {
            success: true,
            data: { signature, solAmount: actualAmountInSol },
            message: `Buy order executed: ${signature} (Amount: ${actualAmountInSol.toFixed(6)} SOL)`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Buy failed: ${error}`,
          };
        }

      case "sell":
        const sellStep = step as SellStep;
        try {
          // Validate amount is specified
          if (
            sellStep.amountToSell === undefined ||
            sellStep.amountToSell === null
          ) {
            throw new Error(
              "Sell amount is required. Please specify amountToSell (-1 for all tokens, or positive number for specific amount)."
            );
          }

          // To check for Dynamic amount
          let actualSellAmount = sellStep.amountToSell;
          if (sellStep.amountToSell === -1 && context.variables.tokenAmountToSell){
            actualSellAmount = context.variables.tokenAmountToSell;
            // Using dynamic sell amount from context
          }else {
            // Using static sell amount
          }

          if (actualSellAmount === 0) {
            throw new Error(
              "Sell amount cannot be 0. Use -1 to sell all tokens or specify a positive amount."
            );
          }
          if (actualSellAmount < -1) {
            throw new Error(
              "Invalid sell amount. Use -1 to sell all tokens or specify a positive amount."
            );
          }

          // Calling tradingProvider.sellTokens

          const signature = await this.tradingProvider.sellTokens(actualSellAmount, context);
          return {
            success: true,
            data: { signature, amountToSell: actualSellAmount },
            message: `Sell order executed: ${signature} (Amount: ${
              sellStep.amountToSell === -1
                ? "ALL tokens"
                : sellStep.amountToSell + " tokens"
            })`,
          };
        } catch (error) {
          // Sell Failed
          return {
            success: false,
            message: `Sell failed: ${error}`,
          };
        }

      case "waitPriceAbove":
        const waitAboveStep = step as WaitPriceAboveStep;
        try {
          if (!this.tradingProvider.waitForPriceAbove) {
            throw new Error('waitForPriceAbove not supported by this provider');
          }
          const result = await this.tradingProvider.waitForPriceAbove(
            waitAboveStep.targetPrice,
            waitAboveStep.timeoutMs || 60000
          );
          return {
            success: result.success,
            data: result.data,
            message: result.message,
          };
        } catch (error) {
          return {
            success: false,
            message: `Wait for price above failed: ${error}`,
          };
        }

      case "waitPriceBelow":
        const waitBelowStep = step as WaitPriceBelowStep;
        try {
          if (!this.tradingProvider.waitForPriceBelow) {
            throw new Error('waitForPriceBelow not supported by this provider');
          }
          const result = await this.tradingProvider.waitForPriceBelow(
            waitBelowStep.targetPrice,
            waitBelowStep.timeoutMs || 60000
          );
          return {
            success: result.success,
            data: result.data,
            message: result.message,
          };
        } catch (error) {
          return {
            success: false,
            message: `Wait for price below failed: ${error}`,
          };
        }

      case "getPrice":
        try {
          const priceData = await this.tradingProvider.getTokenPriceUSD();
          context.variables.currentPrice = priceData.price;
          context.variables.priceSource = priceData.source;
          return {
            success: true,
            data: { price: priceData.price, source: priceData.source },
            message: `Current token price: $${priceData.price} (from ${priceData.source})`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Get price failed: ${error}`,
          };
        }

      case "getJupiterPrice":
        try {
          if (!this.tradingProvider.getJupiterTokenPrice) {
            throw new Error('getJupiterTokenPrice not supported by this provider');
          }
          const priceData = await this.tradingProvider.getJupiterTokenPrice();
          context.variables.currentPrice = priceData.price;
          context.variables.priceSource = priceData.source;
          return {
            success: true,
            data: { price: priceData.price, source: priceData.source },
            message: `Current token price: $${priceData.price} (from ${priceData.source})`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Get Jupiter price failed: ${error}`,
          };
        }

      case "getSolPrice":
        try {
          if (!this.tradingProvider.getSolPriceUSD) {
            throw new Error('getSolPriceUSD not supported by this provider');
          }
          const priceResult = await this.tradingProvider.getSolPriceUSD();
          context.variables.solPrice = priceResult.price;
          return {
            success: true,
            data: { price: priceResult.price },
            message: `Current SOL price: $${priceResult.price}`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Get SOL price failed: ${error}`,
          };
        }

      case "wait":
        const waitStep = step as WaitStep;
        try {
          // Make wait interruptible by checking stop flag periodically
          const checkInterval = 1000; // Check every 1 second
          const totalDuration = waitStep.durationMs;
          let elapsed = 0;
          
          while (elapsed < totalDuration) {
            // Check if stop flag is set
            if (context.variables._shouldStop === true) {
              console.log(`[WAIT] Strategy stopped during wait at ${elapsed}ms/${totalDuration}ms`);
              return {
                success: false,
                message: `Wait interrupted by stop flag after ${elapsed}ms`,
              };
            }
            
            // Wait for the shorter of: remaining time or check interval
            const waitTime = Math.min(checkInterval, totalDuration - elapsed);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            elapsed += waitTime;
          }
          
          return {
            success: true,
            message: `Waited for ${waitStep.durationMs}ms`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Wait failed: ${error}`,
          };
        }

      case "condition":
        const conditionStep = step as ConditionStep;
        try {
          let conditionMet = false;

          if (
            conditionStep.condition === "priceAbove" &&
            conditionStep.targetPrice
          ) {
            const currentPriceData = conditionStep.useJupiterPrice
              ? (this.tradingProvider.getJupiterTokenPrice ? await this.tradingProvider.getJupiterTokenPrice() : await this.tradingProvider.getTokenPriceUSD())
              : await this.tradingProvider.getTokenPriceUSD();
            conditionMet = currentPriceData.price >= conditionStep.targetPrice;
          } else if (
            conditionStep.condition === "priceBelow" &&
            conditionStep.targetPrice
          ) {
            const currentPriceData = conditionStep.useJupiterPrice
              ? (this.tradingProvider.getJupiterTokenPrice ? await this.tradingProvider.getJupiterTokenPrice() : await this.tradingProvider.getTokenPriceUSD())
              : await this.tradingProvider.getTokenPriceUSD();
            conditionMet = currentPriceData.price <= conditionStep.targetPrice;
          } else if (
            conditionStep.condition === "custom" &&
            conditionStep.customCondition
          ) {
            conditionMet = await conditionStep.customCondition(context);
          }

          return {
            success: conditionMet,
            data: { conditionMet },
            message: `Condition ${conditionMet ? "met" : "not met"}`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Condition check failed: ${error}`,
          };
        }

      default:
        return {
          success: false,
          message: `Unknown step type: ${(step as any).type}`,
        };
    }
  }

  /**
   * Validate strategy for production readiness
   */
  validateStrategy(strategyId: string): StrategyValidationError[] {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      return [{
        stepId: 'strategy',
        errorType: 'validation',
        message: `Strategy ${strategyId} not found`,
        severity: 'error'
      }];
    }

    const errors: StrategyValidationError[] = [];

    // Basic validation
    if (!strategy.startStepId) {
      errors.push({
        stepId: 'strategy',
        errorType: 'validation',
        message: 'Strategy must have a start step',
        severity: 'error'
      });
    }

    if (strategy.steps.length === 0) {
      errors.push({
        stepId: 'strategy',
        errorType: 'validation',
        message: 'Strategy must have at least one step',
        severity: 'error'
      });
    }

    // Validate each step
    for (const step of strategy.steps) {
      // Required fields validation
      if (!step.id || !step.type) {
        errors.push({
          stepId: step.id || 'unknown',
          errorType: 'validation',
          message: 'Step must have id and type',
          severity: 'error'
        });
      }

      // Step-specific validation
      if (step.type === 'buy') {
        const buyStep = step as BuyStep;
        // Allow -1 for dynamic amount from context (like sell steps)
        if (buyStep.amountInSol === 0 || buyStep.amountInSol < -1) {
          errors.push({
            stepId: step.id,
            errorType: 'validation',
            message: 'Buy step must have valid amountInSol (-1 for dynamic from context, or positive number)',
            severity: 'error'
          });
        }

        // Risk validation (skip if using dynamic amount)
        if (buyStep.amountInSol > 0 && buyStep.amountInSol > strategy.riskLimits.maxPositionSizeSOL) {
          errors.push({
            stepId: step.id,
            errorType: 'risk',
            message: `Buy amount ${buyStep.amountInSol} SOL exceeds max position size ${strategy.riskLimits.maxPositionSizeSOL} SOL`,
            severity: 'error'
          });
        }
      }

      if (step.type === 'sell') {
        const sellStep = step as SellStep;
        if (sellStep.amountToSell === 0 || sellStep.amountToSell < -1) {
          errors.push({
            stepId: step.id,
            errorType: 'validation',
            message: 'Sell step must have valid amountToSell (-1 for all, or positive number)',
            severity: 'error'
          });
        }
      }

      // Navigation validation
      if (step.onSuccess && !strategy.steps.find(s => s.id === step.onSuccess)) {
        errors.push({
          stepId: step.id,
          errorType: 'logic',
          message: `onSuccess step '${step.onSuccess}' not found in strategy`,
          severity: 'error'
        });
      }

      if (step.onFailure && !strategy.steps.find(s => s.id === step.onFailure)) {
        errors.push({
          stepId: step.id,
          errorType: 'logic',
          message: `onFailure step '${step.onFailure}' not found in strategy`,
          severity: 'error'
        });
      }
    }

    // Check for unreachable steps
    const reachableSteps = this.findReachableSteps(strategy);
    const unreachableSteps = strategy.steps.filter(step => !reachableSteps.has(step.id));
    for (const step of unreachableSteps) {
      errors.push({
        stepId: step.id,
        errorType: 'logic',
        message: 'Step is unreachable from start step',
        severity: 'warning'
      });
    }

    return errors;
  }

  /**
   * Find all steps reachable from start step
   */
  private findReachableSteps(strategy: Strategy): Set<string> {
    const reachable = new Set<string>();
    const toVisit = [strategy.startStepId];

    while (toVisit.length > 0) {
      const stepId = toVisit.pop()!;
      if (reachable.has(stepId)) continue;

      reachable.add(stepId);
      const step = strategy.steps.find(s => s.id === stepId);
      if (step) {
        if (step.onSuccess) toVisit.push(step.onSuccess);
        if (step.onFailure) toVisit.push(step.onFailure);
      }
    }

    return reachable;
  }

  /**
   * Save strategy to JSON file for persistence
   */
  saveStrategy(strategyId: string, filePath?: string): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const savePath = filePath || path.join(process.cwd(), 'strategies', `${strategyId}.json`);
    const dir = path.dirname(savePath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    strategy.updatedAt = Date.now();
    fs.writeFileSync(savePath, JSON.stringify(strategy, null, 2));
    
  // Strategy saved
    awsLogger.info(`Strategy saved`, { strategyId, metadata: { filePath: savePath } });
  }

  /**
   * Load strategy from JSON file
   */
  loadStrategy(filePath: string): Strategy {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Strategy file not found: ${filePath}`);
    }

    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const strategy: Strategy = JSON.parse(data);
      
      // Validate loaded strategy structure
      if (!strategy.id || !strategy.name || !Array.isArray(strategy.steps)) {
        throw new Error('Invalid strategy file format');
      }

      this.strategies.set(strategy.id, strategy);
    // Strategy loaded
      awsLogger.info(`Strategy loaded`, { strategyId: strategy.id, metadata: { filePath } });
      
      return strategy;
    } catch (error) {
      throw new Error(`Failed to load strategy from ${filePath}: ${error}`);
    }
  }

  /**
   * Update strategy risk limits
   */
  updateRiskLimits(strategyId: string, riskLimits: Partial<RiskLimits>): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    strategy.riskLimits = { ...strategy.riskLimits, ...riskLimits };
    strategy.updatedAt = Date.now();
    
    awsLogger.info(`Risk limits updated`, { strategyId, metadata: { riskLimits } });
  }

  /**
   * Update strategy metrics after execution
   */
  updateMetrics(strategyId: string, tradeResult: { success: boolean; pnl: number; tradeTime: number }): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    strategy.metrics.totalTrades++;
    if (tradeResult.success) {
      strategy.metrics.successfulTrades++;
    }
    
    strategy.metrics.totalPnL += tradeResult.pnl;
    strategy.metrics.winRate = (strategy.metrics.successfulTrades / strategy.metrics.totalTrades) * 100;
    strategy.metrics.averageTradeTime = 
      (strategy.metrics.averageTradeTime * (strategy.metrics.totalTrades - 1) + tradeResult.tradeTime) / 
      strategy.metrics.totalTrades;
    
    if (tradeResult.pnl < 0 && Math.abs(tradeResult.pnl) > strategy.metrics.maxDrawdown) {
      strategy.metrics.maxDrawdown = Math.abs(tradeResult.pnl);
    }
    
    strategy.metrics.lastExecuted = Date.now();
    strategy.updatedAt = Date.now();

    awsLogger.info(`Strategy metrics updated`, { 
      strategyId, 
      metadata: {
        totalTrades: strategy.metrics.totalTrades,
        winRate: strategy.metrics.winRate,
        totalPnL: strategy.metrics.totalPnL
      }
    });
  }

  /**
   * Get strategy performance report
   */
  getPerformanceReport(strategyId: string): string {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const { metrics } = strategy;
    const uptime = Date.now() - strategy.createdAt;

    return `
📊 **Strategy Performance Report: ${strategy.name}**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**📈 Trading Metrics:**
• Total Trades: ${metrics.totalTrades}
• Successful Trades: ${metrics.successfulTrades}
• Win Rate: ${metrics.winRate.toFixed(2)}%
• Total P&L: ${metrics.totalPnL.toFixed(4)} SOL

**⏱️ Performance:**
• Average Trade Time: ${(metrics.averageTradeTime / 1000).toFixed(2)}s
• Max Drawdown: ${metrics.maxDrawdown.toFixed(4)} SOL
• Strategy Uptime: ${(uptime / 1000 / 60 / 60).toFixed(2)} hours

**🔧 Risk Settings:**
• Max Position Size: ${strategy.riskLimits.maxPositionSizeSOL} SOL
• Max Daily Loss: ${strategy.riskLimits.maxDailyLossSOL} SOL
• Stop Loss: ${strategy.riskLimits.stopLossPercentage}%
• Take Profit: ${strategy.riskLimits.takeProfitPercentage}%

**📋 Status:**
• Active: ${strategy.status.isActive ? '✅' : '❌'}
• Paused: ${strategy.status.isPaused ? '⏸️' : '▶️'}
• Execution Count: ${strategy.status.executionCount}
• Production Ready: ${strategy.isProduction ? '✅' : '🧪'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
  }

  /**
   * Mark strategy as production ready
   */
  promoteToProduction(strategyId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Validate before promoting
    const errors = this.validateStrategy(strategyId);
    const criticalErrors = errors.filter(e => e.severity === 'error');
    
    if (criticalErrors.length > 0) {
      throw new Error(`Cannot promote strategy to production. Critical errors found: ${criticalErrors.map(e => e.message).join(', ')}`);
    }

    strategy.isProduction = true;
    strategy.updatedAt = Date.now();
    
  // Strategy promoted to PRODUCTION
    awsLogger.info(`Strategy promoted to production`, { strategyId });
  }

  /**
   * Emergency stop all active strategies
   */
  emergencyStopAll(): void {
    let stoppedCount = 0;
    for (const [id, strategy] of this.strategies) {
      if (strategy.status.isActive) {
        strategy.status.isActive = false;
        strategy.status.isPaused = true;
        strategy.status.lastError = 'Emergency stop activated';
        stoppedCount++;
      }
    }
    
  // EMERGENCY STOP: strategies stopped
    awsLogger.error(`Emergency stop activated`, { metadata: { stoppedStrategies: stoppedCount } });
  }
}

// Export singleton instance
export const strategyBuilder = new StrategyBuilder();
