/**
 * Production Error Handler
 * Robust error handling with automatic recovery and graceful degradation
 */

import { awsLogger } from '../aws/logger';

export interface ErrorContext {
  component: string;
  operation: string;
  data?: any;
  timestamp: number;
}

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  exponentialBackoff: boolean;
  retryableErrors: string[];
}

export interface RecoveryAction {
  action: 'retry' | 'fallback' | 'skip' | 'abort';
  delay?: number;
  fallbackValue?: any;
}

/**
 * Production-grade error handler with automatic recovery
 */
export class ProductionErrorHandler {
  private errorCounts: Map<string, number> = new Map();
  private lastErrors: Map<string, Date> = new Map();
  private readonly ERROR_THRESHOLD = 10; // Max errors before alerting
  private readonly ERROR_WINDOW_MS = 60000; // 1 minute window
  
  // Default retry configuration
  private defaultRetryConfig: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    exponentialBackoff: true,
    retryableErrors: [
      'NETWORK_ERROR',
      'TIMEOUT',
      'SERVICE_UNAVAILABLE',
      'RATE_LIMIT',
      'CONNECTION_REFUSED',
      'ECONNRESET',
      '503',
      '429',
      '408'
    ]
  };

  constructor() {
    awsLogger.info('ProductionErrorHandler initialized');
  }

  /**
   * Handle error with automatic recovery
   */
  async handleError(
    error: any,
    context: ErrorContext,
    retryConfig?: Partial<RetryConfig>
  ): Promise<RecoveryAction> {
    const config = { ...this.defaultRetryConfig, ...retryConfig };
    const errorKey = `${context.component}-${context.operation}`;
    
    // Log error
    awsLogger.error(`Error in ${context.component}.${context.operation}`, {
      metadata: {
        error: error.message || String(error),
        stack: error.stack,
        context,
        timestamp: Date.now()
      }
    });

    // Track error frequency
    this.trackError(errorKey);

    // Check if error is retryable
    const isRetryable = this.isRetryableError(error, config);

    if (isRetryable) {
      const retryCount = this.errorCounts.get(errorKey) || 0;
      
      if (retryCount < config.maxRetries) {
        const delay = this.calculateDelay(retryCount, config);
        
        awsLogger.info(`Retrying ${context.operation} (attempt ${retryCount + 1}/${config.maxRetries})`, {
          metadata: { delay, errorKey }
        });

        return { action: 'retry', delay };
      } else {
        awsLogger.warn(`Max retries exceeded for ${context.operation}`, {
          metadata: { retryCount, errorKey }
        });
        
        return { action: 'abort' };
      }
    }

    // Non-retryable error - abort immediately
    return { action: 'abort' };
  }

  /**
   * Execute operation with automatic retry
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: ErrorContext,
    retryConfig?: Partial<RetryConfig>
  ): Promise<T> {
    const config = { ...this.defaultRetryConfig, ...retryConfig };
    let lastError: any;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const result = await operation();
        
        // Reset error count on success
        const errorKey = `${context.component}-${context.operation}`;
        this.errorCounts.set(errorKey, 0);
        
        return result;
      } catch (error) {
        lastError = error;
        
        const recovery = await this.handleError(error, context, config);
        
        if (recovery.action === 'retry' && attempt < config.maxRetries) {
          if (recovery.delay) {
            await this.sleep(recovery.delay);
          }
          continue; // Retry
        } else if (recovery.action === 'fallback' && recovery.fallbackValue !== undefined) {
          return recovery.fallbackValue as T;
        } else {
          // Abort
          break;
        }
      }
    }

    // All retries failed
    throw new Error(
      `Operation failed after ${config.maxRetries} retries: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Execute with fallback value on error
   */
  async executeWithFallback<T>(
    operation: () => Promise<T>,
    fallbackValue: T,
    context: ErrorContext
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.handleError(error, context);
      
      awsLogger.info(`Using fallback value for ${context.operation}`, {
        metadata: { context }
      });
      
      return fallbackValue;
    }
  }

  /**
   * Execute with timeout
   */
  async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    context: ErrorContext
  ): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]).catch(async (error) => {
      await this.handleError(error, context);
      throw error;
    });
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: any, config: RetryConfig): boolean {
    const errorMessage = error.message || String(error);
    const errorCode = error.code || error.status || '';
    
    return config.retryableErrors.some(retryable =>
      errorMessage.includes(retryable) || String(errorCode).includes(retryable)
    );
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateDelay(attempt: number, config: RetryConfig): number {
    if (!config.exponentialBackoff) {
      return config.initialDelayMs;
    }

    const delay = config.initialDelayMs * Math.pow(2, attempt);
    return Math.min(delay, config.maxDelayMs);
  }

  /**
   * Track error frequency
   */
  private trackError(errorKey: string): void {
    const now = Date.now();
    const lastError = this.lastErrors.get(errorKey);
    
    // Reset count if outside error window
    if (lastError && now - lastError.getTime() > this.ERROR_WINDOW_MS) {
      this.errorCounts.set(errorKey, 0);
    }

    const count = (this.errorCounts.get(errorKey) || 0) + 1;
    this.errorCounts.set(errorKey, count);
    this.lastErrors.set(errorKey, new Date(now));

    // Alert if threshold exceeded
    if (count >= this.ERROR_THRESHOLD) {
      awsLogger.error('ERROR THRESHOLD EXCEEDED', {
        metadata: {
          errorKey,
          count,
          window: `${this.ERROR_WINDOW_MS}ms`,
          threshold: this.ERROR_THRESHOLD
        }
      });
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get error statistics
   */

  getErrorStats(): Array<{ key: string; count: number; lastError: Date }> {
    const stats: Array<{ key: string; count: number; lastError: Date }> = [];
    
    for (const [key, count] of this.errorCounts.entries()) {
      const lastError = this.lastErrors.get(key);
      if (lastError) {
        stats.push({ key, count, lastError });
      }
    }
    
    return stats.sort((a, b) => b.count - a.count);
  }

  /**
   * Reset error tracking
   */
  reset(): void {
    this.errorCounts.clear();
    this.lastErrors.clear();
    awsLogger.info('Error tracking reset');
  }
}

// Export singleton
export const productionErrorHandler = new ProductionErrorHandler();

