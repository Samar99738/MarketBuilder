/**
 * Test for token sell functionality
 */
import { paperTradingEngine } from '../src/trading_utils/paper-trading/PaperTradingEngine';
import { marketDataProvider } from '../src/trading_utils/paper-trading/MarketDataProvider';

async function testTokenSell() {
  console.log('🧪 Testing TOKEN → SOL sell functionality...\n');
  
  // Step 1: Create session with tokens
  const sessionId = 'test-sell-' + Date.now();
  const tokenAddress = '4VUSvsACrG38GnUN7HAgBqFbx64yr7mvGRWgNt8Ppump';
  
  console.log('📝 Creating paper trading session...');
  const session = await paperTradingEngine.createSession(
    sessionId,
    'test-user',
    'test-strategy',
    {
      initialBalanceSOL: 1,
      initialBalanceTokens: 100000,
      tokenAddress: tokenAddress
    }
  );
  
  console.log('✅ Session created:');
  console.log(`   - SOL Balance: ${session.portfolio.balanceSOL}`);
  console.log(`   - Token Balance: ${session.portfolio.balanceTokens}`);
  console.log(`   - Token Address: ${tokenAddress}\n`);
  
  // Step 2: Fetch token price
  console.log('📊 Fetching token price...');
  const marketData = await marketDataProvider.fetchTokenPrice(tokenAddress);
  
  if (!marketData) {
    console.error('❌ Failed to fetch token price');
    return;
  }
  
  console.log('✅ Token price:');
  console.log(`   - Price: ${marketData.price} SOL`);
  console.log(`   - USD: $${marketData.priceUSD}\n`);
  
  // Step 3: Execute sell
  console.log('💰 Executing sell: 1000 tokens...');
  const sellResult = await paperTradingEngine.executeSell(
    sessionId,
    tokenAddress,
    1000, // Sell 1000 tokens
    'test-strategy',
    'Test Strategy',
    'manual_test'
  );
  
  if (!sellResult.success) {
    console.error('❌ Sell failed:', sellResult.error);
    return;
  }
  
  console.log('✅ Sell executed successfully!');
  console.log(`   - Trade ID: ${sellResult.trade?.id}`);
  console.log(`   - Tokens sold: ${sellResult.trade?.amountTokens}`);
  console.log(`   - SOL received: ${sellResult.trade?.amountSOL}`);
  console.log(`   - Realized P&L: ${sellResult.trade?.realizedPnL} SOL\n`);
  
  // Step 4: Check final balances
  const finalSession = paperTradingEngine.getSession(sessionId);
  
  if (finalSession) {
    console.log('📊 Final balances:');
    console.log(`   - SOL Balance: ${finalSession.portfolio.balanceSOL}`);
    console.log(`   - Token Balance: ${finalSession.portfolio.balanceTokens}`);
    console.log(`   - Total Value USD: $${finalSession.metrics.totalValueUSD}\n`);
  }
  
  console.log('✅ Test completed successfully!');
}

// Run test
testTokenSell().catch(console.error);
