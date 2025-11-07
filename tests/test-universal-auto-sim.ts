/**
 * Test Universal Auto-Simulation
 * Verifies that auto-simulation works for ALL strategy types
 */

import { AgentController } from '../src/agent/agentController';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logPass(test: string) {
  log(`✅ PASS: ${test}`, colors.green);
}

function logFail(test: string, error: any) {
  log(`❌ FAIL: ${test}`, colors.red);
  log(`   Error: ${error}`, colors.red);
}

function logInfo(message: string) {
  log(`ℹ️  ${message}`, colors.blue);
}

// Test different strategy types
const TEST_STRATEGIES = [
  {
    name: 'Time-Based DCA',
    userMessage: 'Create a DCA strategy: buy 0.005 SOL of v7J1VtwaixBtgNPgo6PJRGY9C4kXjJwMACj7rMUqNVE every 15 seconds for 4 trades',
    expectedType: 'time_based_dca',
    shouldAutoSim: true
  },
  {
    name: 'Grid Trading',
    userMessage: 'Create a grid trading strategy for EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v with 5 levels between $0.95 and $1.05, 0.1 SOL per level',
    expectedType: 'grid_trading',
    shouldAutoSim: true
  },
  {
    name: 'Momentum Trading',
    userMessage: 'Buy 0.1 SOL of EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v when price goes above $1.05',
    expectedType: 'momentum',
    shouldAutoSim: true
  },
  {
    name: 'Contrarian Volatility',
    userMessage: 'Sell 1500 tokens of v7J1VtwaixBtgNPgo6PJRGY9C4kXjJwMACj7rMUqNVE when price rises 5% in 5 minutes, buy 0.001 SOL when price drops 15% in 5 minutes',
    expectedType: 'contrarian_volatility',
    shouldAutoSim: true
  },
  {
    name: 'Stop Loss',
    userMessage: 'Buy 0.2 SOL of EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v with 5% stop loss and 10% take profit',
    expectedType: 'stop_loss',
    shouldAutoSim: true
  }
];

async function testStrategyAutoSim(strategy: typeof TEST_STRATEGIES[0]): Promise<boolean> {
  const controller = new AgentController();
  const sessionId = `test-${Date.now()}`;
  
  logInfo(`Testing: ${strategy.name}`);
  logInfo(`Message: ${strategy.userMessage.substring(0, 80)}...`);
  
  try {
    const response = await controller.processMessage(
      sessionId,
      strategy.userMessage,
      undefined // no wallet for paper trading
    );
    
    // Check if strategy was created
    if (!response.suggestedStrategy) {
      logFail(strategy.name, 'No strategy was created');
      return false;
    }
    
    logInfo(`Strategy type: ${response.suggestedStrategy.config?.strategyType || 'unknown'}`);
    logInfo(`Is complete: ${response.suggestedStrategy.config?.isComplete}`);
    logInfo(`Has strategyId: ${!!response.strategyId}`);
    
    // Check if auto-simulation triggered
    const autoSimTriggered = response.actions?.includes('simulation_running') || 
                            response.message?.includes('Simulation is now running');
    
    if (strategy.shouldAutoSim && !autoSimTriggered) {
      logFail(strategy.name, 'Auto-simulation did not trigger when expected');
      log(`   Response actions: ${response.actions}`, colors.yellow);
      log(`   Response message: ${response.message.substring(0, 200)}...`, colors.yellow);
      return false;
    }
    
    if (!strategy.shouldAutoSim && autoSimTriggered) {
      logFail(strategy.name, 'Auto-simulation triggered when it should not');
      return false;
    }
    
    logPass(strategy.name);
    return true;
  } catch (error) {
    logFail(strategy.name, error);
    return false;
  }
}

async function runAllTests() {
  log('\n═══════════════════════════════════════════════════════════════════════════', colors.magenta);
  log('║            UNIVERSAL AUTO-SIMULATION TEST SUITE                         ║', colors.magenta);
  log('║         Testing auto-simulation for ALL strategy types                  ║', colors.magenta);
  log('═══════════════════════════════════════════════════════════════════════════\n', colors.magenta);
  
  let passed = 0;
  let failed = 0;
  
  for (const strategy of TEST_STRATEGIES) {
    const result = await testStrategyAutoSim(strategy);
    if (result) {
      passed++;
    } else {
      failed++;
    }
    log(''); // Empty line between tests
  }
  
  log('\n═══════════════════════════════════════════════════════════════════════════', colors.magenta);
  log(`║                         TEST RESULTS                                    ║`, colors.magenta);
  log(`║  Total: ${TEST_STRATEGIES.length}  |  Passed: ${passed}  |  Failed: ${failed}                                     ║`, colors.magenta);
  log('═══════════════════════════════════════════════════════════════════════════\n', colors.magenta);
  
  if (failed === 0) {
    log('🎉 ALL TESTS PASSED! Universal auto-simulation is working correctly!', colors.green);
  } else {
    log(`⚠️  ${failed} test(s) failed. Please review the errors above.`, colors.red);
  }
  
  process.exit(failed === 0 ? 0 : 1);
}

// Run tests
runAllTests().catch(error => {
  log(`\n❌ Test suite crashed: ${error}`, colors.red);
  console.error(error);
  process.exit(1);
});
