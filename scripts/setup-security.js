#!/usr/bin/env node

/**
 * Security Setup Script
 * 
 * This script helps you set up AWS Secrets Manager for the trading bot.
 * 
 * Usage:
 *   npm run security:setup
 */

const readline = require('readline');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function execCommand(command, description) {
  console.log(`\n🔄 ${description}...`);
  try {
    const output = execSync(command, { encoding: 'utf-8' });
    console.log(`✅ Success!`);
    return output;
  } catch (error) {
    console.error(`❌ Failed: ${error.message}`);
    throw error;
  }
}

async function checkAWSCLI() {
  try {
    execSync('aws --version', { encoding: 'utf-8' });
    console.log('✅ AWS CLI is installed');
    return true;
  } catch (error) {
    console.error('❌ AWS CLI is not installed');
    console.log('\n📥 Please install AWS CLI:');
    console.log('   Windows: https://awscli.amazonaws.com/AWSCLIV2.msi');
    console.log('   Mac: brew install awscli');
    console.log('   Linux: sudo apt-get install awscli');
    return false;
  }
}

async function checkAWSCredentials() {
  try {
    const identity = execSync('aws sts get-caller-identity', { encoding: 'utf-8' });
    console.log('✅ AWS credentials are configured');
    console.log(identity);
    return true;
  } catch (error) {
    console.error('❌ AWS credentials are not configured');
    console.log('\n🔧 Please configure AWS CLI:');
    console.log('   Run: aws configure');
    console.log('   You will need:');
    console.log('   - AWS Access Key ID');
    console.log('   - AWS Secret Access Key');
    console.log('   - Default region (e.g., us-east-1)');
    return false;
  }
}

async function createWalletSecret(region) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📝 CREATE WALLET PRIVATE KEY SECRET');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const secretName = await question('\nSecret name [trading-bot/wallet-private-key]: ') || 'trading-bot/wallet-private-key';
  const privateKey = await question('Wallet private key (Base58): ');
  
  if (!privateKey) {
    console.error('❌ Private key is required');
    return false;
  }

  const secretValue = JSON.stringify({ privateKey });
  
  try {
    execCommand(
      `aws secretsmanager create-secret --name "${secretName}" --description "Trading bot wallet private key" --secret-string '${secretValue}' --region ${region}`,
      'Creating wallet secret in AWS Secrets Manager'
    );
    console.log(`✅ Secret created: ${secretName}`);
    return true;
  } catch (error) {
    if (error.message.includes('ResourceExistsException')) {
      console.log('⚠️  Secret already exists');
      const update = await question('Do you want to update it? (y/N): ');
      if (update.toLowerCase() === 'y') {
        try {
          execCommand(
            `aws secretsmanager update-secret --secret-id "${secretName}" --secret-string '${secretValue}' --region ${region}`,
            'Updating wallet secret'
          );
          console.log(`✅ Secret updated: ${secretName}`);
          return true;
        } catch (updateError) {
          console.error(`❌ Failed to update secret: ${updateError.message}`);
          return false;
        }
      }
    }
    return false;
  }
}

async function createAPIKeysSecret(region) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 CREATE API KEYS SECRET');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const secretName = await question('\nSecret name [trading-bot/api-keys]: ') || 'trading-bot/api-keys';
  
  console.log('\n📋 Enter your API keys (press Enter to skip):');
  const geminiKey = await question('GEMINI_API_KEY: ');
  const helioKey = await question('HELIO_API_KEY: ');
  const biconomyKey = await question('BICONOMY_API_KEY: ');
  
  const apiKeys = {};
  if (geminiKey) apiKeys.GEMINI_API_KEY = geminiKey;
  if (helioKey) apiKeys.HELIO_API_KEY = helioKey;
  if (biconomyKey) apiKeys.BICONOMY_API_KEY = biconomyKey;
  
  if (Object.keys(apiKeys).length === 0) {
    console.log('⚠️  No API keys provided, skipping...');
    return true;
  }

  const secretValue = JSON.stringify(apiKeys);
  
  try {
    execCommand(
      `aws secretsmanager create-secret --name "${secretName}" --description "Trading bot API keys" --secret-string '${secretValue}' --region ${region}`,
      'Creating API keys secret in AWS Secrets Manager'
    );
    console.log(`✅ Secret created: ${secretName}`);
    console.log(`   Stored keys: ${Object.keys(apiKeys).join(', ')}`);
    return true;
  } catch (error) {
    if (error.message.includes('ResourceExistsException')) {
      console.log('⚠️  Secret already exists');
      const update = await question('Do you want to update it? (y/N): ');
      if (update.toLowerCase() === 'y') {
        try {
          execCommand(
            `aws secretsmanager update-secret --secret-id "${secretName}" --secret-string '${secretValue}' --region ${region}`,
            'Updating API keys secret'
          );
          console.log(`✅ Secret updated: ${secretName}`);
          console.log(`   Stored keys: ${Object.keys(apiKeys).join(', ')}`);
          return true;
        } catch (updateError) {
          console.error(`❌ Failed to update secret: ${updateError.message}`);
          return false;
        }
      }
    }
    return false;
  }
}

async function updateEnvFile() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚙️  UPDATE .ENV FILE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const envPath = path.join(__dirname, '..', '.env');
  const envExamplePath = path.join(__dirname, '..', '.env.example');
  
  if (!fs.existsSync(envPath)) {
    console.log('📄 .env file not found, creating from .env.example...');
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      console.log('✅ Created .env file');
    } else {
      console.error('❌ .env.example not found');
      return false;
    }
  }

  const update = await question('\nDo you want to update .env with security settings? (Y/n): ');
  if (update.toLowerCase() === 'n') {
    console.log('⏭️  Skipping .env update');
    return true;
  }

  let envContent = fs.readFileSync(envPath, 'utf-8');
  
  // Update or add USE_SECRETS_MANAGER
  if (envContent.includes('USE_SECRETS_MANAGER=')) {
    envContent = envContent.replace(/USE_SECRETS_MANAGER=.*/g, 'USE_SECRETS_MANAGER=true');
  } else {
    envContent += '\nUSE_SECRETS_MANAGER=true\n';
  }
  
  // Update or add ENABLE_APPROVAL_WORKFLOW
  if (envContent.includes('ENABLE_APPROVAL_WORKFLOW=')) {
    envContent = envContent.replace(/ENABLE_APPROVAL_WORKFLOW=.*/g, 'ENABLE_APPROVAL_WORKFLOW=true');
  } else {
    envContent += 'ENABLE_APPROVAL_WORKFLOW=true\n';
  }
  
  fs.writeFileSync(envPath, envContent);
  console.log('✅ Updated .env file');
  console.log('   - USE_SECRETS_MANAGER=true');
  console.log('   - ENABLE_APPROVAL_WORKFLOW=true');
  
  return true;
}

async function testConnection(region) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 TEST SECRETS MANAGER CONNECTION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const test = await question('\nDo you want to test the connection? (Y/n): ');
  if (test.toLowerCase() === 'n') {
    console.log('⏭️  Skipping test');
    return true;
  }

  try {
    execCommand(
      `aws secretsmanager list-secrets --region ${region}`,
      'Listing secrets in AWS Secrets Manager'
    );
    console.log('✅ Connection test successful!');
    return true;
  } catch (error) {
    console.error('❌ Connection test failed');
    return false;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   🔐 SECURITY SETUP WIZARD                ║');
  console.log('║   Trading Bot - AWS Secrets Manager       ║');
  console.log('╚════════════════════════════════════════════╝\n');

  console.log('This wizard will help you:');
  console.log('  1. ✅ Verify AWS CLI installation');
  console.log('  2. ✅ Check AWS credentials');
  console.log('  3. 🔐 Create wallet private key secret');
  console.log('  4. 🔑 Create API keys secret');
  console.log('  5. ⚙️  Update .env file');
  console.log('  6. 🧪 Test connection\n');

  const proceed = await question('Ready to proceed? (Y/n): ');
  if (proceed.toLowerCase() === 'n') {
    console.log('👋 Setup cancelled');
    rl.close();
    return;
  }

  // Step 1: Check AWS CLI
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 STEP 1: CHECK AWS CLI');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const hasAWSCLI = await checkAWSCLI();
  if (!hasAWSCLI) {
    rl.close();
    return;
  }

  // Step 2: Check AWS Credentials
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 STEP 2: CHECK AWS CREDENTIALS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const hasCredentials = await checkAWSCredentials();
  if (!hasCredentials) {
    rl.close();
    return;
  }

  // Get AWS region
  const region = await question('\nAWS Region [us-east-1]: ') || 'us-east-1';

  // Step 3: Create wallet secret
  await createWalletSecret(region);

  // Step 4: Create API keys secret
  await createAPIKeysSecret(region);

  // Step 5: Update .env file
  await updateEnvFile();

  // Step 6: Test connection
  await testConnection(region);

  // Summary
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   ✅ SETUP COMPLETE!                      ║');
  console.log('╚════════════════════════════════════════════╝\n');
  
  console.log('📋 Next Steps:');
  console.log('   1. Review your .env file');
  console.log('   2. Install dependencies: npm install');
  console.log('   3. Build the project: npm run build');
  console.log('   4. Test the setup: npm run test');
  console.log('   5. Start the server: npm start\n');
  
  console.log('📚 Documentation:');
  console.log('   - SECURITY_SETUP_GUIDE.md');
  console.log('   - PRODUCTION_READINESS_REPORT.md');
  console.log('   - AREAS_OF_IMPROVEMENT.md\n');
  
  console.log('⚠️  IMPORTANT REMINDERS:');
  console.log('   - Never commit .env to git');
  console.log('   - Start with small test amounts (< 0.1 SOL)');
  console.log('   - Monitor approval requests regularly');
  console.log('   - Review security settings before production\n');
  
  console.log('🎉 Happy trading!\n');

  rl.close();
}

// Run the wizard
main().catch(error => {
  console.error(`\n❌ Setup failed: ${error.message}`);
  rl.close();
  process.exit(1);
});
