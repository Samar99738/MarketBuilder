/**
 * Quick Start Example: Strategy with Analytics
 * 
 * This example shows how to:
 * 1. Start a strategy with analytics tracking
 * 2. Monitor performance in real-time
 * 3. View performance reports
 */

import { strategyExecutionManager } from './src/trading_utils/StrategyExecutionManager';
import { strategyExecutionTracker } from './src/trading_utils/StrategyExecutionTracker';
import { createStrategyFromTemplate } from './src/trading_utils/StrategyTemplates';
import { strategyBuilder } from './src/trading_utils/StrategyBuilder';

async function runStrategyWithAnalytics() {
  console.log('🚀 Starting Strategy with Analytics...\n');

  // Step 1: Create a DCA strategy
  const strategy = createStrategyFromTemplate('dca', {
    buyAmountSOL: 0.01,        // Buy 0.01 SOL each time
    intervalMinutes: 1,         // Every 1 minute
    numberOfBuys: 5,           // Execute 5 buys total
  });

  const strategyId = strategy.id;
  console.log(`✅ Strategy created: ${strategyId}\n`);

  // Step 2: Start strategy with analytics enabled
  const initialBalance = 1.0; // 1 SOL
  const runningId = await strategyExecutionManager.startStrategy(
    strategyId,
    60000,           // Check every 60 seconds
    true,            // Enable analytics tracking
    initialBalance   // Initial balance
  );

  console.log(`✅ Strategy started: ${runningId}`);
  console.log(`💰 Initial Balance: ${initialBalance} SOL\n`);

  // Step 3: Monitor performance every 30 seconds
  const monitorInterval = setInterval(async () => {
    const performance = strategyExecutionTracker.getPerformance(runningId);
    
    if (!performance) {
      console.log('⏳ Waiting for first execution...');
      return;
    }

    console.log('\n📊 Current Performance:');
    console.log(`   Executions: ${performance.totalExecutions} (${performance.buyExecutions} buys, ${performance.sellExecutions} sells)`);
    console.log(`   Success Rate: ${performance.successRate.toFixed(2)}%`);
    console.log(`   Total Profit: ${performance.totalProfitSOL.toFixed(4)} SOL ($${performance.totalProfitUSD.toFixed(2)})`);
    console.log(`   ROI: ${performance.roi > 0 ? '+' : ''}${performance.roi.toFixed(2)}%`);
    console.log(`   Fees Paid: ${performance.totalFeesSOL.toFixed(6)} SOL ($${performance.totalFeesUSD.toFixed(2)})`);

    // Stop after strategy completes all buys
    if (performance.buyExecutions >= 5) {
      clearInterval(monitorInterval);
      await showFinalReport(runningId);
    }
  }, 30000); // Every 30 seconds

  console.log('\n🔄 Strategy is running...');
  console.log('📈 Monitoring performance every 30 seconds\n');
}

async function showFinalReport(runningId: string) {
  console.log('\n🛑 Strategy completed! Generating final report...\n');

  // Stop the strategy
  await strategyExecutionManager.stopStrategy(runningId);

  // Wait a moment for final metrics
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Generate and display report
  const report = strategyExecutionTracker.generateReport(runningId);
  console.log(report);

  // Show summary
  const summary = strategyExecutionTracker.generateSummary(runningId);
  console.log('\n📋 JSON Summary:');
  console.log(JSON.stringify(summary, null, 2));

  process.exit(0);
}

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n\n⏹️  Stopping strategy...');
  await strategyExecutionManager.stopAllStrategies();
  process.exit(0);
});

// Run the example
if (require.main === module) {
  runStrategyWithAnalytics().catch((error) => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
}

export { runStrategyWithAnalytics };
