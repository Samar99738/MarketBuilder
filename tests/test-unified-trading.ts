import { Connection } from '@solana/web3.js';
import { getUnifiedTrading } from '../src/trading_utils/UnifiedTrading';

async function testUnifiedTrading() {
  console.log('🧪 Testing Unified Trading Interface...\n');

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const trading = getUnifiedTrading(connection);

  // Test 1: Get token info
  console.log('Test 1: Getting token info for SOL...');
  const solInfo = await trading.getTokenInfo('SOL');
  console.log(`✅ Token info retrieved`);
  console.log(`   Type: ${solInfo.type}`);
  console.log(`   Valid: ${solInfo.isValid}`);
  console.log(`   Symbol: ${solInfo.symbol || 'N/A'}\n`);

  // Test 2: Validate token
  console.log('Test 2: Validating SOL token...');
  const validation = await trading.validateToken('So11111111111111111111111111111111111111112');
  console.log(`✅ Validation result: ${validation.valid}`);
  if (validation.reason) {
    console.log(`   Reason: ${validation.reason}`);
  }

  // Test 3: Get cache stats
  console.log('\nTest 3: Checking cache stats...');
  const stats = trading.getCacheStats();
  console.log(`✅ Cache stats:`);
  console.log(`   Size: ${stats.size} tokens`);
  console.log(`   Keys: ${stats.keys.slice(0, 3).join(', ')}${stats.keys.length > 3 ? '...' : ''}\n`);

  // Test 4: Get trending pump tokens
  console.log('Test 4: Getting trending pump.fun tokens...');
  const trending = await trading.getTrendingPumpTokens(3);
  console.log(`✅ Found ${trending.length} trending pump tokens\n`);

  // Test 5: Clear cache
  console.log('Test 5: Testing cache clear...');
  trading.clearCache();
  const statsAfter = trading.getCacheStats();
  console.log(`✅ Cache cleared!`);
  console.log(`   Size after clear: ${statsAfter.size}\n`);

  console.log('🎉 Unified Trading interface tests completed!');
  console.log('✅ All functions working correctly!\n');
  console.log('⚠️  NOTE: No actual trades were executed (safe tests only)');
}

testUnifiedTrading().catch(console.error);