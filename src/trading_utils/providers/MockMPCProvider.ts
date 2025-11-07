/**
 * Mock MPC Provider
 *
 * This is a mock implementation of the MPC provider interface for testing and development.
 * It simulates MPC operations without requiring actual MPC infrastructure.
 */

import { PublicKey, Transaction, VersionedTransaction, Keypair, Connection } from "@solana/web3.js";
import { IMPCProvider, MPCTransactionRequest, MPCSignatureResponse, MPCWalletBalance } from "../MPCWallet";
import { MPCError, MPCErrorType } from "../MPCWallet";
import { TRADING_CONFIG } from "../config";

/**
 * Mock MPC Provider for testing and development
 */
export class MockMPCProvider implements IMPCProvider {
  private mockWallet: Keypair | null = null;
  private initialized = false;
  private pendingTransactions = new Map<string, any>();
  private connection: Connection | null = null;
  private mockBalances = {
    sol: 10.0,
    tokens: {
      'So11111111111111111111111111111111111111112': 150.0, // SOL
    }
  };

  getProviderName(): string {
    return 'MockMPCProvider';
  }

  async initialize(config: any): Promise<void> {
    try {
      // Initialize MPC wallet with real blockchain connection
      console.log('Initializing mock MPC provider with real blockchain connection...');

      // Generate a mock wallet for testing
      this.mockWallet = Keypair.generate();

      // Create connection to the configured RPC endpoint
      if (!TRADING_CONFIG.RPC_ENDPOINT) {
        throw new Error('RPC endpoint not configured');
      }
      this.connection = new Connection(TRADING_CONFIG.RPC_ENDPOINT, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000
      });

      // Simulate network delay
      await this.delay(500);

      this.initialized = true;
      //console.log(`Mock MPC wallet initialized: ${this.mockWallet.publicKey.toString()}`);
      //console.log(`Connected to RPC: ${TRADING_CONFIG.RPC_ENDPOINT}`);

    } catch (error) {
      throw new MPCError(
        MPCErrorType.PROVIDER_NOT_INITIALIZED,
        'Failed to initialize mock MPC provider',
        true,
        error as Error
      );
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async getPublicKey(): Promise<PublicKey> {
    if (!this.initialized || !this.mockWallet) {
      throw new MPCError(
        MPCErrorType.PROVIDER_NOT_INITIALIZED,
        'Mock MPC provider not initialized',
        true
      );
    }

    return this.mockWallet.publicKey;
  }

  async getBalance(): Promise<MPCWalletBalance> {
    if (!this.initialized || !this.mockWallet) {
      throw new MPCError(
        MPCErrorType.PROVIDER_NOT_INITIALIZED,
        'Mock MPC provider not initialized',
        true
      );
    }

    // Only use mock data in test mode
    if (process.env.NODE_ENV === 'test') {
      await this.delay(100);
      return {
        sol: this.mockBalances.sol,
        tokens: this.mockBalances.tokens
      };
    }

    // Production mode: Always fetch real balance from blockchain
    try {
      await this.delay(100);
      
      if (!this.connection) {
        throw new Error('Connection not available');
      }

      //console.log(`Fetching real balance for wallet: ${this.mockWallet.publicKey.toBase58()}`);
      //console.log(`Using RPC endpoint: ${TRADING_CONFIG.RPC_ENDPOINT}`);

      // Get actual SOL balance from blockchain
      const solBalanceLamports = await this.connection.getBalance(this.mockWallet.publicKey);
      const solBalance = solBalanceLamports / 1e9; // Convert lamports to SOL

      //console.log(`Real blockchain balance: ${solBalance} SOL (${solBalanceLamports} lamports)`);

      // For now, return empty tokens object - can be enhanced later with actual token account lookup
      const tokens: { [mintAddress: string]: number } = {};

      return {
        sol: solBalance,
        tokens
      };

    } catch (error) {
      console.error('Failed to fetch balance:', error);
      throw new MPCError(
        MPCErrorType.NETWORK_ERROR,
        'Failed to fetch wallet balance from blockchain',
        true,
        error as Error
      );
    }
  }

  async signTransaction(request: MPCTransactionRequest): Promise<MPCSignatureResponse> {
    if (!this.initialized || !this.mockWallet) {
      throw new MPCError(
        MPCErrorType.PROVIDER_NOT_INITIALIZED,
        'Mock MPC provider not initialized',
        true
      );
    }

    try {
      console.log(`Mock MPC signing transaction: ${request.description || 'No description'}`);

      // Simulate MPC approval process
      await this.simulateMPCApproval(request);

      // Sign the transaction
      const signature = await this.signWithMockWallet(request.transaction);

      // Create response
      const response: MPCSignatureResponse = {
        signature,
        publicKey: this.mockWallet.publicKey,
        metadata: {
          signerId: 'mock-signer-1',
          timestamp: Date.now(),
          approvalCount: request.requiredSignatures || 2,
        }
      };

      // Track pending transaction for status checking
      this.pendingTransactions.set(signature, {
        status: 'approved',
        signaturesCollected: request.requiredSignatures || 2,
        requiredSignatures: request.requiredSignatures || 2,
        expiresAt: new Date(Date.now() + (request.timeoutMs || 300000)), // 5 minutes default
      });

      return response;

    } catch (error) {
      throw new MPCError(
        MPCErrorType.INVALID_TRANSACTION,
        'Failed to sign mock MPC transaction',
        true,
        error as Error
      );
    }
  }

  async getTransactionStatus(signature: string): Promise<any> {
    if (!this.initialized) {
      throw new MPCError(
        MPCErrorType.PROVIDER_NOT_INITIALIZED,
        'Mock MPC provider not initialized',
        true
      );
    }

    const status = this.pendingTransactions.get(signature);

    if (!status) {
      return {
        status: 'expired' as const,
        signaturesCollected: 0,
        requiredSignatures: 2,
      };
    }

    // Check if expired
    if (status.expiresAt && status.expiresAt < new Date()) {
      this.pendingTransactions.delete(signature);
      return {
        status: 'expired' as const,
        signaturesCollected: status.signaturesCollected,
        requiredSignatures: status.requiredSignatures,
        expiresAt: status.expiresAt,
      };
    }

    return status;
  }

  async cancelTransaction(signature: string): Promise<void> {
    if (!this.initialized) {
      throw new MPCError(
        MPCErrorType.PROVIDER_NOT_INITIALIZED,
        'Mock MPC provider not initialized',
        true
      );
    }

    this.pendingTransactions.delete(signature);
    console.log(`Mock MPC transaction cancelled: ${signature}`);
  }

  getSupportedTransactionTypes(): string[] {
    return ['buy', 'sell', 'transfer', 'swap'];
  }

  async dispose(): Promise<void> {
    if (this.mockWallet) {
      this.mockWallet = null;
    }
    this.initialized = false;
    this.pendingTransactions.clear();
    //console.log('Mock MPC provider disposed');
  }

  // Private helper methods

  private async signWithMockWallet(transaction: Transaction | VersionedTransaction): Promise<string> {
    // Simulate signing delay
    await this.delay(200);

    if (!this.mockWallet) {
      throw new Error('Mock wallet not available');
    }

      // For mock purposes, we'll simulate signing by creating a fake signature
    // In a real implementation, this would use the actual MPC signing process
    const fakeSignature = `mock_mpc_signature_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Simulate transaction signing for mock purposes
    // Note: In a real implementation, this would use MPC signing
    // For now, we just ensure the transaction object is valid

    return fakeSignature;
  }

  private async simulateMPCApproval(request: MPCTransactionRequest): Promise<void> {
    const requiredSignatures = request.requiredSignatures || 2;
    const timeoutMs = request.timeoutMs || 30000; // 30 seconds default

    //console.log(`Simulating MPC approval process (${requiredSignatures} signatures required)...`);

    // Simulate collecting signatures from multiple parties
    for (let i = 1; i <= requiredSignatures; i++) {
      // Simulate random delay for each signature (100-500ms)
      const delayMs = 100 + Math.random() * 400;
      await this.delay(delayMs);

      //console.log(`Mock MPC signature ${i}/${requiredSignatures} collected`);
    }

    //console.log('Mock MPC approval process completed');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Test utilities

  /**
   * Set mock balance for testing
   */
  setMockBalance(balance: Partial<MPCWalletBalance>): void {
    if (balance.sol !== undefined) {
      this.mockBalances.sol = balance.sol;
    }
    if (balance.tokens) {
      Object.assign(this.mockBalances.tokens, balance.tokens);
    }
  }

  /**
   * Simulate MPC approval failure for testing
   */
  async simulateApprovalFailure(): Promise<void> {
    throw new MPCError(
      MPCErrorType.INSUFFICIENT_APPROVALS,
      'Mock MPC approval failed (simulated)',
      true
    );
  }

  /**
   * Simulate network timeout for testing
   */
  async simulateTimeout(): Promise<void> {
    await this.delay(1000);
    throw new MPCError(
      MPCErrorType.SIGNATURE_TIMEOUT,
      'Mock MPC signature timeout (simulated)',
      true
    );
  }
}
