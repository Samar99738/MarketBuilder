/**
 * Request Validation Middleware
 * Uses Zod for schema validation and input sanitization
 */

import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { ValidationError } from './errorHandler';

/**
 * Zod schema for strategy creation
 */
export const createStrategySchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'ID must contain only letters, numbers, hyphens, and underscores'),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  steps: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['buy', 'sell', 'wait', 'condition', 'get_price', 'custom']),
    amountInSol: z.number().positive().optional(),
    amountToSell: z.number().optional(),
    targetPrice: z.number().positive().optional(),
    durationMs: z.number().positive().optional(),
    condition: z.string().optional(),
    onSuccess: z.string().optional(),
    onFailure: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
  riskLimits: z.object({
    maxPositionSizeSOL: z.number().positive().max(1000).optional(),
    maxDailyLossSOL: z.number().positive().max(10000).optional(),
    stopLossPercentage: z.number().min(0).max(100).optional(),
    takeProfitPercentage: z.number().min(0).max(1000).optional(),
  }).optional(),
});

/**
 * Zod schema for strategy update
 */
export const updateStrategySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  steps: z.array(z.any()).optional(),
  riskLimits: z.object({
    maxPositionSizeSOL: z.number().positive().max(1000).optional(),
    maxDailyLossSOL: z.number().positive().max(10000).optional(),
    stopLossPercentage: z.number().min(0).max(100).optional(),
    takeProfitPercentage: z.number().min(0).max(1000).optional(),
  }).optional(),
});

/**
 * Zod schema for template-based strategy creation
 */
export const createFromTemplateSchema = z.object({
  templateName: z.enum(['dca', 'grid', 'stop_loss', 'momentum', 'dollar_cost_averaging', 'grid_trading', 'stop_loss_take_profit', 'momentum_trading']),
  config: z.object({
    id: z.string().min(1).max(100),
    buyAmountSOL: z.number().positive().max(100).optional(),
    intervalMinutes: z.number().positive().max(1440).optional(),
    buyCount: z.number().int().positive().max(100).optional(),
    gridLevels: z.number().int().positive().max(50).optional(),
    lowerPrice: z.number().positive().optional(),
    upperPrice: z.number().positive().optional(),
    amountPerLevel: z.number().positive().optional(),
    entryPrice: z.number().positive().optional(),
    stopLossPrice: z.number().positive().optional(),
    stopLossPercentage: z.number().min(0).max(100).optional(),
    takeProfitPercentage: z.number().min(0).max(1000).optional(),
    momentumThreshold: z.number().min(0).max(100).optional(),
    sellThreshold: z.number().min(0).max(100).optional(),
    timeframeMinutes: z.number().positive().optional(),
  }),
});

/**
 * Zod schema for strategy execution
 */
export const executeStrategySchema = z.object({
  strategyId: z.string().min(1),
  restartDelay: z.number().int().positive().max(3600000).optional(), // Max 1 hour
});

/**
 * Zod schema for trading operations
 */
export const tradingSchema = z.object({
  amountInSol: z.number().positive().max(100).optional(),
  amountToSell: z.number().optional(),
  slippageBps: z.number().int().min(0).max(10000).optional(),
});

/**
 * Generic validation middleware factory
 */
export function validateRequest(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      const validated = schema.parse(req.body);
      req.body = validated; // Replace with validated data
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = new ValidationError(
          'Request validation failed',
          error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
            code: err.code,
          }))
        );
        next(validationError);
      } else {
        next(error);
      }
    }
  };
}

/**
 * Validate strategy ID parameter
 */
export function validateStrategyId(req: Request, res: Response, next: NextFunction) {
  const { id } = req.params;
  
  if (!id || typeof id !== 'string' || id.length === 0) {
    return next(new ValidationError('Invalid strategy ID'));
  }
  
  if (id.length > 100) {
    return next(new ValidationError('Strategy ID too long (max 100 characters)'));
  }
  
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return next(new ValidationError('Strategy ID must contain only letters, numbers, hyphens, and underscores'));
  }
  
  next();
}

/**
 * Sanitize string inputs (prevent injection)
 */
export function sanitizeInput(value: any): any {
  if (typeof value === 'string') {
    // Remove any potential script tags or dangerous characters
    return value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/[<>]/g, '')
      .trim()
      .substring(0, 10000); // Max length
  }
  
  if (Array.isArray(value)) {
    return value.map(sanitizeInput);
  }
  
  if (value && typeof value === 'object') {
    const sanitized: any = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = sanitizeInput(val);
    }
    return sanitized;
  }
  
  return value;
}

/**
 * Sanitization middleware
 */
export function sanitizeRequestBody(req: Request, res: Response, next: NextFunction) {
  if (req.body) {
    req.body = sanitizeInput(req.body);
  }
  next();
}

