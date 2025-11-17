/**
 * Strategy Validator
 * Lightweight validation for AI-generated strategy configurations
 * Does NOT attempt to parse or extract - that's AI's job
 * Only validates structure, required fields, and data types
 * 
 * PHASE 2: Now uses Dynamic Strategy Registry instead of hardcoded schemas
 */

import { strategyRegistry } from '../trading_utils/StrategyRegistry';

export interface ValidationResult {
  isValid: boolean;
  isComplete: boolean;
  errors: string[];
  warnings: string[];
  missingFields: string[];
  confidence: number;
}

/**
 * Get strategy schema dynamically from registry
 * Backwards compatible with old STRATEGY_SCHEMA format
 */
export function getStrategySchema() {
  return strategyRegistry.generateValidatorSchema();
}

export class StrategyValidator {
  /**
   * Validate AI-generated strategy configuration
   * PHASE 2: Now uses dynamic registry for validation
   */
  validateStrategy(config: any): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      isComplete: false,
      errors: [],
      warnings: [],
      missingFields: [],
      confidence: 0
    };

    // 1. Check if config exists
    if (!config || typeof config !== 'object') {
      result.errors.push('Strategy config is null or not an object');
      result.isValid = false;
      return result;
    }

    // 2. Check strategyType exists and is valid
    if (!config.strategyType) {
      result.errors.push('Missing strategyType field');
      result.isValid = false;
      return result;
    }

    // Get strategy definition from registry
    const strategyDef = strategyRegistry.get(config.strategyType);
    
    if (!strategyDef) {
      result.warnings.push(`Unknown strategyType: ${config.strategyType} (not found in registry)`);
      // Don't fail - might be a custom strategy
      return result;
    }

    // 3. Get required fields from strategy definition
    const requiredFields = strategyRegistry.getRequiredFields(config.strategyType);

    // 4. Check each required field
    for (const field of requiredFields) {
      if (config[field] === undefined || config[field] === null || config[field] === '') {
        result.missingFields.push(field);
      }
    }

    // 5. Validate each field using registry definitions
    if (strategyDef) {
      for (const fieldDef of strategyDef.fields) {
        const fieldValue = config[fieldDef.name];
        
        // Skip null/undefined for optional fields
        if ((fieldValue === null || fieldValue === undefined) && !fieldDef.required) {
          continue;
        }

        // Validate field using registry
        const fieldValidation = strategyRegistry.validateField(
          config.strategyType,
          fieldDef.name,
          fieldValue
        );

        if (!fieldValidation.isValid) {
          result.errors.push(...fieldValidation.errors);
          result.isValid = false;
        }
      }
    }

    // Additional warnings and SPECIAL COMPLETENESS HANDLING for specific strategies
    if (strategyDef) {
      // REACTIVE STRATEGY SPECIAL HANDLING: Mirror mode doesn't need amount fields
      if (config.strategyType === 'reactive') {
        const isMirrorMode = config.sizingRule && 
          (config.sizingRule.includes('mirror') || config.sizingRule === 'mirror_volume' || config.sizingRule === 'mirror_buy_volume');
        const isSellStrategy = config.side === 'sell';
        
        console.log(`🔍 [VALIDATOR] Reactive strategy validation - side: ${config.side}, isMirrorMode: ${isMirrorMode}, sizingRule: ${config.sizingRule}`);
        
        if (isMirrorMode && isSellStrategy) {
          // Mirror SELL strategies don't need sellAmountTokens - they mirror detected buys
          // Remove sellAmountTokens from missing fields if present
          const amountFieldIndex = result.missingFields.indexOf('sellAmountTokens');
          if (amountFieldIndex !== -1) {
            result.missingFields.splice(amountFieldIndex, 1);
          }
          console.log(`✅ [VALIDATOR] SELL strategy in mirror mode - amount NOT required`);
        } else if (isMirrorMode && !isSellStrategy) {
          // Mirror BUY strategies don't need buyAmountSOL - they mirror detected sells
          const amountFieldIndex = result.missingFields.indexOf('buyAmountSOL');
          if (amountFieldIndex !== -1) {
            result.missingFields.splice(amountFieldIndex, 1);
          }
          console.log(`✅ [VALIDATOR] BUY strategy in mirror mode - amount NOT required`);
        }
      }
      
      if (config.strategyType === 'contrarian_volatility') {
        if (!config.sellTriggerTimeframeMinutes) {
          result.warnings.push('sellTriggerTimeframeMinutes not specified (will use default)');
        }
        if (!config.buyTriggerTimeframeMinutes) {
          result.warnings.push('buyTriggerTimeframeMinutes not specified (will use default)');
        }
      }

      if (config.strategyType === 'grid_trading') {
        if (config.priceRangeLow && config.priceRangeHigh && config.priceRangeLow >= config.priceRangeHigh) {
          result.errors.push('priceRangeLow must be less than priceRangeHigh');
          result.isValid = false;
        }
      }
    }

    // 7. Check if AI marked strategy as complete
    if (config.isComplete !== undefined) {
      result.isComplete = config.isComplete === true;
    } else {
      // Calculate completeness based on missing fields
      result.isComplete = result.missingFields.length === 0 && result.errors.length === 0;
    }

    // 8. Calculate confidence score
    const totalFields = requiredFields.length;
    const providedFields = totalFields - result.missingFields.length;

    if (totalFields > 0) {
      result.confidence = providedFields / totalFields;
    } else {
      // Custom strategies or strategies with no required fields
      result.confidence = 0.8; // Base confidence
    }

    // Boost confidence if AI provided its own confidence score
    if (config.confidence !== undefined && typeof config.confidence === 'number') {
      result.confidence = Math.max(result.confidence, config.confidence);
    }

    // Penalize confidence for errors
    if (result.errors.length > 0) {
      result.confidence = Math.max(0, result.confidence - (result.errors.length * 0.15));
      result.isValid = false;
    }

    // Penalize slightly for warnings
    if (result.warnings.length > 0) {
      result.confidence = Math.max(0, result.confidence - (result.warnings.length * 0.05));
    }

    return result;
  }

  /**
   * Extract strategy configuration from AI response text
   * Looks for JSON code blocks or raw JSON objects
   */
  extractStrategyFromResponse(aiResponse: string): any | null {
    try {
      // Method 1: Look for JSON code block with ```json
      const jsonBlockMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch && jsonBlockMatch[1]) {
        try {
          const parsed = JSON.parse(jsonBlockMatch[1]);
          console.log(' [EXTRACT] Found JSON in code block');
          return parsed;
        } catch (parseError) {
          console.warn(' [EXTRACT] Found JSON block but failed to parse:', parseError);
        }
      }

      // Method 2: Look for raw JSON object with strategyType field
      const objectMatch = aiResponse.match(/\{[\s\S]*?"strategyType"[\s\S]*?\}/);
      if (objectMatch && objectMatch[0]) {
        try {
          // Find the complete JSON object (handle nested braces)
          const startIndex = objectMatch.index!;
          let braceCount = 0;
          let endIndex = startIndex;
          
          for (let i = startIndex; i < aiResponse.length; i++) {
            if (aiResponse[i] === '{') braceCount++;
            if (aiResponse[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIndex = i + 1;
                break;
              }
            }
          }

          const jsonStr = aiResponse.substring(startIndex, endIndex);
          const parsed = JSON.parse(jsonStr);
          console.log(' [EXTRACT] Found raw JSON object');
          return parsed;
        } catch (parseError) {
          console.warn(' [EXTRACT] Found JSON-like object but failed to parse:', parseError);
        }
      }

      // Method 3: Look for alternative code block markers
      const altBlockMatch = aiResponse.match(/```\s*([\s\S]*?)\s*```/);
      if (altBlockMatch && altBlockMatch[1] && altBlockMatch[1].includes('strategyType')) {
        try {
          const parsed = JSON.parse(altBlockMatch[1]);
          console.log(' [EXTRACT] Found JSON in generic code block');
          return parsed;
        } catch (parseError) {
          console.warn(' [EXTRACT] Found code block with strategyType but failed to parse');
        }
      }

      console.log(' [EXTRACT] No valid JSON found in AI response');
      return null;
    } catch (error) {
      console.error(' [EXTRACT] Exception during strategy extraction:', error);
      return null;
    }
  }

  /**
   * Format validation result for display to user
   */
  formatValidationResult(validation: ValidationResult, strategyType?: string): string {
    let output = '';

    if (!validation.isValid) {
      output += '❌ **Strategy Validation Failed**\n\n';
      output += '**Errors:**\n';
      validation.errors.forEach(error => {
        output += `- ${error}\n`;
      });
    } else if (!validation.isComplete) {
      output += '⚠️ **Strategy Incomplete**\n\n';
      output += '**Missing Information:**\n';
      validation.missingFields.forEach(field => {
        output += `- ${field}\n`;
      });
    } else {
      output += '✅ **Strategy Validated Successfully**\n\n';
      output += `**Type:** ${strategyType || 'Unknown'}\n`;
      output += `**Confidence:** ${(validation.confidence * 100).toFixed(1)}%\n`;
    }

    if (validation.warnings.length > 0) {
      output += '\n**Warnings:**\n';
      validation.warnings.forEach(warning => {
        output += `- ⚠️ ${warning}\n`;
      });
    }

    return output;
  }
}

// Export singleton instance
export const strategyValidator = new StrategyValidator();
