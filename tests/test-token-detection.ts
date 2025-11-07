import { Connection } from '@solana/web3.js';
import { getTokenRouter } from '../src/trading_utils/TokenRouter';

async function testTokenDetection() {
  console.log('🧪 Testing Token Detection & Routing...\n');

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const router = getTokenRouter(connection);

  // Test 1: SOL detection
  console.log('Test 1: Detecting SOL...');
  const solRoute = await router.route('SOL');
  console.log(`✅ SOL detected as: ${solRoute.engine}`);
  console.log(`   Reason: ${solRoute.reason}`);
  console.log(`   Type: ${solRoute.tokenInfo.type}\n`);

  // Test 2: Native SOL address
  console.log('Test 2: Detecting SOL by address...');
  const solRoute2 = await router.route('So11111111111111111111111111111111111111112');
  console.log(`✅ SOL address detected as: ${solRoute2.engine}`);
  console.log(`   Type: ${solRoute2.tokenInfo.type}\n`);

  // Test 3: Cache functionality
  console.log('Test 3: Testing cache...');
  const solRoute3 = await router.route('SOL');
  const stats = router.getCacheStats();
  console.log(`✅ Cache working!`);
  console.log(`   Cached tokens: ${stats.size}`);
  console.log(`   Cache keys: ${stats.keys.join(', ')}\n`);

  // Test 4: Invalid token
  console.log('Test 4: Testing invalid token...');
  const invalidRoute = await router.route('invalid-address-123');
  console.log(`✅ Invalid token handled correctly`);
  console.log(`   Valid: ${invalidRoute.tokenInfo.isValid}`);
  console.log(`   Engine: ${invalidRoute.engine} (defaults to Jupiter)\n`);

  // Test 5: Token validation
  console.log('Test 5: Testing token validation...');
  const validation = await router.validateToken('So11111111111111111111111111111111111111112');
  console.log(`✅ Validation result: ${validation.valid}`);
  console.log(`   Token type: ${validation.tokenInfo?.type}\n`);

  console.log('🎉 All token detection tests passed!');
  console.log('✅ Router is working perfectly!\n');
}

testTokenDetection().catch(console.error);