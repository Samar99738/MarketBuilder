/**
 * Dynamic Strategy Registry System
 * Allows registering and managing strategy types without modifying core code
 * Phase 2 of AI-First Production Architecture
 */

export interface StrategyFieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    customValidator?: (value: any) => boolean;
  };
  defaultValue?: any;
}

export interface StrategyTypeDefinition {
  type: string;
  displayName: string;
  description: string;
  category: 'volatility' | 'timing' | 'trend' | 'arbitrage' | 'custom';
  fields: StrategyFieldDefinition[];
  aiPromptHint: string;
  aiDetectionKeywords: string[];
  exampleInputs: string[];
  exampleConfig: any;
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  recommendedFor: string[];
  version: string;
}

export class StrategyRegistry {
  private strategies: Map<string, StrategyTypeDefinition> = new Map();
  private version: string = '2.0.0';

  constructor() {
    console.log('🏗️ [REGISTRY] Initializing Dynamic Strategy Registry v' + this.version);
    this.registerBuiltInStrategies();
  }

  /**
   * Register a new strategy type dynamically
   */
  register(definition: StrategyTypeDefinition): void {
    // Validate definition
    if (!definition.type || !definition.displayName) {
      throw new Error('[REGISTRY] Invalid strategy definition: missing type or displayName');
    }

    if (this.strategies.has(definition.type)) {
      console.warn(`⚠️ [REGISTRY] Overwriting existing strategy type: ${definition.type}`);
    }

    this.strategies.set(definition.type, definition);
    console.log(`✅ [REGISTRY] Registered strategy: ${definition.displayName} (${definition.type})`);
  }

  /**
   * Get strategy definition by type
   */
  get(type: string): StrategyTypeDefinition | undefined {
    return this.strategies.get(type);
  }

  /**
   * Get all registered strategy types
   */
  getAll(): StrategyTypeDefinition[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get strategies by category
   */
  getByCategory(category: string): StrategyTypeDefinition[] {
    return this.getAll().filter(s => s.category === category);
  }

  /**
   * Get required fields for a strategy type
   */
  getRequiredFields(type: string): string[] {
    const strategy = this.get(type);
    if (!strategy) return [];
    return strategy.fields.filter(f => f.required).map(f => f.name);
  }

  /**
   * Get optional fields for a strategy type
   */
  getOptionalFields(type: string): string[] {
    const strategy = this.get(type);
    if (!strategy) return [];
    return strategy.fields.filter(f => !f.required).map(f => f.name);
  }

  /**
   * Check if a strategy type exists
   */
  has(type: string): boolean {
    return this.strategies.has(type);
  }

  /**
   * Get all strategy types (just the type strings)
   */
  getTypes(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Generate AI system prompt with all registered strategies
   * This is the key to making AI understand all available strategies dynamically
   */
  generateAIPrompt(): string {
    let prompt = '**📚 AVAILABLE STRATEGY TYPES (DYNAMICALLY LOADED):**\n\n';
    
    const strategiesByCategory = new Map<string, StrategyTypeDefinition[]>();
    
    // Group by category
    for (const strategy of this.strategies.values()) {
      const category = strategy.category || 'custom';
      if (!strategiesByCategory.has(category)) {
        strategiesByCategory.set(category, []);
      }
      strategiesByCategory.get(category)!.push(strategy);
    }

    // Generate prompt for each category
    for (const [category, strategies] of strategiesByCategory.entries()) {
      prompt += `### ${category.toUpperCase()} STRATEGIES\n\n`;
      
      for (const strategy of strategies) {
        prompt += `#### ${strategy.displayName} (\`${strategy.type}\`)\n`;
        prompt += `**Risk Level:** ${strategy.riskLevel.toUpperCase()} | **Version:** ${strategy.version}\n\n`;
        prompt += `${strategy.description}\n\n`;
        
        prompt += `**🔍 Detection Rules:**\n`;
        prompt += `- Keywords: ${strategy.aiDetectionKeywords.join(', ')}\n`;
        prompt += `- Hint: ${strategy.aiPromptHint}\n\n`;
        
        prompt += `**📋 Required Fields:**\n`;
        const requiredFields = strategy.fields.filter(f => f.required);
        for (const field of requiredFields) {
          prompt += `- \`${field.name}\` (${field.type}): ${field.description}\n`;
          if (field.validation) {
            const validations = [];
            if (field.validation.min !== undefined) validations.push(`min: ${field.validation.min}`);
            if (field.validation.max !== undefined) validations.push(`max: ${field.validation.max}`);
            if (field.validation.pattern) validations.push(`pattern: ${field.validation.pattern}`);
            if (validations.length > 0) {
              prompt += `  - Validation: ${validations.join(', ')}\n`;
            }
          }
        }
        prompt += '\n';
        
        const optionalFields = strategy.fields.filter(f => !f.required);
        if (optionalFields.length > 0) {
          prompt += `**📋 Optional Fields:**\n`;
          for (const field of optionalFields) {
            prompt += `- \`${field.name}\` (${field.type}): ${field.description}`;
            if (field.defaultValue !== undefined) {
              prompt += ` (default: ${field.defaultValue})`;
            }
            prompt += '\n';
          }
          prompt += '\n';
        }
        
        prompt += `**💡 Example User Inputs:**\n`;
        strategy.exampleInputs.forEach(example => {
          prompt += `- "${example}"\n`;
        });
        prompt += '\n';
        
        prompt += `**📝 Example Configuration:**\n\`\`\`json\n${JSON.stringify(strategy.exampleConfig, null, 2)}\n\`\`\`\n\n`;
        
        if (strategy.recommendedFor.length > 0) {
          prompt += `**✅ Recommended For:** ${strategy.recommendedFor.join(', ')}\n\n`;
        }
        
        prompt += '---\n\n';
      }
    }
    return prompt;
  }

  /**
   * Generate schema for validator (backwards compatible)
   */
  generateValidatorSchema(): {
    strategyTypes: string[];
    requiredFields: Record<string, string[]>;
  } {
    return {
      strategyTypes: this.getTypes(),
      requiredFields: Object.fromEntries(
        this.getTypes().map(type => [type, this.getRequiredFields(type)])
      )
    };
  }

  /**
   * Find strategy type by analyzing user input (AI fallback)
   */
  detectStrategyType(userInput: string): StrategyTypeDefinition | null {
    const input = userInput.toLowerCase();
    
    // Score each strategy based on keyword matches
    const scores = new Map<string, number>();
    
    for (const strategy of this.strategies.values()) {
      let score = 0;
      
      // Check keywords
      for (const keyword of strategy.aiDetectionKeywords) {
        if (input.includes(keyword.toLowerCase())) {
          score += 2;
        }
      }
      
      // Check strategy type name
      if (input.includes(strategy.type.toLowerCase().replace(/_/g, ' '))) {
        score += 3;
      }
      
      // Check display name
      if (input.includes(strategy.displayName.toLowerCase())) {
        score += 3;
      }
      
      if (score > 0) {
        scores.set(strategy.type, score);
      }
    }
    
    // Return highest scoring strategy
    if (scores.size === 0) return null;
    
    const bestMatch = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])[0];
    return this.get(bestMatch[0]) || null;
  }

  /**
   * Validate a field value against its definition
   */
  validateField(strategyType: string, fieldName: string, value: any): {
    isValid: boolean;
    errors: string[];
  } {
    const strategy = this.get(strategyType);
    if (!strategy) {
      return { isValid: false, errors: [`Unknown strategy type: ${strategyType}`] };
    }

    const field = strategy.fields.find(f => f.name === fieldName);
    if (!field) {
      return { isValid: false, errors: [`Unknown field: ${fieldName} for strategy ${strategyType}`] };
    }

    const errors: string[] = [];

    // Type validation
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== field.type && value !== null && value !== undefined) {
      errors.push(`Field ${fieldName} must be type ${field.type}, got ${actualType}`);
    }

    // Validation rules
    if (field.validation && value !== null && value !== undefined) {
      const { min, max, pattern, customValidator } = field.validation;

      if (field.type === 'number') {
        if (min !== undefined && value < min) {
          errors.push(`Field ${fieldName} must be >= ${min}, got ${value}`);
        }
        if (max !== undefined && value > max) {
          errors.push(`Field ${fieldName} must be <= ${max}, got ${value}`);
        }
      }

      if (field.type === 'string' && pattern) {
        const regex = new RegExp(pattern);
        if (!regex.test(value)) {
          errors.push(`Field ${fieldName} does not match required pattern: ${pattern}`);
        }
      }

      if (customValidator && !customValidator(value)) {
        errors.push(`Field ${fieldName} failed custom validation`);
      }
    }
    return { isValid: errors.length === 0, errors };
  }

  /**
   * Get statistics about registered strategies
   */
  getStats(): {
    totalStrategies: number;
    byCategory: Record<string, number>;
    byRiskLevel: Record<string, number>;
  } {
    const stats = {
      totalStrategies: this.strategies.size,
      byCategory: {} as Record<string, number>,
      byRiskLevel: {} as Record<string, number>
    };

    for (const strategy of this.strategies.values()) {
      stats.byCategory[strategy.category] = (stats.byCategory[strategy.category] || 0) + 1;
      stats.byRiskLevel[strategy.riskLevel] = (stats.byRiskLevel[strategy.riskLevel] || 0) + 1;
    }
    return stats;
  }

  /**
   * Register all built-in strategy types
   */
  private registerBuiltInStrategies(): void {
    // 1. CONTRARIAN VOLATILITY
    this.register({
      type: 'contrarian_volatility',
      displayName: 'Contrarian Volatility Trading',
      description: 'Sell when price rises rapidly (sell strength), buy when price drops sharply (buy weakness). Profits from mean reversion after volatility spikes.',
      category: 'volatility',
      riskLevel: 'high',
      version: '1.0.0',
      aiPromptHint: 'User wants to sell on pumps and buy on dumps. Contrarian approach to volatility.',
      aiDetectionKeywords: [
        'sell when rises',
        'buy when drops',
        'contrarian',
        'short pumps',
        'volatility',
        'sell strength',
        'buy weakness',
        'sell high buy low',
        'pump and dump',
        'mean reversion'
      ],
      exampleInputs: [
        'Sell 2000 tokens when price jumps 8% in 3 minutes, buy 0.02 SOL when it crashes 25% in 10 minutes',
        'I want contrarian strategy - sell on 15% rise in 2min, buy on 30% drop in 8min',
        'Short pump: sell 5k tokens at 12% spike, buy back with 0.05 SOL at 35% dump'
      ],
      recommendedFor: [
        'Volatile pump.fun tokens',
        'Memecoin trading',
        'High-frequency scalping',
        'Mean reversion strategies'
      ],
      fields: [
        {
          name: 'tokenAddress',
          type: 'string',
          required: true,
          description: 'Solana token address to trade',
          validation: {
            pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          }
        },
        {
          name: 'sellTriggerPercentage',
          type: 'number',
          required: true,
          description: 'Percentage rise that triggers a sell (e.g., 8 for 8%)',
          validation: {
            min: 0.1,
            max: 1000
          }
        },
        {
          name: 'sellTriggerTimeframeMinutes',
          type: 'number',
          required: false,
          description: 'Timeframe in minutes for measuring price rise',
          validation: {
            min: 0.5,
            max: 1440
          },
          defaultValue: 5
        },
        {
          name: 'sellAmountTokens',
          type: 'number',
          required: true,
          description: 'Number of tokens to sell when trigger hits',
          validation: {
            min: 0.000001
          }
        },
        {
          name: 'buyTriggerPercentage',
          type: 'number',
          required: true,
          description: 'Percentage drop that triggers a buy (e.g., 25 for 25%)',
          validation: {
            min: 0.1,
            max: 100
          }
        },
        {
          name: 'buyTriggerTimeframeMinutes',
          type: 'number',
          required: false,
          description: 'Timeframe in minutes for measuring price drop',
          validation: {
            min: 0.5,
            max: 1440
          },
          defaultValue: 10
        },
        {
          name: 'buyAmountSOL',
          type: 'number',
          required: true,
          description: 'Amount of SOL to spend on buy trigger',
          validation: {
            min: 0.001
          }
        }
      ],
      exampleConfig: {
        id: 'contrarian-volatility-1730304000',
        strategyType: 'contrarian_volatility',
        description: 'Sell 2000 tokens on 8% rise in 3min, buy 0.02 SOL on 25% drop in 10min',
        tokenAddress: 'FfNrWEjpAms4m3hmBc4fjpXgm8MM1MQQtygFrJPYpump',
        sellTriggerPercentage: 8,
        sellTriggerTimeframeMinutes: 3,
        sellAmountTokens: 2000,
        buyTriggerPercentage: 25,
        buyTriggerTimeframeMinutes: 10,
        buyAmountSOL: 0.02,
        confidence: 1.0,
        isComplete: true
      }
    });

    // 2. TIME-BASED DCA
    this.register({
      type: 'time_based_dca',
      displayName: 'Dollar Cost Averaging (DCA)',
      description: 'Purchase or sell fixed amounts at regular time intervals. Reduces impact of volatility through time-based averaging.',
      category: 'timing',
      riskLevel: 'low',
      version: '1.0.0',
      aiPromptHint: 'User wants repeated purchases/sales at fixed time intervals.',
      aiDetectionKeywords: [
        'every',
        'repeatedly',
        'dca',
        'dollar cost average',
        'recurring',
        'schedule',
        'interval',
        'periodic',
        'regular purchases'
      ],
      exampleInputs: [
        'Buy 0.1 SOL of this token every 5 minutes for 10 times',
        'DCA into this token: 0.05 SOL every 30 minutes, repeat 20 times',
        'Schedule recurring buy: 0.02 SOL every 2 minutes for the next hour'
      ],
      recommendedFor: [
        'Long-term accumulation',
        'Reducing volatility impact',
        'Disciplined investing',
        'New token launches'
      ],
      fields: [
        {
          name: 'tokenAddress',
          type: 'string',
          required: true,
          description: 'Solana token address to trade',
          validation: {
            pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          }
        },
        {
          name: 'amountPerTrade',
          type: 'number',
          required: true,
          description: 'Amount of SOL to spend per trade',
          validation: {
            min: 0.001
          }
        },
        {
          name: 'interval',
          type: 'number',
          required: true,
          description: 'Time interval between trades in minutes',
          validation: {
            min: 1,
            max: 10080
          }
        },
        {
          name: 'totalTrades',
          type: 'number',
          required: true,
          description: 'Total number of trades to execute',
          validation: {
            min: 1,
            max: 1000
          }
        }
      ],
      exampleConfig: {
        id: 'time-based-dca-1730304000',
        strategyType: 'time_based_dca',
        description: 'Buy 0.1 SOL every 5 minutes for 10 trades',
        tokenAddress: 'FfNrWEjpAms4m3hmBc4fjpXgm8MM1MQQtygFrJPYpump',
        amountPerTrade: 0.1,
        interval: 5,
        totalTrades: 10,
        confidence: 1.0,
        isComplete: true
      }
    });

    // 3. REACTIVE TRADING
    this.register({
      type: 'reactive',
      displayName: 'Reactive Trading',
      description: 'Mirror or counter real-time market activity. Execute trades in response to detected buy/sell patterns.',
      category: 'trend',
      riskLevel: 'high',
      version: '1.0.0',
      aiPromptHint: 'User wants to react to market activity, mirror trades, or follow volume.',
      aiDetectionKeywords: [
        'when others buy',
        'mirror',
        'copy trades',
        'follow activity',
        'react to market',
        'match buying',
        'follow volume',
        'shadow trading'
      ],
      exampleInputs: [
        'Sell when people are buying this token',
        'Mirror buy activity - match their volume',
        'React to large purchases by selling the same amount'
      ],
      recommendedFor: [
        'High-volume tokens',
        'Liquidity provision',
        'Market making',
        'Contrarian exits'
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
          name: 'trigger',
          type: 'string',
          required: true,
          description: 'What market activity triggers the reaction (e.g., mirror_buy_activity, large_sell)',
        },
        {
          name: 'side',
          type: 'string',
          required: true,
          description: 'Trade side: buy or sell',
        },
        {
          name: 'sizingRule',
          type: 'string',
          required: false,
          description: 'How to size the trade (e.g., mirror_buy_volume, fixed_amount)',
          defaultValue: 'mirror_buy_volume'
        }
      ],
      exampleConfig: {
        id: 'reactive-1730304000',
        strategyType: 'reactive',
        description: 'Sell tokens mirroring detected buy activity',
        tokenAddress: 'FfNrWEjpAms4m3hmBc4fjpXgm8MM1MQQtygFrJPYpump',
        trigger: 'mirror_buy_activity',
        side: 'sell',
        sizingRule: 'mirror_buy_volume',
        confidence: 1.0,
        isComplete: true
      }
    });

    // 4. GRID TRADING
    this.register({
      type: 'grid_trading',
      displayName: 'Grid Trading',
      description: 'Place multiple buy and sell orders at predefined price levels. Profits from price oscillation within a range.',
      category: 'arbitrage',
      riskLevel: 'medium',
      version: '1.0.0',
      aiPromptHint: 'User wants to place orders at multiple price levels in a range.',
      aiDetectionKeywords: [
        'grid',
        'price levels',
        'range',
        'between',
        'laddered orders',
        'spread orders',
        'multiple levels'
      ],
      exampleInputs: [
        'Create 5 buy orders between $1 and $2',
        'Grid trading: 10 levels from 0.001 to 0.002 SOL',
        'Place laddered orders: 8 grids in the range'
      ],
      recommendedFor: [
        'Range-bound markets',
        'Sideways price action',
        'Stable tokens',
        'Automated market making'
      ],
      fields: [
        {
          name: 'tokenAddress',
          type: 'string',
          required: true,
          description: 'Solana token address to trade',
          validation: {
            pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          }
        },
        {
          name: 'priceRangeLow',
          type: 'number',
          required: true,
          description: 'Lower bound of price range',
          validation: {
            min: 0.000001
          }
        },
        {
          name: 'priceRangeHigh',
          type: 'number',
          required: true,
          description: 'Upper bound of price range',
          validation: {
            min: 0.000001
          }
        },
        {
          name: 'gridLevels',
          type: 'number',
          required: true,
          description: 'Number of price levels to create',
          validation: {
            min: 2,
            max: 100
          }
        },
        {
          name: 'amountPerLevel',
          type: 'number',
          required: true,
          description: 'Amount to trade at each level (in SOL)',
          validation: {
            min: 0.001
          }
        }
      ],
      exampleConfig: {
        id: 'grid-trading-1730304000',
        strategyType: 'grid_trading',
        description: 'Grid trading with 5 levels between $1 and $2',
        tokenAddress: 'FfNrWEjpAms4m3hmBc4fjpXgm8MM1MQQtygFrJPYpump',
        priceRangeLow: 1.0,
        priceRangeHigh: 2.0,
        gridLevels: 5,
        amountPerLevel: 0.05,
        confidence: 1.0,
        isComplete: true
      }
    });

    // 5. MOMENTUM TRADING
    this.register({
      type: 'momentum',
      displayName: 'Momentum Trading',
      description: 'Ride strong price trends and breakouts. Enter when momentum is strong, exit when it weakens.',
      category: 'trend',
      riskLevel: 'high',
      version: '1.0.0',
      aiPromptHint: 'User wants to follow strong trends and breakouts.',
      aiDetectionKeywords: [
        'momentum',
        'trend',
        'breakout',
        'follow the move',
        'ride the wave',
        'strong movement',
        'trending'
      ],
      exampleInputs: [
        'Buy when price breaks above resistance with volume',
        'Enter on momentum: 10% rise with high volume',
        'Ride the trend when price accelerates'
      ],
      recommendedFor: [
        'Trending markets',
        'Breakout trading',
        'High volatility periods',
        'Strong directional moves'
      ],
      fields: [
        {
          name: 'tokenAddress',
          type: 'string',
          required: true,
          description: 'Solana token address to trade',
          validation: {
            pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          }
        },
        {
          name: 'momentumThreshold',
          type: 'number',
          required: true,
          description: 'Momentum threshold to trigger entry (percentage)',
          validation: {
            min: 0.1,
            max: 100
          }
        },
        {
          name: 'timeframe',
          type: 'number',
          required: true,
          description: 'Timeframe to measure momentum (minutes)',
          validation: {
            min: 1,
            max: 1440
          }
        },
        {
          name: 'positionSize',
          type: 'number',
          required: true,
          description: 'Position size in SOL',
          validation: {
            min: 0.001
          }
        }
      ],
      exampleConfig: {
        id: 'momentum-1730304000',
        strategyType: 'momentum',
        description: 'Buy on 10% momentum spike in 5 minutes',
        tokenAddress: 'FfNrWEjpAms4m3hmBc4fjpXgm8MM1MQQtygFrJPYpump',
        momentumThreshold: 10,
        timeframe: 5,
        positionSize: 0.1,
        confidence: 1.0,
        isComplete: true
      }
    });

    // 6. MEAN REVERSION
    this.register({
      type: 'mean_reversion',
      displayName: 'Mean Reversion',
      description: 'Trade oversold/overbought conditions. Buy when price deviates below average, sell when above.',
      category: 'volatility',
      riskLevel: 'medium',
      version: '1.0.0',
      aiPromptHint: 'User wants to trade price extremes and reversions to average.',
      aiDetectionKeywords: [
        'mean reversion',
        'oversold',
        'overbought',
        'bounce back',
        'rsi',
        'deviation',
        'extreme',
        'revert'
      ],
      exampleInputs: [
        'Buy when RSI drops below 30',
        'Trade mean reversion: buy 2 std deviations below average',
        'Enter when price is oversold and likely to bounce'
      ],
      recommendedFor: [
        'Range-bound markets',
        'Established tokens',
        'Lower volatility',
        'Statistical arbitrage'
      ],
      fields: [
        {
          name: 'tokenAddress',
          type: 'string',
          required: true,
          description: 'Solana token address to trade',
          validation: {
            pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          }
        },
        {
          name: 'deviationThreshold',
          type: 'number',
          required: true,
          description: 'Price deviation threshold (standard deviations or percentage)',
          validation: {
            min: 0.1,
            max: 10
          }
        },
        {
          name: 'lookbackPeriod',
          type: 'number',
          required: true,
          description: 'Historical period to calculate mean (minutes)',
          validation: {
            min: 5,
            max: 1440
          }
        },
        {
          name: 'positionSize',
          type: 'number',
          required: true,
          description: 'Position size in SOL',
          validation: {
            min: 0.001
          }
        }
      ],
      exampleConfig: {
        id: 'mean-reversion-1730304000',
        strategyType: 'mean_reversion',
        description: 'Buy when price drops 2 std deviations below 60-min average',
        tokenAddress: 'FfNrWEjpAms4m3hmBc4fjpXgm8MM1MQQtygFrJPYpump',
        deviationThreshold: 2,
        lookbackPeriod: 60,
        positionSize: 0.05,
        confidence: 1.0,
        isComplete: true
      }
    });

    const stats = this.getStats();
    console.log(`✅ [REGISTRY] Registered ${stats.totalStrategies} built-in strategies:`, stats);
  }
}

// Export singleton instance
export const strategyRegistry = new StrategyRegistry();
