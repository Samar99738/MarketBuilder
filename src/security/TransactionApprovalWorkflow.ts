/**
 * Transaction Approval Workflow
 * Implements approval requirements for large transactions
 * 
 * CRITICAL SECURITY: Prevents automated execution of large trades without human oversight
 */

import { awsLogger } from '../aws/logger';
import EventEmitter from 'events';

export interface TransactionApprovalRequest {
  id: string;
  strategyId: string;
  strategyName: string;
  type: 'buy' | 'sell';
  amountSOL: number;
  amountUSD: number;
  tokenAddress: string;
  estimatedPrice: number;
  slippage: number;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approvedBy?: string;
  approvedAt?: number;
  rejectedBy?: string;
  rejectedAt?: number;
  rejectionReason?: string;
  metadata?: Record<string, any>;
}

export interface ApprovalConfig {
  // Auto-approve trades below this amount
  autoApproveThresholdSOL: number;
  
  // Require manual approval above this amount
  requireApprovalAboveSOL: number;
  
  // Maximum allowed transaction size
  maxTransactionSOL: number;
  
  // Daily trading limits
  dailyTradingLimitSOL: number;
  
  // Approval timeout (ms)
  approvalTimeoutMs: number;
  
  // Webhook for approval notifications
  approvalWebhookUrl?: string;
  
  // Email notifications
  approvalEmailRecipients?: string[];
}

/**
 * Transaction Approval Workflow Manager
 */
export class TransactionApprovalWorkflow extends EventEmitter {
  private pendingApprovals: Map<string, TransactionApprovalRequest> = new Map();
  private approvalHistory: TransactionApprovalRequest[] = [];
  private dailyTradingVolume: Map<string, number> = new Map(); // date -> volume
  private config: ApprovalConfig;

  constructor(config?: Partial<ApprovalConfig>) {
    super();
    
    this.config = {
      autoApproveThresholdSOL: parseFloat(process.env.AUTO_APPROVE_SOL || '0.1'),
      requireApprovalAboveSOL: parseFloat(process.env.REQUIRE_APPROVAL_SOL || '1.0'),
      maxTransactionSOL: parseFloat(process.env.MAX_TRANSACTION_SOL || '10.0'),
      dailyTradingLimitSOL: parseFloat(process.env.DAILY_LIMIT_SOL || '50.0'),
      approvalTimeoutMs: parseInt(process.env.APPROVAL_TIMEOUT_MS || '3600000'), // 1 hour
      approvalWebhookUrl: process.env.APPROVAL_WEBHOOK_URL,
      approvalEmailRecipients: process.env.APPROVAL_EMAIL_RECIPIENTS?.split(','),
      ...config
    };

    // Clean up expired approvals every minute
    setInterval(() => this.cleanupExpiredApprovals(), 60000);
    
    // Reset daily volume at midnight
    this.scheduleDailyReset();
  }

  /**
   * Check if transaction requires approval
   */
  async checkTransactionRequiresApproval(
    type: 'buy' | 'sell',
    amountSOL: number,
    strategyId: string
  ): Promise<{ requiresApproval: boolean; reason?: string }> {
    try {
      // Check if amount is above max allowed
      if (amountSOL > this.config.maxTransactionSOL) {
        return {
          requiresApproval: true,
          reason: `Transaction amount (${amountSOL} SOL) exceeds maximum allowed (${this.config.maxTransactionSOL} SOL)`
        };
      }

      // Auto-approve small transactions
      if (amountSOL <= this.config.autoApproveThresholdSOL) {
        await awsLogger.info('Transaction auto-approved (below threshold)', {
          metadata: { type, amountSOL, strategyId, threshold: this.config.autoApproveThresholdSOL }
        });
        return { requiresApproval: false };
      }

      // Check daily trading limit
      const today = new Date().toISOString().split('T')[0];
      const todayVolume = this.dailyTradingVolume.get(today) || 0;
      
      if (todayVolume + amountSOL > this.config.dailyTradingLimitSOL) {
        return {
          requiresApproval: true,
          reason: `Daily trading limit exceeded (${todayVolume + amountSOL} / ${this.config.dailyTradingLimitSOL} SOL)`
        };
      }

      // Require approval for large transactions
      if (amountSOL > this.config.requireApprovalAboveSOL) {
        return {
          requiresApproval: true,
          reason: `Transaction amount (${amountSOL} SOL) requires manual approval (threshold: ${this.config.requireApprovalAboveSOL} SOL)`
        };
      }

      return { requiresApproval: false };
    } catch (error: any) {
      await awsLogger.error('Error checking approval requirement', {
        metadata: { error: error.message, type, amountSOL, strategyId }
      });
      // Fail-safe: require approval on error
      return { requiresApproval: true, reason: 'Error checking approval status' };
    }
  }

  /**
   * Create approval request for transaction
   */
  async createApprovalRequest(params: {
    strategyId: string;
    strategyName: string;
    type: 'buy' | 'sell';
    amountSOL: number;
    amountUSD: number;
    tokenAddress: string;
    estimatedPrice: number;
    slippage: number;
    metadata?: Record<string, any>;
  }): Promise<TransactionApprovalRequest> {
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const request: TransactionApprovalRequest = {
      id: requestId,
      ...params,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.approvalTimeoutMs,
      status: 'pending'
    };

    this.pendingApprovals.set(requestId, request);
    this.approvalHistory.push(request);

    // Emit event for UI/webhook notifications
    this.emit('approval:requested', request);

    await awsLogger.info('Approval request created', {
      metadata: { 
        requestId, 
        strategyId: params.strategyId,
        type: params.type,
        amountSOL: params.amountSOL
      }
    });

    // Send notifications
    await this.sendApprovalNotifications(request);

    return request;
  }

  /**
   * Approve transaction
   */
  async approveTransaction(
    requestId: string,
    approvedBy: string = 'system'
  ): Promise<TransactionApprovalRequest> {
    const request = this.pendingApprovals.get(requestId);

    if (!request) {
      throw new Error(`Approval request ${requestId} not found`);
    }

    if (request.status !== 'pending') {
      throw new Error(`Approval request ${requestId} is not pending (status: ${request.status})`);
    }

    if (Date.now() > request.expiresAt) {
      request.status = 'expired';
      this.pendingApprovals.delete(requestId);
      throw new Error(`Approval request ${requestId} has expired`);
    }

    request.status = 'approved';
    request.approvedBy = approvedBy;
    request.approvedAt = Date.now();

    this.pendingApprovals.delete(requestId);

    // Update daily volume
    const today = new Date().toISOString().split('T')[0];
    const currentVolume = this.dailyTradingVolume.get(today) || 0;
    this.dailyTradingVolume.set(today, currentVolume + request.amountSOL);

    // Emit event
    this.emit('approval:approved', request);

    await awsLogger.info('Transaction approved', {
      metadata: { 
        requestId, 
        approvedBy,
        strategyId: request.strategyId,
        amountSOL: request.amountSOL
      }
    });

    return request;
  }

  /**
   * Reject transaction
   */
  async rejectTransaction(
    requestId: string,
    rejectedBy: string,
    reason: string
  ): Promise<TransactionApprovalRequest> {
    const request = this.pendingApprovals.get(requestId);

    if (!request) {
      throw new Error(`Approval request ${requestId} not found`);
    }

    if (request.status !== 'pending') {
      throw new Error(`Approval request ${requestId} is not pending (status: ${request.status})`);
    }

    request.status = 'rejected';
    request.rejectedBy = rejectedBy;
    request.rejectedAt = Date.now();
    request.rejectionReason = reason;

    this.pendingApprovals.delete(requestId);

    // Emit event
    this.emit('approval:rejected', request);

    await awsLogger.info('Transaction rejected', {
      metadata: { 
        requestId, 
        rejectedBy,
        reason,
        strategyId: request.strategyId
      }
    });

    return request;
  }

  /**
   * Wait for approval with timeout
   */
  async waitForApproval(requestId: string): Promise<TransactionApprovalRequest> {
    return new Promise((resolve, reject) => {
      const request = this.pendingApprovals.get(requestId);
      
      if (!request) {
        return reject(new Error(`Approval request ${requestId} not found`));
      }

      // Check if already approved/rejected
      if (request.status === 'approved') {
        return resolve(request);
      }
      if (request.status === 'rejected') {
        return reject(new Error(`Transaction rejected: ${request.rejectionReason}`));
      }
      if (request.status === 'expired') {
        return reject(new Error('Approval request expired'));
      }

      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        request.status = 'expired';
        this.emit('approval:expired', request);
        reject(new Error('Approval request timed out'));
      }, request.expiresAt - Date.now());

      // Listen for approval events
      const approvalHandler = (approvedRequest: TransactionApprovalRequest) => {
        if (approvedRequest.id === requestId) {
          clearTimeout(timeout);
          this.removeListener('approval:approved', approvalHandler);
          this.removeListener('approval:rejected', rejectionHandler);
          resolve(approvedRequest);
        }
      };

      const rejectionHandler = (rejectedRequest: TransactionApprovalRequest) => {
        if (rejectedRequest.id === requestId) {
          clearTimeout(timeout);
          this.removeListener('approval:approved', approvalHandler);
          this.removeListener('approval:rejected', rejectionHandler);
          reject(new Error(`Transaction rejected: ${rejectedRequest.rejectionReason}`));
        }
      };

      this.on('approval:approved', approvalHandler);
      this.on('approval:rejected', rejectionHandler);
    });
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(): TransactionApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * Get approval history
   */
  getApprovalHistory(limit: number = 100): TransactionApprovalRequest[] {
    return this.approvalHistory.slice(-limit);
  }

  /**
   * Get daily trading volume
   */
  getDailyTradingVolume(): { date: string; volumeSOL: number }[] {
    return Array.from(this.dailyTradingVolume.entries()).map(([date, volume]) => ({
      date,
      volumeSOL: volume
    }));
  }

  /**
   * Get approval statistics
   */
  getApprovalStats(): {
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    totalRequests: number;
    approvalRate: number;
  } {
    const pending = this.pendingApprovals.size;
    const approved = this.approvalHistory.filter(r => r.status === 'approved').length;
    const rejected = this.approvalHistory.filter(r => r.status === 'rejected').length;
    const expired = this.approvalHistory.filter(r => r.status === 'expired').length;
    const total = this.approvalHistory.length;

    return {
      pending,
      approved,
      rejected,
      expired,
      totalRequests: total,
      approvalRate: total > 0 ? (approved / total) * 100 : 0
    };
  }

  /**
   * Send approval notifications
   */
  private async sendApprovalNotifications(request: TransactionApprovalRequest): Promise<void> {
    try {
      // Webhook notification
      if (this.config.approvalWebhookUrl) {
        await fetch(this.config.approvalWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'approval_required',
            request,
            timestamp: Date.now()
          })
        }).catch(err => console.error('Webhook notification failed:', err));
      }

      // Email notification would go here
      // if (this.config.approvalEmailRecipients) {
      //   await sendEmail(this.config.approvalEmailRecipients, 'Approval Required', ...);
      // }
    } catch (error: any) {
      console.error('Failed to send approval notifications:', error);
    }
  }

  /**
   * Clean up expired approvals
   */
  private cleanupExpiredApprovals(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [id, request] of this.pendingApprovals.entries()) {
      if (now > request.expiresAt) {
        request.status = 'expired';
        this.pendingApprovals.delete(id);
        this.emit('approval:expired', request);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      console.log(`[ApprovalWorkflow] Cleaned up ${expiredCount} expired approval requests`);
    }
  }

  /**
   * Schedule daily volume reset
   */
  private scheduleDailyReset(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      
      // Keep today and yesterday, remove older entries
      for (const [date] of this.dailyTradingVolume.entries()) {
        if (date !== today && date !== yesterday) {
          this.dailyTradingVolume.delete(date);
        }
      }
      
      console.log('[ApprovalWorkflow] Daily trading volume reset');
      
      // Schedule next reset
      this.scheduleDailyReset();
    }, msUntilMidnight);
  }

  /**
   * Emergency stop - reject all pending approvals
   */
  async emergencyStop(reason: string = 'Emergency stop activated'): Promise<void> {
    console.warn('⚠️  EMERGENCY STOP: Rejecting all pending approvals');
    
    const pending = Array.from(this.pendingApprovals.values());
    
    for (const request of pending) {
      await this.rejectTransaction(request.id, 'system', reason);
    }

    await awsLogger.warn('Emergency stop activated', {
      metadata: { reason, rejectedCount: pending.length }
    });
  }
}

/**
 * Singleton instance
 */
export const transactionApprovalWorkflow = new TransactionApprovalWorkflow();

/**
 * Helper function to check if approval workflow is enabled
 */
export function isApprovalWorkflowEnabled(): boolean {
  return process.env.ENABLE_APPROVAL_WORKFLOW !== 'false';
}
