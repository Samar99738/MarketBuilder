/**
 * Transaction Approval Routes
 * API endpoints for managing transaction approvals
 */

import { Router, Request, Response } from 'express';
import { transactionApprovalWorkflow } from '../../security/TransactionApprovalWorkflow';
import { awsLogger } from '../../aws/logger';

const router = Router();

router.get('/pending', async (req: Request, res: Response) => {
  try {
    const pending = transactionApprovalWorkflow.getPendingApprovals();
    
    res.json({
      success: true,
      data: pending,
      count: pending.length
    });
  } catch (error: any) {
    console.error('Error fetching pending approvals:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


router.get('/history', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const history = transactionApprovalWorkflow.getApprovalHistory(limit);
    
    res.json({
      success: true,
      data: history,
      count: history.length
    });
  } catch (error: any) {
    console.error('Error fetching approval history:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = transactionApprovalWorkflow.getApprovalStats();
    const volume = transactionApprovalWorkflow.getDailyTradingVolume();
    
    res.json({
      success: true,
      data: {
        ...stats,
        dailyVolume: volume
      }
    });
  } catch (error: any) {
    console.error('Error fetching approval stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/:requestId/approve', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const { approvedBy = 'api-user' } = req.body;
    
    const request = await transactionApprovalWorkflow.approveTransaction(requestId, approvedBy);
    
    await awsLogger.info('Transaction approved via API', {
      metadata: { requestId, approvedBy }
    });
    
    res.json({
      success: true,
      data: request,
      message: 'Transaction approved successfully'
    });
  } catch (error: any) {
    console.error('Error approving transaction:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/:requestId/reject', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const { rejectedBy = 'api-user', reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required'
      });
    }
    
    const request = await transactionApprovalWorkflow.rejectTransaction(
      requestId,
      rejectedBy,
      reason
    );
    
    await awsLogger.info('Transaction rejected via API', {
      metadata: { requestId, rejectedBy, reason }
    });
    
    res.json({
      success: true,
      data: request,
      message: 'Transaction rejected successfully'
    });
  } catch (error: any) {
    console.error('Error rejecting transaction:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/emergency-stop', async (req: Request, res: Response) => {
  try {
    const { reason = 'Emergency stop activated via API' } = req.body;
    
    await transactionApprovalWorkflow.emergencyStop(reason);
    
    await awsLogger.warn('Emergency stop activated via API', {
      metadata: { reason }
    });
    
    res.json({
      success: true,
      message: 'Emergency stop activated - all pending approvals rejected'
    });
  } catch (error: any) {
    console.error('Error activating emergency stop:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
