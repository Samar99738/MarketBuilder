/**
 * Comprehensive Test for Auto-Simulation Feature
 * Tests all scenarios for automatic strategy detection and simulation
 */

import { agentController } from '../src/agent/agentController';
import { strategyParser } from '../src/agent/strategyParser';

// Test colors for output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logTest(testName: string) {
  console.log('\n' + '='.repeat(80));
  log(`🧪 TEST: ${testName}`, colors.blue);
  console.log('='.repeat(80));
}

function logPass(message: string) {
  log(`✅ PASS: ${message}`, colors.green);
}

function logFail(message: string) {
  log(`❌ FAIL: ${message}`, colors.red);
}

function logInfo(message: string) {
  log(`ℹ️  INFO: ${message}`, colors.yellow);
}

// Test counters
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(testName: string, testFn: () => Promise<boolean>) {
  totalTests++;
  logTest(testName);
  
  try {
    const result = await testFn();
    if (result) {
      passedTests++;
      logPass('Test passed');
    } else {
      failedTests++;
      logFail('Test failed');
    }
    return result;
  } catch (error) {
    failedTests++;
    logFail(`Test threw error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.error(error);
    return false;
  }
}

// ============================================================================
// TEST 1: Reactive Strategy Detection
// ============================================================================
async function testReactiveStrategyDetection(): Promise<boolean> {
  const testInput = `I've this token: 8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump and I've supply of 10 million and I want to sell this token in exact amount of people that are buying in realtime.`;
  
  logInfo(`Input: "${testInput}"`);
  
  const parsed = strategyParser.parseStrategy(testInput);
  
  if (!parsed) {
    logFail('Parser returned null');
    return false;
  }
  
  logInfo(`Parsed template: ${parsed.template}`);
  logInfo(`Parsed config: ${JSON.stringify(parsed.config, null, 2)}`);
  
  // Check if it's a custom/reactive strategy
  if (parsed.template !== 'custom') {
    logFail(`Expected template 'custom', got '${parsed.template}'`);
    return false;
  }
  
  // Check if strategy type is reactive
  if (parsed.config.strategyType !== 'reactive') {
    logFail(`Expected strategyType 'reactive', got '${parsed.config.strategyType}'`);
    return false;
  }
  
  // Check if token address was extracted
  if (!parsed.config.tokenAddress) {
    logFail('Token address not extracted');
    return false;
  }
  logPass(`Token address extracted: ${parsed.config.tokenAddress}`);
  
  // Check if trigger was detected
  if (!parsed.config.trigger || parsed.config.trigger === 'unknown') {
    logFail('Trigger not detected or unknown');
    return false;
  }
  logPass(`Trigger detected: ${parsed.config.trigger}`);
  
  // Check if side was detected
  if (parsed.config.side !== 'sell') {
    logFail(`Expected side 'sell', got '${parsed.config.side}'`);
    return false;
  }
  logPass(`Side detected: ${parsed.config.side}`);
  
  // Check if marked as complete
  if (!parsed.config.isComplete) {
    logFail('Strategy not marked as complete');
    return false;
  }
  logPass('Strategy marked as complete');
  
  return true;
}

// ============================================================================
// TEST 2: DCA Strategy Detection
// ============================================================================
async function testDCAStrategyDetection(): Promise<boolean> {
  const testInput = `I want to buy 0.05 SOL for every 12 second and repeat this trade twice`;
  
  logInfo(`Input: "${testInput}"`);
  
  const parsed = strategyParser.parseStrategy(testInput);
  
  if (!parsed) {
    logFail('Parser returned null');
    return false;
  }
  
  logInfo(`Parsed template: ${parsed.template}`);
  logInfo(`Parsed config: ${JSON.stringify(parsed.config, null, 2)}`);
  
  // Check template
  if (parsed.template !== 'dca') {
    logFail(`Expected template 'dca', got '${parsed.template}'`);
    return false;
  }
  
  // Check amount
  if (parsed.config.buyAmountSOL !== 0.05) {
    logFail(`Expected buyAmountSOL 0.05, got ${parsed.config.buyAmountSOL}`);
    return false;
  }
  logPass(`Buy amount: ${parsed.config.buyAmountSOL} SOL`);
  
  // Check interval (12 seconds = 0.2 minutes)
  if (parsed.config.intervalMinutes !== 0.2) {
    logFail(`Expected intervalMinutes 0.2, got ${parsed.config.intervalMinutes}`);
    return false;
  }
  logPass(`Interval: ${parsed.config.intervalMinutes} minutes`);
  
  // Check count
  if (parsed.config.buyCount !== 2) {
    logFail(`Expected buyCount 2, got ${parsed.config.buyCount}`);
    return false;
  }
  logPass(`Buy count: ${parsed.config.buyCount}`);
  
  return true;
}

// ============================================================================
// TEST 3: Strategy Completeness Check
// ============================================================================
async function testStrategyCompletenessCheck(): Promise<boolean> {
  logInfo('Testing completeness detection for various strategies...');
  
  // Test 1: Complete reactive strategy
  const reactiveStrategy = strategyParser.parseStrategy(
    `Sell token 8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump when others buy`
  );
  
  if (!reactiveStrategy) {
    logFail('Failed to parse reactive strategy');
    return false;
  }
  
  // Log the full parsed strategy for debugging
  console.log('📋 [TEST] Full parsed reactive strategy:', JSON.stringify(reactiveStrategy, null, 2));
  
  // Create a session to test completeness
  const session = agentController.getSession('test-completeness');
  session.currentStrategy = reactiveStrategy;
  
  // Use private method through type assertion
  const controller = agentController as any;
  const isComplete = controller.isStrategyConfigComplete(reactiveStrategy);
  
  if (!isComplete) {
    logFail('Reactive strategy not recognized as complete');
    return false;
  }
  logPass('Reactive strategy recognized as complete');
  
  // Test 2: Complete DCA strategy
  const dcaStrategy = strategyParser.parseStrategy(
    `Buy 0.1 SOL every hour 10 times`
  );
  
  if (!dcaStrategy) {
    logFail('Failed to parse DCA strategy');
    return false;
  }
  
  const isDCAComplete = controller.isStrategyConfigComplete(dcaStrategy);
  
  if (!isDCAComplete) {
    logFail('DCA strategy not recognized as complete');
    return false;
  }
  logPass('DCA strategy recognized as complete');
  
  // Test 3: Incomplete strategy (missing parameters)
  const incompleteStrategy = {
    template: 'dca' as const,
    config: {
      id: 'test',
      side: 'buy'
      // Missing: buyAmountSOL, intervalMinutes
    },
    confidence: 0.8,
    requiresConfirmation: true
  };
  
  const isIncomplete = controller.isStrategyConfigComplete(incompleteStrategy);
  
  if (isIncomplete) {
    logFail('Incomplete strategy incorrectly recognized as complete');
    return false;
  }
  logPass('Incomplete strategy correctly identified');
  
  return true;
}

// ============================================================================
// TEST 4: Token Address Extraction
// ============================================================================
async function testTokenAddressExtraction(): Promise<boolean> {
  const testCases = [
    {
      input: `Sell when others buy Token: 6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump`,
      expected: '6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump'
    },
    {
      input: `I want to buy when others sell 8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump`,
      expected: '8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump'
    },
    {
      input: `Mirror buying activity for So11111111111111111111111111111111111111112`,
      expected: 'So11111111111111111111111111111111111111112'
    }
  ];
  
  for (const testCase of testCases) {
    logInfo(`Testing: "${testCase.input.substring(0, 50)}..."`);
    
    const parsed = strategyParser.parseStrategy(testCase.input);
    
    if (!parsed?.config.tokenAddress) {
      logFail(`Failed to extract token address from: ${testCase.input}`);
      return false;
    }
    
    if (parsed.config.tokenAddress !== testCase.expected) {
      logFail(`Expected ${testCase.expected}, got ${parsed.config.tokenAddress}`);
      return false;
    }
    
    logPass(`Extracted: ${parsed.config.tokenAddress}`);
  }
  
  return true;
}

// ============================================================================
// TEST 5: Agent Auto-Simulation Trigger
// ============================================================================
async function testAutoSimulationTrigger(): Promise<boolean> {
  logInfo('Testing auto-simulation trigger in agent...');
  
  const sessionId = 'test-auto-sim';
  const userMessage = `I've this token: 8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump and I've supply of 10 million and I want to sell this token in exact amount of people that are buying in realtime.`;
  
  logInfo(`Sending message to agent: "${userMessage}"`);
  
  try {
    const response = await agentController.processMessage(
      sessionId,
      userMessage,
      undefined,
      ['getTokenInfo', 'buyToken', 'sellToken', 'listAccounts', 'getAccountBalance']
    );
    
    logInfo(`Response message: ${response.message.substring(0, 200)}...`);
    logInfo(`Actions: ${JSON.stringify(response.actions)}`);
    
    // Check if simulation_starting action is present
    if (!response.actions?.includes('simulation_starting')) {
      logFail('simulation_starting action not found in response');
      logInfo(`Available actions: ${JSON.stringify(response.actions)}`);
      return false;
    }
    logPass('Auto-simulation trigger detected');
    
    // Check if strategy was stored
    const session = agentController.getSession(sessionId);
    if (!session.currentStrategy) {
      logFail('Strategy not stored in session');
      return false;
    }
    logPass('Strategy stored in session');
    
    // Check if message contains simulation start indicator
    if (!response.message.includes('🎯') && !response.message.includes('Strategy Detected')) {
      logFail('Response does not contain strategy detection message');
      return false;
    }
    logPass('Response contains strategy detection message');
    
    return true;
  } catch (error) {
    logFail(`Agent processing error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

// ============================================================================
// TEST 6: Multiple Strategy Types
// ============================================================================
async function testMultipleStrategyTypes(): Promise<boolean> {
  const testCases = [
    {
      name: 'Mirror Buy Activity',
      input: 'Sell when others buy token 6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump',
      expectedTemplate: 'custom',
      expectedTrigger: 'mirror_buy_activity'
    },
    {
      name: 'Mirror Sell Activity',
      input: 'Buy when people sell 8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump',
      expectedTemplate: 'custom',
      expectedTrigger: 'mirror_sell_activity'
    },
    {
      name: 'Match Volume',
      input: 'Match buying volume for So11111111111111111111111111111111111111112',
      expectedTemplate: 'custom',
      expectedTrigger: 'mirror_sell_activity'
    }
  ];
  
  for (const testCase of testCases) {
    logInfo(`Testing: ${testCase.name}`);
    logInfo(`Input: "${testCase.input}"`);
    
    const parsed = strategyParser.parseStrategy(testCase.input);
    
    if (!parsed) {
      logFail(`Failed to parse: ${testCase.name}`);
      return false;
    }
    
    if (parsed.template !== testCase.expectedTemplate) {
      logFail(`Expected template '${testCase.expectedTemplate}', got '${parsed.template}'`);
      return false;
    }
    
    if (parsed.config.trigger !== testCase.expectedTrigger) {
      logFail(`Expected trigger '${testCase.expectedTrigger}', got '${parsed.config.trigger}'`);
      return false;
    }
    
    logPass(`${testCase.name} parsed correctly`);
  }
  
  return true;
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
async function runAllTests() {
  console.log('\n');
  log('╔═══════════════════════════════════════════════════════════════════════════════╗', colors.blue);
  log('║                    AUTO-SIMULATION COMPREHENSIVE TEST SUITE                  ║', colors.blue);
  log('╚═══════════════════════════════════════════════════════════════════════════════╝', colors.blue);
  
  await runTest('Reactive Strategy Detection', testReactiveStrategyDetection);
  await runTest('DCA Strategy Detection', testDCAStrategyDetection);
  await runTest('Strategy Completeness Check', testStrategyCompletenessCheck);
  await runTest('Token Address Extraction', testTokenAddressExtraction);
  await runTest('Agent Auto-Simulation Trigger', testAutoSimulationTrigger);
  await runTest('Multiple Strategy Types', testMultipleStrategyTypes);
  
  // Print summary
  console.log('\n');
  log('╔═══════════════════════════════════════════════════════════════════════════════╗', colors.blue);
  log('║                              TEST SUMMARY                                     ║', colors.blue);
  log('╚═══════════════════════════════════════════════════════════════════════════════╝', colors.blue);
  console.log('');
  log(`Total Tests: ${totalTests}`, colors.blue);
  log(`Passed: ${passedTests}`, colors.green);
  log(`Failed: ${failedTests}`, failedTests > 0 ? colors.red : colors.green);
  console.log('');
  
  if (failedTests === 0) {
    log('╔═══════════════════════════════════════════════════════════════════════════════╗', colors.green);
    log('║                         ✅ ALL TESTS PASSED! ✅                              ║', colors.green);
    log('╚═══════════════════════════════════════════════════════════════════════════════╝', colors.green);
  } else {
    log('╔═══════════════════════════════════════════════════════════════════════════════╗', colors.red);
    log('║                         ❌ SOME TESTS FAILED ❌                              ║', colors.red);
    log('╚═══════════════════════════════════════════════════════════════════════════════╝', colors.red);
  }
  
  console.log('');
  
  process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runAllTests().catch((error) => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
