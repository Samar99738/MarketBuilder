/**
 * Wallet Management Routes
 * 
 * Provides endpoints for wallet operations:
 * - Get wallet info (address, balances)
 * - Execute trades (buy/sell)
 */

import { Router, Request, Response } from 'express';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import * as bs58 from 'bs58';
import { TRADING_CONFIG, MPC_CONFIG } from '../../trading_utils/config';
import { ApiErrorClass } from '../middleware/errorHandler';
import { awsLogger } from '../../aws/logger';
import { mpcWalletManager } from '../../trading_utils/MPCWallet';
import { getNetworkType } from '../../config/environment';

const router = Router();

// Simple wallet info cache to reduce blockchain calls
let walletInfoCache: { data: any; timestamp: number } | null = null;
const WALLET_CACHE_TTL = 30000; // 30 seconds cache

router.get('/info', async (req: Request, res: Response) => {
    try {
        let solBalanceFormatted: number = 0;
        let usdcBalance: number = 0;
        const currentTime = Date.now();

        // Check cache first (temporarily disabled for testing real balances)
        // Clear cache to force fresh balance fetch
        walletInfoCache = null;
        // if (walletInfoCache && (currentTime - walletInfoCache.timestamp) < WALLET_CACHE_TTL) {
        //     return res.json(walletInfoCache.data);
        // }

        // Initialize connection for blockchain calls
        if (!TRADING_CONFIG.RPC_ENDPOINT) {
            throw new ApiErrorClass('RPC endpoint not configured', 'RPC_NOT_CONFIGURED', 500);
        }
        const connection = new Connection(TRADING_CONFIG.RPC_ENDPOINT);

        // Try MPC wallet first, fall back to traditional if needed
        let mpcBalanceAttempted = false;
        let walletPublicKey: PublicKey | null = null;

        if (MPC_CONFIG.ENABLED && mpcWalletManager.isMPCEnabled()) {
            // MPC wallet mode (only if properly initialized)
            try {
                console.log('Attempting to use MPC wallet...');
                walletPublicKey = await mpcWalletManager.getPublicKey();
                console.log('About to fetch MPC balance...');
                const balance = await mpcWalletManager.getBalance();
                console.log('MPC Balance fetched:', balance);

                solBalanceFormatted = balance.sol;
                mpcBalanceAttempted = true;

                // For now, return 0 for USDC - can be enhanced later with actual token account lookup
                usdcBalance = 0;

                console.log(`MPC balance result: ${solBalanceFormatted} SOL`);

            } catch (mpcError: any) {
                console.error('MPC wallet error caught:', mpcError);
                console.error('MPC Error details:', mpcError.message);
                mpcBalanceAttempted = true;

                await awsLogger.error('MPC wallet error', {
                    metadata: {
                        error: mpcError.message,
                        stack: mpcError.stack,
                        mpcEnabled: MPC_CONFIG.ENABLED,
                        provider: MPC_CONFIG.PROVIDER,
                        mpcInitialized: mpcWalletManager.isMPCEnabled()
                    }
                });

                // Don't throw error, just log it and continue to traditional wallet fallback
                console.log('MPC wallet failed, falling back to traditional wallet mode');
            }
        }

        // Traditional wallet mode - either as primary mode or fallback
        if (!MPC_CONFIG.ENABLED || !mpcBalanceAttempted || !walletPublicKey) {
            console.log('Using traditional wallet mode...');
            if (!TRADING_CONFIG.WALLET_PRIVATE_KEY) {
                // Return a proper response instead of crashing
                return res.status(200).json({
                    success: false,
                    data: {
                        address: null,
                        solBalance: 0,
                        usdcBalance: 0,
                        walletMode: 'not_configured',
                        message: 'Wallet not configured. Please set up either MPC wallet with proper credentials or provide WALLET_PRIVATE_KEY for traditional wallet mode.'
                    },
                    timestamp: new Date().toISOString(),
                    error: {
                        code: 'WALLET_NOT_CONFIGURED',
                        message: 'Wallet not configured. Either set up MPC wallet with proper configuration or provide WALLET_PRIVATE_KEY for traditional wallet mode.',
                        details: {
                            mpcEnabled: MPC_CONFIG.ENABLED,
                            mpcProvider: MPC_CONFIG.PROVIDER,
                            hasWalletPrivateKey: !!TRADING_CONFIG.WALLET_PRIVATE_KEY,
                            hasMPCConfig: !!(process.env.MPC_WALLET_ID || process.env.MPC_API_KEY)
                        }
                    }
                });
            }

            // Handle both Uint8Array and base58 string formats (same as TokenUtils)
            let wallet: Keypair;
            if (TRADING_CONFIG.WALLET_PRIVATE_KEY instanceof Uint8Array) {
                wallet = Keypair.fromSecretKey(TRADING_CONFIG.WALLET_PRIVATE_KEY);
            } else if (typeof TRADING_CONFIG.WALLET_PRIVATE_KEY === 'string') {
                wallet = Keypair.fromSecretKey(bs58.decode(TRADING_CONFIG.WALLET_PRIVATE_KEY));
            } else {
                throw new Error('Invalid wallet private key format');
            }

            walletPublicKey = wallet.publicKey;

            // Get SOL balance
            console.log(`Fetching traditional wallet balance for: ${walletPublicKey.toBase58()}`);
            const solBalance = await connection.getBalance(walletPublicKey);
            solBalanceFormatted = solBalance / 1e9; // Convert lamports to SOL
            console.log(`Traditional wallet balance: ${solBalanceFormatted} SOL (${solBalance} lamports)`);

            // For now, return 0 for USDC - can be enhanced later with actual token account lookup
            usdcBalance = 0;
        }

        if (!walletPublicKey) {
            throw new Error('Wallet public key not available');
        }

        const walletInfo = {
            success: true,
            walletAddress: walletPublicKey.toBase58(),
            balances: {
                sol: solBalanceFormatted,
                usdc: usdcBalance
            }
        };

        // Cache the result
        walletInfoCache = {
            data: walletInfo,
            timestamp: currentTime
        };

        res.json({
            success: true,
            data: {
                address: walletPublicKey.toBase58(),
                solBalance: solBalanceFormatted,
                usdcBalance,
                walletMode: MPC_CONFIG.ENABLED ? 'MPC' : 'Traditional'
            },
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await awsLogger.error('Failed to retrieve wallet info', {
            metadata: {
                error: error.message,
                stack: error.stack,
                mpcEnabled: MPC_CONFIG.ENABLED,
                provider: MPC_CONFIG.PROVIDER
            }
        });

        if (error instanceof ApiErrorClass) {
            throw error;
        }

        throw new ApiErrorClass(
            'Failed to retrieve wallet information',
            'WALLET_INFO_ERROR',
            500,
            { originalError: error.message }
        );
    }
});

router.get('/balance', async (req: Request, res: Response) => {
    try {
        if (!TRADING_CONFIG.RPC_ENDPOINT) {
            throw new ApiErrorClass('RPC endpoint not configured', 'RPC_NOT_CONFIGURED', 500);
        }

        if (MPC_CONFIG.ENABLED && mpcWalletManager.isMPCEnabled()) {
            // MPC wallet mode
            try {
                const balance = await mpcWalletManager.getBalance();
                res.json({
                    success: true,
                    data: {
                        sol: balance.sol,
                        tokens: balance.tokens,
                        walletMode: 'MPC',
                        network: getNetworkType(TRADING_CONFIG.RPC_ENDPOINT),
                        address: (await mpcWalletManager.getPublicKey()).toBase58()
                    },
                    timestamp: new Date().toISOString()
                });
            } catch (mpcError: any) {
                await awsLogger.error('MPC balance fetch error', {
                    metadata: {
                        error: mpcError.message,
                        stack: mpcError.stack,
                        mpcEnabled: MPC_CONFIG.ENABLED,
                        provider: MPC_CONFIG.PROVIDER
                    }
                });

                // Return error response instead of crashing
                return res.status(200).json({
                    success: false,
                    data: {
                        sol: 0,
                        tokens: {},
                        walletMode: 'mpc_error',
                        network: getNetworkType(TRADING_CONFIG.RPC_ENDPOINT),
                        address: null,
                        message: 'MPC wallet not available. Please check MPC configuration.'
                    },
                    timestamp: new Date().toISOString(),
                    error: {
                        code: 'MPC_BALANCE_ERROR',
                        message: 'MPC wallet balance not available',
                        details: { originalError: mpcError.message }
                    }
                });
            }
        } else {
            // Traditional wallet mode
            if (!TRADING_CONFIG.WALLET_PRIVATE_KEY) {
                return res.status(200).json({
                    success: false,
                    data: {
                        sol: 0,
                        tokens: {},
                        walletMode: 'not_configured',
                        network: getNetworkType(TRADING_CONFIG.RPC_ENDPOINT),
                        address: null,
                        message: 'Wallet not configured. Please set up either MPC wallet with proper credentials or provide WALLET_PRIVATE_KEY for traditional wallet mode.'
                    },
                    timestamp: new Date().toISOString(),
                    error: {
                        code: 'WALLET_NOT_CONFIGURED',
                        message: 'Wallet not configured. Please set up either MPC wallet with proper credentials or provide WALLET_PRIVATE_KEY for traditional wallet mode.'
                    }
                });
            }

            // Handle both Uint8Array and base58 string formats
            let wallet: Keypair;
            if (TRADING_CONFIG.WALLET_PRIVATE_KEY instanceof Uint8Array) {
                wallet = Keypair.fromSecretKey(TRADING_CONFIG.WALLET_PRIVATE_KEY);
            } else if (typeof TRADING_CONFIG.WALLET_PRIVATE_KEY === 'string') {
                wallet = Keypair.fromSecretKey(bs58.decode(TRADING_CONFIG.WALLET_PRIVATE_KEY));
            } else {
                throw new Error('Invalid wallet private key format');
            }

            const connection = new Connection(TRADING_CONFIG.RPC_ENDPOINT);
            const solBalanceLamports = await connection.getBalance(wallet.publicKey);
            const solBalance = solBalanceLamports / 1e9;

            res.json({
                success: true,
                data: {
                    sol: solBalance,
                    tokens: {},
                    walletMode: 'Traditional',
                    network: getNetworkType(TRADING_CONFIG.RPC_ENDPOINT),
                    address: wallet.publicKey.toBase58()
                },
                timestamp: new Date().toISOString()
            });
        }
    } catch (error: any) {
        await awsLogger.error('Failed to retrieve wallet balance', {
            metadata: {
                error: error.message,
                stack: error.stack,
                mpcEnabled: MPC_CONFIG.ENABLED,
                provider: MPC_CONFIG.PROVIDER
            }
        });

        if (error instanceof ApiErrorClass) {
            throw error;
        }

        throw new ApiErrorClass(
            'Failed to retrieve wallet balance',
            'BALANCE_ERROR',
            500,
            { originalError: error.message }
        );
    }
});

router.post('/trade/:type', async (req: Request, res: Response) => {
    try {
        const { type } = req.params;
        const { amount, slippage } = req.body;
        
        if (!['buy', 'sell'].includes(type)) {
            throw new ApiErrorClass('Invalid trade type', 'INVALID_TRADE_TYPE', 400);
        }
        
        if (!amount || amount <= 0) {
            throw new ApiErrorClass('Invalid amount', 'INVALID_AMOUNT', 400);
        }
        
        await awsLogger.info(`Executing ${type} trade`, {
            metadata: {
                amount,
                slippage,
                type,
                walletMode: MPC_CONFIG.ENABLED ? 'MPC' : 'Traditional',
                provider: MPC_CONFIG.PROVIDER
            }
        });
        
        // For now, return a mock response
        // In production, this would integrate with TokenUtils to execute actual trades
        res.json({
            success: true,
            data: {
                type,
                amount,
                slippage,
                signature: 'mock_signature_' + Date.now(),
                timestamp: new Date().toISOString()
            },
            message: `${type.toUpperCase()} trade executed successfully`,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        if (error instanceof ApiErrorClass) {
            throw error;
        }
        
        await awsLogger.error('Trade execution failed', {
            metadata: {
                error: error.message,
                stack: error.stack
            }
        });
        
        throw new ApiErrorClass(
            'Failed to execute trade',
            'TRADE_EXECUTION_ERROR',
            500,
            { originalError: error.message }
        );
    }
});

export default router;

