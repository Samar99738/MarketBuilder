/**
 * Trading Configuration
 * 
 * Centralized configuration for trading operations with mainnet optimization.
 * Handles RPC endpoints, fees, compute units, and performance settings.
 * NOW INCLUDES: Pump.fun integration and unified trading configuration
 */

import { ENV_CONFIG, getNetworkType, getEnvConfig } from "../config/environment";
import { secretsManager, isSecretsManagerEnabled } from "../security/SecretsManager";

// Helper to safely get ENV_CONFIG (supports lazy loading in MCP mode)
const getConfig = () => process.env.MCP_MODE === 'true' ? getEnvConfig() : ENV_CONFIG;

// ============================================================================
// RPC ENDPOINT CONFIGURATION
// ============================================================================

/** RPC endpoint configuration with premium, fallback, and devnet options */
const RPC_ENDPOINTS = {
  /** Premium paid RPC providers for optimal mainnet performance */
  premium: [
    process.env.HELIUS_RPC_URL,
    process.env.QUICKNODE_RPC_URL,
    process.env.ALCHEMY_RPC_URL,
    process.env.TRITON_RPC_URL,
    process.env.GENESYS_GO_RPC_URL,
    process.env.SHADOW_RPC_URL,
  ].filter(Boolean),

  /** High-quality free RPCs (secondary fallback) */
  secondary: [
    "https://api.mainnet-beta.solana.com",
    "https://solana-api.projectserum.com",
  ],

  /** Free public RPCs (last resort fallback - higher latency and rate limits) */
  fallback: [
    "https://rpc.ankr.com/solana",
    "https://solana.publicnode.com",
    "https://nd-266-987-741.p2pify.com/8e5e8b6e4f6b6e4f6b6e4f6b6e4f",
  ],

  /** Devnet endpoints for testing */
  devnet: [
    "https://api.devnet.solana.com",
    "https://devnet.helius-rpc.com/?api-key=" + (process.env.HELIUS_API_KEY || ""),
  ].filter(endpoint => endpoint && !endpoint.endsWith("undefined")),

  /** Localnet for development */
  localnet: [
    "http://localhost:8899",
    "http://127.0.0.1:8899",
  ]
};

// ============================================================================
// PRIORITY FEE CONFIGURATION
// ============================================================================

/** Dynamic priority fee settings for transaction speed optimization */
const PRIORITY_FEE_CONFIG = {
  LOW: 1000,     // Slow but economical
  MEDIUM: 5000,  // Balanced speed/cost
  HIGH: 15000,   // Fast execution
  URGENT: 50000, // Maximum speed for time-critical trades
  
  ENABLE_DYNAMIC_FEES: process.env.ENABLE_DYNAMIC_FEES !== 'false',
  ESCALATION_MULTIPLIER: 1.5,    // Increase fee by 50% on retry
  MAX_ESCALATION_ATTEMPTS: 3,    // Max retry attempts
};

// ============================================================================
// COMPUTE UNIT CONFIGURATION
// ============================================================================

/** Compute unit limits for different transaction complexities */
const COMPUTE_UNIT_CONFIG = {
  SIMPLE_SWAP: 200000,
  COMPLEX_SWAP: 400000,
  MULTI_HOP_SWAP: 800000,
  
  ENABLE_DYNAMIC_CU: process.env.ENABLE_DYNAMIC_CU !== 'false',
  SAFETY_MARGIN: 0.2,  // Add 20% buffer to estimated compute units
};

// ============================================================================
// MPC CONFIGURATION
// ============================================================================

/** MPC provider type */
const MPC_PROVIDER = process.env.MPC_PROVIDER || 'mock';

/** Check if MPC should be enabled */
const MPC_ENABLED = (() => {
  // Only enable MPC if it's explicitly enabled AND properly configured AND provider is implemented
  if (process.env.MPC_ENABLED !== 'true') return false;

  // Check if MPC has proper configuration
  const hasConfig = process.env.MPC_WALLET_ID || process.env.MPC_API_KEY;
  if (!hasConfig) return false;

  // Check if provider is implemented
  const implementedProviders = ['mock', 'fireblocks'];
  return implementedProviders.includes(MPC_PROVIDER);
})();

/** MPC (Multi-Party Computation) wallet configuration */
const MPC_CONFIG = {
  /** MPC provider type */
  PROVIDER: MPC_PROVIDER,

  /** Enable MPC wallet instead of single key */
  ENABLED: MPC_ENABLED,

  /** MPC wallet configuration */
  WALLET: {
    /** MPC wallet ID or address */
    WALLET_ID: process.env.MPC_WALLET_ID,

    /** MPC API credentials */
    API_KEY: process.env.MPC_API_KEY,
    API_SECRET: process.env.MPC_API_SECRET,
    API_URL: process.env.MPC_API_URL,

    /** Threshold signature requirements */
    SIGNATURE_THRESHOLD: parseInt(process.env.MPC_SIGNATURE_THRESHOLD || "2"),
    TOTAL_PARTIES: parseInt(process.env.MPC_TOTAL_PARTIES || "3"),
  },

  /** MPC transaction policies */
  TRANSACTION_POLICIES: {
    /** Require MPC approval for transactions above this amount (in SOL) */
    REQUIRE_APPROVAL_ABOVE_SOL: parseFloat(process.env.MPC_APPROVAL_THRESHOLD_SOL || "1.0"),

    /** Transaction types that require MPC approval */
    REQUIRE_APPROVAL_FOR: ['buy', 'sell', 'transfer'],

    /** Auto-approve small transactions below threshold */
    AUTO_APPROVE_BELOW_SOL: parseFloat(process.env.MPC_AUTO_APPROVE_SOL || "0.1"),
  }
};

// ============================================================================
// PUMP.FUN CONFIGURATION (NEW)
// ============================================================================

/**
 * Pump.fun specific trading configuration
 */
export const PUMPFUN_CONFIG = {
  /** Enable pump.fun trading */
  ENABLED: process.env.PUMPFUN_ENABLED !== 'false', // Enabled by default
  
  /** Default slippage for pump.fun trades (in percentage, e.g., 10 = 10%) */
  DEFAULT_SLIPPAGE: parseInt(process.env.PUMPFUN_SLIPPAGE || '10'),
  
  /** Maximum slippage allowed for pump.fun trades */
  MAX_SLIPPAGE: parseInt(process.env.PUMPFUN_MAX_SLIPPAGE || '25'),
  
  /** Default priority fee for pump.fun trades (in SOL) */
  DEFAULT_PRIORITY_FEE: parseFloat(process.env.PUMPFUN_PRIORITY_FEE || '0.00001'),
  
  /** Maximum SOL amount per pump.fun trade (safety limit) */
  MAX_TRADE_AMOUNT: parseFloat(process.env.PUMPFUN_MAX_TRADE_AMOUNT || '1.0'),
  
  /** Minimum SOL amount per pump.fun trade */
  MIN_TRADE_AMOUNT: parseFloat(process.env.PUMPFUN_MIN_TRADE_AMOUNT || '0.001'),
  
  /** Use PumpPortal API (free) or Lightning API (paid) */
  USE_LIGHTNING_API: process.env.PUMPFUN_USE_LIGHTNING === 'true',
  
  /** API key for Lightning API (if using paid service) */
  LIGHTNING_API_KEY: process.env.PUMPFUN_API_KEY || '',
  
  /** Cache token routing decisions (in milliseconds) */
  ROUTING_CACHE_TTL: parseInt(process.env.PUMPFUN_CACHE_TTL || '300000'), // 5 minutes
  
  /** Auto-validate tokens before trading */
  AUTO_VALIDATE: process.env.PUMPFUN_AUTO_VALIDATE !== 'false',
  
  /** Allow trading of graduated tokens via Jupiter */
  ALLOW_GRADUATED_TOKENS: process.env.PUMPFUN_ALLOW_GRADUATED !== 'false',
  
  /** PumpPortal API endpoints */
  API_ENDPOINTS: {
    TRADE_LOCAL: 'https://pumpportal.fun/api/trade-local',
    TRADE_LIGHTNING: 'https://pumpportal.fun/api/trade',
    FRONTEND_API: 'https://frontend-api.pump.fun',
  },
  
  /** Pump.fun program ID on Solana */
  PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
};

// ============================================================================
// TOKEN ROUTING CONFIGURATION (NEW)
// ============================================================================

/**
 * Token routing configuration
 */
export const ROUTING_CONFIG = {
  /** Enable automatic token routing */
  ENABLED: process.env.TOKEN_ROUTING_ENABLED !== 'false',
  
  /** Prefer pump.fun API over direct on-chain calls */
  PREFER_API: process.env.TOKEN_ROUTING_PREFER_API !== 'false',
  
  /** Cache size (number of tokens to cache) */
  CACHE_SIZE: parseInt(process.env.TOKEN_ROUTING_CACHE_SIZE || '100'),
  
  /** Cache TTL in milliseconds */
  CACHE_TTL: parseInt(process.env.TOKEN_ROUTING_CACHE_TTL || '300000'), // 5 minutes
  
  /** Log routing decisions */
  LOG_ROUTING: process.env.TOKEN_ROUTING_LOG !== 'false',
  
  /** Retry failed route detections */
  RETRY_ON_FAILURE: process.env.TOKEN_ROUTING_RETRY !== 'false',
  
  /** Max retries for route detection */
  MAX_RETRIES: parseInt(process.env.TOKEN_ROUTING_MAX_RETRIES || '2'),
};

// ============================================================================
// RISK MANAGEMENT CONFIGURATION (NEW)
// ============================================================================

/**
 * Risk management configuration for pump.fun trading
 */
export const RISK_CONFIG = {
  /** Maximum total SOL exposure to pump.fun tokens */
  MAX_PUMPFUN_EXPOSURE: parseFloat(process.env.MAX_PUMPFUN_EXPOSURE || '5.0'),
  
  /** Require manual approval for trades above this amount */
  MANUAL_APPROVAL_THRESHOLD: parseFloat(process.env.MANUAL_APPROVAL_THRESHOLD || '0.5'),
  
  /** Enable paper trading mode for pump.fun tokens */
  PAPER_TRADING_PUMPFUN: process.env.PAPER_TRADING_PUMPFUN === 'true',
  
  /** Maximum number of concurrent pump.fun positions */
  MAX_POSITIONS: parseInt(process.env.MAX_PUMPFUN_POSITIONS || '10'),
  
  /** Enable stop-loss for pump.fun trades */
  ENABLE_STOP_LOSS: process.env.PUMPFUN_ENABLE_STOP_LOSS !== 'false',
  
  /** Default stop-loss percentage (e.g., 20 = 20% loss) */
  STOP_LOSS_PERCENTAGE: parseFloat(process.env.PUMPFUN_STOP_LOSS || '20'),
  
  /** Enable take-profit for pump.fun trades */
  ENABLE_TAKE_PROFIT: process.env.PUMPFUN_ENABLE_TAKE_PROFIT !== 'false',
  
  /** Default take-profit percentage (e.g., 50 = 50% gain) */
  TAKE_PROFIT_PERCENTAGE: parseFloat(process.env.PUMPFUN_TAKE_PROFIT || '50'),
  
  /** Warn on suspicious tokens */
  ENABLE_SCAM_DETECTION: process.env.PUMPFUN_SCAM_DETECTION !== 'false',
  
  /** Max age for pump.fun tokens (in hours, 0 = no limit) */
  MAX_TOKEN_AGE_HOURS: parseInt(process.env.PUMPFUN_MAX_TOKEN_AGE || '0'),
};

// ============================================================================
// MAIN TRADING CONFIGURATION
// ============================================================================

/**
 * Complete trading configuration object
 * Combines all settings from environment and hardcoded defaults
 */
export const TRADING_CONFIG = {
  
  // --------------------------------------------------------------------------
  // Wallet Configuration
  // --------------------------------------------------------------------------

  /** Wallet private key - supports both comma-separated array and base58 formats (legacy single-key mode) */
  WALLET_PRIVATE_KEY: MPC_ENABLED ? null : (() => {
    // In production with Secrets Manager enabled, this will be loaded asynchronously
    // Use getWalletPrivateKey() function for actual key retrieval
    if (isSecretsManagerEnabled()) {
      return null; // Will be loaded via secretsManager.getWalletPrivateKey()
    }
    
    const key = getConfig().WALLET_PRIVATE_KEY;
    if (!key) return "";

    // Convert comma-separated array to Uint8Array
    if (key.includes(",")) {
      try {
        const keyArray = key.split(",").map((num) => parseInt(num.trim()));
        return new Uint8Array(keyArray);
      } catch (error) {
        console.error("Error parsing comma-separated private key:", error);
        return "";
      }
    }

    // Assume base58 format
    return key;
  })(),

  /** MPC wallet configuration */
  MPC_CONFIG,

  // --------------------------------------------------------------------------
  // RPC Configuration  
  // --------------------------------------------------------------------------
  
  /** Primary RPC endpoint with intelligent selection and failover support */
  RPC_ENDPOINT: (() => {
    const networkType = getNetworkType(getConfig().RPC_ENDPOINT);

    // For mainnet, prioritize premium providers
    if (networkType === 'mainnet') {
      if (RPC_ENDPOINTS.premium.length > 0) {
        console.log(`Using premium RPC endpoint for optimal mainnet performance: ${RPC_ENDPOINTS.premium[0]}`);
        return RPC_ENDPOINTS.premium[0];
      } else if (RPC_ENDPOINTS.secondary.length > 0) {
        console.log(`Using secondary RPC endpoint for mainnet: ${RPC_ENDPOINTS.secondary[0]}`);
        return RPC_ENDPOINTS.secondary[0];
      } else {
        console.warn("No premium or secondary RPC endpoints configured for mainnet. Using fallback.");
        return RPC_ENDPOINTS.fallback[0] || getConfig().RPC_ENDPOINT;
      }
    }

    // For devnet, prefer configured devnet endpoints
    if (networkType === 'devnet' && RPC_ENDPOINTS.devnet.length > 0) {
      console.log(`Using devnet RPC endpoint: ${RPC_ENDPOINTS.devnet[0]}`);
      return RPC_ENDPOINTS.devnet[0];
    }

    // For localnet, use local endpoints if available
    if (networkType === 'localnet' && RPC_ENDPOINTS.localnet.length > 0) {
      console.log(`Using localnet RPC endpoint: ${RPC_ENDPOINTS.localnet[0]}`);
      return RPC_ENDPOINTS.localnet[0];
    }

    // Fallback to environment configuration
    return getConfig().RPC_ENDPOINT;
  })(),
  
  /** All RPC endpoints for failover support */
  RPC_ENDPOINTS,

  // --------------------------------------------------------------------------
  // Trading Parameters
  // --------------------------------------------------------------------------
  
  TOKEN_ADDRESS: getConfig().TOKEN_ADDRESS,
  BUY_AMOUNT_SOL: getConfig().BUY_AMOUNT_SOL,
  MIN_SELL_AMOUNT: getConfig().MIN_SELL_AMOUNT,
  SLIPPAGE_BPS: getConfig().SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS: getConfig().MAX_SLIPPAGE_BPS,
  
  // --------------------------------------------------------------------------
  // Transaction Optimization
  // --------------------------------------------------------------------------
  
  DYNAMIC_COMPUTE_UNIT_LIMIT: process.env.DYNAMIC_COMPUTE_UNIT_LIMIT !== 'false',
  PRIORITY_FEE_LAMPORTS: parseInt(process.env.PRIORITY_FEE_LAMPORTS || "5000"),
  
  PRIORITY_FEE_CONFIG,
  COMPUTE_UNIT_CONFIG,
  
  // --------------------------------------------------------------------------
  // Network Configuration
  // --------------------------------------------------------------------------
  
  NETWORK_CONFIG: {
    CONNECTION_TIMEOUT: 30000,     // 30 seconds
    TRANSACTION_TIMEOUT: 120000,   // 2 minutes for complex swaps

    // Enhanced retry and failover configuration
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,             // 2 seconds between retries
    RETRY_BACKOFF_MULTIPLIER: 1.5, // Exponential backoff for retries

    // RPC failover configuration
    RPC_FAILOVER_ENABLED: process.env.RPC_FAILOVER_ENABLED !== 'false',
    RPC_HEALTH_CHECK_INTERVAL: parseInt(process.env.RPC_HEALTH_CHECK_INTERVAL || '60000'), // 1 minute
    RPC_MAX_LATENCY: parseInt(process.env.RPC_MAX_LATENCY || '2000'),    // 2 seconds
    RPC_FAILOVER_THRESHOLD: parseInt(process.env.RPC_FAILOVER_THRESHOLD || '3'), // Switch after 3 failures
    RPC_RECOVERY_ATTEMPTS: parseInt(process.env.RPC_RECOVERY_ATTEMPTS || '5'),   // Try to recover 5 times

    COMMITMENT: 'confirmed' as const,
    PREFLIGHT_COMMITMENT: 'processed' as const,

    // Connection pooling for better performance
    CONNECTION_POOL_SIZE: parseInt(process.env.RPC_CONNECTION_POOL_SIZE || '5'),
    KEEP_ALIVE: process.env.RPC_KEEP_ALIVE === 'true',

    // Rate limiting and throttling
    RATE_LIMIT_ENABLED: process.env.RPC_RATE_LIMIT_ENABLED !== 'false',
    RATE_LIMIT_PER_SECOND: parseInt(process.env.RPC_RATE_LIMIT_PER_SECOND || '10'),

    // Advanced features
    ENABLE_GRPC: process.env.ENABLE_GRPC === 'true',
    ENABLE_WEBSOCKET: process.env.ENABLE_WEBSOCKET !== 'false',
  },
  
  // --------------------------------------------------------------------------
  // Market Making Configuration
  // --------------------------------------------------------------------------
  
  MARKET_MAKING: {
    PRICE_UPDATE_INTERVAL: 3000,  // 3 seconds for active trading
    PRICE_CACHE_TTL: 5000,        // 5 seconds cache

    BATCH_TRANSACTIONS: process.env.BATCH_TRANSACTIONS === 'true',
    PARALLEL_EXECUTION: process.env.PARALLEL_EXECUTION !== 'false',

    MAX_POSITION_SIZE_SOL: parseFloat(process.env.MAX_POSITION_SIZE_SOL || "10"),
    STOP_LOSS_PERCENTAGE: parseFloat(process.env.STOP_LOSS_PERCENTAGE || "5"),
  },

  // --------------------------------------------------------------------------
  // Pump.fun Integration (NEW)
  // --------------------------------------------------------------------------
  
  /** Pump.fun specific configuration */
  PUMPFUN_CONFIG,
  
  /** Token routing configuration */
  ROUTING_CONFIG,
  
  /** Risk management for pump.fun */
  RISK_CONFIG,
  
} as const;

/**
 * MPC configuration export for direct access
 */
export { MPC_CONFIG, MPC_ENABLED };

/**
 * Get wallet private key securely (from Secrets Manager or environment)
 * This is the RECOMMENDED way to get the private key
 */
export async function getWalletPrivateKey(): Promise<string | Uint8Array> {
  if (MPC_ENABLED) {
    throw new Error('MPC is enabled, use MPCWallet instead of private key');
  }
  
  if (isSecretsManagerEnabled()) {
    return await secretsManager.getWalletPrivateKey();
  }
  
  const key = TRADING_CONFIG.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error('No wallet private key configured');
  }
  
  return key;
}

// ============================================================================
// CONFIGURATION VALIDATION (NEW)
// ============================================================================

/**
 * Validate pump.fun configuration
 */
export function validatePumpFunConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Validate slippage
  if (PUMPFUN_CONFIG.DEFAULT_SLIPPAGE < 1 || PUMPFUN_CONFIG.DEFAULT_SLIPPAGE > 50) {
    errors.push('PUMPFUN_SLIPPAGE must be between 1 and 50');
  }
  
  if (PUMPFUN_CONFIG.MAX_SLIPPAGE < PUMPFUN_CONFIG.DEFAULT_SLIPPAGE) {
    errors.push('PUMPFUN_MAX_SLIPPAGE must be greater than or equal to PUMPFUN_SLIPPAGE');
  }
  
  // Validate trade amounts
  if (PUMPFUN_CONFIG.MAX_TRADE_AMOUNT < PUMPFUN_CONFIG.MIN_TRADE_AMOUNT) {
    errors.push('PUMPFUN_MAX_TRADE_AMOUNT must be greater than PUMPFUN_MIN_TRADE_AMOUNT');
  }
  
  if (PUMPFUN_CONFIG.MIN_TRADE_AMOUNT < 0.001) {
    warnings.push('PUMPFUN_MIN_TRADE_AMOUNT is very low. Consider increasing for network fees.');
  }
  
  // Validate Lightning API
  if (PUMPFUN_CONFIG.USE_LIGHTNING_API && !PUMPFUN_CONFIG.LIGHTNING_API_KEY) {
    errors.push('PUMPFUN_API_KEY is required when using Lightning API');
  }
  
  // Production warnings
  if (process.env.NODE_ENV === 'production') {
    if (PUMPFUN_CONFIG.MAX_TRADE_AMOUNT > 2.0) {
      warnings.push('PUMPFUN_MAX_TRADE_AMOUNT is high for production. Consider lowering.');
    }
    
    if (!PUMPFUN_CONFIG.AUTO_VALIDATE) {
      warnings.push('Auto-validation is disabled. Trades may fail for invalid tokens.');
    }
    
    if (!PUMPFUN_CONFIG.ENABLED) {
      console.log('Pump.fun trading is disabled');
    }
  }
  
  // Display warnings
  if (warnings.length > 0) {
    console.warn('\nPump.fun Configuration Warnings:');
    warnings.forEach(warning => console.warn(`  ${warning}`));
  }
  
  // Throw errors if validation failed
  if (errors.length > 0) {
    throw new Error(
      `Pump.fun configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`
    );
  }
  
  // Success message
  if (PUMPFUN_CONFIG.ENABLED && errors.length === 0) {
    console.log('Pump.fun configuration validated successfully');
    console.log(`   - Default Slippage: ${PUMPFUN_CONFIG.DEFAULT_SLIPPAGE}%`);
    console.log(`   - Max Trade Amount: ${PUMPFUN_CONFIG.MAX_TRADE_AMOUNT} SOL`);
    console.log(`   - API Mode: ${PUMPFUN_CONFIG.USE_LIGHTNING_API ? 'Lightning (Paid)' : 'PumpPortal (Free)'}`);
    console.log(`   - Auto-Validate: ${PUMPFUN_CONFIG.AUTO_VALIDATE ? 'Enabled' : 'Disabled'}`);
  }
}

// Auto-validate configuration on import (only if pump.fun is enabled)
if (PUMPFUN_CONFIG.ENABLED) {
  try {
    validatePumpFunConfig();
  } catch (error) {
    console.error('Configuration validation failed:', error);
    // In production, you might want to exit here
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
  }
}