/**
 * Optimized RPC Configuration for QuickNode Premium Endpoint
 * 
 * This configuration optimizes connection settings for production-grade
 * QuickNode RPC endpoints with enhanced reliability and performance.
 */

import { Connection, ConnectionConfig, Commitment } from '@solana/web3.js';

/**
 * RPC Configuration Options
 */
export interface RPCConfig {
  endpoint: string;
  wsEndpoint?: string;
  commitment: Commitment;
  confirmTransactionInitialTimeout?: number;
  disableRetryOnRateLimit?: boolean;
  httpHeaders?: Record<string, string>;
  wsOptions?: {
    maxPayload?: number;
  };
}

/**
 * Default RPC configuration optimized for QuickNode
 */
export const DEFAULT_RPC_CONFIG: RPCConfig = {
  endpoint: process.env.RPC_ENDPOINT || process.env.QUICKNODE_RPC_URL || 'https://api.mainnet-beta.solana.com',
  wsEndpoint: process.env.WS_ENDPOINT || process.env.QUICKNODE_WS_URL,
  commitment: 'confirmed' as Commitment,
  confirmTransactionInitialTimeout: 60000, // 60 seconds
  disableRetryOnRateLimit: false, // QuickNode has high rate limits
  httpHeaders: {
    'Content-Type': 'application/json',
  },
  wsOptions: {
    maxPayload: 10485760, // 10MB - QuickNode supports large payloads
  },
};

/**
 * Connection pool for reusing connections
 */
class ConnectionPool {
  private connections: Map<string, Connection> = new Map();
  private readonly maxConnections = 10;

  /**
   * Get or create a connection with specified config
   */
  getConnection(config: Partial<RPCConfig> = {}): Connection {
    const finalConfig = { ...DEFAULT_RPC_CONFIG, ...config };
    const key = `${finalConfig.endpoint}-${finalConfig.commitment}`;

    if (this.connections.has(key)) {
      return this.connections.get(key)!;
    }

    // Create new connection
    const connectionConfig: ConnectionConfig = {
      commitment: finalConfig.commitment,
      confirmTransactionInitialTimeout: finalConfig.confirmTransactionInitialTimeout,
      disableRetryOnRateLimit: finalConfig.disableRetryOnRateLimit,
      httpHeaders: finalConfig.httpHeaders,
      wsEndpoint: finalConfig.wsEndpoint,
    };

    const connection = new Connection(finalConfig.endpoint, connectionConfig);

    // Add to pool
    if (this.connections.size >= this.maxConnections) {
      // Remove oldest connection
      const firstKey = this.connections.keys().next().value;
      if (firstKey) {
        this.connections.delete(firstKey);
      }
    }

    this.connections.set(key, connection);
    console.log(`[RPC] Created new connection to ${finalConfig.endpoint} with commitment: ${finalConfig.commitment}`);

    return connection;
  }

  /**
   * Clear all connections
   */
  clear(): void {
    this.connections.clear();
    console.log('[RPC] Connection pool cleared');
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      activeConnections: this.connections.size,
      maxConnections: this.maxConnections,
      endpoints: Array.from(this.connections.keys()),
    };
  }
}

// Singleton instance
export const connectionPool = new ConnectionPool();

/**
 * Get the default optimized connection
 */
export function getOptimizedConnection(commitment: Commitment = 'confirmed'): Connection {
  return connectionPool.getConnection({ commitment });
}

/**
 * Get connection for specific use case
 */
export function getConnectionForUseCase(useCase: 'trading' | 'monitoring' | 'websocket'): Connection {
  switch (useCase) {
    case 'trading':
      // Fast confirmation for trades
      return connectionPool.getConnection({
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
      });
    
    case 'monitoring':
      // Reliable finality for monitoring
      return connectionPool.getConnection({
        commitment: 'finalized',
        confirmTransactionInitialTimeout: 90000,
      });
    
    case 'websocket':
      // Real-time updates
      return connectionPool.getConnection({
        commitment: 'confirmed',
        wsEndpoint: DEFAULT_RPC_CONFIG.wsEndpoint,
      });
    
    default:
      return getOptimizedConnection();
  }
}

/**
 * Health check for RPC endpoint
 */
export async function checkRPCHealth(connection?: Connection): Promise<{
  healthy: boolean;
  latency: number;
  slot: number;
  error?: string;
}> {
  const conn = connection || getOptimizedConnection();
  const startTime = Date.now();

  try {
    const slot = await conn.getSlot();
    const latency = Date.now() - startTime;

    return {
      healthy: true,
      latency,
      slot,
    };
  } catch (error) {
    return {
      healthy: false,
      latency: Date.now() - startTime,
      slot: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get RPC performance metrics
 */
export async function getRPCMetrics(): Promise<{
  endpoint: string;
  commitment: string;
  health: Awaited<ReturnType<typeof checkRPCHealth>>;
  poolStats: ReturnType<typeof connectionPool.getStats>;
}> {
  const connection = getOptimizedConnection();
  const health = await checkRPCHealth(connection);
  const poolStats = connectionPool.getStats();

  return {
    endpoint: DEFAULT_RPC_CONFIG.endpoint,
    commitment: DEFAULT_RPC_CONFIG.commitment,
    health,
    poolStats,
  };
}

/**
 * Log RPC configuration on startup
 */
export function logRPCConfiguration(): void {
  const isQuickNode = DEFAULT_RPC_CONFIG.endpoint.includes('quiknode.pro');
  const isMainnet = DEFAULT_RPC_CONFIG.endpoint.includes('mainnet');
  
  console.log('\n========================================');
  console.log('🔗 RPC CONFIGURATION');
  console.log('========================================');
  console.log(`Endpoint: ${DEFAULT_RPC_CONFIG.endpoint}`);
  console.log(`WebSocket: ${DEFAULT_RPC_CONFIG.wsEndpoint || 'Not configured'}`);
  console.log(`Network: ${isMainnet ? 'Mainnet' : 'Devnet/Other'}`);
  console.log(`Provider: ${isQuickNode ? 'QuickNode (Premium)' : 'Standard RPC'}`);
  console.log(`Commitment: ${DEFAULT_RPC_CONFIG.commitment}`);
  console.log(`Timeout: ${DEFAULT_RPC_CONFIG.confirmTransactionInitialTimeout}ms`);
  console.log(`Rate Limit Retry: ${!DEFAULT_RPC_CONFIG.disableRetryOnRateLimit}`);
  
  if (isQuickNode) {
    console.log('✅ QuickNode Premium endpoint detected');
    console.log('   - Enhanced rate limits');
    console.log('   - Lower latency');
    console.log('   - Priority support');
  }
  console.log('========================================\n');
}
