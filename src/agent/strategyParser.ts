/**
 * Strategy Parser
 * Converts AI-generated text responses into StrategyBuilder-compatible configurations
 * UPDATED: Fixed extraction bugs - proper priority order and SELL detection!
 */

export interface ParsedStrategy {
  template: 'dca' | 'grid' | 'stop_loss' | 'momentum' | 'reactive_mirror' | 'custom';
  config: any;
  confidence: number;
  requiresConfirmation: boolean;
}

export class StrategyParser {
  /**
   * Parse AI response into strategy configuration
   */
  parseStrategy(text: string): ParsedStrategy | null {
    // Try to infer strategy from natural language
    const inferredStrategy = this.inferStrategyFromText(text);

    // If no basic strategy found, check for advanced strategy patterns
    if (!inferredStrategy) {
      return this.parseAdvancedStrategy(text);
    }
    return inferredStrategy;
  }

  /**
   * Infer strategy type and parameters from natural language
   */
  private inferStrategyFromText(text: string): ParsedStrategy | null {
    const lowerText = text.toLowerCase();

    // Better DCA detection including SELL patterns
    const dcaPatterns = [
      lowerText.includes('buy') && lowerText.includes('every'),
      lowerText.includes('sell') && lowerText.includes('every'),
      lowerText.includes('purchase') && (lowerText.includes('minute') || lowerText.includes('hour') || lowerText.includes('day')),
      lowerText.includes('repeat') && (lowerText.includes('buy') || lowerText.includes('purchase') || lowerText.includes('sell')),
      lowerText.includes('regular') && (lowerText.includes('buy') || lowerText.includes('sell')),
      lowerText.includes('interval') && (lowerText.includes('buy') || lowerText.includes('sell')),
      lowerText.includes('dca') || lowerText.includes('dollar cost')
    ];

    if (dcaPatterns.some(pattern => pattern)) {
      return this.parseDCAStrategy(text);
    }

    // Detect Grid
    if (lowerText.includes('grid') || lowerText.includes('levels') ||
      lowerText.includes('price range')) {
      return this.parseGridStrategy(text);
    }

    // Detect Stop-Loss
    if (lowerText.includes('stop') || lowerText.includes('loss') ||
      lowerText.includes('profit')) {
      return this.parseStopLossStrategy(text);
    }

    // Detect Momentum
    if (lowerText.includes('momentum') || lowerText.includes('trend') ||
      lowerText.includes('breakout')) {
      return this.parseMomentumStrategy(text);
    }

    // Detect Contrarian Volatility strategies (BEFORE reactive, as they use "when" keywords too)
    // Patterns: "sell when rises", "buy when drops", "sell on rises rapidly", "buy on sharp drops"
    const hasContrarianPattern = 
        (lowerText.includes('sell') && (lowerText.includes('rise') || lowerText.includes('rises') || lowerText.includes('rapidly'))) ||
        (lowerText.includes('buy') && (lowerText.includes('drop') || lowerText.includes('drops') || lowerText.includes('sharply'))) ||
        (lowerText.includes('contrarian') || lowerText.includes('volatility')) ||
        (lowerText.includes('short') && lowerText.includes('price rises')) ||
        (lowerText.includes('buy into weakness') || lowerText.includes('sell into strength'));
    
    if (hasContrarianPattern) {
      return this.parseContrarianVolatilityStrategy(text);
    }

    // Detect Reactive/Event-based strategies
    // Match patterns like: "sell when others buy", "buy when people sell", "mirror activity", etc.
    const hasReactivePattern = 
        lowerText.includes('sell when') || 
        lowerText.includes('buy when') ||
        lowerText.includes('mirror') ||
        lowerText.includes('match') ||
        lowerText.includes('follow') ||
        lowerText.includes('exact amount') ||
        lowerText.includes('same amount') ||
        (lowerText.includes('sell') && lowerText.includes('when')) ||
        (lowerText.includes('buy') && lowerText.includes('when')) ||
        (lowerText.includes('people') && lowerText.includes('buying')) ||
        (lowerText.includes('people') && lowerText.includes('selling')) ||
        (lowerText.includes('others') && (lowerText.includes('buy') || lowerText.includes('sell')));
    
    if (hasReactivePattern) {
      return this.parseReactiveStrategy(text);
    }

    // Detect Advanced/Custom strategies
    const advancedKeywords = [
      'funding rate', 'volume imbalance', 'order book', 'derivatives',
      'arbitrage', 'market making', 'volatility', 'correlation',
      'multi-asset', 'cross-chain', 'liquidity', 'spread'
    ];

    const hasAdvancedKeywords = advancedKeywords.some(keyword =>
      lowerText.includes(keyword)
    );

    if (hasAdvancedKeywords) {
      return this.parseAdvancedStrategy(text);
    }
    return null;
  }

  /**
   * Parse DCA strategy from text
   * FIXED: Proper extraction with correct priority order
   */
  private parseDCAStrategy(text: string): ParsedStrategy | null {
    const lowerText = text.toLowerCase();

    console.log(` [parseDCAStrategy] Parsing text:`, text.substring(0, 150));

    // Detect if this is a SELL or BUY strategy
    const isSellStrategy = lowerText.includes('sell') || lowerText.includes('selling');
    const isBuyStrategy = lowerText.includes('buy') || lowerText.includes('buying') || lowerText.includes('purchase');

    console.log(` [parseDCAStrategy] Strategy type:`, { isSellStrategy, isBuyStrategy });

    // Extract amount based on strategy type
    let amount: number | null = null;
    let count: number | null = null;

    if (isSellStrategy) {
      amount = this.extractNumber(text, ['sell', 'selling', 'amount'], 'sol');
      // New: Try flexible extraction for token names
      if(!amount){
        amount = this.extractNumberFlexible(text, ['sell', 'selling', 'amount']);
      }
      count = this.extractCountNumber(text, ['times', 'sells', 'count', 'orders', 'repeat', 'for']);
    } else if (isBuyStrategy) {
      amount = this.extractNumber(text, ['buy', 'buying', 'purchase', 'amount'], 'sol');
      // New: Try flexible extraction for token names
      if(!amount){
        amount = this.extractNumberFlexible(text, ['buy', 'buying', 'purchase', 'amount']);
      }
      count = this.extractCountNumber(text, ['times', 'buys', 'count', 'orders', 'repeat', 'for']);
    }

    const interval = this.extractInterval(text);
    // Extract token address
    const tokenAddress = this.extractTokenAddress(text);

    if (!amount) {
      console.log(` [parseDCAStrategy] No amount found, returning null`);
      return null;
    }

    // Create config with correct field names based on strategy type
   const config: any = {
      id: `ai-dca-${Date.now()}`,
      intervalMinutes: interval || 60,
      side: isSellStrategy ? 'sell' : 'buy',
      tokenAddress: tokenAddress || undefined
    };

    // ===== Proper handling of count =====
    if (isSellStrategy) {
      config.sellAmountSOL = amount;
      if (count !== null) {
        config.sellCount = count;
      } else {
        config.sellCount = undefined;
      }
    } else {
      config.buyAmountSOL = amount;
      if (count !== null) {
        config.buyCount = count;
      } else {
        config.buyCount = undefined;
      }
    }

    console.log(` [parseDCAStrategy] Final config:`, config);

    return {
      template: 'dca',
      config,
      confidence: amount && interval ? 0.9 : 0.6,
      requiresConfirmation: true
    };
  }

  /**
   * Parse Grid strategy from text
   */
  private parseGridStrategy(text: string): ParsedStrategy | null {
    const levels = this.extractNumber(text, ['level', 'grid']);
    const lowerPrice = this.extractNumber(text, ['lower', 'bottom', 'min'], 'price');
    const upperPrice = this.extractNumber(text, ['upper', 'top', 'max'], 'price');
    const amount = this.extractNumber(text, ['amount', 'size'], 'sol');

    if (!levels || !lowerPrice || !upperPrice) return null;

    return {
      template: 'grid',
      config: {
        id: `ai-grid-${Date.now()}`,
        gridLevels: levels || 5,
        lowerPrice: lowerPrice || 200,
        upperPrice: upperPrice || 250,
        amountPerLevel: amount || 0.05
      },
      confidence: levels && lowerPrice && upperPrice ? 0.9 : 0.6,
      requiresConfirmation: true
    };
  }

  /**
   * Parse Stop-Loss strategy from text
   */
  private parseStopLossStrategy(text: string): ParsedStrategy | null {
    const buyAmount = this.extractNumber(text, ['buy', 'amount'], 'sol');
    const stopLoss = this.extractPercentage(text, ['stop', 'loss']);
    const takeProfit = this.extractPercentage(text, ['take', 'profit', 'target']);

    if (!buyAmount) return null;

    return {
      template: 'stop_loss',
      config: {
        id: `ai-stoploss-${Date.now()}`,
        buyAmountSOL: buyAmount,
        stopLossPercentage: stopLoss || 5,
        takeProfitPercentage: takeProfit || 10
      },
      confidence: buyAmount && stopLoss ? 0.9 : 0.7,
      requiresConfirmation: true
    };
  }

  /**
   * Parse Momentum strategy from text
   */
  private parseMomentumStrategy(text: string): ParsedStrategy | null {
    const buyAmount = this.extractNumber(text, ['buy', 'amount'], 'sol');
    const momentum = this.extractPercentage(text, ['momentum', 'increase', 'breakout']);
    const sellThreshold = this.extractPercentage(text, ['sell', 'reversal', 'exit']);
    const timeframe = this.extractNumber(text, ['timeframe', 'period', 'window']);

    if (!buyAmount) return null;

    return {
      template: 'momentum',
      config: {
        id: `ai-momentum-${Date.now()}`,
        buyAmountSOL: buyAmount,
        momentumThreshold: momentum || 5,
        sellThreshold: sellThreshold || 3,
        timeframeMinutes: timeframe || 60
      },
      confidence: buyAmount && momentum ? 0.9 : 0.7,
      requiresConfirmation: true
    };
  }

  /**
   * Extract numeric value from text (for amounts like SOL)
   * Correct priority order - numbers with units FIRST, word numbers LAST
   */
  private extractNumber(text: string, keywords: string[], unit?: string): number | null {
    const lowerText = text.toLowerCase();
    // ===== PRIORITY 1: Numbers with units (e.g., "0.25 SOL") - HIGHEST PRIORITY =====
    if (unit) {
      const unitPatterns = [
        // "buy 0.25 SOL", "sell 0.9975 SOL"
        new RegExp(`(?:${keywords.join('|')})(?:ing)?\\s+(\\d+\\.?\\d*)\\s*${unit}`, 'i'),
        // "0.25 SOL to buy"
        new RegExp(`(\\d+\\.?\\d*)\\s*${unit}\\s+(?:to\\s+)?(?:${keywords.join('|')})`, 'i'),
        // Just number + unit anywhere (fallback)
        new RegExp(`(\\d+\\.?\\d*)\\s*${unit}`, 'i')
      ];

      for (const pattern of unitPatterns) {
        const match = lowerText.match(pattern);
        if (match) {
          const value = parseFloat(match[1]);
          return value;
        }
      }
    }

    // ===== PRIORITY 2: Keyword-based patterns (without unit) =====
    for (const keyword of keywords) {
      const patterns = [
        // "buy 0.25", "sell 0.9975"
        new RegExp(`${keyword}(?:ing)?\\s+(\\d+\\.?\\d*)`, 'i'),
        // "0.25 to buy"
        new RegExp(`(\\d+\\.?\\d*)\\s+(?:to|for)?\\s*${keyword}`, 'i'),
        // "buy: 0.25"
        new RegExp(`${keyword}[:\\s]+(\\d+\\.?\\d*)`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = lowerText.match(pattern);
        if (match) {
          const value = parseFloat(match[1]);
          return value;
        }
      }
    }
    return null;
  }

  /**
   * Extract count numbers (for "repeat once", "5 times", etc.)
   * Separates count extraction from amount extraction
   */
  private extractCountNumber(text: string, keywords: string[]): number | null {
    const lowerText = text.toLowerCase();

    // ===== PRIORITY 1: Word-based counts (for "repeat once", "twice", etc.) =====
    const wordNumbers: { [key: string]: number } = {
      'once': 1,
      'twice': 2,
      'thrice': 3,
      'three times': 3,
      'four times': 4,
      'five times': 5,
      'six times': 6,
      'seven times': 7,
      'eight times': 8,
      'nine times': 9,
      'ten times': 10
    };

    // Check for word-based counts with contextual proximity
    for (const [word, value] of Object.entries(wordNumbers)) {
      if (lowerText.includes(word)) {
        const wordIndex = lowerText.indexOf(word);
        const contextBefore = lowerText.substring(Math.max(0, wordIndex - 30), wordIndex);
        const contextAfter = lowerText.substring(wordIndex, Math.min(lowerText.length, wordIndex + word.length + 30));
        const fullContext = contextBefore + contextAfter;

        // Check if any keyword or "repeat" is near this word
        const isRelevant = keywords.some(keyword => fullContext.includes(keyword)) ||
          fullContext.includes('repeat') ||
          fullContext.includes('do this') ||
          fullContext.includes('do it');

        if (isRelevant) {
          return value;
        }
      }
    }

    // ===== PRIORITY 2: Number + "times" pattern =====
    for (const keyword of keywords) {
      const patterns = [
        // "repeat 5", "5 times"
        new RegExp(`(\\d+)\\s+(?:times?|executions?)`, 'i'),
        // "repeat this 5 times"
        new RegExp(`${keyword}(?:\\s+this)?\\s+(\\d+)(?:\\s+times?)?`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = lowerText.match(pattern);
        if (match) {
          const value = parseInt(match[1]);
          return value;
        }
      }
    }
    return null;
  }

  /**
   * Extract percentage from text
   */
  private extractPercentage(text: string, keywords: string[]): number | null {
    const lowerText = text.toLowerCase();

    for (const keyword of keywords) {
      const patterns = [
        new RegExp(`${keyword}\\s+(\\d+\\.?\\d*)%`, 'i'),
        new RegExp(`${keyword}[:\\s]+(\\d+\\.?\\d*)\\s*percent`, 'i'),
        new RegExp(`(\\d+\\.?\\d*)%\\s*${keyword}`, 'i')
      ];

      for (const pattern of patterns) {
        const match = lowerText.match(pattern);
        if (match) {
          return parseFloat(match[1]);
        }
      }
    }
    return null;
  }

  /**
   * Extract interval in minutes from text
   */
  private extractInterval(text: string): number | null {
    const lowerText = text.toLowerCase();

    // Seconds (convert to minutes)
    const secondsMatch = lowerText.match(/(\d+)\s*sec/i);
    if (secondsMatch) {
      const seconds = parseInt(secondsMatch[1]);
      return seconds / 60; // Convert seconds to minutes (e.g., 30 seconds = 0.5 minutes)
    }

    // Hours
    const hoursMatch = lowerText.match(/(\d+)\s*hours?/i);
    if (hoursMatch) {
      return parseInt(hoursMatch[1]) * 60;
    }

    // Days
    const daysMatch = lowerText.match(/(\d+)\s*days?/i);
    if (daysMatch) {
      return parseInt(daysMatch[1]) * 60 * 24;
    }

    // Minutes
    const minutesMatch = lowerText.match(/(\d+)\s*min/i);
    if (minutesMatch) {
      return parseInt(minutesMatch[1]);
    }

    // Weekly
    if (lowerText.includes('week')) {
      return 7 * 24 * 60;
    }

    // Daily
    if (lowerText.includes('daily') || lowerText.includes('day')) {
      return 24 * 60;
    }
    return null;
  }

  /**
   * Parse advanced/custom strategies that don't fit basic templates
   */
  private parseAdvancedStrategy(inputText: string): ParsedStrategy | null {
    const lowerText = inputText.toLowerCase();

    return {
      template: 'custom',
      config: {
        id: `advanced-strategy-${Date.now()}`,
        strategyType: 'custom',
        description: this.extractStrategyDescription(inputText),
        components: this.identifyAutomatedComponents(inputText),
        manualSteps: this.identifyManualSteps(inputText),
        riskManagement: this.extractRiskManagement(inputText),
        confidence: 0.8
      },
      confidence: 0.8,
      requiresConfirmation: true
    };
  }

  /**
   * Extract strategy description from text
   */
  private extractStrategyDescription(text: string): string {
    // Look for strategy name or description
    const nameMatch = text.match(/Strategy Name:\s*([^\n]+)/i);
    const goalMatch = text.match(/Goal:\s*([^\n]+)/i);
    const descMatch = text.match(/Description:\s*([^\n]+)/i);

    if (nameMatch) return nameMatch[1].trim();
    if (goalMatch) return goalMatch[1].trim();
    if (descMatch) return descMatch[1].trim();
    
    return 'Advanced custom trading strategy';
  }

  /**
   * Identify components that can be automated
   */
  private identifyAutomatedComponents(text: string): string[] {
    const components: string[] = [];
    const lowerText = text.toLowerCase();

    if (lowerText.includes('stop loss') || lowerText.includes('take profit') || lowerText.includes('auto-close')) {
      components.push('Risk management (stop-loss/take-profit)');
    }

    if (lowerText.includes('position size') || lowerText.includes('portfolio') || lowerText.includes('trade size')) {
      components.push('Position sizing');
    }

    if (lowerText.includes('buy signal') || lowerText.includes('sell signal') || lowerText.includes('trigger')) {
      components.push('Trade entry/exit signals');
    }

    if (lowerText.includes('technical indicator') || lowerText.includes('moving average') || lowerText.includes('rsi')) {
      components.push('Technical indicator calculations');
    }

    if (lowerText.includes('hold until') || lowerText.includes('max of') || lowerText.includes('days')) {
      components.push('Time-based trade management');
    }

    if (lowerText.includes('profits split') || lowerText.includes('reinvest') || lowerText.includes('stablecoins')) {
      components.push('Profit allocation and portfolio rebalancing');
    }

    if (lowerText.includes('monitor') && (lowerText.includes('whale') || lowerText.includes('wallet activity'))) {
      components.push('Whale wallet activity monitoring (requires external data feed)');
    }

    if (lowerText.includes('exchange') && (lowerText.includes('outflows') || lowerText.includes('inflows') || lowerText.includes('volume'))) {
      components.push('Exchange flow monitoring (requires external data feed)');
    }
    return components;
  }

  /**
   * Identify steps requiring manual intervention
   */
  private identifyManualSteps(text: string): string[] {
    const steps: string[] = [];
    const lowerText = text.toLowerCase();

    if (lowerText.includes('funding rate')) {
      steps.push('Monitor funding rates (external data)');
    }

    if (lowerText.includes('volume imbalance') || lowerText.includes('order book')) {
      steps.push('Analyze order book volume imbalance');
    }

    if (lowerText.includes('short') || lowerText.includes('shorting')) {
      steps.push('Short position execution (derivatives required)');
    }

    if (lowerText.includes('stablecoin') || lowerText.includes('allocation')) {
      steps.push('Portfolio rebalancing and stablecoin conversion');
    }
    return steps;
  }

  /**
   * Extract risk management approach
   */
  private extractRiskManagement(text: string): string {
    const lowerText = text.toLowerCase();

    if (lowerText.includes('risk tolerance')) {
      const riskMatch = text.match(/Risk Tolerance:\s*([^\n]+)/i);
      if (riskMatch) return riskMatch[1].trim();
    }

    if (lowerText.includes('position size')) {
      const sizeMatch = text.match(/Position size capped at ([^\n]+)/i);
      if (sizeMatch) return `Position size limit: ${sizeMatch[1].trim()}`;
    }

    return 'Standard risk management with position sizing and stop-losses';
  }

  /**
   * Validate parsed strategy
   */
  validateParsedStrategy(strategy: ParsedStrategy): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate template
    if (!['dca', 'grid', 'stop_loss', 'momentum', 'custom'].includes(strategy.template)) {
      errors.push('Invalid strategy template');
    }

    // Validate config has required ID
    if (!strategy.config.id) {
      errors.push('Strategy ID is required');
    }

    // Template-specific validation
    switch (strategy.template) {
      case 'custom':
        // Custom strategies are more flexible
        if (!strategy.config.description) {
          strategy.config.description = 'Custom trading strategy';
        }
        if (!strategy.config.components || strategy.config.components.length === 0) {
          strategy.config.components = ['Basic automated trading logic'];
        }
        break;

      case 'dca':
        // Check if this is a buy or sell DCA strategy
        if (strategy.config.side === 'sell') {
          // Validate sell DCA strategy
          if (!strategy.config.sellAmountSOL || strategy.config.sellAmountSOL <= 0) {
            errors.push('DCA SELL: sellAmountSOL must be > 0');
          }
        } else {
          // Validate buy DCA strategy
          if (!strategy.config.buyAmountSOL || strategy.config.buyAmountSOL <= 0) {
            errors.push('DCA BUY: buyAmountSOL must be > 0');
          }
        }
        if (!strategy.config.intervalMinutes || strategy.config.intervalMinutes <= 0) {
          errors.push('DCA: intervalMinutes must be > 0');
        }
        // buyCount/sellCount can be undefined now (unlimited)
        break;

      case 'grid':
        if (!strategy.config.gridLevels || strategy.config.gridLevels < 2) {
          errors.push('Grid: gridLevels must be >= 2');
        }
        if (!strategy.config.lowerPrice || !strategy.config.upperPrice) {
          errors.push('Grid: lowerPrice and upperPrice required');
        }
        if (strategy.config.lowerPrice >= strategy.config.upperPrice) {
          errors.push('Grid: lowerPrice must be < upperPrice');
        }
        break;

      case 'stop_loss':
        if (!strategy.config.buyAmountSOL || strategy.config.buyAmountSOL <= 0) {
          errors.push('Stop-Loss: buyAmountSOL must be > 0');
        }
        break;

      case 'momentum':
        if (!strategy.config.buyAmountSOL || strategy.config.buyAmountSOL <= 0) {
          errors.push('Momentum: buyAmountSOL must be > 0');
        }
        break;
    }
    return {
      valid: errors.length === 0,
      errors
    };
  }

/**
 * Extract number without strict unit requirements (handles token names)
 */
  private extractNumberFlexible(text: string, keywords: string[]): number | null {
    const lowerText = text.toLowerCase();

    for (const keyword of keywords) {
      const patterns = [
        new RegExp(`${keyword}(?:ing)?\\s+(\\d+\\.?\\d*)\\s*[A-Za-z]*`, 'i'),
        new RegExp(`(\\d+\\.?\\d*)\\s+(?:to|for)?\\s*${keyword}`, 'i'),
        new RegExp(`${keyword}[:\\s]+(\\d+\\.?\\d*)`, 'i'),
        new RegExp(`${keyword}(?:ing)?\\s+(\\d+\\.?\\d*)\\s*(?:of|worth)?`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = lowerText.match(pattern);
        if (match) {
          const value = parseFloat(match[1]);
          if (!isNaN(value) && value > 0) {
            console.log(` [extractNumberFlexible] Found: ${value} near "${keyword}"`);
            return value;
          }
        }
      }
    }
    return null;
  }

  /**
   * Extract Solana token address from text
   */
  private extractTokenAddress(text: string): string | null {
    // Clean up the text - remove labels and extra spaces
    const cleanText = text
      .replace(/\bToken\s*:\s*/gi, '')
      .replace(/\bAddress\s*:\s*/gi, '')
      .replace(/\bToken\s+Address\s*:\s*/gi, '')
      .trim();
    
    // Look for Solana address pattern (32-44 alphanumeric characters)
    const addressPattern = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
    const match = cleanText.match(addressPattern);

    if (match) {
      console.log(` [extractTokenAddress] Found: ${match[0]}`);
      return match[0];
    }
    return null;
  }

  /**
   * Parse reactive/event-based strategies
   * Handles: "sell when others buy", "mirror activity", "match volume"
   */
  private parseReactiveStrategy(text: string): ParsedStrategy | null {
    const lowerText = text.toLowerCase();
    
    console.log(` [parseReactiveStrategy] Parsing reactive strategy`);
    
    // Determine the PRIMARY action (what WE are doing) vs the TRIGGER (what we're watching)
    // Pattern: "I want to [ACTION] when [TRIGGER]" or "[ACTION] when [TRIGGER]"
    
    // Check which action comes first - that's usually our action
    const sellIndex = lowerText.indexOf('sell');
    const buyIndex = lowerText.indexOf('buy');
    
    let primaryAction: 'buy' | 'sell' | null = null;
    let triggerAction: 'buy' | 'sell' | null = null;
    
    if (sellIndex !== -1 && buyIndex !== -1) {
      // Both present - determine which is primary based on position and context
      if (sellIndex < buyIndex) {
        primaryAction = 'sell';
        triggerAction = 'buy';
      } else {
        primaryAction = 'buy';
        triggerAction = 'sell';
      }
      
      // Override if we have clear "when" pattern
      const whenMatch = lowerText.match(/(sell|buy)\s+(?:this\s+)?(?:token\s+)?(?:in\s+)?(?:exact\s+)?(?:amount\s+)?(?:of\s+)?(?:people\s+)?(?:that\s+)?(?:are\s+)?(?:when\s+)?(?:others?\s+)?(?:people\s+)?(sell|buy)/);
      if (whenMatch) {
        primaryAction = whenMatch[1] as 'buy' | 'sell';
        triggerAction = whenMatch[2] as 'buy' | 'sell';
      }
    } else if (sellIndex !== -1) {
      primaryAction = 'sell';
    } else if (buyIndex !== -1) {
      primaryAction = 'buy';
    }
    
    if (!primaryAction) {
      return null;
    }
    
    const isSell = primaryAction === 'sell';
    const isBuy = primaryAction === 'buy';
    
    // Extract token address
    const tokenAddress = this.extractTokenAddress(text);
    
    // Extract supply/amount
    const supply = this.extractNumber(text, ['supply', 'have', 'holding', 'own', 'million', 'thousand'], undefined);
    
    // Determine trigger type
    let trigger = 'unknown';
    let triggerDescription = '';
    
    if (lowerText.includes('when') || lowerText.includes('exact amount') || lowerText.includes('same amount')) {
      // If we're SELLING when others BUY -> mirror_buy_activity
      // If we're BUYING when others SELL -> mirror_sell_activity
      if (triggerAction) {
        trigger = triggerAction === 'buy' ? 'mirror_buy_activity' : 'mirror_sell_activity';
        triggerDescription = `${primaryAction === 'sell' ? 'Sell' : 'Buy'} the same amount that others are ${triggerAction}ing`;
      } else if (isSell && (lowerText.includes('buy') || lowerText.includes('buying'))) {
        trigger = 'mirror_buy_activity';
        triggerDescription = 'Sell the same amount that others are buying';
      } else if (isBuy && (lowerText.includes('sell') || lowerText.includes('selling'))) {
        trigger = 'mirror_sell_activity';
        triggerDescription = 'Buy the same amount that others are selling';
      }
    }
    
    if (lowerText.includes('mirror') || lowerText.includes('match') || lowerText.includes('follow')) {
      trigger = isSell ? 'mirror_buy_activity' : 'mirror_sell_activity';
      triggerDescription = `${isSell ? 'Sell' : 'Buy'} to mirror market activity`;
    }
    
    // Only set volume_threshold if we don't already have a more specific trigger
    if ((lowerText.includes('volume') || lowerText.includes('activity')) && trigger === 'unknown') {
      trigger = 'volume_threshold';
      triggerDescription = 'Execute when volume threshold is reached';
    }
    
    console.log(` [parseReactiveStrategy] Extracted:`, {
      tokenAddress,
      supply,
      trigger,
      side: isSell ? 'sell' : 'buy'
    });
    
    // Must have token address to be valid
    if (!tokenAddress) {
      console.log(' [parseReactiveStrategy] No token address found');
      return null;
    }
    
    // Calculate confidence
    const hasAllRequiredInfo = !!(tokenAddress && trigger !== 'unknown' && (supply || isBuy));
    const confidence = hasAllRequiredInfo ? 0.95 : 0.7;
    
    return {
      template: 'custom',
      config: {
        id: `reactive-${Date.now()}`,
        strategyType: 'reactive',
        description: triggerDescription || `Reactive ${isSell ? 'selling' : 'buying'} strategy`,
        tokenAddress,
        supply: supply ? supply * 1000000 : undefined, // Convert millions to actual units
        trigger,
        side: isSell ? 'sell' : 'buy',
        components: [
          'Real-time blockchain monitoring',
          `${trigger.replace(/_/g, ' ')} detection`,
          'Automated order execution',
          'Volume matching logic'
        ],
        manualSteps: [
          'Monitor requires external data feed',
          'May need API access for real-time events'
        ],
        // Mark as complete if we have essential info
        isComplete: hasAllRequiredInfo
      },
      confidence,
      requiresConfirmation: true
    };
  }

  /**
   * Parse contrarian volatility strategy - sells into strength, buys into weakness
   * Example: "sell 1500 tokens when price rises 5% in 5 minutes, buy 0.001 SOL when price drops 15% in 5 minutes"
   */
  private parseContrarianVolatilityStrategy(text: string): ParsedStrategy {
    const lowerText = text.toLowerCase();
    
    // Extract token address
    const tokenAddress = this.extractTokenAddress(text);
    
    // Extract sell parameters - MORE flexible patterns
    // Patterns: "sell X tokens when/if price rises/increases/pumps Y% in/within Z minutes"
    const sellTriggerMatch = lowerText.match(/(?:sell|short).*?(?:rise|increase|up|pump|gain|jump).*?(\d+(?:\.\d+)?)\s*%(?:.*?(?:in|within)\s*(\d+)\s*(?:min|minute))?/i);
    const sellAmountMatch = lowerText.match(/(?:sell|short)\s+(?:around\s+)?(\d+(?:\.\d+)?)\s*k?\s*(?:token|sol)?/i);
    
    // Extract buy parameters - MORE flexible patterns
    // Patterns: "buy X SOL when/if price drops/decreases/falls/dumps Y% in/within Z minutes"
    const buyTriggerMatch = lowerText.match(/(?:buy|long).*?(?:drop|decrease|down|dump|fall|loss|dip).*?(\d+(?:\.\d+)?)\s*%(?:.*?(?:in|within)\s*(\d+)\s*(?:min|minute))?/i);
    const buyAmountMatch = lowerText.match(/(?:buy|long)\s+(?:around\s+)?(\d+(?:\.\d+)?)\s*(?:sol|token)?/i);
    
    // Parse sell trigger percentage and timeframe - NO DEFAULTS
    const sellTriggerPercentage = sellTriggerMatch ? parseFloat(sellTriggerMatch[1]) : undefined;
    const sellTriggerTimeframeMinutes = sellTriggerMatch?.[2] ? parseInt(sellTriggerMatch[2]) : undefined;
    
    // Parse sell amount - Handle "k" notation (e.g., "1.5k" = 1500)
    let sellAmountTokens: number | undefined = undefined;
    if (sellAmountMatch) {
      const amount = parseFloat(sellAmountMatch[1]);
      sellAmountTokens = lowerText.includes('k') ? amount * 1000 : amount;
    }
    
    // Parse buy trigger percentage and timeframe - NO DEFAULTS
    const buyTriggerPercentage = buyTriggerMatch ? parseFloat(buyTriggerMatch[1]) : undefined;
    const buyTriggerTimeframeMinutes = buyTriggerMatch?.[2] ? parseInt(buyTriggerMatch[2]) : undefined;
    
    // Parse buy amount - NO DEFAULTS
    const buyAmountSOL = buyAmountMatch ? parseFloat(buyAmountMatch[1]) : undefined;
    
    // Check if we have all required info
    const hasAllRequiredInfo = !!(
      tokenAddress &&
      sellTriggerPercentage !== undefined &&
      buyTriggerPercentage !== undefined &&
      sellAmountTokens !== undefined &&
      buyAmountSOL !== undefined
    );
    
    // Calculate confidence based on extracted information
    let confidence = 0.5; // Base confidence for contrarian pattern
    if (tokenAddress) confidence += 0.15;
    if (sellTriggerMatch && sellAmountMatch) confidence += 0.15;
    if (buyTriggerMatch && buyAmountMatch) confidence += 0.15;
    if (hasAllRequiredInfo) confidence += 0.05;
    
    // Build list of missing parameters for manual steps
    const missingParams: string[] = [];
    if (!tokenAddress) missingParams.push('Token address');
    if (sellTriggerPercentage === undefined) missingParams.push('Sell trigger percentage (e.g., "rises 10%")');
    if (sellTriggerTimeframeMinutes === undefined) missingParams.push('Sell timeframe (e.g., "in 5 minutes")');
    if (sellAmountTokens === undefined) missingParams.push('Sell amount (e.g., "2000 tokens")');
    if (buyTriggerPercentage === undefined) missingParams.push('Buy trigger percentage (e.g., "drops 20%")');
    if (buyTriggerTimeframeMinutes === undefined) missingParams.push('Buy timeframe (e.g., "in 10 minutes")');
    if (buyAmountSOL === undefined) missingParams.push('Buy amount (e.g., "0.005 SOL")');
    
    return {
      template: 'custom' as const,
      config: {
        strategyType: 'contrarian_volatility',
        tokenAddress,
        sellTriggerPercentage,
        sellTriggerTimeframeMinutes,
        sellAmountTokens,
        buyTriggerPercentage,
        buyTriggerTimeframeMinutes,
        buyAmountSOL,
        components: [
          'Real-time price monitoring',
          'Baseline price tracking',
          'Rapid price movement detection',
          'Automated contrarian execution',
          sellTriggerPercentage !== undefined && sellTriggerTimeframeMinutes !== undefined 
            ? `Sell trigger: ${sellTriggerPercentage}% rise in ${sellTriggerTimeframeMinutes} minutes`
            : 'Sell trigger: [To be configured]',
          buyTriggerPercentage !== undefined && buyTriggerTimeframeMinutes !== undefined
            ? `Buy trigger: ${buyTriggerPercentage}% drop in ${buyTriggerTimeframeMinutes} minutes`
            : 'Buy trigger: [To be configured]'
        ],
        manualSteps: missingParams.length > 0 ? [
          'Missing parameters:',
          ...missingParams.map(param => `  - ${param}`)
        ] : [],
        isComplete: hasAllRequiredInfo
      },
      confidence,
      requiresConfirmation: true
    };
  }
}

// Export singleton
export const strategyParser = new StrategyParser();