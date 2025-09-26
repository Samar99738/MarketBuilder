#!/usr/bin/env node

/**
 * PRODUCTION DEPLOYMENT SCRIPT
 * 
 * Handles secure deployment to production environment with proper validation
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENVIRONMENTS = {
  development: {
    name: 'Development',
    safe: true,
    description: 'Safe testing environment using devnet'
  },
  production: {
    name: 'Production',
    safe: false,
    description: '🚨 REAL MONEY - Mainnet trading environment'
  },
  staging: {
    name: 'Staging',
    safe: true,
    description: 'Pre-production testing environment'
  }
};

async function main() {
  console.log('🚀 Market Maker Production Deployment Tool\n');
  
  // Get target environment
  const environment = process.argv[2] || 'development';
  
  if (!ENVIRONMENTS[environment]) {
    console.error(`❌ Invalid environment: ${environment}`);
    console.log(`Available environments: ${Object.keys(ENVIRONMENTS).join(', ')}`);
    process.exit(1);
  }
  
  const env = ENVIRONMENTS[environment];
  
  console.log(`📋 Deploying to: ${env.name}`);
  console.log(`📝 Description: ${env.description}\n`);
  
  // Production safety check
  if (!env.safe) {
    console.log('WARNING: You are deploying to PRODUCTION (real money)!');
    console.log('This will trade with actual SOL on Solana mainnet.');
    console.log('Make sure you have:\n');
    console.log('   • Tested thoroughly on devnet');
    console.log('   • Verified your wallet private key');
    console.log('   • Confirmed your trading parameters');
    console.log('   • Set appropriate risk limits\n');
    
    // Wait for user confirmation in production
    if (process.env.CI !== 'true') {
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const answer = await new Promise(resolve => {
        readline.question('Type "I UNDERSTAND" to continue: ', resolve);
      });
      
      readline.close();
      
      if (answer !== 'I UNDERSTAND') {
        console.log('❌ Deployment cancelled for safety');
        process.exit(1);
      }
    }
  }
  
  try {
    console.log('Validating environment configuration...');
    await validateEnvironment(environment);
    
    console.log('Building application...');
    await buildApplication();
    
    console.log('Running pre-deployment tests...');
    await runTests();
    
    console.log('Starting application...');
    await startApplication(environment);
    
    console.log(`Deployment completed successfully!`);
    console.log(`Monitor your application at: http://localhost:3000/api/performance`);
    
    if (!env.safe) {
      console.log('\n PRODUCTION DEPLOYMENT ACTIVE');
      console.log('Your bot is now trading with real money!');
      console.log('Monitor performance: http://localhost:3000/api/performance');
      console.log('Stop trading: Ctrl+C or kill the process');
    }
    
  } catch (error) {
    console.error('❌ Deployment failed:', error.message);
    process.exit(1);
  }
}

async function validateEnvironment(environment) {
  const envFile = `.env.${environment}`;
  const envPath = path.resolve(process.cwd(), envFile);
  
  // Check if environment file exists
  if (!fs.existsSync(envPath)) {
    throw new Error(`Environment file ${envFile} not found. Please create it from .env.example`);
  }
  
  // Load and validate environment variables
  require('dotenv').config({ path: envPath });
  
  const requiredVars = [
    'WALLET_PRIVATE_KEY',
    'TOKEN_ADDRESS', 
    'RPC_ENDPOINT',
    'BUY_AMOUNT_SOL',
    'SLIPPAGE_BPS'
  ];
  
  const missingVars = requiredVars.filter(varName => {
    const value = process.env[varName];
    return !value || value.includes('your_') || value.includes('_here');
  });
  
  if (missingVars.length > 0) {
    throw new Error(`Missing or placeholder values for: ${missingVars.join(', ')}`);
  }
  
  // Validate specific values
  if (environment === 'production' && process.env.RPC_ENDPOINT?.includes('devnet')) {
    throw new Error('Production environment cannot use devnet RPC endpoint');
  }
  
  if (parseFloat(process.env.BUY_AMOUNT_SOL || '0') <= 0) {
    throw new Error('BUY_AMOUNT_SOL must be greater than 0');
  }
  
  console.log('Environment validation passed');
}

async function buildApplication() {
  try {
    execSync('npm run build', { stdio: 'inherit' });
    console.log('Build completed successfully');
  } catch (error) {
    throw new Error('Build failed. Please fix TypeScript errors and try again.');
  }
}

async function runTests() {
  try {
    // Basic connectivity test
    const { Connection } = require('@solana/web3.js');
    const connection = new Connection(process.env.RPC_ENDPOINT);
    
    const version = await connection.getVersion();
    console.log(`RPC connection successful (version: ${version['solana-core']})`);
    
    // Validate wallet can be loaded
    if (process.env.WALLET_PRIVATE_KEY) {
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58');
      
      let wallet;
      if (process.env.WALLET_PRIVATE_KEY.includes(',')) {
        const keyArray = process.env.WALLET_PRIVATE_KEY.split(',').map(n => parseInt(n.trim()));
        wallet = Keypair.fromSecretKey(new Uint8Array(keyArray));
      } else {
        wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
      }
      
      console.log(`Wallet loaded: ${wallet.publicKey.toString()}`);
      
      // Check balance
      const balance = await connection.getBalance(wallet.publicKey);
      const balanceSOL = balance / 1e9;
      console.log(`Wallet balance: ${balanceSOL.toFixed(6)} SOL`);
      
      if (balanceSOL < parseFloat(process.env.BUY_AMOUNT_SOL || '0')) {
        console.warn(`Wallet balance (${balanceSOL.toFixed(6)} SOL) is less than BUY_AMOUNT_SOL (${process.env.BUY_AMOUNT_SOL} SOL)`);
      }
    }
    
  } catch (error) {
    throw new Error(`Pre-deployment tests failed: ${error.message}`);
  }
}

async function startApplication(environment) {
  // Set NODE_ENV for the application
  process.env.NODE_ENV = environment;
  
  console.log(`Starting application in ${environment} mode...`);
  console.log('Use Ctrl+C to stop the application\n');
  
  // Start the application
  execSync('npm start', { stdio: 'inherit' });
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { validateEnvironment, buildApplication, runTests };