/**
 * ENVIRONMENT CONFIGURATION MANAGER
 * 
 * Handles environment-specific settings, validation, and secure configuration loading.
 * Ensures proper setup for development, staging, and production environments.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Environment types
export type Environment = 'development' | 'production' | 'staging' | 'test';

// Configuration interface
export interface EnvironmentConfig {
  // Environment
  NODE_ENV: Environment;

  // Security (optional when MPC is enabled)
  WALLET_PRIVATE_KEY?: string;
  WEBHOOK_SECRET?: string;
  
  // Network
  RPC_ENDPOINT: string;
  WS_ENDPOINT?: string;
  
  // Trading
  TOKEN_ADDRESS: string;
  BUY_AMOUNT_SOL: number;
  SLIPPAGE_BPS: number;
  MAX_SLIPPAGE_BPS: number;
  PRIORITY_FEE_LAMPORTS: number;
  MIN_SELL_AMOUNT: number;
  DYNAMIC_COMPUTE_UNIT_LIMIT: boolean;
  MAX_RETRIES: number;
  
  // Server
  PORT: number;
  CORS_ORIGIN: string;
  
  // Monitoring
  ENABLE_PERFORMANCE_MONITORING: boolean;
  LOG_LEVEL: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  
  // Security
  ENABLE_RATE_LIMITING: boolean;
  MAX_REQUESTS_PER_MINUTE: number;
  
  // AWS
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  ENABLE_CLOUDWATCH_LOGGING: boolean;
}

/**
 * Load environment configuration with validation
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  // Determine environment
  const env = (process.env.NODE_ENV || 'development') as Environment;
  
  console.error(`Loading configuration for environment: ${env}`);
  
  // Load environment-specific .env file
  const envFile = `.env.${env}`;
  const envPath = path.resolve(process.cwd(), envFile);
  
  if (fs.existsSync(envPath)) {
    console.error(`Loading environment config from: ${envFile}`);
    dotenv.config({ path: envPath });
  } else {
    console.error(`Environment file ${envFile} not found, using .env`);
  }
  
  // Also load .env as fallback
  dotenv.config();
  
  // Build and validate configuration
  const config: EnvironmentConfig = {
    // Environment
    NODE_ENV: env,
    
    // Security (optional when MPC is enabled)
    WALLET_PRIVATE_KEY: process.env.MPC_ENABLED === 'true' ? process.env.WALLET_PRIVATE_KEY : getRequiredEnv('WALLET_PRIVATE_KEY'),
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    
    // Network
    RPC_ENDPOINT: getRequiredEnv('RPC_ENDPOINT'),
    WS_ENDPOINT: process.env.WS_ENDPOINT,
    
    // Trading (TOKEN_ADDRESS optional in MCP mode, will be provided per-tool call)
    TOKEN_ADDRESS: process.env.TOKEN_ADDRESS || 'So11111111111111111111111111111111111111112', // Default to SOL
    BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || '0.1'),
    SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || '300'),
    MAX_SLIPPAGE_BPS: parseInt(process.env.MAX_SLIPPAGE_BPS || '1000'),
    PRIORITY_FEE_LAMPORTS: parseInt(process.env.PRIORITY_FEE_LAMPORTS || '5000'),
    MIN_SELL_AMOUNT: parseFloat(process.env.MIN_SELL_AMOUNT || '1000'),
    DYNAMIC_COMPUTE_UNIT_LIMIT: process.env.DYNAMIC_COMPUTE_UNIT_LIMIT === 'true',
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3'),
    
    // Server
    PORT: parseInt(process.env.PORT || '3000'),
    CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
    
    // Monitoring
    ENABLE_PERFORMANCE_MONITORING: process.env.ENABLE_PERFORMANCE_MONITORING !== 'false',
    LOG_LEVEL: (process.env.LOG_LEVEL as any) || 'INFO',
    
    // Security
    ENABLE_RATE_LIMITING: process.env.ENABLE_RATE_LIMITING === 'true',
    MAX_REQUESTS_PER_MINUTE: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '100'),
    
    // AWS
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    ENABLE_CLOUDWATCH_LOGGING: process.env.ENABLE_CLOUDWATCH_LOGGING === 'true',
  };
  
  // Validate configuration
  validateConfiguration(config);
  
  // Log configuration (without sensitive data)
  logConfiguration(config);
  
  return config;
}

/**
 * Get required environment variable with validation
 */
function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Required environment variable ${key} is not set. Please check your .env file.`
    );
  }
  return value.trim();
}

/**
 * Validate configuration values
 */
function validateConfiguration(config: EnvironmentConfig): void {
  const errors: string[] = [];
  
  // Validate wallet private key format (only when MPC is disabled)
  if (process.env.MPC_ENABLED !== 'true') {
    if (!config.WALLET_PRIVATE_KEY ||
        config.WALLET_PRIVATE_KEY === 'your_base58_private_key_here' ||
        config.WALLET_PRIVATE_KEY === 'your_wallet_private_key_here') {
      errors.push('WALLET_PRIVATE_KEY must be set to your actual private key (not the placeholder)');
    }
  }
  
  // Validate token address
  if (config.TOKEN_ADDRESS.length !== 44) {
    console.error('TOKEN_ADDRESS might not be a valid Solana address (expected 44 characters)');
  }
  
  // Validate RPC endpoint
  if (!config.RPC_ENDPOINT.startsWith('http')) {
    errors.push('RPC_ENDPOINT must be a valid HTTP/HTTPS URL');
  }
  
  // Validate trading amounts
  if (config.BUY_AMOUNT_SOL <= 0) {
    errors.push('BUY_AMOUNT_SOL must be greater than 0');
  }
  
  if (config.SLIPPAGE_BPS < 0 || config.SLIPPAGE_BPS > 10000) {
    errors.push('SLIPPAGE_BPS must be between 0 and 10000 (0-100%)');
  }
  
  if (config.MAX_SLIPPAGE_BPS < config.SLIPPAGE_BPS) {
    errors.push('MAX_SLIPPAGE_BPS must be greater than or equal to SLIPPAGE_BPS');
  }
  
  // Production-specific validations
  if (config.NODE_ENV === 'production') {
    if (config.RPC_ENDPOINT.includes('devnet')) {
      errors.push('Production environment should not use devnet RPC endpoint');
    }
    
    if (!config.ENABLE_RATE_LIMITING) {
      console.error('Rate limiting is disabled in production. Consider enabling for security.');
    }
    
    if (config.BUY_AMOUNT_SOL > 1) {
      console.error('BUY_AMOUNT_SOL is quite large for production. Please verify this is intentional.');
    }
  }
  
  // Development-specific recommendations
  if (config.NODE_ENV === 'development') {
    if (!config.RPC_ENDPOINT.includes('devnet')) {
      console.error('Development environment is using mainnet. Consider using devnet for safety.');
    }
  }
  
  // Throw errors if validation failed
  if (errors.length > 0) {
    throw new Error(
      `Configuration validation failed:\n${errors.map(e => `  â€¢ ${e}`).join('\n')}`
    );
  }
}

/**
 * Log configuration (without sensitive data)
 */
function logConfiguration(config: EnvironmentConfig): void {
  const safeConfig = {
    NODE_ENV: config.NODE_ENV,
    RPC_ENDPOINT: maskSensitiveUrl(config.RPC_ENDPOINT),
    TOKEN_ADDRESS: config.TOKEN_ADDRESS,
    BUY_AMOUNT_SOL: config.BUY_AMOUNT_SOL,
    SLIPPAGE_BPS: config.SLIPPAGE_BPS,
    PORT: config.PORT,
    ENABLE_PERFORMANCE_MONITORING: config.ENABLE_PERFORMANCE_MONITORING,
    LOG_LEVEL: config.LOG_LEVEL,
    ENABLE_RATE_LIMITING: config.ENABLE_RATE_LIMITING,
    WALLET_INITIALIZED: config.WALLET_PRIVATE_KEY ? 'Yes' : (process.env.MPC_ENABLED === 'true' ? 'MPC Mode' : 'No'),
  };
  
  console.error('Configuration loaded:');
  console.error(safeConfig);
  
  // Environment-specific notices
  if (config.NODE_ENV === 'production') {
    console.error('PRODUCTION MODE: Trading with real money on mainnet!');
  } else if (config.NODE_ENV === 'development') {
    console.error('DEVELOPMENT MODE: Safe testing environment');
  }
}

/**
 * Mask sensitive parts of URLs (API keys, etc.)
 */
function maskSensitiveUrl(url: string): string {
  return url.replace(/(api-key=|v2\/)([a-zA-Z0-9]+)/g, '$1***masked***');
}

/**
 * Get network type from RPC endpoint
 */
export function getNetworkType(rpcEndpoint: string): 'mainnet' | 'devnet' | 'testnet' | 'localnet' {
  if (rpcEndpoint.includes('devnet')) return 'devnet';
  if (rpcEndpoint.includes('testnet')) return 'testnet';
  if (rpcEndpoint.includes('localhost') || rpcEndpoint.includes('127.0.0.1')) return 'localnet';
  return 'mainnet';
}

/**
 * Check if environment is safe for testing
 */
export function isSafeEnvironment(config: EnvironmentConfig): boolean {
  return config.NODE_ENV !== 'production' || getNetworkType(config.RPC_ENDPOINT) === 'devnet';
}

// Global configuration instance
// Global configuration instance - lazy load in MCP mode
let _cachedConfig: EnvironmentConfig | null = null;

export function getEnvConfig(): EnvironmentConfig {
  if (!_cachedConfig) {
    _cachedConfig = loadEnvironmentConfig();
  }
  return _cachedConfig;
}

export const ENV_CONFIG = process.env.MCP_MODE === 'true' 
  ? null as any as EnvironmentConfig
  : loadEnvironmentConfig();