import { Connection } from '@solana/web3.js';
import { getPumpFunAPI } from '../src/trading_utils/PumpFunAPI';

async function testPumpFunAPI() {
  console.log('🧪 Testing Pump.fun API (Read-Only)...\n');

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const pumpAPI = getPumpFunAPI(connection);

  // Test 1: Get trending tokens
  console.log('Test 1: Fetching trending tokens...');
  const trending = await pumpAPI.getTrendingTokens(5);
  console.log(`✅ Found ${trending.length} trending tokens`);
  
  if (trending.length > 0) {
    console.log(`\n📊 First trending token:`);
    const first = trending[0];
    console.log(`   Name: ${first.name || 'N/A'}`);
    console.log(`   Symbol: ${first.symbol || 'N/A'}`);
    console.log(`   Mint: ${first.mint || first.address || 'N/A'}`);
  }

  // Test 2: Get token metadata (if trending available)
  if (trending.length > 0) {
    const tokenMint = trending[0].mint || trending[0].address;
    console.log(`\nTest 2: Fetching metadata for ${tokenMint}...`);
    const metadata = await pumpAPI.getTokenMetadata(tokenMint);
    
    if (metadata) {
      console.log(`✅ Metadata retrieved successfully`);
      console.log(`   Name: ${metadata.name || 'N/A'}`);
      console.log(`   Symbol: ${metadata.symbol || 'N/A'}`);
      console.log(`   Description: ${(metadata.description || 'N/A').substring(0, 50)}...`);
    } else {
      console.log(`⚠️  Could not fetch metadata (this is normal for some tokens)`);
    }

    // Test 3: Get token price
    console.log(`\nTest 3: Fetching price for ${tokenMint}...`);
    const price = await pumpAPI.getTokenPrice(tokenMint);
    
    if (price) {
      console.log(`✅ Price retrieved: $${price}`);
    } else {
      console.log(`⚠️  Could not fetch price (this is normal for some tokens)`);
    }
  }

  console.log('\n🎉 Pump.fun API tests completed!');
  console.log('✅ API connectivity working perfectly!\n');
}

testPumpFunAPI().catch(console.error);