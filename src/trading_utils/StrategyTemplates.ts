/**
 * Production-Ready Strategy Templates
 * 
 * This module provides pre-built, tested strategy templates for common trading patterns.
 * All templates are production-ready with proper risk management and validation.
 * 
 * UPDATED: Fixed "repeat once" bug - no more default 10 executions!
 */

import { timeStamp } from 'console';
import { Strategy, StrategyStep, strategyBuilder } from './StrategyBuilder';


export interface StrategyTemplateConfig {
  name: string;
  description: string;
  parameters: Record<string, any>;
  riskLimits?: {
    maxPositionSizeSOL?: number;
    maxDailyLossSOL?: number;
    stopLossPercentage?: number;
    takeProfitPercentage?: number;
  };
}

/**
 * DCA (Dollar Cost Averaging) Strategy Template
 * Buys fixed amounts at regular intervals regardless of price
 * UPDATED: Fixed default count behavior - undefined now means unlimited
 */
export function createDCAStrategy(config: {
  id: string;
  buyAmountSOL: number;
  intervalMinutes: number;
  maxTotalInvestmentSOL?: number;
  buyCount?: number;
  targetProfitPercentage?: number;
  side?: 'buy' | 'sell';
  sellAmountSOL?: number;
  sellCount?: number;
  tokenAddress?: string;
}): Strategy {
  //  ADD THIS LOGGING AND VALIDATION BLOCK
  /*console.log(`[createDCAStrategy] Creating ${config.side || 'buy'} strategy with config:`, {
    id: config.id,
    side: config.side,
    buyAmountSOL: config.buyAmountSOL,
    sellAmountSOL: config.sellAmountSOL,
    buyCount: config.buyCount,
    sellCount: config.sellCount,
    intervalMinutes: config.intervalMinutes
  });*/

  // ===== Handle undefined count properly =====
  const count = config.side === 'sell' ? config.sellCount : config.buyCount;
  const amount = config.side === 'sell' ? config.sellAmountSOL : config.buyAmountSOL;

  // ADD AMOUNT VALIDATION
  if (!amount || amount <= 0) {
    throw new Error(`[createDCAStrategy] Invalid ${config.side || 'buy'} amount: ${amount}. Must be a positive number.`);
  }

  console.log(`[createDCAStrategy] Validated amount: ${amount} SOL, count: ${count === undefined ? 'unlimited' : count}`);

  // If count is defined, use it. Otherwise, use maxTotalInvestmentSOL or default to large number for risk limits
  const maxInvestment = count
    ? amount! * count
    : (config.maxTotalInvestmentSOL || amount! * 100); // Use 100 as reasonable max for risk calculation

  const countDescription = count ? ` (${count} times)` : ' (unlimited until manually stopped)';

  const strategy = strategyBuilder.createStrategy(
    config.id,
    `DCA ${config.side?.toUpperCase()} Strategy - ${amount} SOL every ${config.intervalMinutes}min${countDescription}`,
    `Dollar Cost Averaging ${config.side} strategy ${config.side === 'sell' ? 'selling' : 'buying'} ${amount} SOL worth of tokens every ${config.intervalMinutes} minutes${count ? ` for ${count} executions` : ` until manually stopped`}.`
  );

  // Update risk limits for DCA strategy
  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: maxInvestment,
    maxDailyLossSOL: maxInvestment * 0.2, // 20% of total investment
    stopLossPercentage: config.side === 'sell' ? 30 : 30, // Conservative stop loss for DCA
    takeProfitPercentage: config.targetProfitPercentage || (config.side === 'sell' ? 50 : 100),
  });

  // Main DCA loop
  const steps: StrategyStep[] = [
    {
      id: 'check_investment_limit',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        console.log(`🔍 [DEBUG DCA check_investment_limit] Entry - stop flag: ${context.variables._shouldStop}`);

        //  Check stop flag FIRST before any other logic
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [DCA STRATEGY] Stop requested - exiting after ${context.variables.executionCount || 0} executions`);
          return false; // Exit strategy immediately
        }

        // Initialize execution counter and other variables
        if (!context.variables.executionCount) {
          context.variables.executionCount = 0;
          context.variables.totalInvested = 0;

          // Initialize tokenAddress from config
          if (config.tokenAddress) {
            context.variables.tokenAddress = config.tokenAddress;
            console.log(`🎯 [DCA INIT] Token address set: ${config.tokenAddress}`);
          }

          // Handle both buy and sell strategies
          if (config.side === 'sell' && config.sellAmountSOL) {
            context.variables.sellAmountSOL = config.sellAmountSOL;
            const countMsg = config.sellCount ? `${config.sellCount} times` : 'until manually stopped';
            //console.log(`DCA SELL Strategy initialized: Will sell ${config.sellAmountSOL} SOL worth ${countMsg}`);
          } else if (config.buyAmountSOL) {
            context.variables.buyAmountSOL = config.buyAmountSOL;
            const countMsg = config.buyCount ? `${config.buyCount} times` : 'until manually stopped';
            // console.log(`DCA BUY Strategy initialized: Will buy ${config.buyAmountSOL} SOL ${countMsg}`);
          }

          //  ADD THIS VALIDATION LOGGING
          /* console.log(`[check_investment_limit] Context variables initialized:`, {
             executionCount: context.variables.executionCount,
             buyAmountSOL: context.variables.buyAmountSOL,
             sellAmountSOL: context.variables.sellAmountSOL,
             totalInvested: context.variables.totalInvested,
             configBuyAmount: config.buyAmountSOL,
             configSellAmount: config.sellAmountSOL
           });*/
        }

        // ===== Only check count if it's defined =====
        const count = config.side === 'sell' ? config.sellCount : config.buyCount;
        if (count !== undefined && count !== null) {
          const canContinue = context.variables.executionCount < count;
          const action = config.side === 'sell' ? 'sells' : 'buys';

          console.log(`🔍 [DCA LIMIT CHECK] Execution ${context.variables.executionCount}/${count} ${action}`, {
            executionCount: context.variables.executionCount,
            limit: count,
            canContinue,
            willStop: !canContinue
          });

          if (!canContinue) {
            console.log(`✅ [DCA COMPLETE] Reached limit: ${context.variables.executionCount} of ${count} ${action} completed`);
          }
          return canContinue;
        }

        // If no count specified, continue indefinitely (until manually stopped)
        // Only check max investment for buy strategies without count
        if (config.side !== 'sell' && config.maxTotalInvestmentSOL) {
          const currentInvested = context.variables.totalInvested || 0;
          const canContinue = currentInvested < config.maxTotalInvestmentSOL;
          if (!canContinue) {
            // console.log(` DCA BUY Strategy completed: Reached max investment of ${config.maxTotalInvestmentSOL} SOL`);
          }
          return canContinue;
        }

        // For unlimited strategies, always return true (runs until manually stopped)
        console.log(`🔍 [DEBUG DCA check_investment_limit] Returning true (unlimited strategy)`);
        return true;
      },
      onSuccess: config.side === 'sell' ? 'get_current_price_for_sell' : 'dca_buy',
      onFailure: 'strategy_complete',
      description: 'Check if we should continue executing'
    },
    ...(config.side === 'sell' ? [

      // DCA SELL steps for sell strategies
      {
        id: 'get_current_price_for_sell',
        type: 'getPrice' as const,
        onSuccess: 'calculate_sell_amount',
        onFailure: 'handle_sell_failure',
        description: 'Get current token price to calculate sell amount'
      },
      {
        id: 'calculate_sell_amount',
        type: 'condition' as const,
        condition: 'custom' as const,
        customCondition: (context: any) => {
          if (config.side !== 'sell') return false;

          const currentPrice = context.stepResults.get_current_price_for_sell?.data?.price;
          const sellAmountSOL = config.sellAmountSOL;

          if (!currentPrice || !sellAmountSOL) {
            // console.log(` DCA SELL: Missing price or sell amount`);
            return false;
          }

          // Calculate token amount to sell based on SOL amount and current price
          const tokenAmountToSell = sellAmountSOL;
          context.variables.tokenAmountToSell = tokenAmountToSell;

          //console.log(` DCA SELL: Selling ${tokenAmountToSell.toFixed(6)} tokens worth ${sellAmountSOL} SOL at ${currentPrice} price`);
          return true;
        },
        onSuccess: 'dca_sell',
        onFailure: 'handle_sell_failure',
        description: 'Calculate token amount to sell based on SOL value'
      },
      {
        id: 'dca_sell',
        type: 'sell' as const,
        amountToSell: -1, // Will be set dynamically based on tokenAmountToSell in context
        onSuccess: 'update_amount',
        onFailure: 'handle_sell_failure',
        description: `Sell tokens worth ${config.sellAmountSOL} SOL`
      }
    ] : [{
      id: 'dca_buy',
      type: 'buy' as const,
      amountInSol: config.buyAmountSOL!,
      onSuccess: 'update_amount',
      onFailure: 'handle_buy_failure',
      description: `Buy ${config.buyAmountSOL} SOL worth of tokens`
    }]),
    {
      id: 'update_amount',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Increment execution counter
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;

        if (config.side === 'sell' && config.sellAmountSOL) {
          context.variables.totalSold = (context.variables.totalSold || 0) + config.sellAmountSOL;
          const countMsg = config.sellCount ? `/${config.sellCount}` : ' (unlimited)';
          console.log(`📊 [DCA SELL] Progress: ${context.variables.executionCount}${countMsg} executions, ${context.variables.totalSold.toFixed(2)} SOL sold`);
        } else if (config.buyAmountSOL) {
          context.variables.totalInvested = (context.variables.totalInvested || 0) + config.buyAmountSOL;
          const countMsg = config.buyCount ? `/${config.buyCount}` : ' (unlimited)';
          console.log(`📊 [DCA BUY] Progress: ${context.variables.executionCount}${countMsg} executions, ${context.variables.totalInvested.toFixed(4)} SOL invested`);
        }

        return true;
      },
      onSuccess: 'wait_interval',
      description: 'Update total amount'
    },
    {
      id: 'wait_interval',
      type: 'wait',
      durationMs: config.intervalMinutes * 60 * 1000,
      onSuccess: 'check_investment_limit',
      description: `Wait ${config.intervalMinutes} minutes before next ${config.side === 'sell' ? 'sell' : 'buy'}`
    },
    {
      id: 'handle_buy_failure',
      type: 'wait',
      durationMs: 60000, // Wait 1 minute on failure
      onSuccess: 'check_investment_limit',
      description: 'Wait after buy failure before retrying'
    },
    {
      id: 'handle_sell_failure',
      type: 'wait',
      durationMs: 60000, // Wait 1 minute on failure
      onSuccess: 'check_investment_limit',
      description: 'Wait after sell failure before retrying'
    },
    {
      id: 'strategy_complete',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: () => {
        if (config.side === 'sell') {
          console.log(` DCA SELL Strategy Complete`);
        } else {
          console.log(` DCA BUY Strategy Complete`);
        }
        return false; // Returning false stops the strategy
      },
      description: 'DCA strategy completed successfully'
    }
  ];

  //  ADD THIS VALIDATION LOGGING BLOCK
  console.log(`[createDCAStrategy] Created ${steps.length} steps for ${config.side || 'buy'} strategy`);
  const buySteps = steps.filter(s => s.type === 'buy');
  const sellSteps = steps.filter(s => s.type === 'sell');
  if (buySteps.length > 0) {
    buySteps.forEach((step: any) => {
      console.log(`[createDCAStrategy] BUY step configured: ${step.id}, amountInSol: ${step.amountInSol}`);
    });
  }
  if (sellSteps.length > 0) {
    sellSteps.forEach((step: any) => {
      console.log(`[createDCAStrategy] SELL step configured: ${step.id}, amountToSell: ${step.amountToSell}`);
    });
  }

  // Add all steps
  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }

  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * DCA SELL Strategy Template
 * Sells fixed amounts at regular intervals regardless of price
 * UPDATED: Fixed default count behavior
 */
export function createDCASellStrategy(config: {
  id: string;
  sellAmountSOL: number;
  intervalMinutes: number;
  sellCount?: number; // Number of sells to execute before stopping (undefined = unlimited)
}): Strategy {
  // ===== Only calculate total if count is defined =====
  const totalToSell = config.sellCount
    ? config.sellAmountSOL * config.sellCount
    : config.sellAmountSOL * 100; // Use 100 as reasonable max for risk calculation

  const countDescription = config.sellCount ? ` (${config.sellCount} times)` : ' (unlimited until manually stopped)';

  const strategy = strategyBuilder.createStrategy(
    config.id,
    `DCA SELL Strategy - ${config.sellAmountSOL} SOL every ${config.intervalMinutes}min${countDescription}`,
    `Dollar Cost Averaging SELL strategy selling ${config.sellAmountSOL} SOL worth of tokens every ${config.intervalMinutes} minutes${config.sellCount ? ` for ${config.sellCount} executions` : ` until manually stopped`}.`
  );

  // Update risk limits for DCA SELL strategy
  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: totalToSell,
    maxDailyLossSOL: totalToSell * 0.2,
    stopLossPercentage: 30,
    takeProfitPercentage: 50,
  });

  // Main DCA SELL loop
  const steps: StrategyStep[] = [
    {
      id: 'check_sell_limit',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Check stop flag FIRST before any other logic
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [DCA SELL STRATEGY] Stop requested - exiting after ${context.variables.executionCount || 0} executions`);
          return false; // Exit strategy immediately
        }

        // Initialize execution counter and store sellAmountSOL in context
        if (!context.variables.executionCount) {
          context.variables.executionCount = 0;
          context.variables.sellAmountSOL = config.sellAmountSOL;
          const countMsg = config.sellCount ? `${config.sellCount} times` : 'until manually stopped';
          //console.log(`Starting DCA SELL Strategy: Will sell ${config.sellAmountSOL} SOL worth ${countMsg}`);
        }

        // ===== Only check count if it's defined =====
        if (config.sellCount !== undefined && config.sellCount !== null) {
          const canContinue = context.variables.executionCount < config.sellCount;
          if (!canContinue) {
            //  console.log(`DCA SELL Strategy completed: Executed ${context.variables.executionCount} of ${config.sellCount} planned sells`);
          }
          return canContinue;
        }

        // If no count specified, continue indefinitely (until manually stopped)
        return true;
      },
      onSuccess: 'get_current_price_for_sell',
      onFailure: 'strategy_complete',
      description: 'Check if we should continue selling'
    },
    {
      id: 'get_current_price_for_sell',
      type: 'getPrice',
      onSuccess: 'calculate_sell_amount',
      onFailure: 'handle_sell_failure',
      description: 'Get current token price to calculate sell amount'
    },
    {
      id: 'calculate_sell_amount',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const currentPrice = context.stepResults.get_current_price_for_sell?.data?.price;
        const sellAmountSOL = context.variables.sellAmountSOL;

        if (!currentPrice || !sellAmountSOL) {
          //console.log(`DCA SELL: Missing price or sell amount`);
          return false;
        }

        // Calculate token amount to sell based on SOL amount and current price
        const tokenAmountToSell = sellAmountSOL;
        context.variables.tokenAmountToSell = tokenAmountToSell;

        console.log(`DCA SELL: Selling ${tokenAmountToSell.toFixed(6)} tokens worth ${sellAmountSOL} SOL at ${currentPrice} price`);
        return true;
      },
      onSuccess: 'dca_sell',
      onFailure: 'handle_sell_failure',
      description: 'Calculate token amount to sell based on SOL value'
    },
    {
      id: 'dca_sell',
      type: 'sell',
      amountToSell: -1, // Will be set dynamically based on tokenAmountToSell in context
      onSuccess: 'update_sold_amount',
      onFailure: 'handle_sell_failure',
      description: `Sell tokens worth ${config.sellAmountSOL} SOL`
    },
    {
      id: 'update_sold_amount',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Increment execution counter
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;
        context.variables.totalSold = (context.variables.totalSold || 0) + config.sellAmountSOL;

        const countMsg = config.sellCount ? `/${config.sellCount}` : ' (unlimited)';
        //console.log(`DCA SELL Progress: ${context.variables.executionCount}${countMsg} executions, ${context.variables.totalSold.toFixed(2)} SOL sold`);
        return true;
      },
      onSuccess: 'wait_interval_sell',
      description: 'Update total sold amount'
    },
    {
      id: 'wait_interval_sell',
      type: 'wait',
      durationMs: config.intervalMinutes * 60 * 1000,
      onSuccess: 'check_sell_limit',
      description: `Wait ${config.intervalMinutes} minutes before next sell`
    },
    {
      id: 'handle_sell_failure',
      type: 'wait',
      durationMs: 60000, // Wait 1 minute on failure
      onSuccess: 'check_sell_limit',
      description: 'Wait after sell failure before retrying'
    },
    {
      id: 'strategy_complete',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: () => {
        // console.log(`DCA SELL Strategy Complete`);
        return false; // Returning false stops the strategy
      },
      description: 'DCA SELL strategy completed successfully'
    }
  ];

  // Add all steps
  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }

  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * Grid Trading Strategy Template
 * Places buy/sell orders at predetermined price levels
 */
export function createGridTradingStrategy(config: {
  id: string;
  basePrice: number;
  gridSpacing: number;
  gridLevels: number;
  amountPerLevel: number;
}): Strategy {
  const strategy = strategyBuilder.createStrategy(
    config.id,
    `Grid Trading Strategy - ${config.gridLevels} levels`,
    `Grid trading strategy with ${config.gridLevels} levels spaced ${config.gridSpacing}% apart, starting from base price $${config.basePrice}`
  );

  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: config.amountPerLevel * config.gridLevels,
    stopLossPercentage: 15,
    takeProfitPercentage: 25,
  });

  const steps: StrategyStep[] = [
    {
      id: 'initialize_grid',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const gridLevels = [];
        for (let i = 0; i < config.gridLevels; i++) {
          const priceLevel = config.basePrice * (1 + (config.gridSpacing / 100) * (i - Math.floor(config.gridLevels / 2)));
          gridLevels.push({
            price: priceLevel,
            isBuyLevel: i < Math.floor(config.gridLevels / 2),
            executed: false
          });
        }
        context.variables.gridLevels = gridLevels;
        context.variables.activeGridLevel = 0;
        return true;
      },
      onSuccess: 'monitor_grid',
      description: 'Initialize grid levels'
    },
    {
      id: 'monitor_grid',
      type: 'getPrice',
      onSuccess: 'check_grid_levels',
      onFailure: 'wait_and_retry',
      description: 'Get current price to check grid levels'
    },
    {
      id: 'check_grid_levels',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Check stop flag FIRST before any other logic
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [GRID TRADING] Stop requested - exiting grid strategy`);
          return false; // Exit strategy immediately
        }

        const currentPrice = context.stepResults.monitor_grid?.data?.price;
        const gridLevels = context.variables.gridLevels;

        for (const level of gridLevels) {
          if (!level.executed) {
            if (level.isBuyLevel && currentPrice <= level.price) {
              context.variables.pendingAction = 'buy';
              context.variables.pendingLevel = level;
              return true;
            } else if (!level.isBuyLevel && currentPrice >= level.price) {
              context.variables.pendingAction = 'sell';
              context.variables.pendingLevel = level;
              return true;
            }
          }
        }
        return false;
      },
      onSuccess: 'execute_grid_order',
      onFailure: 'wait_and_retry',
      description: 'Check if any grid level should trigger'
    },
    {
      id: 'execute_grid_order',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const action = context.variables.pendingAction;
        context.variables.pendingLevel.executed = true;
        console.log(`Grid ${action.toUpperCase()} executed at level ${context.variables.pendingLevel.price}`);
        return true;
      },
      onSuccess: 'wait_and_retry',
      description: 'Execute grid order'
    },
    {
      id: 'wait_and_retry',
      type: 'wait',
      durationMs: 30000,
      onSuccess: 'monitor_grid',
      description: 'Wait before checking grid again'
    }
  ];

  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }
  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * Stop-Loss/Take-Profit Strategy Template
 */
export function createStopLossTakeProfitStrategy(config: {
  id: string;
  buyAmountSOL: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
}): Strategy {
  const strategy = strategyBuilder.createStrategy(
    config.id,
    `Stop-Loss/Take-Profit Strategy`,
    `Buy ${config.buyAmountSOL} SOL, exit at -${config.stopLossPercentage}% or +${config.takeProfitPercentage}%`
  );

  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: config.buyAmountSOL,
    stopLossPercentage: config.stopLossPercentage,
    takeProfitPercentage: config.takeProfitPercentage,
  });

  const steps: StrategyStep[] = [
    {
      id: 'initial_buy',
      type: 'buy',
      amountInSol: config.buyAmountSOL,
      onSuccess: 'store_entry_price',
      onFailure: 'strategy_failed',
      description: 'Execute initial buy'
    },
    {
      id: 'store_entry_price',
      type: 'getPrice',
      onSuccess: 'set_exit_targets',
      onFailure: 'strategy_failed',
      description: 'Get entry price'
    },
    {
      id: 'set_exit_targets',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const entryPrice = context.stepResults.store_entry_price?.data?.price;
        context.variables.entryPrice = entryPrice;
        context.variables.stopLossPrice = entryPrice * (1 - config.stopLossPercentage / 100);
        context.variables.takeProfitPrice = entryPrice * (1 + config.takeProfitPercentage / 100);
        // console.log(`Exit targets set: SL=${context.variables.stopLossPrice}, TP=${context.variables.takeProfitPrice}`);
        return true;
      },
      onSuccess: 'monitor_position',
      description: 'Calculate exit targets'
    },
    {
      id: 'monitor_position',
      type: 'getPrice',
      onSuccess: 'check_exit_conditions',
      onFailure: 'wait_and_monitor',
      description: 'Monitor current price'
    },
    {
      id: 'check_exit_conditions',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Check stop flag FIRST before any other logic
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [STOP-LOSS/TAKE-PROFIT] Stop requested - exiting strategy`);
          context.variables.exitReason = 'Manually stopped by user';
          return true; // Exit to execute_exit step
        }

        const currentPrice = context.stepResults.monitor_position?.data?.price;
        const stopLoss = context.variables.stopLossPrice;
        const takeProfit = context.variables.takeProfitPrice;

        if (currentPrice <= stopLoss) {
          context.variables.exitReason = 'Stop-loss triggered';
          return true;
        } else if (currentPrice >= takeProfit) {
          context.variables.exitReason = 'Take-profit triggered';
          return true;
        }
        return false;
      },
      onSuccess: 'execute_exit',
      onFailure: 'wait_and_monitor',
      description: 'Check if stop-loss or take-profit should trigger'
    },
    {
      id: 'execute_exit',
      type: 'sell',
      amountToSell: -1,
      onSuccess: 'strategy_completed',
      onFailure: 'retry_exit',
      description: 'Execute exit trade'
    },
    {
      id: 'retry_exit',
      type: 'wait',
      durationMs: 5000,
      onSuccess: 'execute_exit',
      description: 'Wait before retrying exit'
    },
    {
      id: 'wait_and_monitor',
      type: 'wait',
      durationMs: 10000,
      onSuccess: 'monitor_position',
      description: 'Wait before next price check'
    },
    {
      id: 'strategy_completed',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        console.log(`Strategy completed: ${context.variables.exitReason}`);
        return true;
      },
      description: 'Strategy execution completed'
    },
    {
      id: 'strategy_failed',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: () => {
        console.log(`Strategy failed to initialize`);
        return true;
      },
      description: 'Strategy failed'
    }
  ];

  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }

  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * Momentum Trading Strategy Template
 */
export function createMomentumStrategy(config: {
  id: string;
  buyAmountSOL?: number;
  positionSize?: number;
  momentumThreshold: number;
  sellThreshold?: number;
  timeframeMinutes?: number;
  timeframe?: number;
  tokenAddress?: string;
  description?: string;
  sellAmountTokens?: number; // NEW: Specific amount to sell (optional, defaults to -1 = sell all)
}): Strategy {
  // Map different field names to standard ones
  const buyAmount = config.buyAmountSOL || config.positionSize || 0.01;
  const timeframeMin = config.timeframeMinutes || config.timeframe || 1;
  const sellThreshold = config.sellThreshold || -3; // Default: sell on -3% reversal
  const sellAmount = config.sellAmountTokens || -1; // Default: -1 means sell ALL tokens

  const strategy = strategyBuilder.createStrategy(
    config.id,
    config.description || `Momentum Trading Strategy`,
    config.description || `Buy ${buyAmount} SOL on +${config.momentumThreshold}% momentum, sell on ${sellThreshold}% reversal`
  );

  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: buyAmount,
    stopLossPercentage: Math.abs(sellThreshold),
    takeProfitPercentage: config.momentumThreshold * 2,
  });

  const steps: StrategyStep[] = [
    // Initialize context variables
    {
      id: 'initialize_context',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Store token address in context for price fetching
        context.variables.tokenAddress = config.tokenAddress;
        context.variables.hasPosition = false;
        context.variables.buyAmount = buyAmount;
        context.variables.momentumThreshold = config.momentumThreshold;
        context.variables.sellThreshold = sellThreshold;
        context.variables.sellAmount = sellAmount; // Store sell amount configuration
        const sellDescription = sellAmount === -1 ? 'ALL tokens' : `${sellAmount} tokens`;
        console.log(`💡 [MOMENTUM INIT] Token: ${config.tokenAddress}, Buy: ${buyAmount} SOL, Threshold: +${config.momentumThreshold}%, Sell: ${sellDescription}`);
        return true;
      },
      onSuccess: 'initialize_momentum',
      description: 'Initialize strategy context with token address and sell amount'
    },
    {
      id: 'initialize_momentum',
      type: 'getPrice',
      onSuccess: 'store_initial_price',
      onFailure: 'wait_retry',
      description: 'Get initial price for momentum calculation'
    },
    {
      id: 'store_initial_price',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        context.variables.initialPrice = context.stepResults.initialize_momentum?.data?.price;
        console.log(`📊 [MOMENTUM] Baseline price set: $${context.variables.initialPrice}`);
        return true;
      },
      onSuccess: 'wait_timeframe',
      description: 'Store initial price'
    },
    {
      id: 'wait_timeframe',
      type: 'wait',
      durationMs: timeframeMin * 60 * 1000,
      onSuccess: 'check_stop_flag',
      description: `Wait ${timeframeMin} minutes`
    },
    {
      id: 'check_stop_flag',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [MOMENTUM] Stop requested - exiting strategy`);
          return false;
        }
        return true;
      },
      onSuccess: 'check_momentum',
      onFailure: 'strategy_stopped',
      description: 'Check if strategy should stop'
    },
    {
      id: 'check_momentum',
      type: 'getPrice',
      onSuccess: 'calculate_momentum',
      onFailure: 'wait_retry',
      description: 'Get current price for momentum'
    },
    {
      id: 'calculate_momentum',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const currentPrice = context.stepResults.check_momentum?.data?.price;
        const initialPrice = context.variables.initialPrice;
        const momentum = ((currentPrice - initialPrice) / initialPrice) * 100;

        context.variables.currentMomentum = momentum;
        context.variables.currentPrice = currentPrice;

        console.log(`📈 [MOMENTUM] Price: $${currentPrice}, Change: ${momentum.toFixed(2)}%, HasPosition: ${context.variables.hasPosition}, Threshold: +${config.momentumThreshold}%`);

        // BUY condition: momentum exceeds threshold and no position
        if (!context.variables.hasPosition && momentum >= config.momentumThreshold) {
          console.log(`🟢 [MOMENTUM BUY TRIGGER] Momentum ${momentum.toFixed(2)}% >= ${config.momentumThreshold}%`);
          context.variables.shouldSell = false; // Explicitly set to false
          return true;
        }

        // SELL condition: momentum drops below sell threshold and has position
        if (context.variables.hasPosition && momentum <= sellThreshold) {
          console.log(`🔴 [MOMENTUM SELL TRIGGER] Momentum ${momentum.toFixed(2)}% <= ${sellThreshold}%, HasPosition: ${context.variables.hasPosition}`);
          context.variables.shouldSell = true;
          return true;
        }

        // No trigger - reset baseline and continue monitoring
        console.log(`⏸️ [MOMENTUM] No trigger - resetting baseline. HasPosition: ${context.variables.hasPosition}`);
        context.variables.initialPrice = currentPrice;
        return false;
      },
      onSuccess: 'route_action',
      onFailure: 'wait_timeframe',
      description: 'Calculate momentum and decide action'
    },
    {
      id: 'route_action',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        return !context.variables.shouldSell; // true = buy, false = sell
      },
      onSuccess: 'execute_buy',
      onFailure: 'prepare_sell_amount',
      description: 'Route to buy or sell action'
    },
    {
      id: 'execute_buy',
      type: 'buy',
      amountInSol: buyAmount,
      onSuccess: 'log_buy_execution',
      onFailure: 'handle_trade_failure',
      description: `Buy ${buyAmount} SOL on momentum spike`
    },
    {
      id: 'log_buy_execution',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        context.variables.hasPosition = true;
        context.variables.entryPrice = context.variables.currentPrice;
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;
        console.log(`💰 [MOMENTUM BUY #${context.variables.executionCount}] Bought ${buyAmount} SOL at $${context.variables.entryPrice}`);
        return true;
      },
      onSuccess: 'wait_timeframe',
      description: 'Log buy execution and update state'
    },
    {
      id: 'prepare_sell_amount',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Store the configured sell amount in context for PaperTradingProvider to use
        const configuredSellAmount = context.variables.sellAmount || -1;

        // If sellAmount is -1 (sell all), keep it as -1
        // If sellAmount is a positive number, store it
        context.variables.tokenAmountToSell = configuredSellAmount;

        const sellDescription = configuredSellAmount === -1 ? 'ALL tokens' : `${configuredSellAmount} tokens`;
        console.log(`📤 [PREPARE SELL] Configured to sell: ${sellDescription}`);
        return true;
      },
      onSuccess: 'execute_sell',
      description: 'Prepare sell amount based on configuration'
    },
    {
      id: 'execute_sell',
      type: 'sell',
      amountToSell: -1, // Will use context.variables.tokenAmountToSell set in prepare_sell_amount
      onSuccess: 'log_sell_execution',
      onFailure: 'handle_trade_failure',
      description: 'Sell tokens on momentum reversal'
    },
    {
      id: 'log_sell_execution',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const sellAmount = context.variables.tokenAmountToSell;
        const sellDescription = sellAmount === -1 ? 'ALL tokens' : `${sellAmount} tokens`;

        context.variables.hasPosition = false;
        context.variables.shouldSell = false;
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;
        console.log(`💰 [MOMENTUM SELL #${context.variables.executionCount}] Sold ${sellDescription} at $${context.variables.currentPrice}`);
        return true;
      },
      onSuccess: 'wait_timeframe',
      description: 'Log sell execution and update state'
    },
    {
      id: 'handle_trade_failure',
      type: 'wait',
      durationMs: 5000,
      onSuccess: 'wait_timeframe',
      description: 'Handle trade failure and continue monitoring'
    },
    {
      id: 'wait_retry',
      type: 'wait',
      durationMs: 10000,
      onSuccess: 'initialize_momentum',
      description: 'Wait before retrying price fetch'
    },
    {
      id: 'strategy_stopped',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        console.log(`⏹️ [MOMENTUM] Strategy stopped after ${context.variables.executionCount || 0} executions`);
        return false;
      },
      description: 'Strategy stopped'
    }
  ];

  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }
  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * Custom Strategy Template
 * For advanced strategies that don't fit standard templates
 */
export function createCustomStrategy(config: {
  id: string;
  strategyType: string;
  description: string;
  tokenAddress?: string;
  supply?: number;
  trigger?: string;
  side?: 'buy' | 'sell';
  sizingRule?: string;
  components?: string[];
  manualSteps?: string[];
  riskManagement?: string;
  // Price-based conditional parameters
  priceDropPercentage?: number;
  priceRecoveryPercentage?: number;
  rebuyPercentage?: number;
  initialBuyAmount?: number;
  // Contrarian volatility parameters
  sellTriggerPercentage?: number; // e.g., 5 = sell when rises 5%
  sellTriggerTimeframeMinutes?: number; // e.g., 5 = within 5 minutes
  sellAmountTokens?: number; // e.g., 1500 tokens
  buyTriggerPercentage?: number; // e.g., 15 = buy when drops 15%
  buyTriggerTimeframeMinutes?: number; // e.g., 5 = within 5 minutes
  buyAmountSOL?: number; // e.g., 0.001 SOL
}): Strategy {
  // Check if this is a contrarian volatility strategy
  if (config.strategyType === 'contrarian_volatility' ||
    (config.sellTriggerPercentage && config.buyTriggerPercentage &&
      config.sellTriggerTimeframeMinutes && config.buyTriggerTimeframeMinutes)) {
    console.log(`🎯 [createCustomStrategy] Creating CONTRARIAN VOLATILITY strategy`);
    return createContrarianVolatilityStrategy({
      id: config.id,
      description: config.description,
      tokenAddress: config.tokenAddress || '',
      sellTriggerPercentage: config.sellTriggerPercentage || 5,
      sellTriggerTimeframeMinutes: config.sellTriggerTimeframeMinutes || 5,
      sellAmountTokens: config.sellAmountTokens || 1000,
      buyTriggerPercentage: config.buyTriggerPercentage || 15,
      buyTriggerTimeframeMinutes: config.buyTriggerTimeframeMinutes || 5,
      buyAmountSOL: config.buyAmountSOL || 0.001
    });
  }

  // Check if this is a reactive/mirror strategy
  if (config.strategyType === 'reactive' && config.trigger && config.trigger.includes('mirror') && config.side) {
    console.log(`🎯 [createCustomStrategy] Creating REACTIVE mirror strategy with config:`, {
      sellAmountTokens: config.sellAmountTokens,
      sizingRule: config.sizingRule,
      side: config.side,
      tokenAddress: config.tokenAddress
    });
    return createReactiveMirrorStrategy({
      id: config.id,
      description: config.description,
      tokenAddress: config.tokenAddress,
      supply: config.supply,
      trigger: config.trigger,
      side: config.side,
      sizingRule: config.sizingRule,
      sellAmount: config.sellAmountTokens // Pass user-specified token amount
    });
  }

  // Check if this is a price-based conditional strategy
  if (config.strategyType === 'price_based_conditional' ||
    (config.priceDropPercentage && config.priceRecoveryPercentage)) {
    console.log(`🎯 [createCustomStrategy] Creating PRICE-BASED CONDITIONAL strategy`);
    return createPriceBasedConditionalStrategy({
      id: config.id,
      description: config.description,
      tokenAddress: config.tokenAddress,
      priceDropPercentage: config.priceDropPercentage || 20,
      priceRecoveryPercentage: config.priceRecoveryPercentage || 10,
      rebuyPercentage: config.rebuyPercentage || 50,
      initialBuyAmount: config.initialBuyAmount || 0.1
    });
  }

  // Default custom strategy behavior
  const strategy = strategyBuilder.createStrategy(
    config.id,
    `Custom Strategy: ${config.strategyType}`,
    config.description || 'Advanced custom trading strategy'
  );

  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: 1.0,
    maxDailyLossSOL: 0.5,
    stopLossPercentage: 20,
    takeProfitPercentage: 50,
  });

  const steps: StrategyStep[] = [
    {
      id: 'initialize_custom',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // console.log(`Custom Strategy initialized: ${config.description}`);
        if (config.components && config.components.length > 0) {
          //console.log(`Automated components:`, config.components);
        }
        if (config.manualSteps && config.manualSteps.length > 0) {
          // console.log(`Manual steps required:`, config.manualSteps);
        }
        context.variables.customStrategyActive = true;
        return true;
      },
      onSuccess: 'initial_buy',
      description: 'Initialize custom strategy'
    },
    {
      id: 'initial_buy',
      type: 'buy',
      amountInSol: config.initialBuyAmount || 0.1, // Use config or default to 0.1 SOL
      onSuccess: 'store_entry_price',
      onFailure: 'strategy_failed',
      description: 'Execute initial buy'
    },
    {
      id: 'store_entry_price',
      type: 'getPrice',
      onSuccess: 'set_exit_targets',
      onFailure: 'strategy_failed',
      description: 'Get entry price'
    },
    {
      id: 'set_exit_targets',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const entryPrice = context.stepResults.store_entry_price?.data?.price;
        context.variables.entryPrice = entryPrice;
        context.variables.stopLossPrice = entryPrice * 0.8;
        context.variables.takeProfitPrice = entryPrice * 1.5;
        // console.log(`Exit targets set: SL=${context.variables.stopLossPrice}, TP=${context.variables.takeProfitPrice}`);
        return true;
      },
      onSuccess: 'monitor_position',
      description: 'Calculate exit targets'
    },
    {
      id: 'monitor_position',
      type: 'getPrice',
      onSuccess: 'check_exit_conditions',
      onFailure: 'wait_and_monitor',
      description: 'Monitor current price'
    },
    {
      id: 'check_exit_conditions',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Check stop flag FIRST before any other logic
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [CUSTOM STRATEGY] Stop requested - exiting strategy`);
          context.variables.exitReason = 'Manually stopped by user';
          return true; // Exit to execute_exit step
        }

        const currentPrice = context.stepResults.monitor_position?.data?.price;
        const stopLoss = context.variables.stopLossPrice;
        const takeProfit = context.variables.takeProfitPrice;

        if (currentPrice <= stopLoss) {
          context.variables.exitReason = 'Stop-loss triggered';
          return true;
        } else if (currentPrice >= takeProfit) {
          context.variables.exitReason = 'Take-profit triggered';
          return true;
        }
        return false;
      },
      onSuccess: 'execute_exit',
      onFailure: 'wait_and_monitor',
      description: 'Check if stop-loss or take-profit should trigger'
    },
    {
      id: 'execute_exit',
      type: 'sell',
      amountToSell: -1,
      onSuccess: 'strategy_completed',
      onFailure: 'retry_exit',
      description: 'Execute exit trade'
    },
    {
      id: 'retry_exit',
      type: 'wait',
      durationMs: 5000,
      onSuccess: 'execute_exit',
      description: 'Wait before retrying exit'
    },
    {
      id: 'wait_and_monitor',
      type: 'wait',
      durationMs: 10000,
      onSuccess: 'monitor_position',
      description: 'Wait before next price check'
    },
    {
      id: 'strategy_completed',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const exitReason = context.variables.exitReason;
        // console.log(`Custom Strategy completed: ${exitReason}`);
        return true;
      },
      description: 'Strategy execution completed'
    },
    {
      id: 'strategy_failed',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: () => {
        // console.log(`Custom Strategy failed: Could not execute initial buy`);
        return true;
      },
      description: 'Strategy failed to initialize'
    }
  ];

  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }
  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * Price-Based Conditional Stop-Loss and Re-entry Strategy
 * 
 * This strategy:
 * 1. Buys initial position
 * 2. Monitors price continuously
 * 3. Sells 100% of position if price drops by specified percentage (e.g., 20%)
 * 4. Waits for price to recover by specified percentage (e.g., 10%)
 * 5. Rebuys specified percentage of original position (e.g., 50%)
 * 6. Repeats the cycle
 * 
 * Example: "Sell ALL if price drops 20%, rebuy 50% when it recovers 10%"
 */
export function createPriceBasedConditionalStrategy(config: {
  id: string;
  description: string;
  tokenAddress?: string;
  priceDropPercentage: number; // e.g., 20 for 20% drop
  priceRecoveryPercentage: number; // e.g., 10 for 10% recovery
  rebuyPercentage: number; // e.g., 50 for 50% of original position
  initialBuyAmount: number; // Initial SOL amount to buy
}): Strategy {
  console.log(`🎯 [createPriceBasedConditionalStrategy] Creating strategy with:`, {
    priceDropPercentage: config.priceDropPercentage,
    priceRecoveryPercentage: config.priceRecoveryPercentage,
    rebuyPercentage: config.rebuyPercentage,
    initialBuyAmount: config.initialBuyAmount
  });

  const strategy = strategyBuilder.createStrategy(
    config.id,
    `Price-Based Conditional Strategy`,
    config.description || `Sell all if price drops ${config.priceDropPercentage}%, rebuy ${config.rebuyPercentage}% when it recovers ${config.priceRecoveryPercentage}%`
  );

  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: config.initialBuyAmount * 2,
    maxDailyLossSOL: config.initialBuyAmount,
    stopLossPercentage: config.priceDropPercentage,
    takeProfitPercentage: 100,
  });

  const steps: StrategyStep[] = [
    // Step 1: Initial buy
    {
      id: 'initial_buy',
      type: 'buy',
      amountInSol: config.initialBuyAmount,
      onSuccess: 'store_entry_price',
      onFailure: 'strategy_failed',
      description: `Execute initial buy of ${config.initialBuyAmount} SOL`
    },

    // Step 2: Store entry price and token amount
    {
      id: 'store_entry_price',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Store the entry price and initial position size
        const buyResult = context.stepResults.initial_buy;
        if (buyResult && buyResult.data) {
          context.variables.entryPrice = buyResult.data.executionPrice || buyResult.data.price;
          context.variables.initialTokenAmount = buyResult.data.tokensReceived || buyResult.data.amountTokens;
          context.variables.originalBuyAmount = config.initialBuyAmount;

          // Calculate sell trigger price (e.g., 20% drop)
          const dropMultiplier = 1 - (config.priceDropPercentage / 100);
          context.variables.sellTriggerPrice = context.variables.entryPrice * dropMultiplier;

          console.log(`📊 [Price Conditional] Entry recorded:`, {
            entryPrice: context.variables.entryPrice,
            initialTokenAmount: context.variables.initialTokenAmount,
            sellTriggerPrice: context.variables.sellTriggerPrice,
            dropPercentage: config.priceDropPercentage
          });
          return true;
        }
        return false;
      },
      onSuccess: 'monitor_for_price_drop',
      onFailure: 'strategy_failed',
      description: 'Store entry price and calculate sell trigger'
    },

    // Step 3: Monitor price for drop
    {
      id: 'monitor_for_price_drop',
      type: 'getPrice',
      onSuccess: 'check_price_drop',
      onFailure: 'wait_before_price_check',
      description: 'Monitor current price for drop trigger'
    },

    // Step 4: Check if price dropped enough to trigger sell
    {
      id: 'check_price_drop',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Check stop flag
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [Price Conditional] Stop requested`);
          return false;
        }

        const currentPrice = context.stepResults.monitor_for_price_drop?.data?.price;
        const sellTriggerPrice = context.variables.sellTriggerPrice;
        const entryPrice = context.variables.entryPrice;

        if (!currentPrice || !sellTriggerPrice) {
          console.log(`⚠️ [Price Conditional] Missing price data`);
          return false;
        }

        const priceDropPercent = ((entryPrice - currentPrice) / entryPrice) * 100;

        console.log(`📉 [Price Conditional] Price check:`, {
          currentPrice: currentPrice.toFixed(9),
          sellTriggerPrice: sellTriggerPrice.toFixed(9),
          entryPrice: entryPrice.toFixed(9),
          dropPercent: priceDropPercent.toFixed(2) + '%',
          shouldSell: currentPrice <= sellTriggerPrice
        });

        // Trigger sell if price dropped by specified percentage or more
        if (currentPrice <= sellTriggerPrice) {
          console.log(`🔴 [Price Conditional] SELL TRIGGER! Price dropped ${priceDropPercent.toFixed(2)}%`);
          context.variables.sellPrice = currentPrice;
          return true;
        }
        return false;
      },
      onSuccess: 'sell_all_position',
      onFailure: 'wait_before_price_check',
      description: `Check if price dropped ${config.priceDropPercentage}%`
    },

    // Step 5: Sell ALL position
    {
      id: 'sell_all_position',
      type: 'sell',
      amountToSell: -1, // -1 means sell ALL tokens
      onSuccess: 'wait_for_recovery',
      onFailure: 'retry_sell',
      description: `Sell 100% of position`
    },

    // Step 6: Retry sell if it failed
    {
      id: 'retry_sell',
      type: 'wait',
      durationMs: 5000,
      onSuccess: 'sell_all_position',
      description: 'Wait before retrying sell'
    },

    // Step 7: Wait a bit before monitoring for recovery
    {
      id: 'wait_for_recovery',
      type: 'wait',
      durationMs: 10000,
      onSuccess: 'monitor_for_recovery',
      description: 'Wait before monitoring for price recovery'
    },

    // Step 8: Monitor price for recovery
    {
      id: 'monitor_for_recovery',
      type: 'getPrice',
      onSuccess: 'check_price_recovery',
      onFailure: 'wait_before_recovery_check',
      description: 'Monitor price for recovery'
    },

    // Step 9: Check if price recovered enough to trigger rebuy
    {
      id: 'check_price_recovery',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // Check stop flag
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [Price Conditional] Stop requested during recovery wait`);
          return false;
        }

        const currentPrice = context.stepResults.monitor_for_recovery?.data?.price;
        const sellPrice = context.variables.sellPrice;

        if (!currentPrice || !sellPrice) {
          console.log(`⚠️ [Price Conditional] Missing price data for recovery check`);
          return false;
        }

        // Calculate recovery trigger price (e.g., 10% above sell price)
        const recoveryMultiplier = 1 + (config.priceRecoveryPercentage / 100);
        const rebuyTriggerPrice = sellPrice * recoveryMultiplier;

        const recoveryPercent = ((currentPrice - sellPrice) / sellPrice) * 100;

        console.log(`📈 [Price Conditional] Recovery check:`, {
          currentPrice: currentPrice.toFixed(9),
          sellPrice: sellPrice.toFixed(9),
          rebuyTriggerPrice: rebuyTriggerPrice.toFixed(9),
          recoveryPercent: recoveryPercent.toFixed(2) + '%',
          shouldRebuy: currentPrice >= rebuyTriggerPrice
        });

        // Trigger rebuy if price recovered by specified percentage or more
        if (currentPrice >= rebuyTriggerPrice) {
          console.log(`🟢 [Price Conditional] REBUY TRIGGER! Price recovered ${recoveryPercent.toFixed(2)}%`);

          // Calculate rebuy amount (e.g., 50% of original position)
          const rebuyAmount = context.variables.originalBuyAmount * (config.rebuyPercentage / 100);
          context.variables.rebuyAmount = rebuyAmount;

          console.log(`💰 [Price Conditional] Rebuy amount: ${rebuyAmount} SOL (${config.rebuyPercentage}% of original ${context.variables.originalBuyAmount} SOL)`);

          return true;
        }
        return false;
      },
      onSuccess: 'rebuy_position',
      onFailure: 'wait_before_recovery_check',
      description: `Check if price recovered ${config.priceRecoveryPercentage}%`
    },

    // Step 10: Rebuy specified percentage of original position
    {
      id: 'rebuy_position',
      type: 'buy',
      amountInSol: config.initialBuyAmount * (config.rebuyPercentage / 100),
      onSuccess: 'update_entry_after_rebuy',
      onFailure: 'retry_rebuy',
      description: `Rebuy ${config.rebuyPercentage}% of original position`
    },

    // Step 11: Retry rebuy if it failed
    {
      id: 'retry_rebuy',
      type: 'wait',
      durationMs: 5000,
      onSuccess: 'rebuy_position',
      description: 'Wait before retrying rebuy'
    },

    // Step 12: Update entry price after rebuy
    {
      id: 'update_entry_after_rebuy',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const rebuyResult = context.stepResults.rebuy_position;
        if (rebuyResult && rebuyResult.data) {
          const newEntryPrice = rebuyResult.data.executionPrice || rebuyResult.data.price;
          context.variables.entryPrice = newEntryPrice;

          // Update sell trigger for next cycle
          const dropMultiplier = 1 - (config.priceDropPercentage / 100);
          context.variables.sellTriggerPrice = newEntryPrice * dropMultiplier;

          console.log(`📊 [Price Conditional] New entry after rebuy:`, {
            newEntryPrice: newEntryPrice,
            newSellTriggerPrice: context.variables.sellTriggerPrice
          });
          return true;
        }
        return false;
      },
      onSuccess: 'monitor_for_price_drop', // Loop back to monitoring
      onFailure: 'strategy_failed',
      description: 'Update entry price and restart monitoring cycle'
    },

    // Helper steps
    {
      id: 'wait_before_price_check',
      type: 'wait',
      durationMs: 10000, // Check every 10 seconds
      onSuccess: 'monitor_for_price_drop',
      description: 'Wait before next price check'
    },
    {
      id: 'wait_before_recovery_check',
      type: 'wait',
      durationMs: 10000, // Check every 10 seconds
      onSuccess: 'monitor_for_recovery',
      description: 'Wait before next recovery check'
    },
    {
      id: 'strategy_failed',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: () => {
        console.log(`❌ [Price Conditional] Strategy failed`);
        return true;
      },
      description: 'Strategy failed'
    }
  ];

  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }

  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * Reactive Mirror Strategy
 * Monitors blockchain for buy/sell activity and mirrors it
 * 
 * NOTE: This is a SIMULATED version for paper trading
 * Real implementation would need:
 * - WebSocket connection to blockchain
 * - Transaction monitoring service
 * - Real-time event detection
 */
export function createReactiveMirrorStrategy(config: {
  id: string;
  description: string;
  tokenAddress?: string;
  supply?: number;
  trigger: string;
  side: 'buy' | 'sell';
  sizingRule?: string;
  buyAmount?: number; // Amount in SOL for buy orders
  sellAmount?: number; // FIXED amount of tokens to sell (if user specifies)
}): Strategy {
  console.log(`🎯 [createReactiveMirrorStrategy] Creating reactive ${config.side} strategy for token: ${config.tokenAddress}`);
  console.log(`🎯 [createReactiveMirrorStrategy] Config:`, {
    sizingRule: config.sizingRule,
    buyAmount: config.buyAmount,
    sellAmount: config.sellAmount,
    trigger: config.trigger
  });

  const isSellStrategy = config.side === 'sell';
  const actionName = isSellStrategy ? 'SELL' : 'BUY';

  // Determine what blockchain activity we're WATCHING FOR (not what action we take)
  // Example: "mirror_buy_activity" means we WATCH FOR buys, then execute sells
  // Example: "mirror_sell_activity" means we WATCH FOR sells, then execute buys
  const triggerAction = config.trigger.includes('buy') ? 'buy' : 'sell';

  console.log(`🎯 [TRIGGER SETUP] User wants to ${config.side.toUpperCase()} when they detect ${triggerAction.toUpperCase()} activity`);
  console.log(`🎯 [TRIGGER SETUP] We will watch for "${triggerAction}" trades and execute "${config.side}" orders`);
  
  // Validate user provided amount - NO DEFAULTS!
  if (!isSellStrategy && (!config.buyAmount || config.buyAmount <= 0)) {
    throw new Error('buyAmount is required and must be greater than 0. Please specify the SOL amount to buy.');
  }

  const buyAmount = config.buyAmount;

  const strategy = strategyBuilder.createStrategy(
    config.id,
    `Reactive Mirror ${actionName} Strategy`,
    `${config.description} - Monitors for ${triggerAction} activity and mirrors with ${config.side} orders`
  );

  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: config.supply ? (config.supply / 1000000) * 0.1 : 1.0, // 10% of supply max
    maxDailyLossSOL: 0.5,
    stopLossPercentage: 30,
    takeProfitPercentage: 100,
  });

  // For paper trading simulation, we'll execute periodic sell/buy orders
  // In production, this would monitor actual blockchain events
  const steps: StrategyStep[] = [
    {
      id: 'initialize_reactive',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        console.log(`🎯 Reactive Mirror Strategy initialized`);
        console.log(`📊 Token: ${config.tokenAddress}`);
        console.log(`📈 Action: ${config.side.toUpperCase()}`);
        console.log(`🔔 Trigger: ${config.trigger}`);
        console.log(`📦 Sizing: ${config.sizingRule || 'mirror_volume'}`);

        context.variables.tokenAddress = config.tokenAddress;
        context.variables.reactiveActive = true;
        context.variables.executionCount = 0;
        context.variables.simulatedAmount = 0.001; // Start with small test amount

        // FLAG: Request subscription to start IMMEDIATELY
        context.variables._needsSubscription = true;

        return true;
      },
      onSuccess: 'wait_for_trigger',
      description: 'Initialize reactive monitoring'
    },
    {
      id: 'wait_for_trigger',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // STOP FLAG BEFORE CONTINUING
        if (context.variables._shouldStop === true) {
          console.log(`⏹️ [REACTIVE] Strategy stopped during wait`);
          return false; // Exit strategy
        }
        return true; // Continue to detect_activity
      },
      onSuccess: 'wait_delay',
      onFailure: 'strategy_stopped',
      description: 'Check if strategy should continue'
    },
    {
      id: 'wait_delay',
      type: 'wait',
      durationMs: 500, // Check every 0.5 seconds (reduced CPU usage)
      onSuccess: 'detect_activity',
      description: 'Wait 0.5s before next trigger check'
    },
    {
      id: 'detect_activity',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: async (context: any) => {
        // CHECK STOP FLAG FIRST
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [REACTIVE] Strategy stopped by user`);
          return false;
        }

        // Track consecutive failed detections to prevent infinite loops
        if (!context.variables._detectionAttempts) {
          context.variables._detectionAttempts = 0;
        }
        
        // REAL BLOCKCHAIN MONITORING
        // Check if we received a real trade event from RealTradeFeedService
        if (context.variables.realTradeDetected === true) {
          // Reset attempt counter on successful detection
          context.variables._detectionAttempts = 0;
          const tradeType = context.variables.realTradeType; // 'buy' or 'sell'
          const tradePrice = context.variables.realTradePrice;
          const tradeSolAmount = context.variables.realTradeSolAmount;
          const tradeTokenAmount = context.variables.realTradeTokenAmount; // Token amount from trade
          const tradeSignature = context.variables.realTradeSignature;

          // Get token symbol for better readability
          const tokenSymbol = context.variables.tokenSymbol || context.variables.tokenName || 'UNKNOWN';
          const tokenAddr = context.variables.tokenAddress;
          
          console.log(`\n🔔 ========== REAL ${tradeType.toUpperCase()} DETECTED! ==========`);
          console.log(`🔔 Token: ${tokenSymbol} (${tokenAddr.substring(0, 8)}...)`);
          console.log(`🔔 SOL: ${tradeSolAmount.toFixed(4)} | Tokens: ${tradeTokenAmount ? tradeTokenAmount.toLocaleString() : 'N/A'}`);
          console.log(`🔔 Price: ${tradePrice ? tradePrice.toFixed(10) : 'N/A'} SOL/token`);
          console.log(`🔔 Signature: ${tradeSignature?.substring(0, 12)}...`);
          console.log(`🔔 ================================================\n`);

          // Check if this trade matches our trigger
          console.log(`🎯 [TRIGGER CHECK] Detected trade type: "${tradeType}", Looking for: "${triggerAction}"`);
          console.log(`🎯 [TRIGGER CHECK] Strategy side: "${config.side}", Sizing: "${config.sizingRule}"`);
          const shouldTrigger = (triggerAction === tradeType);
          console.log(`🎯 [TRIGGER CHECK] Match result: ${shouldTrigger ? '✅ MATCHED' : '❌ NO MATCH'}`);

          if (shouldTrigger) {
            console.log(`✅ TRIGGER MATCHED! Executing ${config.side} order\n`);

            // CRITICAL FIX: Reset flag IMMEDIATELY after detection
            // This allows multiple rapid BUY trades to each trigger execution
            context.variables.realTradeDetected = false;
            console.log(`🔄 [FLAG RESET] Flag reset immediately - ready for next trade`);

            // CRITICAL: Set detectedVolume based on what strategy needs
            // - SELL strategies (watching buys) need volume in SOL (how much SOL was spent buying)
            // - BUY strategies (watching sells) need volume in TOKENS (how many tokens were sold)
            if (isSellStrategy) {
              // Watching BUYs → Need SOL amount to mirror
              context.variables.detectedVolume = tradeSolAmount;
            } else {
              // Watching SELLs → Need TOKEN amount to mirror
              context.variables.detectedVolume = tradeTokenAmount;
            }

            // Calculate mirror amount based on sizing rule (legacy support)
            if (config.sizingRule === 'mirror_volume' || config.sizingRule === 'mirror_buy_volume' || config.sizingRule === 'mirror_sell_volume') {
              if (isSellStrategy) {
                // Sell strategy: volume is in SOL, will be converted to tokens later
                context.variables.solAmountToBuy = tradeSolAmount;
              } else {
                // Buy strategy: volume is in tokens, will be converted to SOL later
                context.variables.solAmountToBuy = tradeSolAmount; // Store SOL amount temporarily
              }
            } else if (config.sizingRule === 'mirror_half') {
              context.variables.solAmountToBuy = tradeSolAmount * 0.5;
            } else if (config.sizingRule === 'mirror_double') {
              context.variables.solAmountToBuy = tradeSolAmount * 2;
            } else {
              // Fixed amount
              context.variables.solAmountToBuy = config.buyAmount || 0.005;
            }

            // Store the trigger price and signature for reference
            context.variables.triggerPrice = tradePrice;
            context.variables.triggerSignature = tradeSignature;

            // Reset the flag so we don't re-trigger
            //  context.variables.realTradeDetected = false;

            return true; // Trigger action
          }

          //  Don't blindly reset flag
          // Only reset if we're certain no new trade arrived (wrong type)
          if (!shouldTrigger) {
            context.variables.realTradeDetected = false;
            console.log(`ℹ️ [RESET] Trade type mismatch, resetting flag for next detection`);
            console.log(`ℹ️ [IGNORED TRADE] ${tradeType.toUpperCase()} trade ignored - looking for ${triggerAction.toUpperCase()} trades`);
          }
        }

        // Increment detection attempts
        context.variables._detectionAttempts++;
        
        // CRITICAL FIX: Yield control periodically to prevent CPU saturation
        // After 50 failed attempts (~25 seconds), pause execution and return
        // This prevents the 1000-iteration limit and allows event loop to process new trades
        if (context.variables._detectionAttempts >= 50) {
          console.log(`⏸️ [DETECT] Pausing after ${context.variables._detectionAttempts} checks (~25s) - yielding control`);
          context.variables._detectionAttempts = 0; // Reset counter
          // Return false to go back to wait_for_trigger and re-enter waiting state
        }

        return false; // No trigger yet, keep waiting
      },
      onSuccess: isSellStrategy ? 'calculate_sell_amount' : 'calculate_buy_amount',
      onFailure: 'wait_for_trigger',
      description: '🔥 Detect REAL blockchain activity via WebSocket and trigger action'
    }
  ];

  // Add execution step based on strategy side
  if (isSellStrategy) {
    // Step 0: Get current position size
    steps.push({
      id: 'get_position_size',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const tokenAddress = context.variables.tokenAddress;

        // Priority 1: Check if user explicitly specified token supply
        if (config.supply && config.supply > 0) {
          context.variables.tokenBalance = config.supply;
          console.log(`📊 [GET POSITION] Using user-specified supply: ${config.supply.toLocaleString()} tokens`);
          return true;
        }

        // Priority 2: Try to get actual position from paper trading state
        if (context.paperTradingState?.portfolio?.positions) {
          const position = context.paperTradingState.portfolio.positions.find(
            (p: any) => p.tokenAddress === tokenAddress
          );
          if (position && position.amount > 0) {
            context.variables.tokenBalance = position.amount;
            console.log(`📊 [GET POSITION] Found existing position: ${position.amount.toFixed(0)} tokens`);
            return true;
          }
        }

        // Priority 3: No position found - FAIL for SELL strategies (no dangerous fallbacks!)
        console.error(`❌ [GET POSITION] No position found for token ${tokenAddress.substring(0, 8)}...`);
        console.error(`❌ [GET POSITION] SELL strategies require either:`);
        console.error(`❌   1. User-specified 'supply' parameter in strategy config`);
        console.error(`❌   2. Existing token position in portfolio`);
        console.error(`❌ [GET POSITION] Cannot execute SELL without tokens!`);

        throw new Error(`No token position available. Cannot sell tokens you don't own. Please specify 'supply' in config or ensure position exists.`);
      },
      onSuccess: 'fetch_token_price',
      description: 'Get current token position size with proper validation'
    });

    // Step 1a: Fetch token price from market
    steps.push({
      id: 'fetch_token_price',
      type: 'getPrice',
      onSuccess: 'validate_token_price',
      onFailure: 'validate_token_price', // Continue even if fetch fails
      description: 'Fetch current token price from market data'
    });

    // Step 1b: Validate we got TOKEN price (not SOL price) for calculation  
    steps.push({
      id: 'validate_token_price',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // CRITICAL: Validate we have TOKEN/SOL price for calculations
        const stepResult = context.stepResults?.fetch_token_price?.data;

        if (!stepResult || !stepResult.price) {
          console.error(`❌ [PRICE ERROR] No price data returned from fetch`);
          throw new Error('Failed to fetch token price. Cannot execute trade without market price.');
        }

        const price = stepResult.price;
        const priceUSD = stepResult.priceUSD;
        const solPrice = stepResult.solPrice;

        // CRITICAL: Validate we have TOKEN/SOL price (should be < 1 for most tokens)
        if (price >= 1) {
          console.error(`❌ [PRICE ERROR] Invalid price: ${price}`);
          console.error(`❌ This looks like SOL/USD or TOKEN/USD, not TOKEN/SOL!`);
          console.error(`❌ TOKEN/SOL prices should always be < 1`);

          // Try to derive TOKEN/SOL from TOKEN/USD and SOL/USD
          if (priceUSD && solPrice && priceUSD > 0 && solPrice > 0) {
            const tokenPriceInSOL = priceUSD / solPrice;
            if (tokenPriceInSOL > 0 && tokenPriceInSOL < 1) {
              context.variables.currentPrice = tokenPriceInSOL;
              context.variables.priceSource = `${stepResult.source} (derived)`;
              console.log(`✅ [DERIVED] Calculated TOKEN/SOL: ${tokenPriceInSOL.toFixed(10)}`);
              console.log(`✅ From: $${priceUSD} TOKEN/USD / $${solPrice} SOL/USD`);
              return true;
            }
          }

          throw new Error(`Invalid price type: ${price}. Expected TOKEN/SOL price < 1.`);
        }

        // Valid TOKEN/SOL price
        context.variables.currentPrice = price;
        context.variables.priceSource = stepResult.source;
        console.log(`✅ [PRICE OK] TOKEN/SOL: ${price.toFixed(10)} from ${stepResult.source}`);

        // Store additional price info for display
        if (priceUSD) context.variables.tokenPriceUSD = priceUSD;
        if (solPrice) context.variables.solPriceUSD = solPrice;

        return true;
      },
      onSuccess: 'calculate_sell_amount',
      description: 'Validate TOKEN price in SOL (not SOL/USD price!)'
    });

    // Step 2: Calculate EXACT sell amount based on mirror_buy_volume sizing rule
    steps.push({
      id: 'calculate_sell_amount',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: async (context: any) => {
        const sizingRule = config.sizingRule || 'mirror_buy_volume';
        const detectedVolumeSOL = context.variables.detectedVolume || 0.001;
        let currentPosition = context.variables.tokenBalance;

        // PAPER TRADING FIX: Check if user specified initial virtual position OR auto-initialize for SELL strategies
        if (!currentPosition || currentPosition <= 0) {
          const userSpecified = context.strategyConfig?.initialTokenBalance;
          const initialBalance = userSpecified ? parseFloat(userSpecified) : 100000; // Default 100k tokens for SELL strategies
          
          if (initialBalance > 0) {
            console.log(`💰 [AUTO-INIT] ${userSpecified ? 'Using user-specified' : 'Auto-initializing'} virtual position: ${initialBalance.toLocaleString()} tokens`);
            console.log(`💰 [AUTO-INIT] This allows reactive SELL strategy to execute immediately`);
            currentPosition = initialBalance;
            context.variables.tokenBalance = initialBalance;
            
            // Add to paper trading portfolio if available
            if (context.paperTradingProvider) {
              try {
                await context.paperTradingProvider.simulateInitialPosition(
                  context.strategyConfig.tokenAddress,
                  initialBalance
                );
                console.log(`✅ [PAPER TRADING] Virtual position added to portfolio: ${initialBalance.toLocaleString()} tokens`);
                console.log(`✅ [PAPER TRADING] Can now execute SELL trades mirroring BUY activity`);
              } catch (err) {
                console.warn(`⚠️ [PAPER TRADING] Could not add to portfolio:`, err);
              }
            }
          }
        }

        // Verify position is now available
        if (!currentPosition || currentPosition <= 0){
          console.error(`❌ [POSITION ERROR] Failed to initialize token position for SELL strategy`);
          console.error(`❌ Cannot execute SELL without tokens. Please check paper trading engine.`);
          
          // Mark this execution as skipped, not failed
          context.variables._executionSkipped = true;
          context.variables._skipReason = 'Failed to initialize position';
          
          // CRITICAL: Reset the trade detected flag so we can catch the NEXT trade
          context.variables.realTradeDetected = false;
          
          return false;
        }

        console.log(`[POSITION] Current holding: ${currentPosition.toLocaleString()} tokens`);

        console.log(`\n====== CALCULATE SELL AMOUNT DEBUG ======`);
        console.log(`📌 Config sizingRule: ${sizingRule}`);
        console.log(`📌 Detected volume: ${detectedVolumeSOL.toFixed(6)} SOL`);
        console.log(`📌 Current position: ${currentPosition.toLocaleString()} tokens`);

        // Get current token price - PRIORITIZE REAL TRADE PRICE from detected trade
        // Order of priority: real trade price > fresh fetch > cached variable > fallback
        let currentPrice = context.variables?.realTradePrice || // BEST: Price from the actual trade that triggered us
          context.stepResults?.fetch_token_price?.data?.price ||
          context.variables?.currentPrice ||
          context.variables?.lastKnownPrice;

        console.log(`📌 Price from real trade (TRIGGER): ${context.variables?.realTradePrice}`);
        console.log(`📌 Price from fetch_token_price (FRESH): ${context.stepResults?.fetch_token_price?.data?.price}`);
        console.log(`📌 Price from variables (CACHED): ${context.variables?.currentPrice}`);
        console.log(`📌 Final price used: ${currentPrice}`);

        // Warn if there's a significant price mismatch between fresh and cached
        const tradePrice = context.variables?.realTradePrice;
        const fetchedPrice = context.stepResults?.fetch_token_price?.data?.price;
        if (tradePrice && fetchedPrice && tradePrice !== fetchedPrice) {
          const priceDiff = Math.abs((tradePrice - fetchedPrice) / fetchedPrice) * 100;
          if (priceDiff > 5) {
            console.warn(`⚠️ [PRICE MISMATCH] Trade price differs from fetched by ${priceDiff.toFixed(2)}%! (Trade: ${tradePrice}, Fetched: ${fetchedPrice})`);
            console.warn(`⚠️ Using trade price as it's more accurate (reflects actual execution price)`);
          }
        }

        // Validate price - NO FALLBACKS!
        if (!currentPrice || currentPrice <= 0) {
          console.error(`❌ [PRICE ERROR] Could not get valid price from any source`);
          console.error(`❌ Available prices: trade=${context.variables?.realTradePrice}, fetched=${context.stepResults?.fetch_token_price?.data?.price}, cached=${context.variables?.currentPrice}`);
          throw new Error('Cannot execute trade without current market price. All price sources failed.');
        }
        
        if (currentPrice >= 1) {
          console.error(`❌ [PRICE ERROR] Got invalid price ${currentPrice} (likely SOL/USD or TOKEN/USD, not TOKEN/SOL)`);
          throw new Error(`Invalid price type: ${currentPrice}. Expected TOKEN/SOL price < 1.`);
        }

        let calculatedAmount: number;

        // CHECK IF USER SPECIFIED A FIXED SELL AMOUNT
        if (config.sellAmount && config.sellAmount > 0) {
          // USER SPECIFIED EXACT TOKEN AMOUNT - override any calculation
          calculatedAmount = config.sellAmount;
          console.log(`💎 [FIXED USER AMOUNT] User specified exact amount: ${config.sellAmount.toLocaleString()} tokens`);
          console.log(`📊 [INFO] Ignoring detected volume - using user's fixed amount`);
        } else if (sizingRule === 'mirror_buy_volume' || sizingRule === 'mirror_volume') {
          // EXACT 1:1 MIRRORING: Sell the exact same token amount that buyers are buying
          // CRITICAL FIX: Use the actual token amount from the real trade, NOT recalculated from SOL
          // This ensures 100% accurate mirroring regardless of price slippage
          const mirrorTokenAmount = context.variables.realTradeTokenAmount;
          const mirrorSolAmount = context.variables.realTradeSolAmount || detectedVolumeSOL;
          
          if (mirrorTokenAmount && mirrorTokenAmount > 0) {
            // Use actual token amount from trade (MOST ACCURATE)
            calculatedAmount = mirrorTokenAmount;
            console.log(`🎯 [MIRROR MODE] Exact 1:1 mirroring - using ACTUAL trade token amount`);
            console.log(`📊 [MIRROR MODE] Detected buy: ${mirrorTokenAmount.toFixed(2)} tokens (${mirrorSolAmount.toFixed(6)} SOL)`);
            console.log(`📊 [MIRROR MODE] Will sell EXACTLY: ${Math.floor(calculatedAmount).toLocaleString()} tokens`);
          } else {
            // Fallback: Calculate from SOL amount (less accurate due to price movement)
            calculatedAmount = mirrorSolAmount / currentPrice;
            console.log(`⚠️ [MIRROR MODE] Token amount not available, calculating from SOL`);
            console.log(`📊 [MIRROR MODE] Detected buy: ${mirrorSolAmount.toFixed(6)} SOL`);
            console.log(`📊 [MIRROR MODE] Current price: ${currentPrice.toFixed(10)} SOL per token`);
            console.log(`📊 [MIRROR MODE] Calculated: ${calculatedAmount.toFixed(2)} tokens`);
          }
        } else if (sizingRule === 'percentage') {
          // Percentage of position (5% default)
          const sellPercentage = 0.05;
          calculatedAmount = currentPosition * sellPercentage;

          console.log(`📊 [PERCENTAGE MODE] Selling ${sellPercentage * 100}% of position: ${calculatedAmount.toFixed(0)} tokens`);
        } else if (sizingRule === 'fixed_amount') {
          // Fixed token amount (from config or default)
          calculatedAmount = config.sellAmount || (config.buyAmount ? (config.buyAmount / currentPrice) : 5000);

          console.log(`📊 [FIXED MODE] Selling fixed amount: ${calculatedAmount.toFixed(0)} tokens`);
        } else {
          // Fallback: use mirror mode
          calculatedAmount = detectedVolumeSOL / currentPrice;
          console.log(`⚠️ [DEFAULT] Unknown sizingRule '${sizingRule}', using mirror mode`);
        }

        // Ensure we don't sell more than we have
        calculatedAmount = Math.min(calculatedAmount, currentPosition);

        // Calculate final amount
        const finalAmount = Math.floor(calculatedAmount);

        // Set amount based on mode
        if (config.sellAmount && config.sellAmount > 0) {
          // User specified amount - use it exactly
          context.variables.tokenAmountToSell = config.sellAmount;
          console.log(`💎 [USER SPECIFIED] Using exact user amount: ${config.sellAmount.toLocaleString()} tokens`);
        } else {
          // Dynamic calculation - use calculated amount directly (no artificial minimums)
          context.variables.tokenAmountToSell = Math.max(1, finalAmount);
          console.log(`🔢 [CALCULATED] Using calculated amount: ${finalAmount.toLocaleString()} tokens from ${detectedVolumeSOL.toFixed(6)} SOL at price ${currentPrice.toFixed(10)}`);
        }

        console.log(`✅ [SIZING FINAL] Will sell ${context.variables.tokenAmountToSell.toLocaleString()} tokens (${((context.variables.tokenAmountToSell / currentPosition) * 100).toFixed(2)}% of position)`);

        // Store price for next iteration if fetch failed
        if (context.stepResults?.get_current_price?.data?.price) {
          context.variables.lastKnownPrice = context.stepResults.get_current_price.data.price;
          context.variables.lastPriceTimestamp = Date.now();
        }

        return true;
      },
      onSuccess: 'execute_mirror_sell',
      onFailure: 'wait_for_trigger', // Loop back to monitoring if no tokens available
      description: `Calculate sell amount using ${config.sizingRule || 'mirror_buy_volume'} sizing rule`
    });

    steps.push({
      id: 'execute_mirror_sell',
      type: 'sell',
      amountToSell: -1, // -1 means use context.variables.tokenAmountToSell (dynamic sizing)
      onSuccess: 'log_sell_execution',
      onFailure: 'handle_failure',
      description: 'Execute mirrored sell order (dynamic amount from calculate_sell_amount)'
    });
    steps.push({
      id: 'log_sell_execution',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;
        const lastSellAmount = context.stepResults.execute_mirror_sell?.data?.tokenAmount || 0;
        console.log(`💰 [MIRROR SELL #${context.variables.executionCount}] Sold ${lastSellAmount} tokens (dynamically calculated)`);
        
        // CRITICAL FIX: Reset ALL flags to clean state after execution
        context.variables.realTradeDetected = false;
        context.variables._detectionAttempts = 0; // Reset detection counter
        console.log(`🔄 [FLAG RESET] Trade executed successfully, all flags reset for next trigger`);
        
        return true;
      },
      onSuccess: 'wait_for_trigger',
      description: 'Log sell execution and reset trigger flag'
    });
  } else {
    // BUY STRATEGY: Mirror sell volumes
    // Step 1a: Fetch token price from market
    steps.push({
      id: 'fetch_token_price_buy',
      type: 'getPrice',
      onSuccess: 'validate_token_price_buy',
      onFailure: 'validate_token_price_buy', // Continue even if fetch fails
      description: 'Fetch current token price from market data'
    });

    // Step 1b: Validate we got TOKEN price (not SOL price)
    steps.push({
      id: 'validate_token_price_buy',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        // CRITICAL: Validate we have TOKEN/SOL price for calculations
        const stepResult = context.stepResults?.fetch_token_price_buy?.data;

        if (!stepResult || !stepResult.price) {
          console.error(`❌ [BUY PRICE ERROR] No price data returned from fetch`);
          throw new Error('Failed to fetch token price. Cannot execute trade without market price.');
        }

        const price = stepResult.price;
        const priceUSD = stepResult.priceUSD;
        const solPrice = stepResult.solPrice;

        // CRITICAL: Validate we have TOKEN/SOL price (should be < 1 for most tokens)
        if (price >= 1) {
          console.error(`❌ [BUY PRICE ERROR] Invalid price: ${price}`);
          console.error(`❌ This looks like SOL/USD or TOKEN/USD, not TOKEN/SOL!`);
          console.error(`❌ TOKEN/SOL prices should always be < 1`);

          // Try to derive TOKEN/SOL from TOKEN/USD and SOL/USD
          if (priceUSD && solPrice && priceUSD > 0 && solPrice > 0) {
            const tokenPriceInSOL = priceUSD / solPrice;
            if (tokenPriceInSOL > 0 && tokenPriceInSOL < 1) {
              context.variables.currentPrice = tokenPriceInSOL;
              context.variables.priceSource = `${stepResult.source} (derived)`;
              console.log(`✅ [BUY DERIVED] Calculated TOKEN/SOL: ${tokenPriceInSOL.toFixed(10)}`);
              console.log(`✅ From: $${priceUSD} TOKEN/USD / $${solPrice} SOL/USD`);
              return true;
            }
          }

          throw new Error(`Invalid price type: ${price}. Expected TOKEN/SOL price < 1.`);
        }

        // Valid TOKEN/SOL price
        context.variables.currentPrice = price;
        context.variables.priceSource = stepResult.source;
        console.log(`✅ [BUY PRICE OK] TOKEN/SOL: ${price.toFixed(10)} from ${stepResult.source}`);

        // Store additional price info for display
        if (priceUSD) context.variables.tokenPriceUSD = priceUSD;
        if (solPrice) context.variables.solPriceUSD = solPrice;

        return true;
      },
      onSuccess: 'calculate_buy_amount',
      description: 'Validate TOKEN price in SOL (not SOL/USD price!)'
    });

    // Step 2: Calculate EXACT buy amount (in SOL) based on detected sell volume (in tokens)
    steps.push({
      id: 'calculate_buy_amount',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const sizingRule = config.sizingRule || 'mirror_sell_volume';
        const detectedTokenVolume = context.variables.detectedVolume || 1000; // Default: 1000 tokens

        console.log(`\n====== CALCULATE BUY AMOUNT DEBUG ======`);
        console.log(`📌 Config sizingRule: ${sizingRule}`);
        console.log(`📌 Detected sell volume: ${detectedTokenVolume.toLocaleString()} tokens`);

        // Get current token price - should be TOKEN/SOL, not SOL/USD!
        let currentPrice = context.variables?.currentPrice ||
          context.stepResults?.fetch_token_price_buy?.data?.price ||
          context.variables?.lastKnownPrice;

        console.log(`📌 Price from variables: ${context.variables?.currentPrice}`);
        console.log(`📌 Price from fetch: ${context.stepResults?.fetch_token_price_buy?.data?.price}`);
        console.log(`📌 Final price used: ${currentPrice}`);

        // Validate price - NO FALLBACKS!
        if (!currentPrice || currentPrice <= 0) {
          console.error(`❌ [BUY PRICE ERROR] Could not fetch valid price`);
          throw new Error('Cannot execute trade without current market price. Price fetch failed.');
        }
        
        if (currentPrice >= 1) {
          console.error(`❌ [BUY PRICE ERROR] Got invalid price ${currentPrice} (likely SOL/USD or TOKEN/USD, not TOKEN/SOL)`);
          throw new Error(`Invalid price type: ${currentPrice}. Expected TOKEN/SOL price < 1.`);
        }

        let calculatedSOL: number;

        // CHECK IF USER SPECIFIED A FIXED BUY AMOUNT
        if (config.buyAmount && config.buyAmount > 0) {
          // USER SPECIFIED EXACT SOL AMOUNT - override any calculation
          calculatedSOL = config.buyAmount;
          console.log(`💎 [FIXED USER AMOUNT] User specified exact amount: ${config.buyAmount.toFixed(6)} SOL`);
          console.log(`📊 [INFO] Ignoring detected sell volume - using user's fixed amount`);
        } else if (sizingRule === 'mirror_sell_volume') {
          // EXACT 1:1 MIRRORING: Buy the exact same token amount that sellers are selling
          // Convert detected token volume to SOL amount using current price
          calculatedSOL = detectedTokenVolume * currentPrice;

          console.log(`🎯 [MIRROR MODE] Exact 1:1 mirroring enabled`);
          console.log(`📊 [MIRROR MODE] Detected sell: ${detectedTokenVolume.toLocaleString()} tokens`);
          console.log(`📊 [MIRROR MODE] Current price: ${currentPrice.toFixed(10)} SOL per token`);
          console.log(`📊 [MIRROR MODE] Raw calculation: ${calculatedSOL.toFixed(6)} SOL`);
          console.log(`📊 [MIRROR MODE] Will buy with EXACTLY: ${calculatedSOL.toFixed(6)} SOL`);
        } else {
          // Fallback: use fixed amount or default
          calculatedSOL = config.buyAmount || 0.01;
          console.log(`⚠️ [DEFAULT] Unknown sizingRule '${sizingRule}', using ${calculatedSOL} SOL`);
        }

        // Store calculated SOL amount
        const finalSOL = Math.max(0.00001, calculatedSOL); // Minimum 0.00001 SOL
        context.variables.solAmountToBuy = finalSOL;

        console.log(`🔢 [CALCULATED] Using calculated amount: ${finalSOL.toFixed(6)} SOL to buy ${(finalSOL / currentPrice).toLocaleString()} tokens`);
        console.log(`✅ [SIZING FINAL] Will buy with ${finalSOL.toFixed(6)} SOL`);

        // Store price for next iteration
        if (context.stepResults?.fetch_token_price_buy?.data?.price) {
          context.variables.lastKnownPrice = context.stepResults.fetch_token_price_buy.data.price;
          context.variables.lastPriceTimestamp = Date.now();
        }

        return true;
      },
      onSuccess: 'execute_mirror_buy',
      description: `Calculate buy amount (in SOL) using ${config.sizingRule || 'mirror_sell_volume'} sizing rule`
    });

    steps.push({
      id: 'execute_mirror_buy',
      type: 'buy',
      amountInSol: -1, // -1 means use context.variables.solAmountToBuy (dynamic sizing)
      onSuccess: 'log_buy_execution',
      onFailure: 'handle_failure',
      description: 'Execute mirrored buy order (dynamic SOL amount from calculate_buy_amount)'
    });

    steps.push({
      id: 'log_buy_execution',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;
        const lastBuySOL = context.stepResults.execute_mirror_buy?.data?.solAmount || 0;
        console.log(`💰 [MIRROR BUY #${context.variables.executionCount}] Bought with ${lastBuySOL.toFixed(6)} SOL (dynamically calculated)`);

        // CRITICAL FIX: Reset ALL flags to clean state after execution
        context.variables.realTradeDetected = false;
        context.variables._detectionAttempts = 0; // Reset detection counter
        console.log(`🔄 [FLAG RESET] Trade executed successfully, all flags reset for next trigger`);
        return true;
      },
      onSuccess: 'wait_for_trigger',
      description: 'Log buy execution and reset trigger flag'
    });
  }

  steps.push({
    id: 'handle_failure',
    type: 'wait',
    durationMs: 5000,
    onSuccess: 'wait_for_trigger',
    description: 'Handle execution failure and retry'
  });

  steps.push({
    id: 'strategy_stopped',
    type: 'condition' as const,
    condition: 'custom' as const,
    customCondition: (context: any) => {
      console.log(`⏹️ [REACTIVE] Strategy successfully stopped after ${context.variables.executionCount || 0} executions`);
      return false; // Return false to end strategy
    },
    description: 'Strategy stopped by user'
  });

  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }

  console.log(`✅ [createReactiveMirrorStrategy] Strategy created with ${steps.length} steps`);

  // CRITICAL FIX: Attach tokenAddress to strategy object so it can be used for WebSocket subscription
  const builtStrategy = strategyBuilder.getStrategy(config.id)!;
  
  // Validate and attach tokenAddress
  if (!config.tokenAddress) {
    console.error(`❌ [createReactiveMirrorStrategy] CRITICAL: config.tokenAddress is missing!`);
    console.error(`❌ [createReactiveMirrorStrategy] Config:`, JSON.stringify(config, null, 2));
    throw new Error('tokenAddress is required for reactive mirror strategies');
  }
  
  (builtStrategy as any).tokenAddress = config.tokenAddress;
  console.log(`✅ [createReactiveMirrorStrategy] Attached tokenAddress to strategy: ${config.tokenAddress}`);

  return builtStrategy;
}

/**
 * CONTRARIAN VOLATILITY STRATEGY
 * Sell into strength (price rises rapidly) and buy into weakness (price drops sharply)
 * Perfect for high-volatility tokens and mean reversion trading
 */
export function createContrarianVolatilityStrategy(config: {
  id: string;
  description: string;
  tokenAddress: string;
  // Sell conditions
  sellTriggerPercentage: number; // e.g., 5 = sell when price rises 5%
  sellTriggerTimeframeMinutes: number; // e.g., 5 = within 5 minutes
  sellAmountTokens: number; // e.g., 1500 tokens
  // Buy conditions
  buyTriggerPercentage: number; // e.g., 15 = buy when price drops 15%
  buyTriggerTimeframeMinutes: number; // e.g., 5 = within 5 minutes
  buyAmountSOL: number; // e.g., 0.001 SOL
}): Strategy {
  console.log(`🎯 [createContrarianVolatilityStrategy] Creating volatility strategy for ${config.tokenAddress}`);

  const strategy = strategyBuilder.createStrategy(
    config.id,
    `Contrarian Volatility Strategy`,
    `${config.description} - Sell on ${config.sellTriggerPercentage}% rise, Buy on ${config.buyTriggerPercentage}% drop`
  );

  strategyBuilder.updateRiskLimits(config.id, {
    maxPositionSizeSOL: config.buyAmountSOL * 10,
    maxDailyLossSOL: config.buyAmountSOL * 5,
    stopLossPercentage: config.buyTriggerPercentage,
    takeProfitPercentage: config.sellTriggerPercentage,
  });

  const steps: StrategyStep[] = [
    {
      id: 'initialize_volatility_strategy',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        console.log(`🎯 Contrarian Volatility Strategy initialized`);
        console.log(`📊 Token: ${config.tokenAddress}`);
        console.log(`📈 SELL Trigger: +${config.sellTriggerPercentage}% in ${config.sellTriggerTimeframeMinutes} min → Sell ${config.sellAmountTokens} tokens`);
        console.log(`📉 BUY Trigger: -${config.buyTriggerPercentage}% in ${config.buyTriggerTimeframeMinutes} min → Buy ${config.buyAmountSOL} SOL`);

        context.variables.tokenAddress = config.tokenAddress;
        context.variables.strategyActive = true;
        context.variables.executionCount = 0;
        context.variables.lastCheckPrice = null;
        context.variables.priceHistory = [];

        return true;
      },
      onSuccess: 'get_baseline_price',
      description: 'Initialize contrarian volatility strategy'
    },

    // Get initial baseline price
    {
      id: 'get_baseline_price',
      type: 'getPrice',
      onSuccess: 'store_baseline',
      onFailure: 'wait_before_retry',
      description: 'Get baseline price for volatility tracking'
    },

    {
      id: 'store_baseline',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const currentPrice = context.stepResults.get_baseline_price?.data?.price;
        if (!currentPrice) return false;

        context.variables.baselinePrice = currentPrice;
        context.variables.baselineTimestamp = Date.now();
        context.variables.priceHistory.push({ price: currentPrice, timestamp: Date.now() });

        console.log(`📊 [BASELINE] Set baseline price: ${currentPrice.toFixed(10)}`);
        return true;
      },
      onSuccess: 'wait_before_check',
      description: 'Store baseline price'
    },

    // Main monitoring loop
    {
      id: 'wait_before_check',
      type: 'wait',
      durationMs: 10000, // Check every 10 seconds
      onSuccess: 'check_stop_flag',
      description: 'Wait before next volatility check'
    },

    {
      id: 'check_stop_flag',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        if (context.variables._shouldStop === true) {
          console.log(`🛑 [VOLATILITY] Strategy stopped by user`);
          return false;
        }
        return true;
      },
      onSuccess: 'get_current_price',
      onFailure: 'strategy_stopped',
      description: 'Check if strategy should stop'
    },

    {
      id: 'get_current_price',
      type: 'getPrice',
      onSuccess: 'analyze_volatility',
      onFailure: 'wait_before_check',
      description: 'Get current price for volatility analysis'
    },

    {
      id: 'analyze_volatility',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        const currentPrice = context.stepResults.get_current_price?.data?.price;
        const baselinePrice = context.variables.baselinePrice;
        const baselineTimestamp = context.variables.baselineTimestamp;

        if (!currentPrice || !baselinePrice) return false;

        const now = Date.now();
        const timeElapsedMinutes = (now - baselineTimestamp) / (1000 * 60);

        // Add to price history
        context.variables.priceHistory.push({ price: currentPrice, timestamp: now });

        // Keep only recent history (last 10 minutes)
        const tenMinutesAgo = now - (10 * 60 * 1000);
        context.variables.priceHistory = context.variables.priceHistory.filter(
          (entry: any) => entry.timestamp > tenMinutesAgo
        );

        // Calculate price change percentage
        const priceChangePercent = ((currentPrice - baselinePrice) / baselinePrice) * 100;

        console.log(`📊 [VOLATILITY CHECK] Price: ${currentPrice.toFixed(10)}, Baseline: ${baselinePrice.toFixed(10)}, Change: ${priceChangePercent.toFixed(2)}%, Time: ${timeElapsedMinutes.toFixed(2)} min`);

        // Check SELL condition (price rose rapidly)
        if (priceChangePercent >= config.sellTriggerPercentage &&
          timeElapsedMinutes <= config.sellTriggerTimeframeMinutes) {
          console.log(`🔴 [SELL TRIGGER] Price rose ${priceChangePercent.toFixed(2)}% in ${timeElapsedMinutes.toFixed(2)} minutes!`);
          context.variables.triggerType = 'sell';
          context.variables.triggerPrice = currentPrice;
          return true;
        }

        // Check BUY condition (price dropped sharply)
        if (priceChangePercent <= -config.buyTriggerPercentage &&
          timeElapsedMinutes <= config.buyTriggerTimeframeMinutes) {
          console.log(`🟢 [BUY TRIGGER] Price dropped ${Math.abs(priceChangePercent).toFixed(2)}% in ${timeElapsedMinutes.toFixed(2)} minutes!`);
          context.variables.triggerType = 'buy';
          context.variables.triggerPrice = currentPrice;
          return true;
        }

        // Reset baseline if timeframe exceeded without trigger
        if (timeElapsedMinutes > Math.max(config.sellTriggerTimeframeMinutes, config.buyTriggerTimeframeMinutes)) {
          console.log(`⏰ [RESET] Timeframe exceeded, resetting baseline to current price`);
          context.variables.baselinePrice = currentPrice;
          context.variables.baselineTimestamp = now;
        }

        return false;
      },
      onSuccess: 'route_to_action',
      onFailure: 'wait_before_check',
      description: 'Analyze price volatility for triggers'
    },

    {
      id: 'route_to_action',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        return context.variables.triggerType === 'sell';
      },
      onSuccess: 'execute_contrarian_sell',
      onFailure: 'execute_contrarian_buy',
      description: 'Route to sell or buy action'
    },

    // SELL execution
    {
      id: 'execute_contrarian_sell',
      type: 'sell',
      amountToSell: config.sellAmountTokens,
      onSuccess: 'log_sell_execution',
      onFailure: 'handle_execution_failure',
      description: `Contrarian SELL: ${config.sellAmountTokens} tokens (price rose ${config.sellTriggerPercentage}%)`
    },

    {
      id: 'log_sell_execution',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;
        const triggerPrice = context.variables.triggerPrice;
        console.log(`💰 [CONTRARIAN SELL #${context.variables.executionCount}] Sold ${config.sellAmountTokens} tokens at ${triggerPrice.toFixed(10)} (price spike)`);

        // Reset baseline after execution
        context.variables.baselinePrice = triggerPrice;
        context.variables.baselineTimestamp = Date.now();

        return true;
      },
      onSuccess: 'wait_before_check',
      description: 'Log sell execution and reset baseline'
    },

    // BUY execution
    {
      id: 'execute_contrarian_buy',
      type: 'buy',
      amountInSol: config.buyAmountSOL,
      onSuccess: 'log_buy_execution',
      onFailure: 'handle_execution_failure',
      description: `Contrarian BUY: ${config.buyAmountSOL} SOL (price dropped ${config.buyTriggerPercentage}%)`
    },

    {
      id: 'log_buy_execution',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        context.variables.executionCount = (context.variables.executionCount || 0) + 1;
        const triggerPrice = context.variables.triggerPrice;
        console.log(`💰 [CONTRARIAN BUY #${context.variables.executionCount}] Bought ${config.buyAmountSOL} SOL at ${triggerPrice.toFixed(10)} (price dip)`);

        // Reset baseline after execution
        context.variables.baselinePrice = triggerPrice;
        context.variables.baselineTimestamp = Date.now();

        return true;
      },
      onSuccess: 'wait_before_check',
      description: 'Log buy execution and reset baseline'
    },

    {
      id: 'handle_execution_failure',
      type: 'wait',
      durationMs: 5000,
      onSuccess: 'wait_before_check',
      description: 'Handle execution failure and continue monitoring'
    },

    {
      id: 'wait_before_retry',
      type: 'wait',
      durationMs: 5000,
      onSuccess: 'get_baseline_price',
      description: 'Wait before retrying price fetch'
    },

    {
      id: 'strategy_stopped',
      type: 'condition' as const,
      condition: 'custom' as const,
      customCondition: (context: any) => {
        console.log(`⏹️ [VOLATILITY] Strategy stopped after ${context.variables.executionCount || 0} executions`);
        return false;
      },
      description: 'Strategy stopped'
    }
  ];

  for (const step of steps) {
    strategyBuilder.addStep(config.id, step);
  }

  console.log(`✅ [createContrarianVolatilityStrategy] Strategy created with ${steps.length} steps`);
  return strategyBuilder.getStrategy(config.id)!;
}

/**
 * Template factory function
 * UPDATED: Better handling of DCA strategies with undefined count
 */
export function createStrategyFromTemplate(templateName: string, config: any): Strategy {
  console.log(`[StrategyTemplates] Creating strategy from template:`, {
    templateName,
    strategyType: config.strategyType,
    configKeys: Object.keys(config)
  });

  // CRITICAL FIX: Map AI-generated strategyType to proper template
  // AI generates { template: "custom", strategyType: "time_based_dca", ... }
  // We need to route "time_based_dca" to DCA template, not custom!
  let actualTemplate = templateName.toLowerCase();

  if (actualTemplate === 'custom' && config.strategyType) {
    const strategyType = config.strategyType.toLowerCase();

    // Map AI strategy types to execution templates
    if (strategyType === 'time_based_dca' || strategyType === 'dca' || strategyType === 'dollar_cost_averaging') {
      actualTemplate = 'dca';
      console.log(`✅ [Template Mapping] Mapped strategyType "${config.strategyType}" → DCA template`);
    } else if (strategyType === 'grid_trading' || strategyType === 'grid') {
      actualTemplate = 'grid';
      console.log(`✅ [Template Mapping] Mapped strategyType "${config.strategyType}" → Grid template`);
    } else if (strategyType === 'momentum' || strategyType === 'momentum_trading') {
      actualTemplate = 'momentum';
      console.log(`✅ [Template Mapping] Mapped strategyType "${config.strategyType}" → Momentum template`);
    } else if (strategyType === 'stop_loss' || strategyType === 'stop_loss_take_profit') {
      actualTemplate = 'stop_loss';
      console.log(`✅ [Template Mapping] Mapped strategyType "${config.strategyType}" → Stop Loss template`);
    } else {
      console.log(`ℹ️ [Template Mapping] Custom strategyType "${config.strategyType}" → using Custom template`);
    }
  }

  switch (actualTemplate) {
    case 'dca':
    case 'dollar_cost_averaging':
      // Map AI fields to DCA fields
      const dcaConfig = {
        id: config.id,
        buyAmountSOL: config.amountPerTrade || config.buyAmountSOL,
        intervalMinutes: config.interval || config.intervalMinutes,
        buyCount: config.totalTrades || config.buyCount,
        sellAmountSOL: config.sellAmountSOL,
        sellCount: config.sellCount,
        side: config.side || 'buy',
        tokenAddress: config.tokenAddress  // Pass tokenAddress through
      };

      console.log(`[StrategyTemplates] Creating DCA Strategy with mapped config:`, dcaConfig);

      // Check if this is a SELL DCA or BUY DCA
      if (dcaConfig.sellAmountSOL || dcaConfig.side === 'sell') {
        return createDCASellStrategy({
          id: dcaConfig.id,
          sellAmountSOL: dcaConfig.sellAmountSOL!,
          intervalMinutes: dcaConfig.intervalMinutes!,
          sellCount: dcaConfig.sellCount
        });
      } else {
        return createDCAStrategy(dcaConfig);
      }

    case 'grid':
    case 'grid_trading':
      return createGridTradingStrategy(config);

    case 'stop_loss':
    case 'stop_loss_take_profit':
      return createStopLossTakeProfitStrategy(config);

    case 'momentum':
    case 'momentum_trading':
      return createMomentumStrategy(config);

    case 'custom':
    case 'advanced':
      return createCustomStrategy(config);

    default:
      throw new Error(`Unknown strategy template: ${actualTemplate}. Available templates: dca, grid, stop_loss, momentum, custom`);
  }
}