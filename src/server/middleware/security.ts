/**
 * Security Middleware
 * Implements security best practices for the API
 */

import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from './errorHandler';

/**
 * Helmet configuration for security headers
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.socket.io', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com', 'https://plugin.jup.ag'],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers for agent UI
      imgSrc: ["'self'", 'data:', 'https:', 'https://cdnjs.cloudflare.com'],
      connectSrc: ["'self'", 'ws://localhost:3000', 'http://localhost:3000', 'https://cdn.socket.io', 'https://api.coingecko.com', 'https://api.coinmarketcap.com', 'https://api.binance.com', 'https://unpkg.com', 'https://plugin.jup.ag', 'https://quote-api.jup.ag', 'https://api.jup.ag', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://api.mainnet-beta.solana.com', 'https://*.solana.com', 'https://*.jup.ag'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      styleSrcElem: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
      scriptSrcElem: ["'self'", "'unsafe-inline'", 'https://cdn.socket.io', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com', 'https://plugin.jup.ag'],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
});

/**
 * CORS configuration
 */
export function configureCORS(req: Request, res: Response, next: NextFunction) {
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',') || ['*'];
  const origin = req.headers.origin;

  if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key');
  res.header('Access-Control-Allow-Credentials', 'true');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
}

/**
 * Simple API key authentication (basic protection)
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  // Skip if API key auth is disabled
  if (process.env.DISABLE_API_KEY_AUTH === 'true') {
    return next();
  }

  const apiKey = process.env.API_KEY;
  
  // If no API key is configured, skip authentication
  if (!apiKey) {
    return next();
  }

  const requestKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!requestKey || requestKey !== apiKey) {
    return next(new UnauthorizedError('Invalid or missing API key'));
  }

  next();
}

/**
 * Request logging middleware with enhanced production monitoring
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);

  // Add request ID for tracing
  (req as any).requestId = requestId;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const log = {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.substring(0, 100), // Truncate long user agents
      timestamp: new Date().toISOString(),
    };

    // Only detailed logging in development or if verbose logging is enabled
    if (process.env.NODE_ENV === 'development' || process.env.VERBOSE_LOGGING === 'true') {
      console.log(`[${new Date().toISOString()}]`, JSON.stringify(log));
    }
  });

  next();
}

/**
 * Prevent parameter pollution
 */
export function preventParameterPollution(req: Request, res: Response, next: NextFunction) {
  // Ensure query parameters are not arrays (prevent pollution)
  if (req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        req.query[key] = value[0]; // Take only first value
      }
    }
  }
  next();
}

