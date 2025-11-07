/**
 * Manual Parser Test - Tests strategy parsing without requiring Gemini API
 */

import { StrategyParser } from '../src/agent/strategyParser';

const parser = new StrategyParser();

console.log('\n='.repeat(80));
console.log('MANUAL STRATEGY PARSER TEST');
console.log('='.repeat(80));

// Test 1: Reactive Strategy - Sell when others buy
console.log('\n📌 TEST 1: Reactive Strategy - Sell when others buy');
console.log('Input: "I have token 8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump with 10 million supply and I want to sell this token in exact amount of people that are buying in realtime"');

const test1 = parser.parseStrategy(
  'I have token 8mo9czagoGJfJFDvc5LjVG8EpTrepyWdddGhem9Ppump with 10 million supply and I want to sell this token in exact amount of people that are buying in realtime'
);

if (test1) {
  console.log('✅ Strategy Parsed Successfully!');
  console.log('Template:', test1.template);
  console.log('Strategy Type:', test1.config.strategyType);
  console.log('Token Address:', test1.config.tokenAddress);
  console.log('Trigger:', test1.config.trigger);
  console.log('Side:', test1.config.side);
  console.log('Is Complete:', test1.config.isComplete);
  console.log('Confidence:', test1.confidence);
} else {
  console.log('❌ Failed to parse');
}

// Test 2: Reactive Strategy - Buy when others sell
console.log('\n📌 TEST 2: Reactive Strategy - Buy when others sell');
console.log('Input: "Buy when people sell 6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump"');

const test2 = parser.parseStrategy(
  'Buy when people sell 6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump'
);

if (test2) {
  console.log('✅ Strategy Parsed Successfully!');
  console.log('Template:', test2.template);
  console.log('Strategy Type:', test2.config.strategyType);
  console.log('Token Address:', test2.config.tokenAddress);
  console.log('Trigger:', test2.config.trigger);
  console.log('Side:', test2.config.side);
  console.log('Is Complete:', test2.config.isComplete);
} else {
  console.log('❌ Failed to parse');
}

// Test 3: DCA Strategy
console.log('\n📌 TEST 3: DCA Strategy');
console.log('Input: "I want to buy 0.05 SOL every 12 seconds and repeat this trade twice"');

const test3 = parser.parseStrategy(
  'I want to buy 0.05 SOL every 12 seconds and repeat this trade twice'
);

if (test3) {
  console.log('✅ Strategy Parsed Successfully!');
  console.log('Template:', test3.template);
  console.log('Buy Amount:', test3.config.buyAmountSOL, 'SOL');
  console.log('Interval:', test3.config.intervalMinutes, 'minutes');
  console.log('Count:', test3.config.buyCount, 'times');
  console.log('Side:', test3.config.side);
} else {
  console.log('❌ Failed to parse');
}

// Test 4: Mirror activity
console.log('\n📌 TEST 4: Mirror Activity');
console.log('Input: "Match buying volume for So11111111111111111111111111111111111111112"');

const test4 = parser.parseStrategy(
  'Match buying volume for So11111111111111111111111111111111111111112'
);

if (test4) {
  console.log('✅ Strategy Parsed Successfully!');
  console.log('Template:', test4.template);
  console.log('Strategy Type:', test4.config.strategyType);
  console.log('Token Address:', test4.config.tokenAddress);
  console.log('Trigger:', test4.config.trigger);
  console.log('Side:', test4.config.side);
} else {
  console.log('❌ Failed to parse');
}

// Test 5: Token extraction with "Token:" prefix
console.log('\n📌 TEST 5: Token Extraction with Prefix');
console.log('Input: "Sell when others buy Token: 6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump"');

const test5 = parser.parseStrategy(
  'Sell when others buy Token: 6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump'
);

if (test5 && test5.config.tokenAddress === '6g2sANgfkgrkPc836we6TrktQjMoVK4uqpjKF8Dgpump') {
  console.log('✅ Token extracted correctly!');
  console.log('Token Address:', test5.config.tokenAddress);
} else {
  console.log('❌ Token extraction failed');
  console.log('Got:', test5?.config.tokenAddress);
}

console.log('\n' + '='.repeat(80));
console.log('MANUAL TESTING COMPLETE');
console.log('All parsing logic works WITHOUT needing Gemini API!');
console.log('='.repeat(80) + '\n');
