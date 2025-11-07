/**
 * Jest Test Setup
 *
 * Configures test environment for MPC wallet testing
 */

// Set test environment
process.env.NODE_ENV = 'test';
process.env.MPC_ENABLED = 'true';
process.env.MPC_PROVIDER = 'mock';
process.env.MPC_WALLET_ID = 'test-wallet-id'; // Required for MPC to be enabled in tests

// Set dummy wallet key for tests (MPC tests don't need real keys)
process.env.WALLET_PRIVATE_KEY = 'test_wallet_key_for_jest';

// Set other required environment variables for tests
process.env.RPC_ENDPOINT = 'https://api.devnet.solana.com';
process.env.TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
