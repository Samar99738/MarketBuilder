/**
 * AI Model Manager
 * Handles multiple AI providers and models with intelligent fallbacks
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

// Lazy initialize Gemini AI (to allow .env loading first)
let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  }
  return genAI;
}

export interface AIProvider {
  name: string;
  models: string[];
  isAvailable: boolean;
  lastError?: string;
  successCount: number;
  errorCount: number;
}

export interface AIResponse {
  text: string;
  provider: string;
  model: string;
  rawResponse?: any;
}

export class AIModelManager {
  private providers: Map<string, AIProvider> = new Map();
  private currentProvider: string = 'gemini';
  private currentModel: string = '';

  constructor() {
    this.initializeProviders();
  }

  /**
   * Initialize available AI providers
   */
  private initializeProviders(): void {
    // Gemini Models (Google) - Using models available with the current API key
    // Order matters: prioritize fast, reliable models first
    this.providers.set('gemini', {
      name: 'Google Gemini',
      models: [
        'gemini-2.5-flash',        // Fastest, most reliable
        'gemini-flash-latest',      // Stable fallback
        'gemini-2.5-pro',          // High quality
        'gemini-pro-latest',        // Legacy stable
        'gemini-2.0-flash'          // Alternative
      ],
      isAvailable: true,
      successCount: 0,
      errorCount: 0
    });
  }

  /**
   * Generate AI response with intelligent fallbacks
   */
  async generateResponse(prompt: string): Promise<AIResponse> {
    let lastError: any = null;

    // Try all providers and their models
    for (const [providerName, provider] of this.providers.entries()) {
      if (!provider.isAvailable) continue;

      for (const modelName of provider.models) {
        try {
          let response: any = null;

          if (providerName === 'gemini') {
            response = await this.callGeminiModel(modelName, prompt);
          }

          if (response && response.text) {
            // Success! Update stats and return
            provider.successCount++;
            this.currentProvider = providerName;
            this.currentModel = modelName;

            return {
              text: response.text,
              provider: providerName,
              model: modelName,
              rawResponse: response.rawResponse
            };
          }

        } catch (error: any) {
          provider.errorCount++;
          provider.lastError = error.message;
          lastError = error;

          // Mark provider as temporarily unavailable if too many errors (increased threshold)
          if (provider.errorCount > 15) {
            provider.isAvailable = false;
          }

          // Wait before trying next model if overloaded
          if (error.status === 503) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          continue;
        }
      }
    }

    // All providers and models failed - throw error to force real API usage
    throw new Error(`All AI models failed. Please verify your Gemini API key is valid. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Call Gemini model
   */
  private async callGeminiModel(modelName: string, prompt: string): Promise<any> {
    const model = getGenAI().getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const response = await result.response;

    return {
      text: response.text(),
      rawResponse: response
    };
  }

  /**
   * Get provider statistics
   */
  getProviderStats(): Array<{
    name: string;
    isAvailable: boolean;
    successCount: number;
    errorCount: number;
    lastError?: string;
    models: string[];
  }> {
    return Array.from(this.providers.values()).map(provider => ({
      name: provider.name,
      isAvailable: provider.isAvailable,
      successCount: provider.successCount,
      errorCount: provider.errorCount,
      lastError: provider.lastError,
      models: provider.models
    }));
  }

  /**
   * Reset provider availability (e.g., after some time)
   * Only resets providers that have failed to avoid unnecessary resets
   */
  resetProviderAvailability(): void {
    for (const provider of this.providers.values()) {
      if (!provider.isAvailable || provider.errorCount > 0) {
        provider.isAvailable = true;
        provider.errorCount = 0;
        provider.lastError = undefined;
      }
    }
  }

  /**
   * Get current working model info
   */
  getCurrentModel(): { provider: string; model: string } {
    return {
      provider: this.currentProvider,
      model: this.currentModel
    };
  }


  /**
   * Generate intelligent fallback response when all AI models fail
   */
  private generateFallbackResponse(prompt: string): string {
    const lowerPrompt = prompt.toLowerCase();

    // Handle conversational context and corrections
    if (lowerPrompt.includes('not') || lowerPrompt.includes("don't") || lowerPrompt.includes('wrong')) {
      if (lowerPrompt.includes('dca') && lowerPrompt.includes('grid')) {
        return `I apologize for the confusion! You want a **DCA strategy**, not Grid Trading. Let me help you with that.

DCA (Dollar Cost Averaging) is perfect for reducing timing risk by buying fixed amounts at regular intervals.

To set up your DCA strategy, I need:
- **Buy amount per purchase?** (e.g., 0.1 SOL)
- **How often to buy?** (e.g., daily, every 6 hours, weekly)
- **Total number of purchases?** (e.g., 10 times, or unlimited)

What would you prefer for these parameters?`;
      }
    }

    // Handle greetings and general questions
    if (lowerPrompt.includes('hello') || lowerPrompt.includes('hi ') || lowerPrompt.includes('hey')) {
      return `Hello! I'm your AI trading assistant for Solana. I can help you create automated trading strategies.

I specialize in:
 **DCA** - Buy fixed amounts regularly (reduces timing risk)
 **Grid Trading** - Profit from price volatility with multiple levels
 **Stop-Loss/Take-Profit** - Automatic risk management 
 **Momentum** - Follow price trends and breakouts

What type of strategy interests you today?`;
    }

    // Handle thank you and positive responses
    if (lowerPrompt.includes('thank') || lowerPrompt.includes('great') || lowerPrompt.includes('perfect')) {
      return `You're welcome! I'm here to help you succeed with your trading strategies. 

Is there anything you'd like to adjust or any questions about how the strategy works? I can also help you create additional strategies or explain the risks involved.`;
    }

    // Check for grid strategy FIRST (most specific)
    if (lowerPrompt.includes('grid trading') || lowerPrompt.includes('grid strategy') ||
      (lowerPrompt.includes('grid') && !lowerPrompt.includes('momentum') && !lowerPrompt.includes('trend')) ||
      (lowerPrompt.includes('between') && lowerPrompt.includes('$') && lowerPrompt.includes('-'))) {

      // Extract price range if specified
      let lowerPrice = 200;
      let upperPrice = 250;
      let levels = 5;

      const lowerMatch = lowerPrompt.match(/\$?(\d+).*?-.*?\$?(\d+)/);
      if (lowerMatch) {
        lowerPrice = parseInt(lowerMatch[1]);
        upperPrice = parseInt(lowerMatch[2]);
      }

      return `Excellent! I'll create a Grid Trading strategy between $${lowerPrice}-$${upperPrice}.

 **Strategy**: Grid Trading
 **Price Range**: $${lowerPrice} - $${upperPrice}
 **Grid Levels**: ${levels} levels
 **Amount per Level**: 0.05 SOL

Grid trading profits from price volatility by placing buy orders below current price and sell orders above current price.

STRATEGY_CONFIG: {
  "template": "grid",
  "config": {
    "id": "grid-strategy-" + Date.now(),
    "gridLevels": ${levels},
    "lowerPrice": ${lowerPrice},
    "upperPrice": ${upperPrice},
    "amountPerLevel": 0.05
  }
}`;
    }

    // Momentum strategy check SECOND (before modifications)
    if (lowerPrompt.includes('momentum') || lowerPrompt.includes('trend') || lowerPrompt.includes('follow')) {
      return `Perfect! I'll help you create a Momentum Trading strategy!

This strategy follows price trends - buying on upward momentum and selling on reversals.

 **Strategy**: Momentum Trading
 **Buy Amount**: 0.2 SOL per trade
 **Momentum Threshold**: 5% price increase triggers buy
 **Sell Threshold**: 3% reversal triggers sell
 **Timeframe**: 60 minutes to measure momentum

This strategy will automatically buy when SOL shows strong upward momentum and sell when the trend reverses.

STRATEGY_CONFIG: {
  "template": "momentum",
  "config": {
    "id": "momentum-strategy-" + Date.now(),
    "buyAmountSOL": 0.2,
    "momentumThreshold": 5,
    "sellThreshold": 3,
    "timeframeMinutes": 60
  }
}`;
    }

    // Check for modifications THIRD
    if (lowerPrompt.includes('modify') || lowerPrompt.includes('change') || lowerPrompt.includes('update') ||
      lowerPrompt.includes('buyamountsol') || lowerPrompt.includes('intervalminute') ||
      lowerPrompt.includes('0.001') || lowerPrompt.includes('30')) {

      // Extract values from the prompt
      let buyAmount = 0.1;
      let interval = 60;

      // Extract buyAmountSOL
      const buyAmountMatch = lowerPrompt.match(/(?:buyamountsol|buy.*?amount).*?(\d+\.?\d*)/);
      if (buyAmountMatch) {
        buyAmount = parseFloat(buyAmountMatch[1]);
      }

      // Extract intervalMinute  
      const intervalMatch = lowerPrompt.match(/(?:intervalminute|interval).*?(\d+)/);
      if (intervalMatch) {
        interval = parseInt(intervalMatch[1]);
      }

      // Also check for direct numbers in the request
      if (lowerPrompt.includes('0.001')) {
        buyAmount = 0.001;
      }
      if (lowerPrompt.includes(' 30')) {
        interval = 30;
      }

      return `Perfect! I've updated your DCA strategy with your requested changes:

**Buy Amount**: ${buyAmount} SOL per purchase
**Interval**: Every ${interval} minutes
**Strategy**: DCA (Dollar Cost Averaging)

This means you'll buy ${buyAmount} SOL every ${interval} minutes until you manually stop it.

STRATEGY_CONFIG: {
  "template": "dca",
  "config": {
    "id": "modified-dca-" + Date.now(),
    "buyAmountSOL": ${buyAmount},
    "intervalMinutes": ${interval}
  }
}`;
    }

    // Stop-loss strategy check FOURTH  
    if (lowerPrompt.includes('stop') && (lowerPrompt.includes('loss') || lowerPrompt.includes('profit'))) {
      return `Perfect! I'll help you set up a Stop-Loss/Take-Profit strategy for risk management.

This strategy will:
- Buy a specified amount of SOL
- Automatically sell if price drops by your stop-loss percentage
- Automatically sell if price rises by your take-profit percentage

I need:
- Initial buy amount? (e.g., 0.5 SOL)
- Stop-loss percentage? (e.g., 5% for -5% loss limit)
- Take-profit percentage? (e.g., 15% for +15% profit target)

What amounts would you like to use?

STRATEGY_CONFIG: {
  "template": "stop_loss",
  "config": {
    "id": "fallback-stoploss-" + Date.now(),
    "buyAmountSOL": 0.5,
    "stopLossPercentage": 5,
    "takeProfitPercentage": 15
  }
}`;
    }

    // Momentum strategy check SECOND (before modifications)
    if (lowerPrompt.includes('momentum') || lowerPrompt.includes('trend') || lowerPrompt.includes('follow')) {
      return `I'll help you create a Momentum Trading strategy!

This strategy follows price trends - buying on upward momentum and selling on reversals.

I need:
- Buy amount? (e.g., 0.2 SOL)
- Momentum threshold? (e.g., 5% price increase to trigger buy)
- Sell threshold? (e.g., 3% reversal to trigger sell)
- Timeframe? (e.g., 60 minutes to measure momentum)

What parameters would you prefer?

STRATEGY_CONFIG: {
  "template": "momentum",
  "config": {
    "id": "fallback-momentum-" + Date.now(),
    "buyAmountSOL": 0.2,
    "momentumThreshold": 5,
    "sellThreshold": 3,
    "timeframeMinutes": 60
  }
}`;
    }

    // DCA strategy check FIFTH (most general)
    if (lowerPrompt.includes('dca') || lowerPrompt.includes('dollar cost') ||
      (lowerPrompt.includes('build') && lowerPrompt.includes('dca'))) {
      return `Perfect! I'll help you build a DCA (Dollar Cost Averaging) strategy.

DCA is an excellent approach for long-term accumulation - you buy fixed amounts at regular intervals regardless of price, which smooths out market volatility.

Let me set up a starter configuration for you:

**Strategy**: DCA (Dollar Cost Averaging)
**Buy Amount**: 0.1 SOL per purchase
**Frequency**: Every 60 minutes
**Total Purchases**: Unlimited (until manually stopped)

You can modify any of these parameters. Would you like to:
- Change the buy amount?
- Adjust the frequency?
- Set a specific number of purchases?

STRATEGY_CONFIG: {
  "template": "dca",
  "config": {
    "id": "dca-strategy-" + Date.now(),
    "buyAmountSOL": 0.1,
    "intervalMinutes": 60
  }
}`;
    }

    // Handle custom strategy requests
    if (lowerPrompt.includes('custom') || lowerPrompt.includes('new strategy') || lowerPrompt.includes('different')) {
      return `Absolutely! I can help you create a completely custom trading strategy tailored to your specific needs.

Tell me about your trading idea:

**What's your goal?**
- Accumulate SOL over time?
- Profit from volatility?
- Manage risk automatically?
- Follow specific market signals?

**What conditions should trigger trades?**
- Price movements (up/down by X%)?
- Time intervals (every X minutes/hours)?
- Technical indicators?
- Market conditions?

**What parameters do you want to control?**
- Buy/sell amounts
- Timing and frequency
- Risk limits
- Profit targets

For example, you could say:
- "Buy 0.05 SOL when price drops 2%, sell when it goes up 5%"
- "Buy every 3 hours but only if price is below $200"
- "Gradually increase buy amounts during market dips"

**Describe your custom strategy idea and I'll help you build it!**`;
    }

    // Default conversational response
    return `I'm here to help! I can create any trading strategy you have in mind.

I can build:
 **Standard strategies** (DCA, Grid, Stop-Loss, Momentum)
 **Custom strategies** (your unique ideas and combinations)
 **Hybrid approaches** (combining multiple strategies)

What kind of trading strategy are you thinking about? Describe your idea and I'll help you build it exactly how you want it!`;
  }
}

// Export singleton
export const aiModelManager = new AIModelManager();

// Reset provider availability every 30 minutes (more conservative)
setInterval(() => {
  aiModelManager.resetProviderAvailability();
}, 30 * 60 * 1000);
