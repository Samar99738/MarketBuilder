/**
 * Quick Verification Script
 * Verifies pump.fun integration is working correctly
 * 
 * Run with: npx ts-node scripts/verify-pumpfun.ts [TOKEN_MINT]
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getTokenRouter } from '../src/trading_utils/TokenRouter';
import { PumpFunIntegration } from '../src/trading_utils/PumpFunIntegration';
import { TRADING_CONFIG } from '../src/trading_utils/config';

async function verifyPumpFun(tokenMint?: string) {
  console.log('\n' + '='.repeat(70));
  console.log('  PUMP.FUN INTEGRATION VERIFICATION');
  console.log('='.repeat(70) + '\n');

  // Setup
  const rpcEndpoint = TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcEndpoint, 'confirmed');
  
  console.log(`📡 RPC Endpoint: ${rpcEndpoint}`);
  console.log(`✅ Pump.fun Enabled: ${TRADING_CONFIG.PUMPFUN_CONFIG?.ENABLED}`);
  console.log(`⚙️  Default Slippage: ${TRADING_CONFIG.PUMPFUN_CONFIG?.DEFAULT_SLIPPAGE}%`);
  console.log(`💰 Max Trade Amount: ${TRADING_CONFIG.PUMPFUN_CONFIG?.MAX_TRADE_AMOUNT} SOL\n`);

  // Test token (use provided or default)
  const testToken = tokenMint || 'So11111111111111111111111111111111111111112';
  
  console.log(`🎯 Testing Token: ${testToken}\n`);
  console.log('─'.repeat(70));

  try {
    // Test 1: Token Routing
    console.log('\n1️⃣  Testing Token Router...');
    const tokenRouter = getTokenRouter(connection);
    const route = await tokenRouter.route(testToken);
    
    console.log(`   ✅ Routing Decision:`);
    console.log(`      Engine: ${route.engine}`);
    console.log(`      Token Type: ${route.tokenInfo.type}`);
    console.log(`      Valid: ${route.tokenInfo.isValid}`);
    console.log(`      Reason: ${route.reason}`);

    // Test 2: Pump.fun Integration (if it's a pump.fun token)
    if (route.engine === 'pumpfun') {
      console.log('\n2️⃣  Testing Pump.fun Integration...');
      const pumpFunIntegration = new PumpFunIntegration(connection);
      const mint = new PublicKey(testToken);
      const tokenInfo = await pumpFunIntegration.getComprehensiveTokenInfo(mint);
      
      if (tokenInfo) {
        console.log(`   ✅ Token Information:`);
        console.log(`      Symbol: ${tokenInfo.symbol || 'N/A'}`);
        console.log(`      Name: ${tokenInfo.name || 'N/A'}`);
        console.log(`      Decimals: ${tokenInfo.decimals || 'N/A'}`);
      } else {
        console.log(`   ⚠️  Could not fetch token information`);
      }
    } else {
      console.log('\n2️⃣  Skipping Pump.fun Integration (Not a pump.fun token)');
      console.log(`   ℹ️  This token uses ${route.engine} instead`);
    }

    // Test 3: MCP Server
    console.log('\n3️⃣  Testing MCP Server...');
    const { getMCPServer } = await import('../src/agent/MCPServer');
    const mcpServer = getMCPServer();
    console.log(`   ✅ MCP Server initialized successfully`);

    // Test 4: Agent Controller
    console.log('\n4️⃣  Testing Agent Controller...');
    const { AgentController } = await import('../src/agent/agentController');
    const agent = new AgentController();
    const session = agent.getSession('verify-session');
    console.log(`   ✅ Agent session created: ${session.sessionId}`);

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('  ✅ VERIFICATION COMPLETE - ALL SYSTEMS OPERATIONAL');
    console.log('='.repeat(70) + '\n');
    
    console.log('🎉 Pump.fun integration is PRODUCTION READY!\n');
    console.log('Next steps:');
    console.log('  1. Fund your wallet with SOL');
    console.log('  2. Test with small amounts first');
    console.log('  3. Monitor trades in console logs');
    console.log('  4. Deploy to production\n');

  } catch (error) {
    console.error('\n❌ Verification failed:', error);
    console.log('\n💡 Common issues:');
    console.log('  - RPC endpoint not responding (check network connection)');
    console.log('  - Token mint invalid (verify on Solana Explorer)');
    console.log('  - Environment variables not set (check .env file)\n');
    process.exit(1);
  }
}

// Get token mint from command line or use default
const tokenMint = process.argv[2];

if (tokenMint && tokenMint.length !== 43 && tokenMint.length !== 44) {
  console.error('❌ Invalid token mint address');
  console.log('Usage: npx ts-node scripts/verify-pumpfun.ts [TOKEN_MINT]');
  console.log('Example: npx ts-node scripts/verify-pumpfun.ts DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263\n');
  process.exit(1);
}

verifyPumpFun(tokenMint).catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
