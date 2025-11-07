/**
 * Import wallet from seed phrase (recovery phrase)
 * Usage: node scripts/import-from-seed.js <name> "<12 or 24 word seed phrase>"
 */

const fs = require('fs');
const path = require('path');
const { Keypair, Connection } = require('@solana/web3.js');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const keysDir = path.join(process.cwd(), '.keys');

async function importFromSeed(name, seedPhrase) {
  console.log('🔐 Importing wallet from seed phrase...\n');

  // Validate seed phrase
  if (!bip39.validateMnemonic(seedPhrase)) {
    console.error('❌ Invalid seed phrase. Please check and try again.');
    process.exit(1);
  }

  // Ensure .keys directory exists
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  // Check if account already exists
  const keyPath = path.join(keysDir, `${name}.json`);
  if (fs.existsSync(keyPath)) {
    console.error(`❌ Error: Account '${name}' already exists!`);
    console.error(`   Delete ${keyPath} first if you want to replace it.`);
    process.exit(1);
  }

  try {
    // Convert seed phrase to seed
    const seed = await bip39.mnemonicToSeed(seedPhrase);
    
    // Derive keypair using Phantom's derivation path
    const derivationPath = "m/44'/501'/0'/0'"; // Phantom uses this path
    const derivedSeed = derivePath(derivationPath, seed.toString('hex')).key;
    const keypair = Keypair.fromSeed(derivedSeed);

    // Save keypair
    const secretKey = Array.from(keypair.secretKey);
    fs.writeFileSync(keyPath, JSON.stringify(secretKey, null, 2));

    // Get balance
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const balance = await connection.getBalance(keypair.publicKey);
    const balanceInSol = balance / 1e9;

    console.log('✅ Wallet imported successfully!\n');
    console.log(`   Name: ${name}`);
    console.log(`   Public Key: ${keypair.publicKey.toString()}`);
    console.log(`   Balance: ${balanceInSol.toFixed(4)} SOL`);
    console.log(`   File: ${keyPath}`);
    console.log('\n🎉 You can now use this wallet in Claude Desktop!');
    console.log('\n⚠️  SECURITY: Keep your seed phrase safe and never share it!');

  } catch (error) {
    console.error(`\n❌ Failed to import wallet: ${error.message}`);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: node scripts/import-from-seed.js <name> "<seed phrase>"');
  console.log('\nExample:');
  console.log('  node scripts/import-from-seed.js phantom "word1 word2 word3 ... word12"');
  console.log('\nNote: Seed phrase should be 12 or 24 words, enclosed in quotes');
  process.exit(1);
}

const name = args[0];
const seedPhrase = args.slice(1).join(' ');

importFromSeed(name, seedPhrase).catch(console.error);
