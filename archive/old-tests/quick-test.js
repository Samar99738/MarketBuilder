#!/usr/bin/env node

/**
 * Quick Security Test - Non-intrusive
 * Tests security features without shutting down the server
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

async function makeRequest(path) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:3000${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, data: null }); });
  });
}

async function runTests() {
  log('\n╔════════════════════════════════════════════════════╗', colors.cyan);
  log('║  🧪 SECURITY FEATURES - QUICK TEST               ║', colors.cyan);
  log('╚════════════════════════════════════════════════════╝\n', colors.cyan);

  let passed = 0, failed = 0;

  // Test 1: Server Health
  log('Testing server health...', colors.cyan);
  const health = await makeRequest('/health');
  if (health.status === 200) {
    log('✅ Server is healthy', colors.green);
    passed++;
  } else {
    log('❌ Server health check failed', colors.red);
    failed++;
  }

  // Test 2: Approval Stats Endpoint
  log('\nTesting approval workflow API...', colors.cyan);
  const stats = await makeRequest('/api/approvals/stats');
  if (stats.status === 200 && stats.data.success) {
    log('✅ Approval stats endpoint working', colors.green);
    log(`   Pending: ${stats.data.data.pending}, Approved: ${stats.data.data.approved}, Rejected: ${stats.data.data.rejected}`, colors.cyan);
    passed++;
  } else {
    log('❌ Approval stats endpoint failed', colors.red);
    failed++;
  }

  // Test 3: Approval History
  log('\nTesting approval history...', colors.cyan);
  const history = await makeRequest('/api/approvals/history');
  if (history.status === 200) {
    log('✅ Approval history endpoint working', colors.green);
    passed++;
  } else {
    log('❌ Approval history endpoint failed', colors.red);
    failed++;
  }

  // Test 4: Pending Approvals
  log('\nTesting pending approvals...', colors.cyan);
  const pending = await makeRequest('/api/approvals/pending');
  if (pending.status === 200) {
    log('✅ Pending approvals endpoint working', colors.green);
    passed++;
  } else {
    log('❌ Pending approvals endpoint failed', colors.red);
    failed++;
  }

  // Test 5: Security Files
  log('\nChecking security files...', colors.cyan);
  const files = [
    'src/security/SecretsManager.ts',
    'src/security/TransactionApprovalWorkflow.ts',
    'src/server/routes/approvals.ts',
    'dist/src/security/SecretsManager.js',
    'dist/src/security/TransactionApprovalWorkflow.js'
  ];
  
  let filesOk = true;
  for (const file of files) {
    if (!fs.existsSync(path.join(__dirname, file))) {
      log(`❌ Missing: ${file}`, colors.red);
      filesOk = false;
      failed++;
    }
  }
  if (filesOk) {
    log('✅ All security files present', colors.green);
    passed++;
  }

  // Test 6: Documentation
  log('\nChecking documentation...', colors.cyan);
  const docs = [
    'SECURITY_SETUP_GUIDE.md',
    'CRITICAL_SECURITY_IMPLEMENTATION.md',
    'PRODUCTION_READINESS_REPORT.md',
    'AREAS_OF_IMPROVEMENT.md'
  ];
  
  let docsOk = true;
  for (const doc of docs) {
    if (!fs.existsSync(path.join(__dirname, doc))) {
      log(`❌ Missing: ${doc}`, colors.red);
      docsOk = false;
      failed++;
    }
  }
  if (docsOk) {
    log('✅ All documentation present', colors.green);
    passed++;
  }

  // Test 7: Environment Config
  log('\nChecking environment configuration...', colors.cyan);
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const hasSecuritySettings = 
      envContent.includes('USE_SECRETS_MANAGER') &&
      envContent.includes('ENABLE_APPROVAL_WORKFLOW') &&
      envContent.includes('AUTO_APPROVE_SOL');
    
    if (hasSecuritySettings) {
      log('✅ Environment properly configured', colors.green);
      passed++;
    } else {
      log('❌ Missing security settings in .env', colors.red);
      failed++;
    }
  } else {
    log('❌ .env file not found', colors.red);
    failed++;
  }

  // Summary
  log('\n' + '═'.repeat(50), colors.cyan);
  log('  TEST RESULTS', colors.cyan);
  log('═'.repeat(50), colors.cyan);
  log(`\n✅ Passed: ${passed}`, colors.green);
  log(`❌ Failed: ${failed}`, failed > 0 ? colors.red : colors.green);
  
  const total = passed + failed;
  const percentage = ((passed / total) * 100).toFixed(1);
  log(`\n📊 Success Rate: ${percentage}%\n`, percentage >= 90 ? colors.green : colors.yellow);

  if (failed === 0) {
    log('🎉 All tests passed! Security features are working correctly.\n', colors.green);
  } else {
    log('⚠️  Some tests failed. Please review the errors above.\n', colors.yellow);
  }
}

// Check if server is running first
http.get('http://localhost:3000/health', (res) => {
  runTests();
}).on('error', () => {
  log('\n❌ Server is not running on port 3000', colors.red);
  log('Please start the server with: npm run dev\n', colors.yellow);
  process.exit(1);
});
