/**
 * Comprehensive Integration Test
 * Tests pump.fun integration and MCP server functionality
 * 
 * Run with: npx ts-node tests/integration-test.ts
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PumpFunIntegration } from '../src/trading_utils/PumpFunIntegration';
import { getTokenRouter } from '../src/trading_utils/TokenRouter';
import { UnifiedTrading } from '../src/trading_utils/UnifiedTrading';
import { TRADING_CONFIG } from '../src/trading_utils/config';

// Test configuration
const TEST_CONFIG = {
  // Known pump.fun token for testing (use a real one from pump.fun)
  PUMPFUN_TOKEN: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Example: Bonk
  
  // Standard Solana token for comparison
  STANDARD_TOKEN: 'So11111111111111111111111111111111111111112', // Wrapped SOL
  
  // Test amount (very small for safety)
  TEST_AMOUNT: 0.001,
};

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  message: string;
  duration?: number;
}

const results: TestResult[] = [];

/**
 * Run a test with timing
 */
async function runTest(
  name: string,
  testFn: () => Promise<void>,
  skip: boolean = false
): Promise<void> {
  if (skip) {
    results.push({ name, status: 'SKIP', message: 'Test skipped' });
    console.log(`⏭️  ${name} - SKIPPED`);
    return;
  }

  const startTime = Date.now();
  try {
    await testFn();
    const duration = Date.now() - startTime;
    results.push({ name, status: 'PASS', message: 'Test passed', duration });
    console.log(`✅ ${name} - PASS (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Unknown error';
    results.push({ name, status: 'FAIL', message, duration });
    console.log(`❌ ${name} - FAIL: ${message}`);
  }
}

/**
 * Test 1: Connection to Solana
 */
async function testConnection(): Promise<void> {
  const rpcEndpoint = TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcEndpoint, 'confirmed');
  const version = await connection.getVersion();
  
  if (!version || !version['solana-core']) {
    throw new Error('Failed to get Solana version');
  }
  
  console.log(`   Solana Version: ${version['solana-core']}`);
}

/**
 * Test 2: Pump.fun Integration - Get Token Info
 */
async function testPumpFunTokenInfo(): Promise<void> {
  const rpcEndpoint = TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcEndpoint, 'confirmed');
  const pumpFunIntegration = new PumpFunIntegration(connection);
  
  const mint = new PublicKey(TEST_CONFIG.PUMPFUN_TOKEN);
  const tokenInfo = await pumpFunIntegration.getComprehensiveTokenInfo(mint);
  
  if (!tokenInfo) {
    throw new Error('Failed to get token info');
  }
  
  console.log(`   Token: ${mint.toString()}`);
  console.log(`   Symbol: ${tokenInfo.symbol || 'N/A'}`);
}

/**
 * Test 3: Token Router - Pump.fun Detection
 */
async function testTokenRouting(): Promise<void> {
  const rpcEndpoint = TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcEndpoint, 'confirmed');
  const tokenRouter = getTokenRouter(connection);
  
  // Test pump.fun token
  const pumpfunRoute = await tokenRouter.route(TEST_CONFIG.PUMPFUN_TOKEN);
  
  if (pumpfunRoute.engine !== 'pumpfun') {
    throw new Error(`Expected 'pumpfun' engine, got '${pumpfunRoute.engine}'`);
  }
  
  console.log(`   Pump.fun Token Routing: ${pumpfunRoute.engine} ✓`);
  console.log(`   Reason: ${pumpfunRoute.reason}`);
  
  // Test standard token
  const standardRoute = await tokenRouter.route(TEST_CONFIG.STANDARD_TOKEN);
  
  if (standardRoute.engine !== 'jupiter') {
    throw new Error(`Expected 'jupiter' engine, got '${standardRoute.engine}'`);
  }
  
  console.log(`   Standard Token Routing: ${standardRoute.engine} ✓`);
}

/**
 * Test 4: Unified Trading Interface
 */
async function testUnifiedTrading(): Promise<void> {
  const rpcEndpoint = TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcEndpoint, 'confirmed');
  const unifiedTrading = new UnifiedTrading(connection);
  
  // Test that buy/sell methods exist and are callable (dry run)
  if (typeof unifiedTrading.buy !== 'function') {
    throw new Error('UnifiedTrading.buy is not a function');
  }
  
  if (typeof unifiedTrading.sell !== 'function') {
    throw new Error('UnifiedTrading.sell is not a function');
  }
  
  console.log(`   UnifiedTrading.buy: Available ✓`);
  console.log(`   UnifiedTrading.sell: Available ✓`);
}

/**
 * Test 5: MCP Server Initialization
 */
async function testMCPServer(): Promise<void> {
  try {
    const { getMCPServer } = await import('../src/agent/MCPServer');
    const mcpServer = getMCPServer();
    
    if (!mcpServer) {
      throw new Error('Failed to get MCP server instance');
    }
    
    console.log(`   MCP Server: Initialized ✓`);
  } catch (error) {
    throw new Error(`MCP Server initialization failed: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}

/**
 * Test 6: Agent Controller Integration
 */
async function testAgentController(): Promise<void> {
  const { AgentController } = await import('../src/agent/agentController');
  const agent = new AgentController();
  
  const session = agent.getSession('test-session');
  
  if (!session) {
    throw new Error('Failed to create agent session');
  }
  
  if (session.sessionId !== 'test-session') {
    throw new Error('Session ID mismatch');
  }
  
  console.log(`   Agent Session Created: ${session.sessionId} ✓`);
}

/**
 * Test 7: Configuration Validation
 */
async function testConfiguration(): Promise<void> {
  const errors: string[] = [];
  
  // Check RPC endpoint
  if (!TRADING_CONFIG.RPC_ENDPOINT) {
    errors.push('RPC_ENDPOINT not configured');
  }
  
  // Check pump.fun config
  if (!TRADING_CONFIG.PUMPFUN_CONFIG) {
    errors.push('PUMPFUN_CONFIG not found');
  } else {
    if (TRADING_CONFIG.PUMPFUN_CONFIG.DEFAULT_SLIPPAGE < 1) {
      errors.push('PUMPFUN slippage too low');
    }
    if (TRADING_CONFIG.PUMPFUN_CONFIG.MAX_TRADE_AMOUNT <= 0) {
      errors.push('PUMPFUN max trade amount invalid');
    }
  }
  
  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }
  
  console.log(`   RPC Endpoint: ${TRADING_CONFIG.RPC_ENDPOINT} ✓`);
  console.log(`   Pump.fun Enabled: ${TRADING_CONFIG.PUMPFUN_CONFIG?.ENABLED} ✓`);
  console.log(`   Default Slippage: ${TRADING_CONFIG.PUMPFUN_CONFIG?.DEFAULT_SLIPPAGE}% ✓`);
}

/**
 * Main test runner
 */
async function runAllTests(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('  COMPREHENSIVE INTEGRATION TEST');
  console.log('  Pump.fun + MCP Server Integration');
  console.log('='.repeat(70) + '\n');
  
  // Run all tests
  await runTest('1. Solana Connection', testConnection);
  await runTest('2. Pump.fun Token Info', testPumpFunTokenInfo);
  await runTest('3. Token Routing (Pump.fun vs Jupiter)', testTokenRouting);
  await runTest('4. Unified Trading Interface', testUnifiedTrading);
  await runTest('5. MCP Server Initialization', testMCPServer);
  await runTest('6. Agent Controller Integration', testAgentController);
  await runTest('7. Configuration Validation', testConfiguration);
  
  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  TEST SUMMARY');
  console.log('='.repeat(70));
  
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  
  console.log(`\n  Total Tests: ${results.length}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  
  if (failed > 0) {
    console.log('\n  Failed Tests:');
    results
      .filter(r => r.status === 'FAIL')
      .forEach(r => {
        console.log(`    - ${r.name}`);
        console.log(`      Error: ${r.message}`);
      });
  }
  
  const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);
  console.log(`\n  Total Duration: ${totalDuration}ms`);
  console.log('\n' + '='.repeat(70) + '\n');
  
  // Exit with appropriate code
  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('\n❌ Test runner failed:', error);
  process.exit(1);
});
