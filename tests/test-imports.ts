// Test all imports
import { TRADING_CONFIG, PUMPFUN_CONFIG, ROUTING_CONFIG, RISK_CONFIG } from '../src/trading_utils/config';
import { getTokenRouter, TokenType } from '../src/trading_utils/TokenRouter';
import { getPumpFunAPI } from '../src/trading_utils/PumpFunAPI';
import { getUnifiedTrading } from '../src/trading_utils/UnifiedTrading';
import { PUMP_FUN_PROGRAM_ID } from '../src/trading_utils/PumpFunIntegration';
import { Connection } from '@solana/web3.js';

console.log('🧪 Testing Module Imports...\n');

// Test 1: Config imports
console.log('✅ Config imported successfully');
console.log(`   PUMPFUN_ENABLED: ${PUMPFUN_CONFIG.ENABLED}`);
console.log(`   DEFAULT_SLIPPAGE: ${PUMPFUN_CONFIG.DEFAULT_SLIPPAGE}%`);
console.log(`   PROGRAM_ID: ${PUMPFUN_CONFIG.PROGRAM_ID}`);

// Test 2: Router import
console.log('\n✅ TokenRouter imported successfully');
console.log(`   TokenType.PUMP_FUN: ${TokenType.PUMP_FUN}`);
console.log(`   TokenType.JUPITER: ${TokenType.JUPITER}`);

// Test 3: PUMP_FUN_PROGRAM_ID import
console.log('\n✅ PUMP_FUN_PROGRAM_ID imported successfully');
console.log(`   Program ID: ${PUMP_FUN_PROGRAM_ID.toString()}`);

// Test 4: Create instances
const connection = new Connection('https://api.mainnet-beta.solana.com');
const router = getTokenRouter(connection);
const pumpAPI = getPumpFunAPI(connection);
const trading = getUnifiedTrading(connection);

console.log('\n✅ All modules instantiated successfully');
console.log('   - TokenRouter: Ready');
console.log('   - PumpFunAPI: Ready');
console.log('   - UnifiedTrading: Ready');

console.log('\n🎉 All imports working perfectly!');