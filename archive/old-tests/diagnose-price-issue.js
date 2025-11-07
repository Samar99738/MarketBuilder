/**
 * Diagnostic Script: Figure out why AI keeps returning $231.50
 */

async function diagnoseIssue() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🔬 Price Issue Diagnostic Tool');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('📋 Checking potential issues:\n');

  // 1. Check if TypeScript is compiled
  const fs = require('fs');
  const path = require('path');

  console.log('1️⃣  Checking TypeScript compilation...');
  const distExists = fs.existsSync(path.join(__dirname, 'dist'));
  if (distExists) {
    console.log('   ✅ dist/ folder exists');
    const agentControllerExists = fs.existsSync(path.join(__dirname, 'dist', 'agent', 'agentController.js'));
    if (agentControllerExists) {
      console.log('   ✅ Compiled agentController.js exists');
      
      // Check if compiled code has our fix
      const compiledCode = fs.readFileSync(path.join(__dirname, 'dist', 'agent', 'agentController.js'), 'utf8');
      if (compiledCode.includes('isFreshSession')) {
        console.log('   ✅ Compiled code includes isFreshSession fix');
      } else {
        console.log('   ❌ Compiled code MISSING isFreshSession fix');
        console.log('   ⚠️  PROBLEM: TypeScript not recompiled!');
        console.log('   💡 Solution: Run "npm run build" to recompile TypeScript\n');
        return 'need_recompile';
      }
    } else {
      console.log('   ❌ agentController.js not found in dist/');
    }
  } else {
    console.log('   ⚠️  dist/ folder not found (might be using ts-node)');
  }

  console.log('\n2️⃣  Checking if server is using ts-node or compiled code...');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const startScript = packageJson.scripts?.start || '';
  console.log(`   Start script: ${startScript}`);
  
  if (startScript.includes('ts-node')) {
    console.log('   ✅ Using ts-node (reads TypeScript directly)');
    console.log('   💡 Server should pick up changes after restart\n');
  } else if (startScript.includes('node dist')) {
    console.log('   ⚠️  Using compiled JavaScript from dist/');
    console.log('   💡 You MUST run "npm run build" before restart\n');
    return 'need_build';
  }

  console.log('3️⃣  Testing actual API response...\n');
  
  try {
    const timestamp = Date.now();
    const response = await fetch('http://localhost:3000/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What is the current price of SOL?',
        sessionId: `diagnose-${timestamp}`,
      }),
    });

    const data = await response.json();
    
    if (data.success) {
      const hasOldPrice = data.data.message.includes('231.50');
      
      if (hasOldPrice) {
        console.log('   ❌ Still returning $231.50\n');
        
        console.log('4️⃣  Checking system prompt construction...');
        console.log('   The issue is likely in one of these areas:\n');
        console.log('   a) TokenUtils.getSolPriceUSD() not being called');
        console.log('   b) Price not being passed to buildSystemPrompt()');
        console.log('   c) AI model has $231.50 hardcoded in training data');
        console.log('   d) System prompt not overriding AI knowledge\n');
        
        return 'ai_ignoring_prompt';
      } else {
        console.log('   ✅ Price fix is working!\n');
        return 'working';
      }
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}\n`);
    return 'server_error';
  }
}

async function provideSolution(diagnosis) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  💡 SOLUTION');
  console.log('═══════════════════════════════════════════════════════\n');

  switch (diagnosis) {
    case 'need_recompile':
      console.log('⚠️  TypeScript changes NOT compiled to JavaScript!\n');
      console.log('Run these commands:');
      console.log('1️⃣  npm run build       # Compile TypeScript');
      console.log('2️⃣  npm start           # Restart server\n');
      break;

    case 'need_build':
      console.log('⚠️  Server uses compiled code from dist/ folder\n');
      console.log('Run these commands:');
      console.log('1️⃣  npm run build       # Compile TypeScript to dist/');
      console.log('2️⃣  npm start           # Restart server\n');
      break;

    case 'ai_ignoring_prompt':
      console.log('⚠️  AI model is IGNORING the system prompt!\n');
      console.log('This is a tough problem. The AI has strong prior knowledge');
      console.log('that $231.50 is "the price of SOL" (probably from training data).\n');
      console.log('Possible solutions:\n');
      console.log('Option 1: Post-process AI response');
      console.log('   - Intercept AI response');
      console.log('   - Replace $231.50 with real-time price\n');
      console.log('Option 2: Use function calling');
      console.log('   - Force AI to call a price function');
      console.log('   - Make price fetching mandatory\n');
      console.log('Option 3: Different prompting strategy');
      console.log('   - Ask AI to acknowledge the price first');
      console.log('   - Then answer the question\n');
      console.log('I can implement Option 1 (easiest) right now.\n');
      break;

    case 'working':
      console.log('🎉 Price fix is working correctly!\n');
      console.log('The AI is now returning real-time prices.\n');
      break;

    case 'server_error':
      console.log('⚠️  Cannot connect to server\n');
      console.log('Make sure server is running: npm start\n');
      break;
  }

  console.log('═══════════════════════════════════════════════════════\n');
}

async function main() {
  const diagnosis = await diagnoseIssue();
  await provideSolution(diagnosis);
}

main().catch(console.error);
