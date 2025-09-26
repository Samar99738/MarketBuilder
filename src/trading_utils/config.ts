import { ENV_CONFIG, getNetworkType } from "../config/environment";

// **MAINNET PERFORMANCE: Premium RPC Endpoints**
const RPC_ENDPOINTS = {
  // High-performance paid RPCs (users should configure these)
  premium: [
    process.env.HELIUS_RPC_URL, // https://rpc.helius.xyz/?api-key=YOUR_KEY
    process.env.QUICKNODE_RPC_URL, // https://YOUR_SUBDOMAIN.solana-mainnet.quiknode.pro/YOUR_TOKEN/
    process.env.ALCHEMY_RPC_URL, // https://solana-mainnet.g.alchemy.com/v2/YOUR_API_KEY
    process.env.TRITON_RPC_URL, // https://YOUR_SUBDOMAIN.rpc.mainnet.triton.one/
  ].filter(Boolean),
  
  // Free public RPCs (fallbacks)
  fallback: [
    "https://api.mainnet-beta.solana.com",
    "https://solana-api.projectserum.com",
    "https://rpc.ankr.com/solana",
  ],
  
  // Devnet for testing
  devnet: [
    "https://api.devnet.solana.com",
    "https://devnet.helius-rpc.com/?api-key=" + (process.env.HELIUS_API_KEY || ""),
  ].filter(endpoint => endpoint && !endpoint.endsWith("undefined"))
};

// **MAINNET PERFORMANCE: Dynamic Priority Fee Configuration**
const PRIORITY_FEE_CONFIG = {
  // Base fee levels (in lamports)
  LOW: 1000,     // Slow but cheap
  MEDIUM: 5000,  // Balanced speed/cost 
  HIGH: 15000,   // Fast execution
  URGENT: 50000, // Maximum speed for time-sensitive trades
  
  // Dynamic fee calculation
  ENABLE_DYNAMIC_FEES: process.env.ENABLE_DYNAMIC_FEES !== 'false',
  
  // Fee escalation for stuck transactions
  ESCALATION_MULTIPLIER: 1.5,
  MAX_ESCALATION_ATTEMPTS: 3,
};

// **MAINNET PERFORMANCE: Compute Unit Optimization**
const COMPUTE_UNIT_CONFIG = {
  // Base compute units for different transaction types
  SIMPLE_SWAP: 200000,
  COMPLEX_SWAP: 400000,
  MULTI_HOP_SWAP: 800000,
  
  // Dynamic compute unit calculation
  ENABLE_DYNAMIC_CU: process.env.ENABLE_DYNAMIC_CU !== 'false',
  
  // Safety margin (add 20% buffer)
  SAFETY_MARGIN: 0.2,
};

export const TRADING_CONFIG = {
  // **ENVIRONMENT-AWARE CONFIGURATION**
  // Uses centralized environment management with validation
  
  // Wallet configuration - handle both comma-separated and base58 formats
  WALLET_PRIVATE_KEY: (() => {
    const key = ENV_CONFIG.WALLET_PRIVATE_KEY;
    if (!key) return "";

    // If it contains commas, it's in array format - convert to Uint8Array
    if (key.includes(",")) {
      try {
        const keyArray = key.split(",").map((num) => parseInt(num.trim()));
        return new Uint8Array(keyArray);
      } catch (error) {
        console.error("Error parsing comma-separated private key:", error);
        return "";
      }
    }

    // Otherwise assume it's base58 format
    return key;
  })(),

  // **MAINNET PERFORMANCE: Intelligent RPC Selection**
  RPC_ENDPOINT: (() => {
    const networkType = getNetworkType(ENV_CONFIG.RPC_ENDPOINT);
    
    // Use premium RPCs if available
    if (networkType === 'mainnet' && RPC_ENDPOINTS.premium.length > 0) {
      console.log("Using premium RPC endpoint for optimal performance");
      return RPC_ENDPOINTS.premium[0]; // Use first premium RPC
    }
    
    // Use configured RPC endpoint
    return ENV_CONFIG.RPC_ENDPOINT;
  })(),
  
  // All RPC endpoints for failover
  RPC_ENDPOINTS,

  // **ENVIRONMENT-AWARE CONFIGURATION**
  TOKEN_ADDRESS: ENV_CONFIG.TOKEN_ADDRESS,
  BUY_AMOUNT_SOL: ENV_CONFIG.BUY_AMOUNT_SOL,
  MIN_SELL_AMOUNT: ENV_CONFIG.MIN_SELL_AMOUNT,
  SLIPPAGE_BPS: ENV_CONFIG.SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS: ENV_CONFIG.MAX_SLIPPAGE_BPS,
  
  // **MAINNET PERFORMANCE: Transaction Optimization**
  DYNAMIC_COMPUTE_UNIT_LIMIT: process.env.DYNAMIC_COMPUTE_UNIT_LIMIT !== 'false',
  PRIORITY_FEE_LAMPORTS: parseInt(process.env.PRIORITY_FEE_LAMPORTS || "5000"), // Higher default for mainnet
  
  // Performance configuration objects
  PRIORITY_FEE_CONFIG,
  COMPUTE_UNIT_CONFIG,
  
  // **MAINNET PERFORMANCE: Network Optimization**
  NETWORK_CONFIG: {
    // Connection timeouts
    CONNECTION_TIMEOUT: 30000, // 30 seconds
    TRANSACTION_TIMEOUT: 120000, // 2 minutes for complex swaps
    
    // Retry configuration
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000, // 2 seconds between retries
    
    // Confirmation strategy
    COMMITMENT: 'confirmed' as const, // Balance between speed and finality
    PREFLIGHT_COMMITMENT: 'processed' as const,
    
    // Health checking
    HEALTH_CHECK_INTERVAL: 60000, // Check RPC health every minute
    MAX_RPC_LATENCY: 2000, // Switch RPC if response > 2 seconds
  },
  
  // **MAINNET PERFORMANCE: Market Making Optimization**
  MARKET_MAKING: {
    // Price update frequency
    PRICE_UPDATE_INTERVAL: 3000, // 3 seconds for active trading
    PRICE_CACHE_TTL: 5000, // 5 seconds cache
    
    // Execution optimization
    BATCH_TRANSACTIONS: process.env.BATCH_TRANSACTIONS === 'true',
    PARALLEL_EXECUTION: process.env.PARALLEL_EXECUTION !== 'false',
    
    // Risk management
    MAX_POSITION_SIZE_SOL: parseFloat(process.env.MAX_POSITION_SIZE_SOL || "10"),
    STOP_LOSS_PERCENTAGE: parseFloat(process.env.STOP_LOSS_PERCENTAGE || "5"), // 5%
  },
} as const;
