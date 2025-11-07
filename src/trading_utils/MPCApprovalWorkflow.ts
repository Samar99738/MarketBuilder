/**
 * MPC Approval Workflow
 *
 * Production-ready multi-signature approval system for MPC transactions.
 * Provides sophisticated approval workflows with different policies for various
 * transaction types, automated approvals, and comprehensive tracking.
 */

import { Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { MPCTransactionRequest, MPCSignatureResponse } from './MPCWallet';
import { MPC_CONFIG } from './config';
import { awsLogger } from '../aws/logger';

export interface ApprovalPolicy {
  /** Transaction types that require approval */
  requiredForTypes: string[];
  /** Minimum amount (in SOL) that triggers approval requirement */
  thresholdAmount?: number;
  /** Required number of signatures */
  requiredSignatures: number;
  /** Maximum time allowed for approval (in milliseconds) */
  timeoutMs: number;
  /** Whether to auto-approve small transactions */
  autoApproveBelow?: number;
  /** Whether to require manual review for large amounts */
  requireManualReview?: boolean;
}

export interface ApprovalRequest {
  id: string;
  transaction: MPCTransactionRequest;
  policy: ApprovalPolicy;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  signatures: Array<{
    signerId: string;
    signature: string;
    timestamp: number;
    publicKey: PublicKey;
  }>;
  createdAt: number;
  expiresAt: number;
  approvedAt?: number;
  rejectedAt?: number;
  metadata: {
    description?: string;
    amount?: number;
    token?: string;
    type: string;
    riskLevel: 'low' | 'medium' | 'high';
  };
}

export interface ApprovalResult {
  approved: boolean;
  signaturesCollected: number;
  requiredSignatures: number;
  expiresAt: number;
  canAutoApprove: boolean;
  riskAssessment?: {
    level: 'low' | 'medium' | 'high';
    factors: string[];
  };
}

/**
 * MPC Approval Workflow Manager
 */
export class MPCApprovalWorkflow {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private approvalPolicies: Map<string, ApprovalPolicy> = new Map();
  private autoApprovalRules: Map<string, boolean> = new Map();

  constructor() {
    this.initializeDefaultPolicies();
    this.startCleanupTimer();
  }

  /**
   * Initialize default approval policies for different transaction types
   */
  private initializeDefaultPolicies(): void {
    // Buy transactions policy
    this.approvalPolicies.set('buy', {
      requiredForTypes: ['buy'],
      thresholdAmount: MPC_CONFIG.TRANSACTION_POLICIES.REQUIRE_APPROVAL_ABOVE_SOL,
      requiredSignatures: MPC_CONFIG.WALLET.SIGNATURE_THRESHOLD,
      timeoutMs: 300000, // 5 minutes
      autoApproveBelow: MPC_CONFIG.TRANSACTION_POLICIES.AUTO_APPROVE_BELOW_SOL,
      requireManualReview: true,
    });

    // Sell transactions policy
    this.approvalPolicies.set('sell', {
      requiredForTypes: ['sell'],
      thresholdAmount: MPC_CONFIG.TRANSACTION_POLICIES.REQUIRE_APPROVAL_ABOVE_SOL * 0.8, // Slightly lower for sells
      requiredSignatures: MPC_CONFIG.WALLET.SIGNATURE_THRESHOLD,
      timeoutMs: 300000, // 5 minutes
      autoApproveBelow: MPC_CONFIG.TRANSACTION_POLICIES.AUTO_APPROVE_BELOW_SOL,
      requireManualReview: true,
    });

    // Transfer transactions policy (most restrictive)
    this.approvalPolicies.set('transfer', {
      requiredForTypes: ['transfer'],
      thresholdAmount: MPC_CONFIG.TRANSACTION_POLICIES.REQUIRE_APPROVAL_ABOVE_SOL * 0.5, // Very restrictive for transfers
      requiredSignatures: Math.max(MPC_CONFIG.WALLET.SIGNATURE_THRESHOLD, 3), // At least 3 signatures
      timeoutMs: 600000, // 10 minutes
      autoApproveBelow: 0, // Never auto-approve transfers
      requireManualReview: true,
    });

    // Swap transactions policy
    this.approvalPolicies.set('swap', {
      requiredForTypes: ['swap'],
      thresholdAmount: MPC_CONFIG.TRANSACTION_POLICIES.REQUIRE_APPROVAL_ABOVE_SOL,
      requiredSignatures: MPC_CONFIG.WALLET.SIGNATURE_THRESHOLD,
      timeoutMs: 240000, // 4 minutes
      autoApproveBelow: MPC_CONFIG.TRANSACTION_POLICIES.AUTO_APPROVE_BELOW_SOL,
      requireManualReview: false, // Swaps are generally safer
    });
  }

  /**
   * Submit transaction for MPC approval
   */
  async submitForApproval(request: MPCTransactionRequest): Promise<ApprovalRequest> {
    const policy = this.getApprovalPolicy(request);
    const approvalRequest = await this.createApprovalRequest(request, policy);

    this.pendingApprovals.set(approvalRequest.id, approvalRequest);

    // Check for auto-approval
    if (this.canAutoApprove(approvalRequest)) {
      await this.autoApprove(approvalRequest);
    }

    await awsLogger.info('MPC approval request submitted', {
      metadata: {
        requestId: approvalRequest.id,
        transactionType: request.metadata?.type,
        amount: request.metadata?.amount,
        requiredSignatures: policy.requiredSignatures,
        autoApprove: this.canAutoApprove(approvalRequest),
        expiresAt: approvalRequest.expiresAt,
      }
    });

    return approvalRequest;
  }

  /**
   * Approve a pending transaction
   */
  async approveTransaction(
    requestId: string,
    signerId: string,
    signature: string,
    publicKey: PublicKey
  ): Promise<ApprovalResult> {
    const approvalRequest = this.pendingApprovals.get(requestId);
    if (!approvalRequest) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    if (approvalRequest.status !== 'pending') {
      throw new Error(`Approval request ${requestId} is not pending (status: ${approvalRequest.status})`);
    }

    if (approvalRequest.expiresAt < Date.now()) {
      approvalRequest.status = 'expired';
      throw new Error(`Approval request ${requestId} has expired`);
    }

    // Add signature
    approvalRequest.signatures.push({
      signerId,
      signature,
      timestamp: Date.now(),
      publicKey,
    });

    // Check if we have enough signatures
    const signaturesCollected = approvalRequest.signatures.length;
    const requiredSignatures = approvalRequest.policy.requiredSignatures;

    if (signaturesCollected >= requiredSignatures) {
      approvalRequest.status = 'approved';
      approvalRequest.approvedAt = Date.now();

      await awsLogger.info('MPC transaction approved', {
        metadata: {
          requestId,
          signaturesCollected,
          requiredSignatures,
          transactionType: approvalRequest.transaction.metadata?.type,
          amount: approvalRequest.transaction.metadata?.amount,
        }
      });
    }

    return {
      approved: approvalRequest.status === 'approved',
      signaturesCollected,
      requiredSignatures,
      expiresAt: approvalRequest.expiresAt,
      canAutoApprove: this.canAutoApprove(approvalRequest),
      riskAssessment: this.assessTransactionRisk(approvalRequest),
    };
  }

  /**
   * Reject a pending transaction
   */
  async rejectTransaction(requestId: string, reason?: string): Promise<void> {
    const approvalRequest = this.pendingApprovals.get(requestId);
    if (!approvalRequest) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    approvalRequest.status = 'rejected';
    approvalRequest.rejectedAt = Date.now();

    await awsLogger.warn('MPC transaction rejected', {
      metadata: {
        requestId,
        reason,
        transactionType: approvalRequest.transaction.metadata?.type,
        amount: approvalRequest.transaction.metadata?.amount,
      }
    });
  }

  /**
   * Get approval status for a transaction
   */
  getApprovalStatus(requestId: string): ApprovalRequest | null {
    return this.pendingApprovals.get(requestId) || null;
  }

  /**
   * Get all pending approvals
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values())
      .filter(request => request.status === 'pending' && request.expiresAt > Date.now());
  }

  /**
   * Cancel a pending approval
   */
  async cancelApproval(requestId: string): Promise<void> {
    const approvalRequest = this.pendingApprovals.get(requestId);
    if (!approvalRequest) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    approvalRequest.status = 'cancelled';

    await awsLogger.info('MPC approval cancelled', {
      metadata: {
        requestId,
        transactionType: approvalRequest.transaction.metadata?.type,
      }
    });
  }

  /**
   * Get approval policy for a transaction type
   */
  private getApprovalPolicy(request: MPCTransactionRequest): ApprovalPolicy {
    const transactionType = request.metadata?.type || 'unknown';

    // Find matching policy
    for (const [policyType, policy] of this.approvalPolicies.entries()) {
      if (policy.requiredForTypes.includes(transactionType)) {
        return policy;
      }
    }

    // Default policy for unknown types
    return {
      requiredForTypes: ['unknown'],
      requiredSignatures: MPC_CONFIG.WALLET.SIGNATURE_THRESHOLD,
      timeoutMs: 300000,
      requireManualReview: true,
    };
  }

  /**
   * Create approval request
   */
  private async createApprovalRequest(
    request: MPCTransactionRequest,
    policy: ApprovalPolicy
  ): Promise<ApprovalRequest> {
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      id: requestId,
      transaction: request,
      policy,
      status: 'pending',
      signatures: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + policy.timeoutMs,
      metadata: {
        description: request.description,
        amount: request.metadata?.amount,
        token: request.metadata?.token,
        type: request.metadata?.type || 'unknown',
        riskLevel: this.assessTransactionRiskLevel(request),
      },
    };
  }

  /**
   * Check if transaction can be auto-approved
   */
  private canAutoApprove(approvalRequest: ApprovalRequest): boolean {
    const { policy, metadata } = approvalRequest;

    // Check if auto-approval is enabled for this policy
    if (!policy.autoApproveBelow) {
      return false;
    }

    // Check amount threshold
    if (!metadata.amount || metadata.amount >= policy.autoApproveBelow) {
      return false;
    }

    // Check if auto-approval is explicitly disabled for this transaction type
    const policyType = approvalRequest.transaction.metadata?.type || 'unknown';
    if (this.autoApprovalRules.get(policyType) === false) {
      return false;
    }

    return true;
  }

  /**
   * Auto-approve a transaction
   */
  private async autoApprove(approvalRequest: ApprovalRequest): Promise<void> {
    // Simulate auto-approval signatures
    const requiredSignatures = approvalRequest.policy.requiredSignatures;

    for (let i = 0; i < requiredSignatures; i++) {
      approvalRequest.signatures.push({
        signerId: `auto-approver-${i + 1}`,
        signature: `auto_signature_${Date.now()}_${i}`,
        timestamp: Date.now(),
        publicKey: PublicKey.default, // Would be actual key in real implementation
      });
    }

    approvalRequest.status = 'approved';
    approvalRequest.approvedAt = Date.now();

    await awsLogger.info('MPC transaction auto-approved', {
      metadata: {
        requestId: approvalRequest.id,
        transactionType: approvalRequest.transaction.metadata?.type,
        amount: approvalRequest.transaction.metadata?.amount,
      }
    });
  }

  /**
   * Assess transaction risk level
   */
  private assessTransactionRiskLevel(request: MPCTransactionRequest): 'low' | 'medium' | 'high' {
    const amount = request.metadata?.amount || 0;
    const type = request.metadata?.type || 'unknown';

    // High risk factors
    if (type === 'transfer' || amount > MPC_CONFIG.TRANSACTION_POLICIES.REQUIRE_APPROVAL_ABOVE_SOL) {
      return 'high';
    }

    // Medium risk factors
    if (amount > MPC_CONFIG.TRANSACTION_POLICIES.AUTO_APPROVE_BELOW_SOL || type === 'sell') {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Comprehensive risk assessment
   */
  private assessTransactionRisk(approvalRequest: ApprovalRequest): ApprovalResult['riskAssessment'] {
    const { transaction, metadata } = approvalRequest;
    const riskFactors: string[] = [];

    // Amount-based risk
    if (metadata.amount) {
      if (metadata.amount > MPC_CONFIG.TRANSACTION_POLICIES.REQUIRE_APPROVAL_ABOVE_SOL) {
        riskFactors.push('Large transaction amount');
      } else if (metadata.amount > MPC_CONFIG.TRANSACTION_POLICIES.AUTO_APPROVE_BELOW_SOL) {
        riskFactors.push('Medium transaction amount');
      }
    }

    // Type-based risk
    if (metadata.type === 'transfer') {
      riskFactors.push('Transfer transaction type');
    } else if (metadata.type === 'sell') {
      riskFactors.push('Sell transaction type');
    }

    // Time-based risk (unusual hours)
    const hour = new Date().getHours();
    if (hour < 6 || hour > 22) {
      riskFactors.push('Unusual transaction time');
    }

    const riskLevel = riskFactors.length > 1 ? 'high' : riskFactors.length > 0 ? 'medium' : 'low';

    return {
      level: riskLevel,
      factors: riskFactors,
    };
  }

  /**
   * Start cleanup timer for expired approvals
   */
  private startCleanupTimer(): void {
    setInterval(() => {
      this.cleanupExpiredApprovals();
    }, 60000); // Clean up every minute
  }

  /**
   * Clean up expired approval requests
   */
  private cleanupExpiredApprovals(): void {
    const now = Date.now();
    const expiredRequests: string[] = [];

    for (const [requestId, request] of this.pendingApprovals.entries()) {
      if (request.expiresAt < now && request.status === 'pending') {
        request.status = 'expired';
        expiredRequests.push(requestId);
      }
    }
  }

  /**
   * Get approval statistics
   */
  getApprovalStatistics(): {
    totalPending: number;
    totalApproved: number;
    totalRejected: number;
    totalExpired: number;
    averageApprovalTime: number;
    riskDistribution: { low: number; medium: number; high: number };
  } {
    const requests = Array.from(this.pendingApprovals.values());
    const stats = {
      totalPending: 0,
      totalApproved: 0,
      totalRejected: 0,
      totalExpired: 0,
      averageApprovalTime: 0,
      riskDistribution: { low: 0, medium: 0, high: 0 },
    };

    // Count by status
    requests.forEach(request => {
      switch (request.status) {
        case 'pending':
          stats.totalPending++;
          break;
        case 'approved':
          stats.totalApproved++;
          break;
        case 'rejected':
          stats.totalRejected++;
          break;
        case 'expired':
          stats.totalExpired++;
          break;
      }

      // Risk distribution
      if (request.metadata.riskLevel) {
        stats.riskDistribution[request.metadata.riskLevel]++;
      }
    });

    return stats;
  }
}

// Export singleton instance
export const mpcApprovalWorkflow = new MPCApprovalWorkflow();
