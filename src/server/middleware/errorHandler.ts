/**
 * Centralized Error Handling Middleware
 * Provides consistent error responses for the API
 */

import { Request, Response, NextFunction } from 'express';
import { awsLogger } from '../../aws/logger';

export interface ApiError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

/**
 * Standard error response format
 */
export interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    statusCode: number;
    details?: any;
  };
  timestamp: string;
  path: string;
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  err: ApiError,
  req: Request
): ErrorResponse {
  return {
    success: false,
    error: {
      message: err.message || 'Internal server error',
      code: err.name || 'INTERNAL_ERROR',
      statusCode: err.statusCode || 500,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    },
    timestamp: new Date().toISOString(),
    path: req.path,
  };
}

/**
 * Global error handling middleware
 */
export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const errorResponse = createErrorResponse(err, req);

  // Log error
  if (statusCode >= 500) {
    awsLogger.error('Server error occurred', { 
      metadata: {
        error: err.message,
        path: req.path,
        method: req.method,
        statusCode,
        stack: err.stack,
      }
    });
  } else {
    awsLogger.warn('Client error occurred', {
      metadata: {
        error: err.message,
        path: req.path,
        method: req.method,
        statusCode,
      }
    });
  }

  res.status(statusCode).json(errorResponse);
}

/**
 * 404 Not Found handler
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const error: ApiError = new Error(`Route not found: ${req.method} ${req.path}`);
  error.statusCode = 404;
  error.name = 'NOT_FOUND';
  next(error);
}

/**
 * Async error wrapper for route handlers
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Custom error classes
 */
export class ApiErrorClass extends Error {
  statusCode: number;
  isOperational = true;
  
  constructor(message: string, public code: string, statusCode: number, public details?: any) {
    super(message);
    this.name = code;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends Error {
  statusCode = 400;
  isOperational = true;
  
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'VALIDATION_ERROR';
  }
}

export class NotFoundError extends Error {
  statusCode = 404;
  isOperational = true;
  
  constructor(message: string) {
    super(message);
    this.name = 'NOT_FOUND';
  }
}

export class UnauthorizedError extends Error {
  statusCode = 401;
  isOperational = true;
  
  constructor(message: string = 'Unauthorized') {
    super(message);
    this.name = 'UNAUTHORIZED';
  }
}

export class RateLimitError extends Error {
  statusCode = 429;
  isOperational = true;
  
  constructor(message: string = 'Too many requests') {
    super(message);
    this.name = 'RATE_LIMIT_EXCEEDED';
  }
}

