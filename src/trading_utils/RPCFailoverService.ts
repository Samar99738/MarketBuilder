/**
 * RPC Failover Service
 *
 * Production-ready RPC endpoint management with automatic failover, health checking,
 * and performance optimization for Solana mainnet operations.
 */

import { Connection } from '@solana/web3.js';
import { TRADING_CONFIG } from './config';
import { getNetworkType } from '../config/environment';

interface RPCEndpoint {
  url: string;
  priority: 'premium' | 'secondary' | 'fallback';
  latency?: number;
  errorCount: number;
  lastError?: Date;
  lastSuccess?: Date;
  isHealthy: boolean;
}

interface RPCHealthCheck {
  endpoint: string;
  latency: number;
  blockHeight: number;
  timestamp: number;
  error?: string;
}

/**
 * RPC Failover Service for production deployment
 */
export class RPCFailoverService {
  private endpoints: Map<string, RPCEndpoint> = new Map();
  private currentEndpoint: string | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private connectionPool: Map<string, Connection> = new Map();
  private isInitialized = false;

  constructor() {
    this.initializeEndpoints();
  }

  /**
   * Initialize RPC endpoints from configuration
   */
  private initializeEndpoints(): void {
    const { RPC_ENDPOINTS } = TRADING_CONFIG;

    // Add premium endpoints
    RPC_ENDPOINTS.premium.forEach((url, index) => {
      if (url) {
        this.endpoints.set(url, {
          url,
          priority: 'premium',
          errorCount: 0,
          isHealthy: true,
        });
      }
    });

    // Add secondary endpoints
    RPC_ENDPOINTS.secondary.forEach((url, index) => {
      this.endpoints.set(url, {
        url,
        priority: 'secondary',
        errorCount: 0,
        isHealthy: true,
      });
    });

    // Add fallback endpoints
    RPC_ENDPOINTS.fallback.forEach((url, index) => {
      this.endpoints.set(url, {
        url,
        priority: 'fallback',
        errorCount: 0,
        isHealthy: true,
      });
    });

  // RPC Failover Service initialized
    this.isInitialized = true;
  }

  /**
   * Get the best available RPC endpoint
   */
  async getBestEndpoint(): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('RPC Failover Service not initialized');
    }

    // If we have a current working endpoint, test it first
    if (this.currentEndpoint && this.endpoints.get(this.currentEndpoint)?.isHealthy) {
      const healthCheck = await this.checkEndpointHealth(this.currentEndpoint);
      if (healthCheck && healthCheck.latency < TRADING_CONFIG.NETWORK_CONFIG.RPC_MAX_LATENCY) {
        return this.currentEndpoint;
      }
    }

    // Find the best available endpoint
    const availableEndpoints = Array.from(this.endpoints.values()).filter(endpoint => endpoint.isHealthy).sort((a, b) => {
        // Sort by priority first, then by error count and latency
        const priorityOrder = { premium: 0, secondary: 1, fallback: 2 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];

        if (priorityDiff !== 0) return priorityDiff;

        // If same priority, prefer lower error count
        if (a.errorCount !== b.errorCount) {
          return a.errorCount - b.errorCount;
        }

        // Finally, prefer lower latency
        return (a.latency || 9999) - (b.latency || 9999);
      });

    if (availableEndpoints.length === 0) {
      throw new Error('No healthy RPC endpoints available');
    }

    const bestEndpoint = availableEndpoints[0];
    this.currentEndpoint = bestEndpoint.url;

  // Selected RPC endpoint
    return bestEndpoint.url;
  }

  /**
   * Get a connection to the specified endpoint
   */
  getConnection(endpointUrl?: string): Connection {
    const url = endpointUrl || TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
    if (!this.connectionPool.has(url)) {
      const connection = new Connection(url, {
        commitment: TRADING_CONFIG.NETWORK_CONFIG.COMMITMENT,
        confirmTransactionInitialTimeout: TRADING_CONFIG.NETWORK_CONFIG.TRANSACTION_TIMEOUT,
      });
      this.connectionPool.set(url, connection);
    }

    return this.connectionPool.get(url)!;
  }

  /**
   * Check health of a specific endpoint
   */
  async checkEndpointHealth(endpointUrl: string): Promise<RPCHealthCheck | null> {
    const startTime = Date.now();

    try {
      const connection = this.getConnection(endpointUrl);
      const blockHeight = await connection.getBlockHeight();
      const latency = Date.now() - startTime;

      // Update endpoint metrics
      const endpoint = this.endpoints.get(endpointUrl);
      if (endpoint) {
        endpoint.latency = latency;
        endpoint.lastSuccess = new Date();
        endpoint.errorCount = 0; // Reset error count on success
        endpoint.isHealthy = true;
      }

      return {
        endpoint: endpointUrl,
        latency,
        blockHeight,
        timestamp: Date.now(),
      };

    } catch (error) {
      // Update error metrics
      const endpoint = this.endpoints.get(endpointUrl);
      if (endpoint) {
        endpoint.errorCount++;
        endpoint.lastError = new Date();
        endpoint.isHealthy = false;

        // Mark as unhealthy if too many consecutive errors
        if (endpoint.errorCount >= TRADING_CONFIG.NETWORK_CONFIG.RPC_FAILOVER_THRESHOLD) {
          // RPC endpoint marked as unhealthy after errors
        }
      }

      return {
        endpoint: endpointUrl,
        latency: Date.now() - startTime,
        blockHeight: 0,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Start automatic health checking
   */
  startHealthChecking(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, TRADING_CONFIG.NETWORK_CONFIG.RPC_HEALTH_CHECK_INTERVAL);

  // RPC health checking started
  }

  /**
   * Stop health checking
   */
  stopHealthChecking(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
  // RPC health checking stopped
    }
  }

  /**
   * Perform health checks on all endpoints
   */
  private async performHealthChecks(): Promise<void> {
    const healthChecks = await Promise.allSettled(
      Array.from(this.endpoints.keys()).map(url => this.checkEndpointHealth(url))
    );

    // Log health summary
    const successful = healthChecks.filter(result => result.status === 'fulfilled').length;
    const failed = healthChecks.length - successful;

    // RPC Health Check summary

    // Attempt to recover failed endpoints
    if (TRADING_CONFIG.NETWORK_CONFIG.RPC_FAILOVER_ENABLED) {
      await this.attemptEndpointRecovery();
    }
  }

  /**
   * Attempt to recover failed endpoints
   */
  private async attemptEndpointRecovery(): Promise<void> {
    const failedEndpoints = Array.from(this.endpoints.values()).filter(endpoint => !endpoint.isHealthy).slice(0, TRADING_CONFIG.NETWORK_CONFIG.RPC_RECOVERY_ATTEMPTS);

    for (const endpoint of failedEndpoints) {
      try {
        const healthCheck = await this.checkEndpointHealth(endpoint.url);
        if (healthCheck && !healthCheck.error) {
          // RPC endpoint recovered
        }
      } catch (error) {
        // Endpoint still failing, continue to next
      }
    }
  }

  /**
   * Get current RPC status and metrics
   */
  getStatus(): {
    currentEndpoint: string | null;
    totalEndpoints: number;
    healthyEndpoints: number;
    endpointDetails: Array<{
      url: string;
      priority: string;
      latency?: number;
      errorCount: number;
      isHealthy: boolean;
      lastSuccess?: Date;
      lastError?: Date;
    }>;
  } {
    return {
      currentEndpoint: this.currentEndpoint,
      totalEndpoints: this.endpoints.size,
      healthyEndpoints: Array.from(this.endpoints.values()).filter(e => e.isHealthy).length,
      endpointDetails: Array.from(this.endpoints.entries()).map(([url, endpoint]) => ({
        url,
        priority: endpoint.priority,
        latency: endpoint.latency,
        errorCount: endpoint.errorCount,
        isHealthy: endpoint.isHealthy,
        lastSuccess: endpoint.lastSuccess,
        lastError: endpoint.lastError,
      })),
    };
  }

  /**
   * Force switch to a specific endpoint (for manual override)
   */
  async switchToEndpoint(endpointUrl: string): Promise<boolean> {
    const endpoint = this.endpoints.get(endpointUrl);
    if (!endpoint) {
      throw new Error(`Endpoint not found: ${endpointUrl}`);
    }

    // Test the endpoint first
    const healthCheck = await this.checkEndpointHealth(endpointUrl);
    if (!healthCheck || healthCheck.error) {
      throw new Error(`Endpoint not healthy: ${endpointUrl}`);
    }

    this.currentEndpoint = endpointUrl;
  // Manually switched to RPC endpoint
    return true;
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.stopHealthChecking();
    this.connectionPool.clear();
    this.endpoints.clear();
    this.currentEndpoint = null;
    this.isInitialized = false;
  // RPC Failover Service disposed
  }
}

// Export singleton instance
export const rpcFailoverService = new RPCFailoverService();
