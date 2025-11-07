/**
 * MPC Wallet Abstraction Layer
 *
 * This module provides a unified interface for Multi-Party Computation (MPC) wallets,
 * abstracting different MPC providers (Fireblocks, DFNS, Threshold signatures, etc.)
 * and providing a consistent API for the trading application.
 */

import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { MPC_CONFIG } from "./config";
import { mpcApprovalWorkflow, ApprovalRequest, ApprovalResult } from "./MPCApprovalWorkflow";

// ============================================================================
// MPC PROVIDER INTERFACES
// ============================================================================

/**
 * MPC Transaction Request interface
 */
export interface MPCTransactionRequest {
  /** Transaction to be signed */
  transaction: Transaction | VersionedTransaction;
  /** Transaction description for approval */
  description?: string;
  /** Transaction metadata */
  metadata?: {
    type: 'buy' | 'sell' | 'transfer';
    amount?: number;
    token?: string;
    [key: string]: any;
  };
  /** Required signatures for approval */
  requiredSignatures?: number;
  /** Timeout for signature collection */
  timeoutMs?: number;
}

/**
 * MPC Signature Response interface
 */
export interface MPCSignatureResponse {
  /** Transaction signature */
  signature: string;
  /** Public key that signed */
  publicKey: PublicKey;
  /** Signature metadata */
  metadata?: {
    signerId?: string;
    timestamp?: number;
    approvalCount?: number;
    [key: string]: any;
  };
}

/**
 * MPC Wallet Balance interface
 */
export interface MPCWalletBalance {
  /** SOL balance */
  sol: number;
  /** Token balances */
  tokens: {
    [mintAddress: string]: number;
  };
}

/**
 * MPC Provider interface - abstracts different MPC implementations
 */
export interface IMPCProvider {
  /** Provider name */
  getProviderName(): string;

  /** Initialize the MPC provider */
  initialize(config: typeof MPC_CONFIG.WALLET): Promise<void>;

  /** Check if provider is initialized */
  isInitialized(): boolean;

  /** Get wallet public key */
  getPublicKey(): Promise<PublicKey>;

  /** Get wallet balance */
  getBalance(): Promise<MPCWalletBalance>;

  /** Sign a transaction with MPC */
  signTransaction(request: MPCTransactionRequest): Promise<MPCSignatureResponse>;

  /** Check transaction approval status */
  getTransactionStatus(signature: string): Promise<{
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    signaturesCollected: number;
    requiredSignatures: number;
    expiresAt?: Date;
  }>;

  /** Cancel pending transaction */
  cancelTransaction(signature: string): Promise<void>;

  /** Get supported transaction types */
  getSupportedTransactionTypes(): string[];

  /** Cleanup resources */
  dispose(): Promise<void>;
}

// ============================================================================
// MPC WALLET MANAGER
// ============================================================================

/**
 * MPC Wallet Manager - Main interface for MPC operations
 */
export class MPCWalletManager {
  private provider: IMPCProvider | null = null;
  private initialized = false;

  /**
   * Initialize MPC wallet with configuration
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Check current runtime configuration instead of cached config
    const currentMPCEnabled = Boolean(process.env.MPC_ENABLED === 'true' && (process.env.MPC_WALLET_ID || process.env.MPC_API_KEY) && (process.env.MPC_PROVIDER === 'mock' || process.env.MPC_PROVIDER === 'fireblocks'));

    if (!currentMPCEnabled) {
      // MPC wallet disabled, using legacy single-key mode
      return;
    }

    try {
      // Create provider based on configuration
      this.provider = await this.createMPCProvider();

      // Initialize provider
      await this.provider.initialize(MPC_CONFIG.WALLET);

  this.initialized = true;

    } catch (error) {
      console.error('Failed to initialize MPC wallet:', error);
      throw new Error(`MPC wallet initialization failed: ${error}`);
    }
  }

  /**
   * Create appropriate MPC provider based on configuration
   */
  private async createMPCProvider(): Promise<IMPCProvider> {
    const providerType = (process.env.MPC_PROVIDER || 'mock').toLowerCase();

    switch (providerType) {
      case 'fireblocks':
  // Initializing Fireblocks MPC provider for production use
        const { FireblocksMPCProvider } = await import('./providers/FireblocksMPCProvider');
        return new FireblocksMPCProvider();

      case 'dfns':
        throw new Error('DFNS MPC provider not yet implemented. Use MPC_PROVIDER=fireblocks or MPC_PROVIDER=mock.');

      case 'threshold':
        throw new Error('Threshold MPC provider not yet implemented. Use MPC_PROVIDER=fireblocks or MPC_PROVIDER=mock.');

      case 'mock':
      default:
        // Using mock MPC provider. Set MPC_PROVIDER=fireblocks for production use
        const { MockMPCProvider } = await import('./providers/MockMPCProvider');
        return new MockMPCProvider();
    }
  }

  /**
   * Get wallet public key
   */
  async getPublicKey(): Promise<PublicKey> {
    await this.ensureInitialized();
    if (!this.provider) {
      throw new Error('MPC provider not available');
    }
    return this.provider.getPublicKey();
  }

  /**
   * Get wallet balance
   */
  async getBalance(): Promise<MPCWalletBalance> {
    await this.ensureInitialized();
    if (!this.provider) {
      throw new Error('MPC provider not available');
    }
    return this.provider.getBalance();
  }

  /**
   * Sign transaction with MPC approval workflow
   */
  async signTransaction(request: MPCTransactionRequest): Promise<MPCSignatureResponse> {
    await this.ensureInitialized();

    if (!this.provider) {
      throw new Error('MPC provider not available');
    }

    // Submit transaction for approval using the approval workflow
    const approvalRequest = await mpcApprovalWorkflow.submitForApproval(request);

    // Check if transaction is already approved (auto-approved or pre-approved)
    if (approvalRequest.status === 'approved') {
      return this.provider.signTransaction(request);
    }

    // For pending transactions, wait for approval or timeout
    if (approvalRequest.status === 'pending') {
      // In a real implementation, this would wait for approval or timeout
      // For now, we'll simulate the approval process
      const approvalResult = await this.waitForApproval(approvalRequest.id);

      if (approvalResult.approved) {
        return this.provider.signTransaction(request);
      } else {
        throw new Error(`Transaction approval failed or expired: ${approvalRequest.id}`);
      }
    }

    throw new Error(`Transaction not approved: ${approvalRequest.status}`);
  }

  /**
   * Wait for approval completion
   */
  private async waitForApproval(requestId: string, timeoutMs: number = 300000): Promise<ApprovalResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const approvalRequest = mpcApprovalWorkflow.getApprovalStatus(requestId);

      if (!approvalRequest) {
        throw new Error(`Approval request not found: ${requestId}`);
      }

      if (approvalRequest.status === 'approved') {
        return {
          approved: true,
          signaturesCollected: approvalRequest.signatures.length,
          requiredSignatures: approvalRequest.policy.requiredSignatures,
          expiresAt: approvalRequest.expiresAt,
          canAutoApprove: false, // Already handled by workflow
        };
      }

      if (approvalRequest.status === 'rejected' || approvalRequest.status === 'expired') {
        return {
          approved: false,
          signaturesCollected: approvalRequest.signatures.length,
          requiredSignatures: approvalRequest.policy.requiredSignatures,
          expiresAt: approvalRequest.expiresAt,
          canAutoApprove: false,
        };
      }

      // Wait before checking again
      await this.delay(1000);
    }

    throw new Error(`Approval timeout for request: ${requestId}`);
  }

  /**
   * Get approval workflow statistics
   */
  getApprovalStatistics() {
    return mpcApprovalWorkflow.getApprovalStatistics();
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(): ApprovalRequest[] {
    return mpcApprovalWorkflow.getPendingApprovals();
  }

  /**
   * Approve transaction (for manual approval workflow)
   */
  async approveTransaction(
    requestId: string,
    signerId: string,
    signature: string,
    publicKey: PublicKey
  ): Promise<ApprovalResult> {
    return mpcApprovalWorkflow.approveTransaction(requestId, signerId, signature, publicKey);
  }

  /**
   * Reject transaction (for manual approval workflow)
   */
  async rejectTransaction(requestId: string, reason?: string): Promise<void> {
    return mpcApprovalWorkflow.rejectTransaction(requestId, reason);
  }

  /**
   * Cancel pending approval
   */
  async cancelApproval(requestId: string): Promise<void> {
    return mpcApprovalWorkflow.cancelApproval(requestId);
  }

  /**
   * Check transaction approval status
   */
  async getTransactionStatus(signature: string): Promise<any> {
    await this.ensureInitialized();
    if (!this.provider) {
      throw new Error('MPC provider not available');
    }
    return this.provider.getTransactionStatus(signature);
  }

  /**
   * Cancel pending transaction
   */
  async cancelTransaction(signature: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.provider) {
      throw new Error('MPC provider not available');
    }
    return this.provider.cancelTransaction(signature);
  }

  /**
   * Check if MPC is enabled and available
   */
  isMPCEnabled(): boolean {
    // Check current runtime configuration instead of cached config
    const currentMPCEnabled = Boolean(process.env.MPC_ENABLED === 'true' &&
                             (process.env.MPC_WALLET_ID || process.env.MPC_API_KEY) &&
                             ['mock', 'fireblocks'].includes(process.env.MPC_PROVIDER || 'mock'));

    return currentMPCEnabled && this.initialized && this.provider !== null;
  }

  /**
   * Get current provider name
   */
  getProviderName(): string {
    return this.provider?.getProviderName() || 'none';
  }

  /**
   * Ensure MPC wallet is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Cleanup MPC resources
   */
  async dispose(): Promise<void> {
    if (this.provider && typeof this.provider.dispose === 'function') {
      await this.provider.dispose();
    }
    this.provider = null;
    this.initialized = false;
  }

  /**
   * Utility delay method
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// MPC ERROR TYPES
// ============================================================================

/**
 * MPC-specific error types
 */
export enum MPCErrorType {
  PROVIDER_NOT_INITIALIZED = 'PROVIDER_NOT_INITIALIZED',
  SIGNATURE_TIMEOUT = 'SIGNATURE_TIMEOUT',
  INSUFFICIENT_APPROVALS = 'INSUFFICIENT_APPROVALS',
  INVALID_TRANSACTION = 'INVALID_TRANSACTION',
  NETWORK_ERROR = 'NETWORK_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  UNKNOWN = 'UNKNOWN'
}

/**
 * MPC Error class
 */
export class MPCError extends Error {
  constructor(
    public type: MPCErrorType,
    message: string,
    public recoverable: boolean = true,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'MPCError';
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

/**
 * Global MPC wallet manager instance
 */
export const mpcWalletManager = new MPCWalletManager();
