/**
 * Strategy Optimization Engine
 * AI-powered parameter tuning based on historical performance
 */

import { awsLogger } from '../aws/logger';
import { Strategy, StrategyMetrics } from './StrategyBuilder';
import { aiModelManager } from '../agent/aiModelManager';

export interface OptimizationResult {
  originalParams: Record<string, any>;
  suggestedParams: Record<string, any>;
  expectedImprovement: number; // Expected improvement in win rate (%)
  confidence: number; // Confidence in suggestion (0-1)
  reasoning: string;
}

export interface OptimizationConfig {
  minTradesForOptimization: number;
  targetWinRate: number;
  maxParameterChange: number; // Max % change for any parameter
  conservativeMode: boolean; // Make smaller adjustments
}

/**
 * Strategy Optimizer using AI
 */
export class StrategyOptimizer {
  private config: OptimizationConfig;
  
  constructor(config: Partial<OptimizationConfig> = {}) {
    this.config = {
      minTradesForOptimization: 20,
      targetWinRate: 70, // 70% target win rate
      maxParameterChange: 50, // Max 50% change
      conservativeMode: true,
      ...config
    };
    
    awsLogger.info('StrategyOptimizer initialized', {
      metadata: { config: this.config }
    });
  }

  /**
   * Analyze strategy and suggest optimizations
   */
  async optimizeStrategy(strategy: Strategy): Promise<OptimizationResult | null> {
    // Check if we have enough data
    if (strategy.metrics.totalTrades < this.config.minTradesForOptimization) {
      awsLogger.info('Insufficient trades for optimization', {
        metadata: {
          strategyId: strategy.id,
          totalTrades: strategy.metrics.totalTrades,
          required: this.config.minTradesForOptimization
        }
      });
      return null;
    }

    // Extract current parameters
    const currentParams = this.extractParameters(strategy);
    
    // Analyze performance
    const analysis = this.analyzePerformance(strategy.metrics);
    
    // Generate AI-powered suggestions
    const suggestions = await this.generateSuggestions(
      strategy,
      currentParams,
      analysis
    );
    
    if (!suggestions) {
      return null;
    }
    
    return {
      originalParams: currentParams,
      suggestedParams: suggestions.params,
      expectedImprovement: suggestions.improvement,
      confidence: suggestions.confidence,
      reasoning: suggestions.reasoning
    };
  }

  /**
   * Extract parameters from strategy
   */
  private extractParameters(strategy: Strategy): Record<string, any> {
    const params: Record<string, any> = {};
    
    // Extract from strategy steps (simplified - would need strategy-type-specific logic)
    if (strategy.steps.length > 0) {
      const firstStep = strategy.steps[0];
      
      // Extract common parameters
      if ('amountInSol' in firstStep) {
        params.amountInSol = firstStep.amountInSol;
      }
      
      if ('durationMs' in firstStep) {
        params.intervalMs = firstStep.durationMs;
      }
      
      if ('targetPrice' in firstStep) {
        params.targetPrice = firstStep.targetPrice;
      }
    }
    
    // Extract from risk limits
    params.maxPositionSizeSOL = strategy.riskLimits.maxPositionSizeSOL;
    params.stopLossPercentage = strategy.riskLimits.stopLossPercentage;
    params.takeProfitPercentage = strategy.riskLimits.takeProfitPercentage;
    
    return params;
  }

  /**
   * Analyze strategy performance
   */
  private analyzePerformance(metrics: StrategyMetrics): {
    issues: string[];
    strengths: string[];
    needsAdjustment: boolean;
  } {
    const issues: string[] = [];
    const strengths: string[] = [];
    let needsAdjustment = false;
    
    // Analyze win rate
    if (metrics.winRate < this.config.targetWinRate) {
      issues.push(`Win rate (${metrics.winRate.toFixed(1)}%) below target (${this.config.targetWinRate}%)`);
      needsAdjustment = true;
    } else {
      strengths.push(`Good win rate: ${metrics.winRate.toFixed(1)}%`);
    }
    
    // Analyze P&L
    if (metrics.totalPnL < 0) {
      issues.push(`Negative total P&L: ${metrics.totalPnL.toFixed(4)} SOL`);
      needsAdjustment = true;
    } else {
      strengths.push(`Positive P&L: ${metrics.totalPnL.toFixed(4)} SOL`);
    }
    
    // Analyze drawdown
    if (metrics.maxDrawdown > 0.2) { // 20% drawdown
      issues.push(`High drawdown: ${(metrics.maxDrawdown * 100).toFixed(1)}%`);
      needsAdjustment = true;
    }
    
    // Analyze trade time
    if (metrics.averageTradeTime > 300000) { // 5 minutes
      issues.push(`Slow average trade time: ${(metrics.averageTradeTime / 1000).toFixed(0)}s`);
    }
    
    return { issues, strengths, needsAdjustment };
  }

  /**
   * Generate AI-powered optimization suggestions
   */
  private async generateSuggestions(
    strategy: Strategy,
    currentParams: Record<string, any>,
    analysis: { issues: string[]; strengths: string[]; needsAdjustment: boolean }
  ): Promise<{
    params: Record<string, any>;
    improvement: number;
    confidence: number;
    reasoning: string;
  } | null> {
    if (!analysis.needsAdjustment) {
      return null; // Strategy is performing well
    }
    
    // Build AI prompt
    const prompt = `
You are a trading strategy optimizer. Analyze the following strategy and suggest parameter improvements.

**Strategy:** ${strategy.name}
**Type:** ${strategy.description}

**Current Performance:**
- Total Trades: ${strategy.metrics.totalTrades}
- Win Rate: ${strategy.metrics.winRate.toFixed(2)}%
- Total P&L: ${strategy.metrics.totalPnL.toFixed(4)} SOL
- Max Drawdown: ${strategy.metrics.maxDrawdown.toFixed(4)} SOL

**Current Parameters:**
${JSON.stringify(currentParams, null, 2)}

**Issues:**
${analysis.issues.map(i => `- ${i}`).join('\n')}

**Strengths:**
${analysis.strengths.map(s => `- ${s}`).join('\n')}

**Target:**
- Win Rate: ${this.config.targetWinRate}%
- Positive P&L
- Minimal Drawdown

Please suggest optimized parameters that would improve performance. Return ONLY a JSON object with this structure:
{
  "params": { /* optimized parameters */ },
  "improvement": /* expected win rate improvement % */,
  "confidence": /* 0-1 */,
  "reasoning": "Brief explanation"
}
`;

    try {
      const response = await aiModelManager.generateResponse(prompt);
      
      // Parse AI response
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        awsLogger.warn('AI optimization response invalid format', {
          metadata: { response: response.text }
        });
        return null;
      }
      
      const suggestion = JSON.parse(jsonMatch[0]);
      
      // Validate and constrain suggestions
      const validatedParams = this.validateSuggestions(currentParams, suggestion.params);
      
      return {
        params: validatedParams,
        improvement: suggestion.improvement || 0,
        confidence: Math.min(suggestion.confidence || 0.5, 1.0),
        reasoning: suggestion.reasoning || 'AI-suggested optimization'
      };
    } catch (error) {
      awsLogger.error('AI optimization failed', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          strategyId: strategy.id
        }
      });
      return null;
    }
  }

  /**
   * Validate and constrain AI suggestions
   */
  private validateSuggestions(
    original: Record<string, any>,
    suggested: Record<string, any>
  ): Record<string, any> {
    const validated: Record<string, any> = {};
    
    for (const key of Object.keys(suggested)) {
      if (!(key in original)) {
        continue; // Skip new parameters
      }
      
      const originalValue = original[key];
      const suggestedValue = suggested[key];
      
      if (typeof originalValue !== 'number' || typeof suggestedValue !== 'number') {
        validated[key] = originalValue; // Keep original for non-numeric
        continue;
      }
      
      // Calculate max change
      const maxChange = originalValue * (this.config.maxParameterChange / 100);
      const change = suggestedValue - originalValue;
      
      // Constrain change
      if (Math.abs(change) > maxChange) {
        validated[key] = originalValue + Math.sign(change) * maxChange;
      } else {
        validated[key] = suggestedValue;
      }
      
      // Apply conservative mode (reduce change by 50%)
      if (this.config.conservativeMode) {
        const conservativeChange = (validated[key] - originalValue) * 0.5;
        validated[key] = originalValue + conservativeChange;
      }
    }
    return validated;
  }

  /**
   * Apply optimization to strategy
   */
  applyOptimization(
    strategy: Strategy,
    optimization: OptimizationResult
  ): Strategy {
    awsLogger.info('Applying optimization', {
      metadata: {
        strategyId: strategy.id,
        originalParams: optimization.originalParams,
        suggestedParams: optimization.suggestedParams
      }
    });
    
    // Update risk limits if suggested
    if (optimization.suggestedParams.maxPositionSizeSOL) {
      strategy.riskLimits.maxPositionSizeSOL = optimization.suggestedParams.maxPositionSizeSOL;
    }
    
    if (optimization.suggestedParams.stopLossPercentage) {
      strategy.riskLimits.stopLossPercentage = optimization.suggestedParams.stopLossPercentage;
    }
    
    if (optimization.suggestedParams.takeProfitPercentage) {
      strategy.riskLimits.takeProfitPercentage = optimization.suggestedParams.takeProfitPercentage;
    }
    
    // Update strategy version
    const versionParts = strategy.version.split('.');
    versionParts[1] = String(parseInt(versionParts[1]) + 1); // Increment minor version
    strategy.version = versionParts.join('.');
    strategy.updatedAt = Date.now();
    
    awsLogger.info('Strategy optimized', {
      metadata: {
        strategyId: strategy.id,
        newVersion: strategy.version
      }
    });
    return strategy;
  }

  /**
   * Get optimization report
   */
  getOptimizationReport(optimization: OptimizationResult): string {
    let report = `
🤖 **STRATEGY OPTIMIZATION REPORT**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Expected Improvement:** +${optimization.expectedImprovement.toFixed(1)}% win rate
**Confidence:** ${(optimization.confidence * 100).toFixed(0)}%

**Reasoning:**
${optimization.reasoning}

**Parameter Changes:**

`;

    for (const key of Object.keys(optimization.originalParams)) {
      const original = optimization.originalParams[key];
      const suggested = optimization.suggestedParams[key];
      
      if (original !== suggested) {
        const change = suggested - original;
        const changePercent = ((change / original) * 100).toFixed(1);
        const arrow = change > 0 ? '↑' : '↓';
        
        report += `• ${key}: ${original} → ${suggested} (${arrow} ${Math.abs(parseFloat(changePercent))}%)\n`;
      }
    }

    report += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return report;
  }
}

// Export singleton
export const strategyOptimizer = new StrategyOptimizer({
  minTradesForOptimization: 20,
  targetWinRate: 70,
  maxParameterChange: 50,
  conservativeMode: true
});

