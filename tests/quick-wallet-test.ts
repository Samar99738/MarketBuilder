/**
 * Quick test to verify "list my wallet" now works correctly
 * Run with: npx ts-node tests/quick-wallet-test.ts
 */

import { MCPToolExecutor } from '../MCPServer/Mcptoolexecutor';
import { Connection } from '@solana/web3.js';
import { TRADING_CONFIG } from '../src/trading_utils/config';

async function testListAccounts() {
  console.log('🧪 Testing listAccounts tool...\n');
  
  const connection = new Connection(
    TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );
  
  const executor = new MCPToolExecutor(connection);
  
  try {
    const result = await executor.executeTool('listAccounts', {}, 'test-session');
    
    console.log('📋 Result:\n');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('\n✅ SUCCESS! Tool returns wallet data correctly.');
      console.log(`\nFound ${result.data?.count || 0} account(s)`);
      
      if (result.data?.accounts && result.data.accounts.length > 0) {
        console.log('\n📱 Accounts:');
        result.data.accounts.forEach((acc: any) => {
          console.log(`\n  Name: ${acc.name}`);
          console.log(`  Address: ${acc.publicKey}`);
          console.log(`  Balance: ${acc.formatted?.balance || '0 SOL'}`);
          console.log(`  Status: ${acc.status}`);
          console.log(`  Default: ${acc.isDefault ? 'Yes ⭐' : 'No'}`);
        });
      }
      
      if (result.data?.defaultAccount) {
        console.log(`\n⭐ Default Account: ${result.data.defaultAccount}`);
      }
    } else {
      console.log('\n❌ Tool returned error:', result.error);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testListAccounts().then(() => {
  console.log('\n✅ Test completed!');
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
