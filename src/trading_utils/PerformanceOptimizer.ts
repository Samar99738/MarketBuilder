import { Connection } from "@solana/web3.js";
import { TRADING_CONFIG } from "./config";

/**
  MAINNET PERFORMANCE OPTIMIZATION MODULE
  Provides dynamic fee calculation and network congestion detection
  for maximum trading performance on mainnet.
 */

/*
  DYNAMIC PRIORITY FEE CALCULATION
  Calculates optimal priority fees based on current network conditions
 */
export async function calculateOptimalPriorityFee(
  connection: Connection,
  urgency: 'low' | 'medium' | 'high' | 'urgent' = 'medium'
): Promise<number> {
  try {
    if (!TRADING_CONFIG.PRIORITY_FEE_CONFIG.ENABLE_DYNAMIC_FEES) {
      return TRADING_CONFIG.PRIORITY_FEE_LAMPORTS;
    }

    // Get recent prioritization fees
    const recentFees = await connection.getRecentPrioritizationFees();
    
    if (recentFees.length === 0) {
      return TRADING_CONFIG.PRIORITY_FEE_CONFIG[urgency.toUpperCase() as keyof typeof TRADING_CONFIG.PRIORITY_FEE_CONFIG] as number;
    }

    // Calculate percentiles
    const fees = recentFees.map(fee => fee.prioritizationFee).sort((a, b) => a - b);
    const percentiles = {
      low: fees[Math.floor(fees.length * 0.25)],     // 25th percentile
      medium: fees[Math.floor(fees.length * 0.50)],  // 50th percentile (median)
      high: fees[Math.floor(fees.length * 0.75)],    // 75th percentile
      urgent: fees[Math.floor(fees.length * 0.90)],  // 90th percentile
    };

    const baseFee = percentiles[urgency] || 0;
    const configFee = TRADING_CONFIG.PRIORITY_FEE_CONFIG[urgency.toUpperCase() as keyof typeof TRADING_CONFIG.PRIORITY_FEE_CONFIG] as number;
    
    // Use the higher of network-based fee or configured minimum
    const optimalFee = Math.max(baseFee, configFee);
    
    console.log(`Priority fee (${urgency}): ${optimalFee} lamports (network: ${baseFee}, config: ${configFee})`);
    
    return optimalFee;
    
  } catch (error) {
    console.warn('Failed to calculate dynamic priority fee:', (error as Error).message);
    return TRADING_CONFIG.PRIORITY_FEE_CONFIG[urgency.toUpperCase() as keyof typeof TRADING_CONFIG.PRIORITY_FEE_CONFIG] as number;
  }
}

/**
 * NETWORK CONGESTION DETECTION
 * 
 * Detects network congestion and suggests optimal trading strategies
 */
export async function detectNetworkCongestion(connection: Connection): Promise<{
  congestionLevel: 'low' | 'medium' | 'high' | 'extreme';
  suggestedPriorityFee: number;
  suggestedSlippage: number;
  recommendation: string;
}> {
  try {
    // Get recent performance samples
    const perfSamples = await connection.getRecentPerformanceSamples(20);
    
    if (perfSamples.length === 0) {
      return {
        congestionLevel: 'medium',
        suggestedPriorityFee: TRADING_CONFIG.PRIORITY_FEE_CONFIG.MEDIUM,
        suggestedSlippage: TRADING_CONFIG.SLIPPAGE_BPS,
        recommendation: 'Unable to assess network conditions. Using default settings.'
      };
    }

    // Calculate average transaction rate and slot duration
    const avgTxRate = perfSamples.reduce((sum, sample) => sum + sample.numTransactions, 0) / perfSamples.length;
    const avgSlotTime = perfSamples.reduce((sum, sample) => sum + (sample.samplePeriodSecs / sample.numSlots), 0) / perfSamples.length;

    // Determine congestion level
    let congestionLevel: 'low' | 'medium' | 'high' | 'extreme';
    let suggestedPriorityFee: number;
    let suggestedSlippage: number;
    let recommendation: string;

    if (avgTxRate < 2000 && avgSlotTime < 0.5) {
      congestionLevel = 'low';
      suggestedPriorityFee = TRADING_CONFIG.PRIORITY_FEE_CONFIG.LOW;
      suggestedSlippage = TRADING_CONFIG.SLIPPAGE_BPS;
      recommendation = 'Network is clear. Standard trading parameters recommended.';
    } else if (avgTxRate < 3500 && avgSlotTime < 0.7) {
      congestionLevel = 'medium';
      suggestedPriorityFee = TRADING_CONFIG.PRIORITY_FEE_CONFIG.MEDIUM;
      suggestedSlippage = Math.min(TRADING_CONFIG.SLIPPAGE_BPS * 1.5, TRADING_CONFIG.MAX_SLIPPAGE_BPS);
      recommendation = 'Moderate network activity. Consider slightly higher fees and slippage.';
    } else if (avgTxRate < 5000 && avgSlotTime < 1.0) {
      congestionLevel = 'high';
      suggestedPriorityFee = TRADING_CONFIG.PRIORITY_FEE_CONFIG.HIGH;
      suggestedSlippage = Math.min(TRADING_CONFIG.SLIPPAGE_BPS * 2, TRADING_CONFIG.MAX_SLIPPAGE_BPS);
      recommendation = 'High network congestion. Use elevated fees and slippage for reliable execution.';
    } else {
      congestionLevel = 'extreme';
      suggestedPriorityFee = TRADING_CONFIG.PRIORITY_FEE_CONFIG.URGENT;
      suggestedSlippage = TRADING_CONFIG.MAX_SLIPPAGE_BPS;
      recommendation = 'Extreme network congestion. Consider delaying non-urgent trades or using maximum fees.';
    }

    console.log(`Network status: ${congestionLevel} (${avgTxRate.toFixed(0)} tx/s, ${(avgSlotTime * 1000).toFixed(0)}ms slots)`);
    
    return {
      congestionLevel,
      suggestedPriorityFee,
      suggestedSlippage,
      recommendation
    };
    
  } catch (error) {
    console.warn('Failed to detect network congestion:', (error as Error).message);
    return {
      congestionLevel: 'medium',
      suggestedPriorityFee: TRADING_CONFIG.PRIORITY_FEE_CONFIG.MEDIUM,
      suggestedSlippage: TRADING_CONFIG.SLIPPAGE_BPS,
      recommendation: 'Network analysis unavailable. Using default settings.'
    };
  }
}

/**
 PERFORMANCE MONITORING
 Tracks and reports trading performance metrics
 */
export class PerformanceMonitor {
  private metrics = {
    transactionsSent: 0,
    transactionsConfirmed: 0,
    totalLatency: 0,
    averageLatency: 0,
    failureRate: 0,
    startTime: Date.now(),
  };
  
  recordTransactionSent() {
    this.metrics.transactionsSent++;
  }
  
  recordTransactionConfirmed(latencyMs: number) {
    this.metrics.transactionsConfirmed++;
    this.metrics.totalLatency += latencyMs;
    this.metrics.averageLatency = this.metrics.totalLatency / this.metrics.transactionsConfirmed;
    this.updateFailureRate();
  }
  
  recordTransactionFailed() {
    this.updateFailureRate();
  }
  
  private updateFailureRate() {
    const totalAttempts = this.metrics.transactionsSent;
    const failures = totalAttempts - this.metrics.transactionsConfirmed;
    this.metrics.failureRate = totalAttempts > 0 ? (failures / totalAttempts) * 100 : 0;
  }
  
  getMetrics() {
    const uptimeMs = Date.now() - this.metrics.startTime;
    return {
      ...this.metrics,
      uptimeMs,
      uptimeFormatted: this.formatDuration(uptimeMs),
    };
  }
  
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

// Global performance monitor
export const performanceMonitor = new PerformanceMonitor();