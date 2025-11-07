/**
 * Rate Limiting Middleware
 * Protects API from abuse and ensures fair usage
 */

import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

/**
 * General API rate limiter
 * Production: 60 requests per minute per IP
 * Development: 200 requests per minute per IP
 */
const getApiRateLimit = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  return isProduction ? 60 : 200; // Stricter limits in production
};

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || getApiRateLimit().toString()),
  message: {
    success: false,
    error: {
      message: 'Too many requests from this IP, please try again later',
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      retryAfter: '60 seconds',
    },
    timestamp: new Date().toISOString(),
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: {
        message: 'Too many requests, please slow down',
        code: 'RATE_LIMIT_EXCEEDED',
        statusCode: 429,
        retryAfter: Math.ceil(60 - (Date.now() % 60000) / 1000) + ' seconds',
      },
      timestamp: new Date().toISOString(),
      path: req.path,
    });
  },
});

/**
 * Strict rate limiter for strategy creation
 * 10 strategies per hour per IP
 */
export const strategyCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    success: false,
    error: {
      message: 'Too many strategies created. Maximum 10 per hour.',
      code: 'STRATEGY_CREATION_LIMIT',
      statusCode: 429,
    },
    timestamp: new Date().toISOString(),
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed attempts
});

/**
 * Trading rate limiter
 * 30 trades per minute (safety measure)
 */
export const tradingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: {
    success: false,
    error: {
      message: 'Trading rate limit exceeded. Maximum 30 trades per minute.',
      code: 'TRADING_RATE_LIMIT',
      statusCode: 429,
    },
    timestamp: new Date().toISOString(),
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Authentication attempts limiter
 * 5 attempts per 15 minutes
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: {
    success: false,
    error: {
      message: 'Too many authentication attempts. Please try again later.',
      code: 'AUTH_RATE_LIMIT',
      statusCode: 429,
    },
    timestamp: new Date().toISOString(),
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

