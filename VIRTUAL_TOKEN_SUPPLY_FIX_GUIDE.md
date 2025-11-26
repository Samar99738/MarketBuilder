# Virtual Token Supply Fix - Implementation Guide

## Problem Summary
When a user specifies they have a token supply (e.g., "15 million tokens"), the virtual balance always shows a hardcoded 100,000 tokens instead of the user-specified amount. The system needs to dynamically use the user's specified supply value throughout the entire flow.

## Root Cause Analysis
The issue occurs because:
1. User specifies supply in natural language (e.g., "15 million")
2. `strategyParser.ts` extracts this and converts to actual units (15,000,000)
3. BUT the initial token balance is hardcoded to 100,000 in `StrategyExecutionManager.ts`
4. The supply value gets lost in the data flow between parsing and session creation

## Data Flow Chain
```
User Message → strategyParser.ts → agentController.ts → StrategyExecutionManager.ts → PaperTradingEngine.ts → UI
```

---

## FILES TO UPDATE

### FILE 1: `/mnt/project/strategyParser.ts`
**Location:** Line 806 (inside `parseReactiveStrategy` method)
**Current Code:**
```typescript
supply: supply ? supply * 1000000 : undefined, // Convert millions to actual units
```

**Problem:** The code multiplies by 1,000,000, assuming the extracted number is in millions. However, the `extractNumber` method may already return the full number.

**Fix:** Add better number extraction that handles "15 million", "15M", "15000000" correctly

**REPLACE:**
```typescript
// Extract supply/amount
const supply = this.extractNumber(text, ['supply', 'have', 'holding', 'own', 'million', 'thousand'], undefined);
```

**WITH:**
```typescript
// Extract supply/amount with better parsing
const supply = this.extractSupply(text);
```

**ADD THIS NEW METHOD** (after line 825):
```typescript
/**
 * Extract token supply from text with intelligent unit parsing
 * Handles: "15 million", "15M", "15000000", etc.
 */
private extractSupply(text: string): number | undefined {
  const lowerText = text.toLowerCase();
  
  // Pattern 1: Explicit "X million" or "X M"
  const millionMatch = lowerText.match(/(\d+(?:\.\d+)?)\s*(?:million|m\b)/i);
  if (millionMatch) {
    const value = parseFloat(millionMatch[1]) * 1000000;
    console.log(`💰 [extractSupply] Found: ${millionMatch[1]} million = ${value.toLocaleString()} tokens`);
    return value;
  }
  
  // Pattern 2: Explicit "X thousand" or "X K"
  const thousandMatch = lowerText.match(/(\d+(?:\.\d+)?)\s*(?:thousand|k\b)/i);
  if (thousandMatch) {
    const value = parseFloat(thousandMatch[1]) * 1000;
    console.log(`💰 [extractSupply] Found: ${thousandMatch[1]} thousand = ${value.toLocaleString()} tokens`);
    return value;
  }
  
  // Pattern 3: Large raw numbers (> 1000) after supply keywords
  const supplyKeywords = ['supply', 'have', 'holding', 'own', 'tokens'];
  for (const keyword of supplyKeywords) {
    const pattern = new RegExp(`${keyword}[:\\s]+([\\d,]+)`, 'i');
    const match = text.match(pattern);
    if (match) {
      const rawValue = match[1].replace(/,/g, '');
      const value = parseFloat(rawValue);
      if (!isNaN(value) && value > 0) {
        console.log(`💰 [extractSupply] Found: ${value.toLocaleString()} tokens after "${keyword}"`);
        return value;
      }
    }
  }
  
  // Fallback: Try generic number extraction
  const genericSupply = this.extractNumber(text, supplyKeywords, undefined);
  if (genericSupply) {
    // If number is less than 1000, assume it's in millions
    const value = genericSupply < 1000 ? genericSupply * 1000000 : genericSupply;
    console.log(`💰 [extractSupply] Fallback: ${genericSupply} → ${value.toLocaleString()} tokens`);
    return value;
  }
  
  return undefined;
}
```

**THEN UPDATE** line 806:
```typescript
supply: supply, // Already in correct units from extractSupply
```

---

### FILE 2: `/mnt/project/StrategyExecutionManager.ts`
**Location:** Line 270-280 (in `executeStrategy` method)

**Current Code:**
```typescript
initialBalanceTokens: isSellStrategy 
  ? ((strategy as any).initialTokenBalance || (strategy as any).config?.supply || (strategy.variables as any)?.supply || (strategy.variables as any)?.initialSupply || 100000)
  : 0,
```

**Problem:** The fallback value of 100,000 always gets used because the supply is stored in `config.supply` but accessed incorrectly.

**REPLACE WITH:**
```typescript
// For SELL strategies, get initial token balance from multiple sources with proper priority
initialBalanceTokens: isSellStrategy 
  ? this.extractInitialTokenBalance(strategy)
  : 0,
```

**ADD THIS NEW METHOD** (after the `executeStrategy` method, around line 400):
```typescript
/**
 * Extract initial token balance with intelligent fallback priority
 * Priority: config.supply > initialTokenBalance > variables.supply > 100K fallback
 */
private extractInitialTokenBalance(strategy: any): number {
  const sources = [
    { name: 'config.supply', value: strategy.config?.supply },
    { name: 'initialTokenBalance', value: strategy.initialTokenBalance },
    { name: 'variables.supply', value: (strategy.variables as any)?.supply },
    { name: 'variables.initialSupply', value: (strategy.variables as any)?.initialSupply },
  ];
  
  console.log(`🔍 [extractInitialTokenBalance] Checking token balance sources:`);
  for (const source of sources) {
    console.log(`   ${source.name}: ${source.value || 'undefined'}`);
    if (source.value && source.value > 0) {
      console.log(`✅ [extractInitialTokenBalance] Using ${source.name} = ${source.value.toLocaleString()} tokens`);
      return source.value;
    }
  }
  
  console.warn(`⚠️ [extractInitialTokenBalance] No supply found, using fallback: 100,000 tokens`);
  return 100000;
}
```

---

### FILE 3: `/mnt/project/StrategyTemplates.ts`
**Location:** Line 1420-1445 (in `createReactiveMirrorStrategy` function)

**Current Code:**
```typescript
const strategy = strategyBuilder.createStrategy(
  config.id,
  `Reactive Mirror ${actionName} Strategy`,
  `${config.description} - Monitors for ${triggerAction} activity and mirrors with ${config.side} orders`,
  {
    _strategyConfig: {
      trigger: config.trigger,
      side: config.side,
      sizingRule: config.sizingRule,
      tokenAddress: config.tokenAddress
    },
    supply: config.supply, // Pass supply through to variables
    initialSupply: config.supply // Also store as initialSupply
  }
);
```

**Problem:** The supply is stored in variables but not directly on the strategy config where `PaperTradingEngine` expects it.

**REPLACE WITH:**
```typescript
const strategy = strategyBuilder.createStrategy(
  config.id,
  `Reactive Mirror ${actionName} Strategy`,
  `${config.description} - Monitors for ${triggerAction} activity and mirrors with ${config.side} orders`,
  {
    _strategyConfig: {
      trigger: config.trigger,
      side: config.side,
      sizingRule: config.sizingRule,
      tokenAddress: config.tokenAddress,
      supply: config.supply // CRITICAL: Add supply to config
    },
    supply: config.supply, // Pass supply through to variables
    initialSupply: config.supply, // Also store as initialSupply
    initialTokenBalance: config.supply // CRITICAL: Also store as initialTokenBalance
  }
);
```

**AND UPDATE** the strategy builder call to attach config to strategy object (around line 1465):
```typescript
// CRITICAL FIX: Attach tokenAddress and supply to strategy object
const builtStrategy = strategyBuilder.getStrategy(config.id)!;
builtStrategy.tokenAddress = config.tokenAddress;
// CRITICAL: Attach config with supply so StrategyExecutionManager can access it
(builtStrategy as any).config = {
  ...config,
  supply: config.supply,
  initialTokenBalance: config.supply
};
```

---

### FILE 4: `/mnt/project/PaperTradingEngine.ts`
**Location:** Line 140-165 (in `createSession` method)

**Current Code:**
```typescript
// For sell strategies that start with tokens, initialize virtual position
if (initialTokenBalance && initialTokenBalance > 0 && tokenAddress) {
  // ... initialization code ...
}
```

**Problem:** The logging doesn't clearly show which source provided the initial balance.

**ENHANCE LOGGING** by replacing lines 140-145:
```typescript
// For sell strategies that start with tokens, initialize virtual position
if (initialTokenBalance && initialTokenBalance > 0 && tokenAddress) {
  console.log(`\n💰 ========== INITIAL TOKEN POSITION SETUP ==========`);
  console.log(`💰 Token Address: ${tokenAddress}`);
  console.log(`💰 Initial Balance: ${initialTokenBalance.toLocaleString()} tokens`);
  console.log(`💰 Source: User-specified supply from strategy config`);
  console.log(`💰 Session ID: ${sessionId}`);
  console.log(`💰 ==================================================\n`);
```

**Location:** Line 600-650 (in auto-init logic inside `executeSell` method)

**Current Code:**
```typescript
// CRITICAL FIX: Dynamic initial balance with intelligent defaults
const userSpecifiedBalance = (config as any).initialTokenBalance;
const strategySupply = config.supply;
```

**Problem:** The priority order doesn't match the new data structure.

**REPLACE** the entire auto-init priority logic (lines 600-620) with:
```typescript
// CRITICAL FIX: Dynamic initial balance with intelligent priority
// Priority: 1) config.supply 2) initialTokenBalance 3) Detected mirror amount 4) Default 1M
const configSupply = config.supply;
const initialTokenBalance = (config as any).initialTokenBalance;
const strategyConfigSupply = context.strategyConfig?.supply;
const detectedMirrorAmount = context.variables.realTradeTokenAmount;

let initialBalance: number;
let balanceSource: string;

if (configSupply && configSupply > 0) {
  // Priority 1: Use config.supply (from parsed strategy)
  initialBalance = parseFloat(configSupply.toString());
  balanceSource = `config.supply (${initialBalance.toLocaleString()})`;
} else if (initialTokenBalance && initialTokenBalance > 0) {
  // Priority 2: Use initialTokenBalance
  initialBalance = parseFloat(initialTokenBalance.toString());
  balanceSource = `initialTokenBalance (${initialBalance.toLocaleString()})`;
} else if (strategyConfigSupply && strategyConfigSupply > 0) {
  // Priority 3: Use strategy config supply
  initialBalance = parseFloat(strategyConfigSupply.toString());
  balanceSource = `strategyConfig.supply (${initialBalance.toLocaleString()})`;
} else if (detectedMirrorAmount && detectedMirrorAmount >= 1000) {
  // Priority 4: Calculate from detected mirror amount
  initialBalance = Math.ceil(detectedMirrorAmount * 50);
  balanceSource = `calculated from mirror (${detectedMirrorAmount.toLocaleString()} x 50)`;
} else {
  // Priority 5: Absolute last fallback
  initialBalance = 1000000;
  balanceSource = 'default fallback (1M)';
}

console.log(`\n💰 ========== AUTO-INIT TOKEN BALANCE ==========`);
console.log(`💰 Final Balance: ${initialBalance.toLocaleString()} tokens`);
console.log(`💰 Source: ${balanceSource}`);
console.log(`💰 Token: ${tokenAddress.substring(0, 8)}...`);
console.log(`💰 ============================================\n`);
```

---

### FILE 5: `/mnt/project/agent.html`
**Location:** Lines 850-900 (in `updateVirtualBalance` function)

**Current Issue:** The UI correctly receives and displays the balance, but we should add better logging to verify the data flow.

**ENHANCE** the balance update function (around line 870):
```typescript
// Priority 1: Use primaryToken if available (most reliable)
if (data.primaryToken && data.primaryToken.symbol && data.primaryToken.symbol !== 'USDC') {
    const tokenBalance = data.primaryToken.balance || 0;
    const tokenSymbol = data.primaryToken.symbol;

    if (tokenElement) {
        tokenElement.textContent = tokenBalance.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    if (tokenLabelElement) {
        tokenLabelElement.textContent = tokenSymbol;
    }

    console.log(`✅ [TOKEN] Updated to: ${tokenBalance.toLocaleString()} ${tokenSymbol}`);
    console.log(`✅ [TOKEN] Data source: primaryToken from WebSocket event`);
}
```

---

## TESTING PROCEDURE

### Test Case 1: 15 Million Token Supply
**User Input:**
```
I've this token:9BB6NFEcjBCtnNLFko2FqVQBqHHM13kcyCdGbqpump , and I've the supply of 15 million and I want to sell the token at the exactly same price at which people are buying on the real-time.
```

**Expected Results:**
1. **Terminal Logs:**
   ```
   💰 [extractSupply] Found: 15 million = 15,000,000 tokens
   ✅ [extractInitialTokenBalance] Using config.supply = 15,000,000 tokens
   💰 ========== INITIAL TOKEN POSITION SETUP ==========
   💰 Initial Balance: 15,000,000 tokens
   ```

2. **UI Display:**
   - Virtual Token Balance: `15,000,000.00 Fartcoin` (not 100,000.00)
   - Virtual SOL: `10.0000 SOL`

3. **After SELL Trade:**
   - Virtual Token: Should DECREASE from 15M
   - Virtual SOL: Should INCREASE

4. **After BUY Trade:**
   - Virtual Token: Should INCREASE
   - Virtual SOL: Should DECREASE

### Test Case 2: 500K Token Supply
**User Input:**
```
Token: ABC123..., supply: 500000, sell when people buy
```

**Expected Results:**
1. Terminal: `Using config.supply = 500,000 tokens`
2. UI: Virtual Token Balance shows `500,000.00`

### Test Case 3: No Supply Specified (BUY Strategy)
**User Input:**
```
Buy 0.01 SOL of token ABC123... every time someone sells
```

**Expected Results:**
1. Terminal: `Initial token balance = 0` (buy strategy)
2. UI: Virtual Token Balance shows `0.00` initially
3. After BUY: Token balance increases, SOL decreases

---

## VALIDATION CHECKLIST

After implementing all changes:

- [ ] User-specified supply (millions) correctly parsed
- [ ] User-specified supply (raw numbers) correctly parsed
- [ ] Supply value flows from parser → controller → executor → engine
- [ ] UI displays correct initial token balance
- [ ] SELL trades decrease token balance and increase SOL
- [ ] BUY trades increase token balance and decrease SOL
- [ ] No hardcoded 100K fallback when supply is specified
- [ ] Comprehensive logging at each stage
- [ ] Works for both reactive/mirror strategies
- [ ] Works for contrarian volatility strategies

---

## CRITICAL REMINDERS

1. **Units Matter**: Always check if numbers are in millions, thousands, or raw units
2. **Data Flow**: Supply must flow through: parser → config → strategy → execution manager → paper trading engine
3. **Priority Order**: config.supply should be the PRIMARY source, not a fallback
4. **Logging**: Add extensive logging at EVERY stage to track the supply value
5. **Testing**: Test with various formats: "15 million", "15M", "15000000"

---

## Quick Reference: Supply Data Path

```
USER MESSAGE
    ↓
strategyParser.extractSupply()  →  returns 15000000
    ↓
parseReactiveStrategy()  →  config.supply = 15000000
    ↓
agentController  →  passes config to StrategyExecutionManager
    ↓
StrategyExecutionManager.executeStrategy()  →  initialConfig.initialTokenBalance = strategy.config.supply
    ↓
PaperTradingEngine.createSession()  →  initialTokenBalance = mergedConfig.initialTokenBalance
    ↓
Creates position with 15M tokens
    ↓
Emits to UI  →  primaryToken.balance = 15000000
    ↓
UI displays: 15,000,000.00 Fartcoin
```

---

## Summary of Changes

| File | Lines | Change Type | Description |
|------|-------|-------------|-------------|
| strategyParser.ts | 750 + new method | Add + Modify | New `extractSupply()` method with intelligent unit parsing |
| StrategyExecutionManager.ts | 270-280 + new method | Modify + Add | Fix priority order, add `extractInitialTokenBalance()` |
| StrategyTemplates.ts | 1420-1465 | Modify | Attach supply to strategy config properly |
| PaperTradingEngine.ts | 140-145, 600-620 | Enhance | Better logging and priority order |
| agent.html | 870 | Enhance | Better logging for balance updates |

---

## Support

If issues persist after implementation:
1. Check terminal logs for "💰 [extractSupply]" messages
2. Verify supply value at each stage with console.logs
3. Check WebSocket events with browser DevTools Network tab
4. Ensure no TypeScript compilation errors
5. Clear browser cache and restart server
