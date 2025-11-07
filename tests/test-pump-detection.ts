import { Connection } from '@solana/web3.js';
import { getTokenRouter } from '../src/trading_utils/TokenRouter';
import { getPumpFunAPI } from '../src/trading_utils/PumpFunAPI';

async function testPumpDetection() {
  console.log('🧪 Testing Pump.fun Token Detection (Advanced)...\n');

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const router = getTokenRouter(connection);
  const pumpAPI = getPumpFunAPI(connection);

  // Get a real pump.fun token from trending
  console.log('Step 1: Fetching trending pump.fun token...');
  const trending = await pumpAPI.getTrendingTokens(1);
  
  if (trending.length === 0) {
    console.log('⚠️  No trending tokens available, skipping pump detection test');
    return;
  }

  const pumpToken = trending[0].mint || trending[0].address;
  console.log(`✅ Got pump token: ${pumpToken}\n`);

  // Test routing
  console.log('Step 2: Testing token routing...');
  const route = await router.route(pumpToken);
  
  console.log(`📍 Routing Result:`);
  console.log(`   Engine: ${route.engine}`);
  console.log(`   Token Type: ${route.tokenInfo.type}`);
  console.log(`   Is Valid: ${route.tokenInfo.isValid}`);
  console.log(`   Reason: ${route.reason}`);
  
  if (route.tokenInfo.metadata) {
    console.log(`   Is Pump Token: ${route.tokenInfo.metadata.isPumpToken}`);
    console.log(`   Is Graduated: ${route.tokenInfo.metadata.isGraduated || false}`);
    if (route.tokenInfo.metadata.bondingCurveAddress) {
      console.log(`   Bonding Curve: ${route.tokenInfo.metadata.bondingCurveAddress.substring(0, 20)}...`);
    }
  }

  console.log('\n🎉 Pump.fun detection test completed!');
  
  if (route.engine === 'pumpfun') {
    console.log('✅ Token correctly identified as pump.fun token!');
  } else if (route.tokenInfo.metadata?.isGraduated) {
    console.log('✅ Token correctly identified as graduated (will use Jupiter)!');
  } else {
    console.log('⚠️  Token routing decision:', route.reason);
  }
}

testPumpDetection().catch(console.error);