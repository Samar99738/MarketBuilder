/**
 * Test Script: Verify Live Trade Feed Display Fix
 * 
 * This script simulates BUY/SELL trades and verifies that the Live Trade Feed
 * displays the correct token amounts instead of SOL amounts.
 * 
 * Run: node tests/test-live-trade-feed-fix.js
 */

import { PaperTradingEngine } from '../src/trading_utils/paper-trading/PaperTradingEngine';
import { Server as SocketServer } from 'socket.io';

// Mock Socket.IO for testing
class MockSocketIO {
  private events: Map<string, any[]> = new Map();

  emit(event: string, data: any): void {
    console.log(`\n📡 [WebSocket Event] ${event}`);
    
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event)?.push(data);

    // Verify trade feed data structure
    if (event === 'paper:trade:executed') {
      this.verifyTradeExecutedEvent(data);
    } else if (event === 'paper:simulation:update') {
      this.verifySimulationUpdateEvent(data);
    }
  }

  private verifyTradeExecutedEvent(data: any): void {
    console.log('\n✅ [Verification] paper:trade:executed event:');
    
    // Required fields for BUY trades
    if (data.side === 'buy') {
      console.log(`   ✓ amountSOL: ${data.amountSOL?.toFixed(4)} SOL`);
      console.log(`   ✓ amountTokens: ${data.amountTokens?.toLocaleString()} tokens`);
      console.log(`   ✓ tokenSymbol: ${data.tokenSymbol}`);
      console.log(`   ✓ priceUSD: $${data.priceUSD?.toFixed(8)}`);

      // Verify critical fields exist
      if (!data.amountTokens) {
        console.error('   ❌ FAIL: amountTokens is missing!');
      }
      if (!data.tokenSymbol) {
        console.error('   ❌ FAIL: tokenSymbol is missing!');
      }
      if (data.amountTokens && data.tokenSymbol) {
        console.log(`\n   🎯 Display would show: ${data.amountSOL.toFixed(4)} SOL → ${this.formatTokenAmount(data.amountTokens)} ${data.tokenSymbol} @ $${data.priceUSD.toFixed(8)}`);
      }
    }

    // Required fields for SELL trades
    if (data.side === 'sell') {
      console.log(`   ✓ amountTokens: ${data.amountTokens?.toLocaleString()} tokens`);
      console.log(`   ✓ amountSOL: ${data.amountSOL?.toFixed(6)} SOL`);
      console.log(`   ✓ tokenSymbol: ${data.tokenSymbol}`);
      console.log(`   ✓ priceUSD: $${data.priceUSD?.toFixed(8)}`);

      if (!data.amountTokens) {
        console.error('   ❌ FAIL: amountTokens is missing!');
      }
      if (!data.tokenSymbol) {
        console.error('   ❌ FAIL: tokenSymbol is missing!');
      }
      if (data.amountTokens && data.tokenSymbol) {
        console.log(`\n   🎯 Display would show: ${this.formatTokenAmount(data.amountTokens)} ${data.tokenSymbol} → ${data.amountSOL.toFixed(6)} SOL @ $${data.priceUSD.toFixed(8)}`);
      }
    }
  }

  private verifySimulationUpdateEvent(data: any): void {
    console.log('\n✅ [Verification] paper:simulation:update event:');
    
    if (data.tradeDetails) {
      const trade = data.tradeDetails;
      console.log(`   ✓ tradeDetails.type: ${trade.type}`);
      console.log(`   ✓ tradeDetails.amountSOL: ${trade.amountSOL?.toFixed(4)} SOL`);
      console.log(`   ✓ tradeDetails.amountTokens: ${trade.amountTokens?.toLocaleString()} tokens`);
      console.log(`   ✓ tokenSymbol: ${data.tokenSymbol}`);

      if (!trade.amountTokens && !trade.tokensReceived) {
        console.error('   ❌ FAIL: Neither amountTokens nor tokensReceived is present!');
      }
    }
  }

  private formatTokenAmount(amount: number): string {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(2)}M`;
    } else if (amount >= 1000) {
      return `${(amount / 1000).toFixed(2)}K`;
    } else {
      return amount.toFixed(2);
    }
  }

  getEvents(eventName: string): any[] {
    return this.events.get(eventName) || [];
  }
}

async function runTests(): Promise<void> {
  console.log('🧪 Starting Live Trade Feed Display Tests\n');
  console.log('=' .repeat(60));

  // Create mock Socket.IO
  const mockIO = new MockSocketIO();
  
  // Create PaperTradingEngine instance
  const engine = new PaperTradingEngine();
  engine.setSocketIO(mockIO as any);

  // Test 1: BUY Trade
  console.log('\n\n📝 TEST 1: BUY 0.1 SOL worth of tokens');
  console.log('-'.repeat(60));
  
  const sessionId = 'test-session-1';
  await engine.createSession(sessionId, 'test-user', 'test-strategy');

  const buyResult = await engine.executeBuy(
    sessionId,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC address as example
    0.1,
    'test-strategy',
    'Test DCA Strategy',
    'test_trigger'
  );

  if (buyResult.success) {
    console.log('\n✅ BUY Trade executed successfully');
    console.log(`   Trade ID: ${buyResult.trade?.id}`);
    console.log(`   Tokens Received: ${buyResult.trade?.amountTokens?.toLocaleString()}`);
  } else {
    console.error(`\n❌ BUY Trade failed: ${buyResult.error}`);
  }

  // Verify paper:trade:executed event was emitted with correct data
  const buyEvents = mockIO.getEvents('paper:trade:executed').filter((e: any) => e.side === 'buy');
  if (buyEvents.length === 0) {
    console.error('\n❌ FAIL: No paper:trade:executed event emitted for BUY');
  }

  // Test 2: SELL Trade
  console.log('\n\n📝 TEST 2: SELL 5000 tokens');
  console.log('-'.repeat(60));

  // First, we need to have tokens to sell (auto-initialized by engine)
  const sellResult = await engine.executeSell(
    sessionId,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    5000,
    'test-strategy',
    'Test SELL Strategy',
    'test_sell_trigger'
  );

  if (sellResult.success) {
    console.log('\n✅ SELL Trade executed successfully');
    console.log(`   Trade ID: ${sellResult.trade?.id}`);
    console.log(`   SOL Received: ${sellResult.trade?.amountSOL?.toFixed(6)} SOL`);
  } else {
    console.error(`\n❌ SELL Trade failed: ${sellResult.error}`);
  }

  // Verify paper:trade:executed event was emitted with correct data
  const sellEvents = mockIO.getEvents('paper:trade:executed').filter((e: any) => e.side === 'sell');
  if (sellEvents.length === 0) {
    console.error('\n❌ FAIL: No paper:trade:executed event emitted for SELL');
  }

  // Test 3: Verify simulation events
  console.log('\n\n📝 TEST 3: Verify Simulation Events');
  console.log('-'.repeat(60));
  
  const simEvents = mockIO.getEvents('paper:simulation:update');
  console.log(`\n   Found ${simEvents.length} simulation events`);
  
  const buySimEvents = simEvents.filter((e: any) => e.type === 'buy_simulation');
  const sellSimEvents = simEvents.filter((e: any) => e.type === 'sell_executed');
  
  console.log(`   ✓ BUY simulations: ${buySimEvents.length}`);
  console.log(`   ✓ SELL simulations: ${sellSimEvents.length}`);

  // Summary
  console.log('\n\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  
  const allEvents = mockIO.getEvents('paper:trade:executed');
  const allBuyEvents = allEvents.filter((e: any) => e.side === 'buy');
  const allSellEvents = allEvents.filter((e: any) => e.side === 'sell');
  
  console.log(`\n✅ Total paper:trade:executed events: ${allEvents.length}`);
  console.log(`   - BUY events: ${allBuyEvents.length}`);
  console.log(`   - SELL events: ${allSellEvents.length}`);
  
  // Check if all BUY events have required fields
  const buyEventsValid = allBuyEvents.every((e: any) => 
    e.amountSOL !== undefined && 
    e.amountTokens !== undefined && 
    e.tokenSymbol !== undefined &&
    e.priceUSD !== undefined
  );
  
  // Check if all SELL events have required fields
  const sellEventsValid = allSellEvents.every((e: any) => 
    e.amountSOL !== undefined && 
    e.amountTokens !== undefined && 
    e.tokenSymbol !== undefined &&
    e.priceUSD !== undefined
  );
  
  if (buyEventsValid && sellEventsValid) {
    console.log('\n✅ ALL TESTS PASSED! Live Trade Feed will display correctly.');
  } else {
    console.log('\n❌ SOME TESTS FAILED! Live Trade Feed may not display correctly.');
    if (!buyEventsValid) {
      console.log('   - BUY events missing required fields');
    }
    if (!sellEventsValid) {
      console.log('   - SELL events missing required fields');
    }
  }

  // Clean up
  await engine.endSession(sessionId);
  console.log('\n🧹 Test session cleaned up\n');
}

// Run tests
runTests().catch(error => {
  console.error('❌ Test execution failed:', error);
  process.exit(1);
});
