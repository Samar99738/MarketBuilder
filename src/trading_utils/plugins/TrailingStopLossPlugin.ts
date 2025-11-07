/**
 * Example Strategy Plugin: Trailing Stop Loss
 * Demonstrates how to create a custom strategy plugin
 * 
 * This plugin implements a trailing stop loss strategy that follows the price up
 * and sells when the price drops by a certain percentage from the highest point.
 */

import {
  BaseStrategyPlugin,
  TradingContext,
  StrategyExecutionResult
} from '../StrategyPlugin';
import { StrategyTypeDefinition } from '../StrategyRegistry';

export class TrailingStopLossPlugin extends BaseStrategyPlugin {
  name = 'trailing-stop-loss';
  version = '1.0.0';
  author = 'FlicLabs';
  description = 'Trailing stop loss that follows price up and sells on drops';

  // Track highest price seen for each strategy instance
  private highestPrices: Map<string, number> = new Map();

  getStrategyDefinition(): StrategyTypeDefinition {
    return {
      type: 'trailing_stop_loss',
      displayName: 'Trailing Stop Loss',
      description: 'Automatically sell when price drops by a percentage from the highest point reached. The stop loss "trails" the price as it rises.',
      category: 'custom',
      riskLevel: 'low',
      version: this.version,
      aiPromptHint: 'User wants a trailing stop loss that follows price up and sells on drops',
      aiDetectionKeywords: [
        'trailing stop',
        'trailing stop loss',
        'follow price up',
        'sell on drop from high',
        'protect profits',
        'dynamic stop loss'
      ],
      exampleInputs: [
        'Set trailing stop loss at 5% below highest price',
        'Protect my profits with a 10% trailing stop',
        'Sell if price drops 8% from peak'
      ],
      recommendedFor: [
        'Profit protection',
        'Long positions',
        'Volatile markets',
        'Risk management'
      ],
      fields: [
        {
          name: 'tokenAddress',
          type: 'string',
          required: true,
          description: 'Solana token address to monitor',
          validation: {
            pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          }
        },
        {
          name: 'trailingPercentage',
          type: 'number',
          required: true,
          description: 'Percentage drop from highest price that triggers sell (e.g., 5 for 5%)',
          validation: {
            min: 0.1,
            max: 50
          }
        },
        {
          name: 'sellAmountTokens',
          type: 'number',
          required: true,
          description: 'Number of tokens to sell when triggered',
          validation: {
            min: 0.000001
          }
        },
        {
          name: 'initialPrice',
          type: 'number',
          required: false,
          description: 'Initial price to start tracking from (uses current if not specified)',
          validation: {
            min: 0
          }
        }
      ],
      exampleConfig: {
        id: 'trailing-stop-loss-1730304000',
        strategyType: 'trailing_stop_loss',
        description: 'Trailing stop loss at 5% below highest price',
        tokenAddress: 'FfNrWEjpAms4m3hmBc4fjpXgm8MM1MQQtygFrJPYpump',
        trailingPercentage: 5,
        sellAmountTokens: 1000,
        confidence: 1.0,
        isComplete: true
      }
    };
  }

  /**
   * Custom validation for this strategy
   */
  validate(config: any): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required fields
    if (!config.tokenAddress) {
      errors.push('tokenAddress is required');
    }

    const percentageError = this.validateNumber(
      config.trailingPercentage,
      'trailingPercentage',
      { min: 0.1, max: 50 }
    );
    if (percentageError) {
      errors.push(percentageError);
    }

    const amountError = this.validateNumber(
      config.sellAmountTokens,
      'sellAmountTokens',
      { min: 0.000001 }
    );
    if (amountError) {
      errors.push(amountError);
    }

    // Warnings for common issues
    if (config.trailingPercentage > 20) {
      warnings.push('Trailing percentage > 20% is very wide, may not protect profits effectively');
    }

    if (config.trailingPercentage < 2) {
      warnings.push('Trailing percentage < 2% is very tight, may trigger on normal volatility');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Execute the trailing stop loss strategy
   */
  async execute(config: any, context: TradingContext): Promise<StrategyExecutionResult> {
    try {
      const {
        tokenAddress,
        trailingPercentage,
        sellAmountTokens,
        initialPrice
      } = config;

      const currentPrice = context.currentPrice;
      
      // Get or initialize highest price
      const strategyId = `${tokenAddress}-${trailingPercentage}`;
      let highestPrice = this.highestPrices.get(strategyId);

      if (highestPrice === undefined) {
        // First execution - set highest price
        const initialHighest = initialPrice || currentPrice;
        this.highestPrices.set(strategyId, initialHighest);
        
        this.log(`Initialized trailing stop loss at ${initialHighest} with ${trailingPercentage}% trail`);
        
        return this.success('hold', `Trailing stop initialized. Highest: $${initialHighest.toFixed(6)}`, {
          highestPrice: initialHighest,
          currentPrice,
          trailDistance: trailingPercentage,
          stopLossPrice: initialHighest * (1 - trailingPercentage / 100)
        });
      }

      // Update highest price if current is higher
      if (currentPrice > highestPrice) {
        highestPrice = currentPrice;
        this.highestPrices.set(strategyId, highestPrice);
        this.log(`New high reached: $${highestPrice.toFixed(6)}`);
      }

      // Calculate stop loss price (highestPrice is guaranteed to be a number here)
      const stopLossPrice = highestPrice * (1 - trailingPercentage / 100);
      const dropPercentage = ((highestPrice - currentPrice) / highestPrice) * 100;

      this.log(
        `Current: $${currentPrice.toFixed(6)}, ` +
        `High: $${highestPrice.toFixed(6)}, ` +
        `Stop: $${stopLossPrice.toFixed(6)}, ` +
        `Drop: ${dropPercentage.toFixed(2)}%`
      );

      // Check if stop loss triggered
      if (currentPrice <= stopLossPrice) {
        this.log(`🚨 STOP LOSS TRIGGERED! Selling ${sellAmountTokens} tokens`, 'warn');
        
        // Reset highest price after selling
        this.highestPrices.delete(strategyId);

        return this.success('sell', `Trailing stop triggered at $${currentPrice.toFixed(6)}`, {
          highestPrice,
          currentPrice,
          stopLossPrice,
          dropPercentage,
          sellAmountTokens,
          profitFromEntry: initialPrice ? ((currentPrice - initialPrice) / initialPrice) * 100 : null
        });
      }

      // Hold position
      return this.success('hold', `Holding. Price $${currentPrice.toFixed(6)} above stop $${stopLossPrice.toFixed(6)}`, {
        highestPrice,
        currentPrice,
        stopLossPrice,
        dropPercentage,
        distanceToStop: ((currentPrice - stopLossPrice) / currentPrice) * 100
      });

    } catch (error: any) {
      this.log(`Execution error: ${error.message}`, 'error');
      return this.error(error.message);
    }
  }

  /**
   * Lifecycle: Initialize plugin
   */
  async onInit(): Promise<void> {
    this.log('Plugin initialized');
    this.highestPrices.clear();
  }

  /**
   * Lifecycle: Cleanup plugin
   */
  async onDestroy(): Promise<void> {
    this.log('Plugin destroyed');
    this.highestPrices.clear();
  }

  /**
   * Lifecycle: Handle config changes
   */
  async onConfigChange(oldConfig: any, newConfig: any): Promise<void> {
    if (oldConfig.trailingPercentage !== newConfig.trailingPercentage) {
      this.log(`Trailing percentage changed: ${oldConfig.trailingPercentage}% → ${newConfig.trailingPercentage}%`);
    }
  }
}
