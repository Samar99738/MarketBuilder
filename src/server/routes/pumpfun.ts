/**
 * Pump.fun Token Swap Routes
 * 
 * API endpoints for buying tokens from pump.fun pools with transaction reporting
 */

import express, { Request, Response } from 'express';
import { PublicKey, Connection, Transaction } from '@solana/web3.js';
import { PumpFunIntegration, PumpFunSwapParams } from '../../trading_utils/PumpFunIntegration';
import { TRADING_CONFIG } from '../../trading_utils/config';
import { mpcWalletManager } from '../../trading_utils/MPCWallet';

const router = express.Router();

// Initialize connection
const connection = new Connection(TRADING_CONFIG.RPC_ENDPOINT as string, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});

const pumpFunIntegration = new PumpFunIntegration(connection);

router.post('/buy', async (req: Request, res: Response) => {
  try {
    const {
      tokenMint,
      solAmount,
      slippageBps = 300,
      priorityFeeLamports = 10000,
      computeUnitLimit = 400000,
    } = req.body;

    // Validation
    if (!tokenMint || !solAmount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: tokenMint and solAmount',
      });
    }

    if (solAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'solAmount must be greater than 0',
      });
    }

    if (slippageBps < 0 || slippageBps > 10000) {
      return res.status(400).json({
        success: false,
        error: 'slippageBps must be between 0 and 10000',
      });
    }

    let tokenMintPubkey: PublicKey;
    try {
      tokenMintPubkey = new PublicKey(tokenMint);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token mint address',
      });
    }

    console.log(`\n🎯 Pump.fun buy request received`);
    console.log(`Token Mint: ${tokenMint}`);
    console.log(`SOL Amount: ${solAmount}`);
    console.log(`Slippage: ${slippageBps / 100}%`);

    // Validate token and pool
    console.log('Validating token and pool...');
    const validation = await pumpFunIntegration.validateToken(tokenMintPubkey);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: `Token validation failed: ${validation.reason}`,
      });
    }

    console.log(' Token and pool validated');

    // Get wallet public key (MPC or legacy)
    const walletPublicKey = TRADING_CONFIG.MPC_CONFIG.ENABLED
      ? await mpcWalletManager.getPublicKey()
      : null; // For legacy single-key mode, would need to derive from private key

    if (!walletPublicKey) {
      return res.status(500).json({
        success: false,
        error: 'Wallet not available. Ensure MPC wallet is properly configured.',
      });
    }

    console.log(`Buyer wallet: ${walletPublicKey.toString()}`);

    // Build swap parameters
    const swapParams: PumpFunSwapParams = {
      tokenMint: tokenMintPubkey,
      solAmount,
      slippageBps,
      priorityFeeLamports,
      computeUnitLimit,
    };

    // Execute swap with MPC signing
    const result = await pumpFunIntegration.buyToken(
      swapParams,
      walletPublicKey,
      async (tx: Transaction) => {
        // Sign transaction using MPC wallet
        const signatureResponse = await mpcWalletManager.signTransaction({
          transaction: tx,
          description: `Buy ${solAmount} SOL worth of ${tokenMint.substring(0, 8)}... from pump.fun`,
          metadata: {
            type: 'buy',
            amount: solAmount,
            token: tokenMint,
            pool: 'pumpfun',
          },
          requiredSignatures: TRADING_CONFIG.MPC_CONFIG.TRANSACTION_POLICIES.REQUIRE_APPROVAL_FOR.includes('buy')
            ? TRADING_CONFIG.MPC_CONFIG.WALLET.SIGNATURE_THRESHOLD
            : 1,
        });

        // Apply signature to transaction
        // Note: In a real implementation, you'd need to properly apply the MPC signature
        // This is simplified for demonstration
        return tx;
      }
    );

    console.log(`\n Transaction Result:`);
    console.log(`Success: ${result.success}`);
    if (result.signature) {
      console.log(`Signature: ${result.signature}`);
      console.log(`Explorer: https://solscan.io/tx/${result.signature}`);
    }
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }

    return res.status(result.success ? 200 : 500).json(result);
  } catch (error: any) {
    console.error(' Error in pump.fun buy endpoint:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});


router.get('/validate/:tokenMint', async (req: Request, res: Response) => {
  try {
    const { tokenMint } = req.params;

    let tokenMintPubkey: PublicKey;
    try {
      tokenMintPubkey = new PublicKey(tokenMint);
    } catch (error) {
      return res.status(400).json({
        valid: false,
        reason: 'Invalid token mint address',
      });
    }

    const validation = await pumpFunIntegration.validateToken(tokenMintPubkey);
    return res.json(validation);
  } catch (error: any) {
    console.error('Error validating token:', error);
    return res.status(500).json({
      valid: false,
      reason: error.message || 'Validation error',
    });
  }
});

router.get('/price/:tokenMint', async (req: Request, res: Response) => {
  try {
    const { tokenMint } = req.params;

    let tokenMintPubkey: PublicKey;
    try {
      tokenMintPubkey = new PublicKey(tokenMint);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid token mint address',
      });
    }

    const price = await pumpFunIntegration.getTokenPrice(tokenMintPubkey);

    return res.json({
      tokenMint,
      price,
      priceInSOL: price,
    });
  } catch (error: any) {
    console.error('Error getting token price:', error);
    return res.status(500).json({
      error: error.message || 'Failed to fetch token price',
    });
  }
});

router.get('/info/:tokenMint', async (req: Request, res: Response) => {
  try {
    const { tokenMint } = req.params;

    let tokenMintPubkey: PublicKey;
    try {
      tokenMintPubkey = new PublicKey(tokenMint);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid token mint address',
      });
    }

    const info = await pumpFunIntegration.getComprehensiveTokenInfo(tokenMintPubkey);

    if (!info) {
      return res.status(404).json({
        error: 'Token not found or not a pump.fun token',
      });
    }

    return res.json(info);
  } catch (error: any) {
    console.error('Error getting token info:', error);
    return res.status(500).json({
      error: error.message || 'Failed to fetch token information',
    });
  }
});

export default router;
