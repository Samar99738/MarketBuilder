/**
 * Strategy Plugin System - Phase 3
 * Allows developers to create custom strategy types as plugins
 * Plugins can be loaded dynamically without modifying core code
 */

import { StrategyTypeDefinition, strategyRegistry } from './StrategyRegistry';

export interface TradingContext {
  tokenAddress: string;
  currentPrice: number;
  priceHistory: number[];
  timestamp: number;
  userWallet: string;
  availableBalance: number;
  [key: string]: any; // Allow additional context
}

export interface StrategyExecutionResult {
  success: boolean;
  action?: 'buy' | 'sell' | 'hold' | 'custom';
  amount?: number;
  price?: number;
  message?: string;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Base interface for Strategy Plugins
 * Implement this to create a new strategy type
 */
export interface StrategyPlugin {
  // Plugin Metadata
  name: string;
  version: string;
  author: string;
  description?: string;
  
  // Strategy Definition
  getStrategyDefinition(): StrategyTypeDefinition;
  
  // Validation Logic (optional - uses registry validation if not provided)
  validate?(config: any): {
    isValid: boolean;
    errors: string[];
    warnings?: string[];
  };
  
  // Execution Logic
  execute(config: any, context: TradingContext): Promise<StrategyExecutionResult>;
  
  // Lifecycle Hooks (optional)
  onInit?(): Promise<void>;
  onDestroy?(): Promise<void>;
  onConfigChange?(oldConfig: any, newConfig: any): Promise<void>;
}

/**
 * Strategy Plugin Manager
 * Handles loading, registering, and executing strategy plugins
 */
export class StrategyPluginManager {
  private plugins: Map<string, StrategyPlugin> = new Map();
  private executionHistory: Map<string, StrategyExecutionResult[]> = new Map();
  private version: string = '3.0.0';

  constructor() {
    console.log('🔌 [PLUGIN] Initializing Strategy Plugin Manager v' + this.version);
  }

  /**
   * Load and register a plugin
   */
  async loadPlugin(plugin: StrategyPlugin): Promise<void> {
    try {
      // Validate plugin structure
      if (!plugin.name || !plugin.version || !plugin.author) {
        throw new Error('Invalid plugin: missing required metadata (name, version, author)');
      }

      if (typeof plugin.getStrategyDefinition !== 'function') {
        throw new Error('Invalid plugin: missing getStrategyDefinition() method');
      }

      if (typeof plugin.execute !== 'function') {
        throw new Error('Invalid plugin: missing execute() method');
      }

      // Check for duplicate
      if (this.plugins.has(plugin.name)) {
        console.warn(`⚠️ [PLUGIN] Plugin ${plugin.name} already loaded, overwriting...`);
      }

      // Get strategy definition
      const definition = plugin.getStrategyDefinition();
      
      // Validate definition
      if (!definition.type || !definition.displayName) {
        throw new Error('Invalid strategy definition: missing type or displayName');
      }

      // Call onInit lifecycle hook if present
      if (plugin.onInit) {
        console.log(`🔄 [PLUGIN] Initializing ${plugin.name}...`);
        await plugin.onInit();
      }

      // Register strategy type in registry
      strategyRegistry.register(definition);

      // Store plugin
      this.plugins.set(plugin.name, plugin);

      console.log(`✅ [PLUGIN] Loaded: ${plugin.name} v${plugin.version} by ${plugin.author}`);
      console.log(`   Strategy Type: ${definition.type}`);
      console.log(`   Risk Level: ${definition.riskLevel}`);

    } catch (error: any) {
      console.error(`❌ [PLUGIN] Failed to load plugin ${plugin.name}:`, error.message);
      throw error;
    }
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(pluginName: string): Promise<void> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    // Call onDestroy lifecycle hook if present
    if (plugin.onDestroy) {
      console.log(`🔄 [PLUGIN] Destroying ${pluginName}...`);
      await plugin.onDestroy();
    }

    this.plugins.delete(pluginName);
    console.log(`✅ [PLUGIN] Unloaded: ${pluginName}`);
  }

  /**
   * Get plugin by name
   */
  getPlugin(pluginName: string): StrategyPlugin | undefined {
    return this.plugins.get(pluginName);
  }

  /**
   * Get plugin by strategy type
   */
  getPluginByStrategyType(strategyType: string): StrategyPlugin | undefined {
    for (const plugin of this.plugins.values()) {
      const def = plugin.getStrategyDefinition();
      if (def.type === strategyType) {
        return plugin;
      }
    }
    return undefined;
  }

  /**
   * Get all loaded plugins
   */
  getAllPlugins(): StrategyPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Validate a strategy config using plugin's custom validation
   */
  async validateStrategy(strategyType: string, config: any): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const plugin = this.getPluginByStrategyType(strategyType);
    
    if (!plugin) {
      return {
        isValid: false,
        errors: [`No plugin found for strategy type: ${strategyType}`],
        warnings: []
      };
    }

    // Use plugin's custom validation if available
    if (plugin.validate) {
      const result = plugin.validate(config);
      return {
        isValid: result.isValid,
        errors: result.errors,
        warnings: result.warnings || []
      };
    }

    // Fall back to registry validation
    const strategyDef = plugin.getStrategyDefinition();
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    const requiredFields = strategyDef.fields.filter(f => f.required);
    for (const field of requiredFields) {
      if (config[field.name] === undefined || config[field.name] === null) {
        errors.push(`Missing required field: ${field.name}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Execute a strategy using its plugin
   */
  async executeStrategy(
    strategyType: string,
    config: any,
    context: TradingContext
  ): Promise<StrategyExecutionResult> {
    const plugin = this.getPluginByStrategyType(strategyType);

    if (!plugin) {
      return {
        success: false,
        error: `No plugin found for strategy type: ${strategyType}`
      };
    }

    try {
      // Validate first
      const validation = await this.validateStrategy(strategyType, config);
      if (!validation.isValid) {
        return {
          success: false,
          error: `Validation failed: ${validation.errors.join(', ')}`
        };
      }

      // Execute
      console.log(`🚀 [PLUGIN] Executing strategy: ${strategyType} via ${plugin.name}`);
      const result = await plugin.execute(config, context);

      // Store execution history
      if (!this.executionHistory.has(strategyType)) {
        this.executionHistory.set(strategyType, []);
      }
      this.executionHistory.get(strategyType)!.push(result);

      return result;

    } catch (error: any) {
      console.error(`❌ [PLUGIN] Execution error in ${plugin.name}:`, error.message);
      return {
        success: false,
        error: `Execution error: ${error.message}`
      };
    }
  }

  /**
   * Get execution history for a strategy type
   */
  getExecutionHistory(strategyType: string): StrategyExecutionResult[] {
    return this.executionHistory.get(strategyType) || [];
  }

  /**
   * Clear execution history
   */
  clearExecutionHistory(strategyType?: string): void {
    if (strategyType) {
      this.executionHistory.delete(strategyType);
    } else {
      this.executionHistory.clear();
    }
  }

  /**
   * Get plugin statistics
   */
  getStats(): {
    totalPlugins: number;
    pluginsByAuthor: Record<string, number>;
    strategyTypes: string[];
  } {
    const stats = {
      totalPlugins: this.plugins.size,
      pluginsByAuthor: {} as Record<string, number>,
      strategyTypes: [] as string[]
    };

    for (const plugin of this.plugins.values()) {
      stats.pluginsByAuthor[plugin.author] = (stats.pluginsByAuthor[plugin.author] || 0) + 1;
      stats.strategyTypes.push(plugin.getStrategyDefinition().type);
    }

    return stats;
  }

  /**
   * Reload a plugin (useful for development)
   */
  async reloadPlugin(plugin: StrategyPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      await this.unloadPlugin(plugin.name);
    }
    await this.loadPlugin(plugin);
  }
}

/**
 * Abstract base class for creating strategy plugins
 * Provides common functionality for plugin developers
 */
export abstract class BaseStrategyPlugin implements StrategyPlugin {
  abstract name: string;
  abstract version: string;
  abstract author: string;
  description?: string;

  abstract getStrategyDefinition(): StrategyTypeDefinition;
  abstract execute(config: any, context: TradingContext): Promise<StrategyExecutionResult>;

  /**
   * Helper: Log plugin messages
   */
  protected log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = `[${this.name}]`;
    switch (level) {
      case 'info':
        console.log(prefix, message);
        break;
      case 'warn':
        console.warn(prefix, message);
        break;
      case 'error':
        console.error(prefix, message);
        break;
    }
  }

  /**
   * Helper: Validate numeric field
   */
  protected validateNumber(
    value: any,
    fieldName: string,
    options?: { min?: number; max?: number }
  ): string | null {
    if (typeof value !== 'number' || isNaN(value)) {
      return `${fieldName} must be a valid number`;
    }
    if (options?.min !== undefined && value < options.min) {
      return `${fieldName} must be >= ${options.min}`;
    }
    if (options?.max !== undefined && value > options.max) {
      return `${fieldName} must be <= ${options.max}`;
    }
    return null;
  }

  /**
   * Helper: Create success result
   */
  protected success(
    action: StrategyExecutionResult['action'],
    message: string,
    metadata?: Record<string, any>
  ): StrategyExecutionResult {
    return {
      success: true,
      action,
      message,
      metadata
    };
  }

  /**
   * Helper: Create error result
   */
  protected error(message: string): StrategyExecutionResult {
    return {
      success: false,
      error: message
    };
  }
}

// Export singleton instance
export const pluginManager = new StrategyPluginManager();
