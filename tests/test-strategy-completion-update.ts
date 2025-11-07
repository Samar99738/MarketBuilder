/**
 * Test Strategy Completion Update
 * Verifies that strategies update correctly when transitioning from incomplete to complete
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

async function testStrategyCompletionUpdate() {
  log('\n═══════════════════════════════════════════════════════════════', colors.magenta);
  log('║   TEST: Strategy Completion Update                          ║', colors.magenta);
  log('═══════════════════════════════════════════════════════════════\n', colors.magenta);
  
  const controller = new AgentController();
  const sessionId = `test-completion-${Date.now()}`;
  
  try {
    // Step 1: User provides partial info (strategy incomplete)
    log('📝 Step 1: User provides token address only...', colors.blue);
    const response1 = await controller.processMessage(
      sessionId,
      '1: Token Address: Bx2PkKe9sTcfYQebkxqcTzeyoP4Qhy1DnLxcMKpEpump'
    );
    
    log(`Strategy after step 1:`, colors.yellow);
    log(`  - Is Complete: ${response1.suggestedStrategy?.config?.isComplete}`, colors.yellow);
    log(`  - Confidence: ${response1.suggestedStrategy?.confidence}`, colors.yellow);
    log(`  - Has strategyId: ${!!response1.strategyId}`, colors.yellow);
    
    if (response1.suggestedStrategy?.config?.isComplete) {
      log('❌ FAIL: Strategy should be incomplete after first message', colors.red);
      return false;
    }
    
    // Step 2: User provides amount
    log('\n📝 Step 2: User provides amount per trade...', colors.blue);
    const response2 = await controller.processMessage(
      sessionId,
      '1. amount per trade: 0.25 SOL'
    );
    
    log(`Strategy after step 2:`, colors.yellow);
    log(`  - Is Complete: ${response2.suggestedStrategy?.config?.isComplete}`, colors.yellow);
    log(`  - Confidence: ${response2.suggestedStrategy?.confidence}`, colors.yellow);
    
    // Step 3: User provides interval and total trades (strategy becomes complete)
    log('\n📝 Step 3: User provides final parameters...', colors.blue);
    const response3 = await controller.processMessage(
      sessionId,
      '1. interval: 1 minute\n2. Total Trade: 2'
    );
    
    log(`\nStrategy after step 3:`, colors.yellow);
    log(`  - Is Complete: ${response3.suggestedStrategy?.config?.isComplete}`, colors.yellow);
    log(`  - Confidence: ${response3.suggestedStrategy?.confidence}`, colors.yellow);
    log(`  - Has strategyId: ${!!response3.strategyId}`, colors.yellow);
    log(`  - Actions: ${response3.actions}`, colors.yellow);
    
    // Verify the strategy was updated to complete
    if (!response3.suggestedStrategy?.config?.isComplete) {
      log('\n❌ FAIL: Strategy should be complete after providing all parameters', colors.red);
      log(`   Config: ${JSON.stringify(response3.suggestedStrategy?.config, null, 2)}`, colors.red);
      return false;
    }
    
    // Verify simulation started
    const simulationStarted = response3.actions?.includes('simulation_running') ||
                             response3.message?.includes('Simulation is now running');
    
    if (!simulationStarted) {
      log('\n❌ FAIL: Auto-simulation should have triggered', colors.red);
      log(`   Actions: ${response3.actions}`, colors.red);
      log(`   Message preview: ${response3.message?.substring(0, 200)}`, colors.red);
      return false;
    }
    
    log('\n✅ PASS: Strategy correctly transitioned from incomplete to complete!', colors.green);
    log('✅ PASS: Auto-simulation triggered successfully!', colors.green);
    return true;
    
  } catch (error) {
    log(`\n❌ ERROR: ${error}`, colors.red);
    console.error(error);
    return false;
  }
}

// Run test
testStrategyCompletionUpdate().then(success => {
  process.exit(success ? 0 : 1);
});
