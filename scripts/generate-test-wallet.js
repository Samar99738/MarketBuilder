#!/usr/bin/env node

/**
 * Quick Test Wallet Generator
 * Generates a new Solana wallet for development/testing
 */

const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

console.log('\n🔑 Generating test wallet for development...\n');

// Generate new keypair
const keypair = Keypair.generate();

// Get private key in Base58 format
const privateKeyBase58 = bs58.encode(keypair.secretKey);

// Get public key
const publicKey = keypair.publicKey.toString();

console.log('━'.repeat(60));
console.log('✅ Test Wallet Generated Successfully!');
console.log('━'.repeat(60));
console.log('\n📋 Wallet Details:\n');
console.log(`Public Key:  ${publicKey}`);
console.log(`\nPrivate Key (Base58):\n${privateKeyBase58}`);
console.log('\n━'.repeat(60));
console.log('⚠️  IMPORTANT: This is a TEST wallet for DEVELOPMENT only!');
console.log('━'.repeat(60));
console.log('\n📝 Next Steps:\n');
console.log('1. Copy the private key above');
console.log('2. Update your .env file:');
console.log(`   WALLET_PRIVATE_KEY=${privateKeyBase58}`);
console.log('\n3. For testing, you can get free devnet SOL:');
console.log('   • Visit: https://faucet.solana.com/');
console.log(`   • Request airdrop to: ${publicKey}`);
console.log('\n4. Start the server: npm run dev\n');

// Ask if user wants to automatically update .env
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Would you like to automatically update your .env file? (y/N): ', (answer) => {
  if (answer.toLowerCase() === 'y') {
    try {
      const envPath = path.join(__dirname, '.env');
      let envContent = '';
      
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
        
        // Replace the placeholder or existing key
        if (envContent.includes('WALLET_PRIVATE_KEY=')) {
          envContent = envContent.replace(
            /WALLET_PRIVATE_KEY=.*/,
            `WALLET_PRIVATE_KEY=${privateKeyBase58}`
          );
        } else {
          envContent += `\nWALLET_PRIVATE_KEY=${privateKeyBase58}\n`;
        }
        
        fs.writeFileSync(envPath, envContent);
        console.log('\n✅ Updated .env file with new wallet private key');
        console.log('🚀 You can now run: npm run dev\n');
      } else {
        console.log('\n❌ .env file not found');
        console.log('📝 Please create .env from .env.example first\n');
      }
    } catch (error) {
      console.log(`\n❌ Failed to update .env: ${error.message}\n`);
    }
  } else {
    console.log('\n📋 Please manually update your .env file with the private key above.\n');
  }
  
  rl.close();
});
