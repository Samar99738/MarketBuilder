/**
 * Comprehensive Test Suite for Strategy Stop Fix
 * 
 * This test verifies that the strategy execution properly stops when requested
 * and does not continue running in the background.
 * 
 * Tests:
 * 1. Start a strategy
 * 2. Verify it's running
 * 3. Stop the strategy
 * 4. Verify it stops immediately
 * 5. Verify no more executions occur after stop
 */

import { strategyExecutionManager } from '../src/trading_utils/StrategyExecutionManager';
import { createStrategyFromTemplate } from '../src/trading_utils/StrategyTemplates';

// Test configuration
const TEST_TIMEOUT = 30000; // 30 seconds max
const MONITORING_DURATION = 10000; // Monitor for 10 seconds after stop

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runStrategyStopTest() {
  console.log('\n🧪 ========== STRATEGY STOP TEST START ==========\n');
  
  let testPassed = true;
  let runningId: string | null = null;

  try {
    // Step 1: Create a simple DCA strategy
    console.log('📋 Step 1: Creating DCA strategy...');
    const strategyConfig = {
      id: `test-stop-strategy-${Date.now()}`,
      buyAmountSOL: 0.01, // Small amount for testing
      intervalMinutes: 0.05, // 3 seconds interval (0.05 * 60 = 3s)
      buyCount: 100, // Many iterations to test stopping mid-execution
      description: 'Test strategy for stop functionality'
    };

    const strategy = createStrategyFromTemplate('dca', strategyConfig);
    console.log(`✅ Strategy created: ${strategy.id}`);

    // Step 2: Start the strategy in paper trading mode
    console.log('\n📋 Step 2: Starting strategy in paper trading mode...');
    runningId = await strategyExecutionManager.startStrategy(
      strategy.id,
      3000, // 3 second restart delay
      false, // Disable tracking
      1.0, // 1 SOL initial balance
      'paper', // Paper trading mode
      `test-session-${Date.now()}`
    );
    console.log(`✅ Strategy started with runningId: ${runningId}`);

    // Step 3: Let it run for a few executions
    console.log('\n📋 Step 3: Letting strategy run for 10 seconds...');
    await sleep(10000);

    // Check status before stopping
    const statusBeforeStop = strategyExecutionManager.getStrategyStatus(runningId);
    if (!statusBeforeStop) {
      throw new Error('Strategy status not found before stop');
    }

    console.log('\n📊 Status BEFORE stop:', {
      status: statusBeforeStop.status,
      executionCount: statusBeforeStop.executionCount,
      isExecuting: statusBeforeStop.isExecuting,
      hasContext: !!statusBeforeStop.currentContext,
      stopFlag: statusBeforeStop.currentContext?.variables._shouldStop
    });

    if (statusBeforeStop.status !== 'running') {
      throw new Error(`Expected status 'running', got '${statusBeforeStop.status}'`);
    }

    if (statusBeforeStop.executionCount < 1) {
      throw new Error(`Expected at least 1 execution, got ${statusBeforeStop.executionCount}`);
    }

    const executionCountBeforeStop = statusBeforeStop.executionCount;
    console.log(`✅ Strategy executed ${executionCountBeforeStop} times before stop`);

    // Step 4: Stop the strategy
    console.log('\n📋 Step 4: Stopping strategy...');
    const stopped = await strategyExecutionManager.stopStrategy(runningId);

    if (!stopped) {
      throw new Error('Failed to stop strategy - stopStrategy returned false');
    }

    console.log('✅ stopStrategy() returned true');

    // Step 5: Verify status immediately after stop
    console.log('\n📋 Step 5: Verifying status immediately after stop...');
    await sleep(100); // Small delay to let state propagate

    const statusAfterStop = strategyExecutionManager.getStrategyStatus(runningId);
    if (!statusAfterStop) {
      throw new Error('Strategy status not found after stop');
    }

    console.log('\n📊 Status AFTER stop:', {
      status: statusAfterStop.status,
      executionCount: statusAfterStop.executionCount,
      isExecuting: statusAfterStop.isExecuting,
      hasContext: !!statusAfterStop.currentContext,
      stopFlag: statusAfterStop.currentContext?.variables._shouldStop
    });

    if (statusAfterStop.status !== 'stopped') {
      console.error(`❌ FAIL: Expected status 'stopped', got '${statusAfterStop.status}'`);
      testPassed = false;
    } else {
      console.log('✅ Status is "stopped"');
    }

    if (statusAfterStop.currentContext?.variables._shouldStop !== true) {
      console.error('❌ FAIL: Stop flag not set in context');
      testPassed = false;
    } else {
      console.log('✅ Stop flag is set');
    }

    // Step 6: Monitor for additional executions (should NOT happen)
    console.log(`\n📋 Step 6: Monitoring for ${MONITORING_DURATION}ms to ensure no more executions...`);
    const statusBeforeMonitoring = strategyExecutionManager.getStrategyStatus(runningId);
    const countBeforeMonitoring = statusBeforeMonitoring?.executionCount || 0;

    await sleep(MONITORING_DURATION);

    const statusAfterMonitoring = strategyExecutionManager.getStrategyStatus(runningId);
    const countAfterMonitoring = statusAfterMonitoring?.executionCount || 0;

    console.log('\n📊 Execution count comparison:', {
      beforeMonitoring: countBeforeMonitoring,
      afterMonitoring: countAfterMonitoring,
      difference: countAfterMonitoring - countBeforeMonitoring
    });

    if (countAfterMonitoring > countBeforeMonitoring) {
      console.error(`❌ FAIL: Strategy continued executing! Count increased from ${countBeforeMonitoring} to ${countAfterMonitoring}`);
      testPassed = false;
    } else {
      console.log('✅ No additional executions detected');
    }

    // Final status check
    console.log('\n📊 Final Status:', {
      status: statusAfterMonitoring?.status,
      executionCount: statusAfterMonitoring?.executionCount,
      totalExecutions: executionCountBeforeStop
    });

  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    testPassed = false;
  } finally {
    // Cleanup
    if (runningId) {
      try {
        await strategyExecutionManager.stopStrategy(runningId);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  console.log('\n🧪 ========== STRATEGY STOP TEST COMPLETE ==========\n');

  if (testPassed) {
    console.log('✅✅✅ ALL TESTS PASSED! ✅✅✅');
    console.log('\n✅ Strategy stop functionality is working correctly!');
    console.log('✅ No background executions detected after stop.');
    process.exit(0);
  } else {
    console.log('❌❌❌ SOME TESTS FAILED ❌❌❌');
    console.log('\n❌ Strategy stop functionality has issues.');
    console.log('❌ Review the logs above for details.');
    process.exit(1);
  }
}

// Run the test
console.log('Starting strategy stop test...');
runStrategyStopTest().catch(error => {
  console.error('Fatal error in test:', error);
  process.exit(1);
});
