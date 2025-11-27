/**
 * ROI and PnL Calculation Debugger
 * 
 * This utility helps debug and validate ROI/PnL calculations across the system.
 * Use this to ensure consistency between different calculation points.
 */

export interface ROIPnLSnapshot {
  timestamp: number;
  source: string;
  
  // Balance Data
  balanceSOL: number;
  balanceUSDC: number;
  balanceTokens: number;
  
  // Portfolio Values
  initialBalanceSOL: number;
  initialBalanceUSD: number;
  currentTotalValueUSD: number;
  
  // P&L Components
  realizedPnLUSD: number;
  unrealizedPnLUSD: number;
  totalPnLUSD: number;
  totalFeesUSD: number;
  
  // ROI Calculation
  roi: number;
  roiCalculationMethod: string;
  
  // Price Data
  solPriceUSD: number;
  tokenPriceUSD?: number;
}

export class ROIPnLDebugger {
  private snapshots: ROIPnLSnapshot[] = [];
  private maxSnapshots = 100;
  
  /**
   * Record a snapshot of ROI/PnL calculation
   */
  recordSnapshot(snapshot: ROIPnLSnapshot): void {
    this.snapshots.push(snapshot);
    
    // Keep only last N snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
    
    // Log if there's a significant discrepancy
    if (this.snapshots.length >= 2) {
      const previous = this.snapshots[this.snapshots.length - 2];
      const current = snapshot;
      
      const roiDiff = Math.abs(current.roi - previous.roi);
      const pnlDiff = Math.abs(current.totalPnLUSD - previous.totalPnLUSD);
      
      if (roiDiff > 5 || pnlDiff > 100) {
        console.warn('\u26a0\ufe0f [ROI/PnL CHANGE DETECTED]', {
          source: `${previous.source} → ${current.source}`,
          roiChange: {
            previous: previous.roi.toFixed(2) + '%',
            current: current.roi.toFixed(2) + '%',
            diff: roiDiff.toFixed(2) + '%'
          },
          pnlChange: {
            previous: '$' + previous.totalPnLUSD.toFixed(2),
            current: '$' + current.totalPnLUSD.toFixed(2),
            diff: '$' + pnlDiff.toFixed(2)
          }
        });
      }
    }
  }
  
  /**
   * Validate ROI calculation consistency
   */
  validateROI(
    initialInvestmentUSD: number,
    currentValueUSD: number,
    calculatedROI: number,
    source: string
  ): boolean {
    const expectedROI = initialInvestmentUSD > 0
      ? ((currentValueUSD - initialInvestmentUSD) / initialInvestmentUSD) * 100
      : 0;
    
    const difference = Math.abs(expectedROI - calculatedROI);
    
    if (difference > 0.01) {
      console.error('\u274c [ROI VALIDATION FAILED]', {
        source,
        expected: expectedROI.toFixed(2) + '%',
        calculated: calculatedROI.toFixed(2) + '%',
        difference: difference.toFixed(4) + '%',
        initialInvestment: '$' + initialInvestmentUSD.toFixed(2),
        currentValue: '$' + currentValueUSD.toFixed(2)
      });
      return false;
    }
    
    return true;
  }
  
  /**
   * Validate P&L calculation consistency
   */
  validatePnL(
    realizedPnL: number,
    unrealizedPnL: number,
    totalPnL: number,
    source: string
  ): boolean {
    const expectedTotal = realizedPnL + unrealizedPnL;
    const difference = Math.abs(expectedTotal - totalPnL);
    
    if (difference > 0.01) {
      console.error('\u274c [PnL VALIDATION FAILED]', {
        source,
        realized: '$' + realizedPnL.toFixed(2),
        unrealized: '$' + unrealizedPnL.toFixed(2),
        expectedTotal: '$' + expectedTotal.toFixed(2),
        actualTotal: '$' + totalPnL.toFixed(2),
        difference: '$' + difference.toFixed(4)
      });
      return false;
    }
    
    return true;
  }
  
  /**
   * Get all snapshots
   */
  getSnapshots(): ROIPnLSnapshot[] {
    return [...this.snapshots];
  }
  
  /**
   * Get latest snapshot
   */
  getLatest(): ROIPnLSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }
  
  /**
   * Compare two snapshots
   */
  compare(snapshot1: ROIPnLSnapshot, snapshot2: ROIPnLSnapshot): void {
    console.log('\n' + '='.repeat(80));
    console.log('\ud83d\udd0d ROI/PnL COMPARISON');
    console.log('='.repeat(80));
    
    console.log(`\nSource: ${snapshot1.source} vs ${snapshot2.source}`);
    console.log(`Time: ${new Date(snapshot1.timestamp).toISOString()} vs ${new Date(snapshot2.timestamp).toISOString()}`);
    
    console.log('\n\ud83d\udcca Balance Comparison:');
    this.logDiff('SOL Balance', snapshot1.balanceSOL, snapshot2.balanceSOL, 'SOL');
    this.logDiff('USDC Balance', snapshot1.balanceUSDC, snapshot2.balanceUSDC, 'USDC');
    this.logDiff('Token Balance', snapshot1.balanceTokens, snapshot2.balanceTokens, 'tokens');
    
    console.log('\n\ud83d\udcb0 Value Comparison:');
    this.logDiff('Initial USD', snapshot1.initialBalanceUSD, snapshot2.initialBalanceUSD, '$');
    this.logDiff('Current USD', snapshot1.currentTotalValueUSD, snapshot2.currentTotalValueUSD, '$');
    
    console.log('\n\ud83d\udcc8 P&L Comparison:');
    this.logDiff('Realized P&L', snapshot1.realizedPnLUSD, snapshot2.realizedPnLUSD, '$');
    this.logDiff('Unrealized P&L', snapshot1.unrealizedPnLUSD, snapshot2.unrealizedPnLUSD, '$');
    this.logDiff('Total P&L', snapshot1.totalPnLUSD, snapshot2.totalPnLUSD, '$');
    this.logDiff('Total Fees', snapshot1.totalFeesUSD, snapshot2.totalFeesUSD, '$');
    
    console.log('\n\ud83c\udfaf ROI Comparison:');
    this.logDiff('ROI', snapshot1.roi, snapshot2.roi, '%');
    console.log(`  Method 1: ${snapshot1.roiCalculationMethod}`);
    console.log(`  Method 2: ${snapshot2.roiCalculationMethod}`);
    
    console.log('\n' + '='.repeat(80) + '\n');
  }
  
  private logDiff(label: string, val1: number, val2: number, unit: string): void {
    const diff = val2 - val1;
    const diffStr = diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
    const arrow = diff === 0 ? '=' : (diff > 0 ? '↑' : '↓');
    
    console.log(`  ${label}: ${val1.toFixed(2)}${unit} → ${val2.toFixed(2)}${unit} (${diffStr}${unit}) ${arrow}`);
  }
  
  /**
   * Generate detailed report
   */
  generateReport(): void {
    if (this.snapshots.length === 0) {
      console.log('No snapshots recorded yet.');
      return;
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('\ud83d\udcca ROI/PnL CALCULATION REPORT');
    console.log('='.repeat(80));
    
    const latest = this.snapshots[this.snapshots.length - 1];
    
    console.log('\n\ud83d\udd52 Latest Snapshot:');
    console.log(`  Source: ${latest.source}`);
    console.log(`  Timestamp: ${new Date(latest.timestamp).toISOString()}`);
    
    console.log('\n\ud83d\udcca Current State:');
    console.log(`  SOL Balance: ${latest.balanceSOL.toFixed(6)} SOL`);
    console.log(`  USDC Balance: $${latest.balanceUSDC.toFixed(2)}`);
    console.log(`  Token Balance: ${latest.balanceTokens.toLocaleString()} tokens`);
    
    console.log('\n\ud83d\udcb0 Portfolio Values:');
    console.log(`  Initial Investment: $${latest.initialBalanceUSD.toFixed(2)}`);
    console.log(`  Current Value: $${latest.currentTotalValueUSD.toFixed(2)}`);
    console.log(`  Change: $${(latest.currentTotalValueUSD - latest.initialBalanceUSD).toFixed(2)}`);
    
    console.log('\n\ud83d\udcc8 P&L Breakdown:');
    console.log(`  Realized P&L: $${latest.realizedPnLUSD.toFixed(2)}`);
    console.log(`  Unrealized P&L: $${latest.unrealizedPnLUSD.toFixed(2)}`);
    console.log(`  Total P&L: $${latest.totalPnLUSD.toFixed(2)}`);
    console.log(`  Total Fees: $${latest.totalFeesUSD.toFixed(2)}`);
    console.log(`  Net P&L (after fees): $${(latest.totalPnLUSD - latest.totalFeesUSD).toFixed(2)}`);
    
    console.log('\n\ud83c\udfaf ROI:');
    console.log(`  ROI: ${latest.roi.toFixed(2)}%`);
    console.log(`  Calculation: ${latest.roiCalculationMethod}`);
    
    console.log('\n\ud83d\udcc9 Historical Summary:');
    console.log(`  Total Snapshots: ${this.snapshots.length}`);
    console.log(`  First Recorded: ${new Date(this.snapshots[0].timestamp).toISOString()}`);
    console.log(`  Duration: ${((latest.timestamp - this.snapshots[0].timestamp) / 1000 / 60).toFixed(2)} minutes`);
    
    // ROI evolution
    if (this.snapshots.length > 1) {
      const roiValues = this.snapshots.map(s => s.roi);
      const minROI = Math.min(...roiValues);
      const maxROI = Math.max(...roiValues);
      
      console.log('\n\ud83d\udcc8 ROI Evolution:');
      console.log(`  Starting ROI: ${this.snapshots[0].roi.toFixed(2)}%`);
      console.log(`  Current ROI: ${latest.roi.toFixed(2)}%`);
      console.log(`  Min ROI: ${minROI.toFixed(2)}%`);
      console.log(`  Max ROI: ${maxROI.toFixed(2)}%`);
      console.log(`  Range: ${(maxROI - minROI).toFixed(2)}%`);
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
  }
  
  /**
   * Clear all snapshots
   */
  clear(): void {
    this.snapshots = [];
    console.log('✅ All snapshots cleared');
  }
}

// Export singleton instance
export const roiPnlDebugger = new ROIPnLDebugger();
