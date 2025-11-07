/**
 * MCP Tool Executor
 * Provides MCP Server tools as callable functions for the AI Agent
 * 
 * This bridges the gap between your standalone MCP Server (for Claude Desktop)
 * and your AI Agent (for web interface), allowing the agent to perform
 * the same operations via natural language.
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { PumpFunIntegration } from '../src/trading_utils/PumpFunIntegration';
import { UnifiedTrading } from '../src/trading_utils/UnifiedTrading';
import { TRADING_CONFIG } from '../src/trading_utils/config';
import { awsLogger } from '../src/aws/logger';
import * as fs from 'fs';
import * as path from 'path';

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: {
    executionTime?: number;
    timestamp?: string;
    toolName?: string;
  };
}

export interface ToolRequest {
  tool: string;
  params: { [key: string]: any };
  sessionId?: string;
  userId?: string;
}

/**
 * Rate limiter for preventing abuse
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Transaction history tracking
 */
interface TransactionRecord {
  id: string;
  type: 'buy' | 'sell';
  timestamp: number;
  token: string;
  amount: number;
  price?: number;
  signature?: string;
  status: 'success' | 'failed';
  accountName: string;
  error?: string;
}

/**
 * MCP Tool Executor
 * Executes MCP-style tools within the agent context
 */
export class MCPToolExecutor {
  private connection: Connection;
  private pumpFunIntegration: PumpFunIntegration;
  private unifiedTrading: UnifiedTrading;
  private keysDir: string;
  
  // Rate limiting
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly MAX_REQUESTS_PER_MINUTE = {
    buyToken: 10,
    sellToken: 10,
    getTokenInfo: 30,
    getAccountBalance: 50,
    listAccounts: 20,
    createAccount: 5,
    importAccount: 5,
    getTransactionHistory: 30,
    getPortfolioSummary: 20
  };

  // Transaction tracking
  private transactionHistory: TransactionRecord[] = [];
  private readonly MAX_HISTORY_SIZE = 1000;

  constructor(connection?: Connection) {
    this.connection = connection || new Connection(
      TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );

    this.pumpFunIntegration = new PumpFunIntegration(this.connection);
    this.unifiedTrading = new UnifiedTrading(this.connection);

    // Setup keys directory - MCPServer folder is one level below project root
    const projectRoot = path.resolve(__dirname, '..');
    this.keysDir = path.join(projectRoot, '.keys');
    
    if (!fs.existsSync(this.keysDir)) {
      fs.mkdirSync(this.keysDir, { recursive: true });
    }

    console.log('   ✅ MCPToolExecutor initialized');
    console.log(`   📁 Keys directory: ${this.keysDir}`);
    console.log(`   🌐 RPC Endpoint: ${this.connection.rpcEndpoint}`);
    
    // Auto-detect and set default wallet (prefer phantom)
    this.autoDetectDefaultWallet();
  }

  /**
   * Auto-detect default wallet (prefer phantom.json)
   */
  private autoDetectDefaultWallet(): void {
    try {
      const files = fs.readdirSync(this.keysDir);
      const wallets = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
      
      if (wallets.length === 0) {
        console.log('⚠️  No wallets found in .keys directory');
        console.log('    Create one with: createAccount tool or add phantom.json');
        return;
      }

      // Priority: phantom > default > first available
      if (wallets.includes('phantom')) {
        console.log('✅ Using Phantom wallet as default');
        this.loadKeypair('phantom').then(kp => {
          console.log(`   📱 Phantom Address: ${kp.publicKey.toString()}`);
        }).catch(err => {
          console.error('❌ Failed to load phantom wallet:', err.message);
        });
      } else if (wallets.includes('default')) {
        console.log('✅ Using default wallet');
      } else {
        console.log(`✅ Using wallet: ${wallets[0]}`);
      }
    } catch (error) {
      console.error('⚠️ Error detecting wallets:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Check rate limit for a tool
   */
  private checkRateLimit(toolName: string, userId: string = 'default'): ToolResult | null {
    const key = `${userId}:${toolName}`;
    const now = Date.now();
    const limit = this.MAX_REQUESTS_PER_MINUTE[toolName as keyof typeof this.MAX_REQUESTS_PER_MINUTE] || 20;

    let entry = this.rateLimits.get(key);

    // Reset if window expired
    if (!entry || now > entry.resetTime) {
      entry = {
        count: 0,
        resetTime: now + this.RATE_LIMIT_WINDOW
      };
      this.rateLimits.set(key, entry);
    }

    // Check if limit exceeded
    if (entry.count >= limit) {
      const waitTime = Math.ceil((entry.resetTime - now) / 1000);
      return {
        success: false,
        error: `⚠️ Rate Limit Exceeded`,
        data: {
          code: 'RATE_LIMIT_EXCEEDED',
          tool: toolName,
          limit: limit,
          window: '1 minute',
          resetIn: `${waitTime} seconds`,
          suggestion: `You've made too many ${toolName} requests. Please wait ${waitTime} seconds before trying again.`
        }
      };
    }

    // Increment counter
    entry.count++;
    this.rateLimits.set(key, entry);

    return null; // No rate limit violation
  }

  /**
   * Clean up expired rate limit entries (optional cleanup)
   */
  private cleanupRateLimits(): void {
    const now = Date.now();
    for (const [key, entry] of this.rateLimits.entries()) {
      if (now > entry.resetTime) {
        this.rateLimits.delete(key);
      }
    }
  }

  /**
   * Record a transaction
   */
  private recordTransaction(record: TransactionRecord): void {
    this.transactionHistory.push(record);

    // Keep only last MAX_HISTORY_SIZE transactions
    if (this.transactionHistory.length > this.MAX_HISTORY_SIZE) {
      this.transactionHistory = this.transactionHistory.slice(-this.MAX_HISTORY_SIZE);
    }

    console.log(`📝 Transaction recorded: ${record.type} ${record.token} - ${record.status}`);
  }

  /**
   * Execute a tool by name
   */
  async executeTool(toolName: string, params: any, sessionId?: string, walletAddress?: string): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      // Rate limit check
      const rateLimitResult = this.checkRateLimit(toolName, sessionId || 'anonymous');
      if (rateLimitResult) {
        console.log(`⚠️ Rate limit exceeded for ${toolName} by ${sessionId || 'anonymous'}`);
        return rateLimitResult;
      }

      let result: ToolResult;

      console.log(`🔧 Executing tool: ${toolName}`);
      console.log(`   Parameters:`, JSON.stringify(params, null, 2));
      if (walletAddress) {
        console.log(`🔐 Phantom Wallet: ${walletAddress}`);
      }

      switch (toolName) {
        case 'getTokenInfo':
          result = await this.getTokenInfo(params.mint);
          break;

        case 'buyToken':
          result = await this.buyToken(
            params.mint,
            params.amount,
            params.slippage,
            params.priorityFee,
            params.accountName
          );
          break;

        case 'sellToken':
          result = await this.sellToken(
            params.mint,
            params.percentage,
            params.slippage,
            params.priorityFee,
            params.accountName
          );
          break;

        case 'getAccountBalance':
          result = await this.getAccountBalance(params.accountName, params.mint, walletAddress);
          break;

        case 'listAccounts':
          result = await this.listAccounts();
          break;

        case 'createAccount':
          result = await this.createAccount(params.name);
          break;

        case 'importAccount':
          result = await this.importAccount(params.name, params.secretKey);
          break;

        case 'getTransactionHistory':
          result = await this.getTransactionHistory(
            params.accountName,
            params.limit,
            params.type
          );
          break;

        case 'getPortfolioSummary':
          result = await this.getPortfolioSummary(params.accountName);
          break;

        default:
          result = {
            success: false,
            error: `Unknown tool: ${toolName}`
          };
      }

      // Add metadata
      result.metadata = {
        executionTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolName
      };

      // Log execution
      await awsLogger.info('MCP tool executed', {
        metadata: {
          toolName,
          success: result.success,
          executionTime: result.metadata.executionTime,
          sessionId,
          error: result.error
        }
      });

      console.log(`✅ Tool ${toolName} completed in ${result.metadata.executionTime}ms`);
      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      console.error(`❌ Tool ${toolName} failed:`, errorMessage);
      
      await awsLogger.error('MCP tool execution failed', {
        metadata: {
          toolName,
          error: errorMessage,
          sessionId
        }
      });

      return {
        success: false,
        error: errorMessage,
        metadata: {
          executionTime: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          toolName
        }
      };
    }
  }

  /**
   * Get comprehensive token information
   */
  async getTokenInfo(mint: string): Promise<ToolResult> {
    try {
      // Validate token address format
      if (!mint || mint.length !== 44) {
        return {
          success: false,
          error: '❌ Invalid Token Address',
          data: {
            code: 'INVALID_ADDRESS',
            providedAddress: mint,
            suggestion: 'Solana token addresses are 44 characters long. Please check the address and try again.'
          }
        };
      }

      let mintPubkey: PublicKey;
      try {
        mintPubkey = new PublicKey(mint);
      } catch (error) {
        return {
          success: false,
          error: '❌ Invalid Token Address Format',
          data: {
            code: 'INVALID_PUBLIC_KEY',
            providedAddress: mint,
            suggestion: 'The address format is invalid. Please verify it\'s a valid Solana address.'
          }
        };
      }

      const tokenInfo = await this.pumpFunIntegration.getComprehensiveTokenInfo(mintPubkey);

      if (!tokenInfo) {
        return {
          success: false,
          error: '❌ Token Not Found',
          data: {
            code: 'TOKEN_NOT_FOUND',
            address: mint,
            suggestion: 'This token might not exist, or it might not be a pump.fun token. Verify the address on Solscan.',
            links: {
              solscan: `https://solscan.io/token/${mint}`,
              dexscreener: `https://dexscreener.com/solana/${mint}`
            }
          }
        };
      }

      return {
        success: true,
        data: {
          mint: mint,
          name: tokenInfo.name || 'Unknown',
          symbol: tokenInfo.symbol || 'Unknown',
          description: tokenInfo.description || 'No description',
          image: tokenInfo.image || null,
          price: tokenInfo.priceInSOL,
          priceUSD: tokenInfo.currentPrice,
          marketCap: tokenInfo.marketCap,
          marketCapUSD: tokenInfo.marketCapUSD,
          priceChange24h: tokenInfo.priceChange24h,
          bondingCurve: {
            virtualSolReserves: tokenInfo.virtualSolReserves,
            virtualTokenReserves: tokenInfo.virtualTokenReserves,
            realSolReserves: tokenInfo.realSolReserves,
            realTokenReserves: tokenInfo.realTokenReserves,
            totalSupply: tokenInfo.totalSupply,
            bondingProgress: tokenInfo.bondingProgress
          },
          volume24h: tokenInfo.volume24h,
          liquidity: tokenInfo.liquidity,
          isGraduated: tokenInfo.isGraduated,
          isActive: tokenInfo.isActive,
          poolAddress: tokenInfo.poolAddress,
          website: tokenInfo.website,
          twitter: tokenInfo.twitter,
          telegram: tokenInfo.telegram,
          creator: tokenInfo.creator,
          createdAt: tokenInfo.createdAt,
          decimals: tokenInfo.decimals,
          updatedAt: new Date().toISOString(),
          links: {
            solscan: `https://solscan.io/token/${mint}`,
            dexscreener: `https://dexscreener.com/solana/${mint}`,
            birdeye: `https://birdeye.so/token/${mint}?chain=solana`
          }
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `❌ Failed to get token info: ${errorMessage}`,
        data: {
          code: 'FETCH_ERROR',
          details: errorMessage,
          suggestion: 'This might be a network issue or the token data is unavailable. Try again in a moment.',
          links: {
            solscan: `https://solscan.io/token/${mint}`
          }
        }
      };
    }
  }

  /**
   * Get default account name (prefer phantom > default > first available)
   */
  private getDefaultAccountName(): string {
    try {
      const files = fs.readdirSync(this.keysDir);
      const wallets = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
      
      if (wallets.includes('phantom')) return 'phantom';
      if (wallets.includes('default')) return 'default';
      if (wallets.length > 0) return wallets[0];
      
      throw new Error('No wallet found in .keys directory');
    } catch (error) {
      throw new Error('No wallet configured. Please add a wallet to .keys directory');
    }
  }

  /**
   * Buy tokens
   */
  async buyToken(
    mint: string,
    amount: number,
    slippage: number = 5,
    priorityFee: number = 0.0001,
    accountName?: string
  ): Promise<ToolResult> {
    try {
      // Use default account if not specified
      const walletName = accountName || this.getDefaultAccountName();
      
      // Validate inputs
      if (amount <= 0) {
        return { 
          success: false, 
          error: '❌ Amount must be greater than 0',
          data: { 
            code: 'INVALID_AMOUNT',
            suggestion: 'Please specify a positive SOL amount (e.g., 0.1 SOL)'
          }
        };
      }
      
      if (slippage < 0 || slippage > 100) {
        return { 
          success: false, 
          error: '❌ Slippage must be between 0 and 100',
          data: {
            code: 'INVALID_SLIPPAGE',
            suggestion: 'Typical slippage is 5-10% for volatile tokens'
          }
        };
      }

      // CRITICAL: Check wallet balance before attempting trade
      const keypair = await this.loadKeypair(walletName);
      const balance = await this.connection.getBalance(keypair.publicKey);
      const balanceInSOL = balance / 1e9;
      
      // Calculate total cost including fees (conservative estimate)
      const estimatedFees = priorityFee + 0.00001; // Priority fee + network fee
      const totalCost = amount + estimatedFees;
      const safetyBuffer = 0.001; // Keep 0.001 SOL for future transactions
      
      if (balanceInSOL < totalCost + safetyBuffer) {
        return {
          success: false,
          error: `❌ Insufficient Balance`,
          data: {
            code: 'INSUFFICIENT_BALANCE',
            currentBalance: balanceInSOL.toFixed(4),
            required: totalCost.toFixed(4),
            shortfall: (totalCost + safetyBuffer - balanceInSOL).toFixed(4),
            wallet: keypair.publicKey.toString(),
            suggestion: `You need ${totalCost.toFixed(4)} SOL but only have ${balanceInSOL.toFixed(4)} SOL. Please fund your wallet with at least ${(totalCost + safetyBuffer - balanceInSOL).toFixed(4)} more SOL.`,
            fundingInstructions: `Send SOL to: ${keypair.publicKey.toString()}`
          }
        };
      }

      // Get token info for confirmation
      const tokenInfo = await this.pumpFunIntegration.getComprehensiveTokenInfo(
        new PublicKey(mint)
      );
      
      // Execute buy through UnifiedTrading
      const buyResult = await this.unifiedTrading.buy({
        token: mint,
        amount: amount,
        amountInSol: true,
        slippage: slippage,
        priorityFee: priorityFee
      });
      
      if (!buyResult.success) {
        // Record failed transaction
        this.recordTransaction({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: 'buy',
          timestamp: Date.now(),
          token: mint,
          amount: amount,
          accountName: walletName,
          status: 'failed',
          error: buyResult.error
        });

        return {
          success: false,
          error: `❌ Trade Failed: ${buyResult.error || 'Unknown error'}`,
          data: {
            code: 'TRADE_FAILED',
            details: buyResult.error,
            suggestion: 'Check token address, network status, and try again'
          }
        };
      }
      
      // Record successful transaction
      this.recordTransaction({
        id: buyResult.signature || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'buy',
        timestamp: Date.now(),
        token: mint,
        amount: amount,
        price: tokenInfo?.priceInSOL,
        signature: buyResult.signature,
        accountName: walletName,
        status: 'success'
      });

      return {
        success: true,
        data: {
          transaction: buyResult.signature,
          tokenAmount: buyResult.tokenAmount,
          solSpent: amount,
          tokenName: tokenInfo?.name || 'Unknown',
          tokenSymbol: tokenInfo?.symbol || 'Unknown',
          pricePerToken: tokenInfo?.priceInSOL,
          slippage: slippage,
          priorityFee: priorityFee,
          account: walletName,
          walletAddress: keypair.publicKey.toString(),
          engine: buyResult.engine,
          timestamp: new Date().toISOString(),
          explorer: buyResult.signature ? `https://solscan.io/tx/${buyResult.signature}` : undefined,
          remainingBalance: (balanceInSOL - amount).toFixed(4)
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Record failed transaction
      this.recordTransaction({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'buy',
        timestamp: Date.now(),
        token: mint,
        amount: amount,
        accountName: accountName || this.getDefaultAccountName(),
        status: 'failed',
        error: errorMessage
      });

      return {
        success: false,
        error: `❌ Failed to buy tokens: ${errorMessage}`,
        data: {
          code: 'EXECUTION_ERROR',
          details: errorMessage,
          suggestion: 'Check error details and wallet configuration'
        }
      };
    }
  }

  /**
   * Sell tokens
   */
  async sellToken(
    mint: string,
    percentage: number = 100,
    slippage: number = 5,
    priorityFee: number = 0.0001,
    accountName?: string
  ): Promise<ToolResult> {
    try {
      // Use default account if not specified
      const walletName = accountName || this.getDefaultAccountName();
      
      // Validate inputs
      if (percentage <= 0 || percentage > 100) {
        return { 
          success: false, 
          error: '❌ Percentage must be between 1 and 100',
          data: {
            code: 'INVALID_PERCENTAGE',
            suggestion: 'Use 100 to sell all tokens, or specify a percentage like 50 for half'
          }
        };
      }
      
      if (slippage < 0 || slippage > 100) {
        return { 
          success: false, 
          error: '❌ Slippage must be between 0 and 100',
          data: {
            code: 'INVALID_SLIPPAGE',
            suggestion: 'Typical slippage is 5-10% for volatile tokens'
          }
        };
      }
      
      // CRITICAL: Check token balance before attempting sell
      const keypair = await this.loadKeypair(walletName);
      const balance = await this.getSPLBalance(keypair.publicKey, mint);
      
      if (balance === 0) {
        return { 
          success: false, 
          error: '❌ No Tokens to Sell',
          data: {
            code: 'NO_TOKENS',
            tokenBalance: 0,
            wallet: keypair.publicKey.toString(),
            tokenMint: mint,
            suggestion: 'You don\'t own any of these tokens. Buy some first before selling.'
          }
        };
      }
      
      const tokensToSell = Math.floor(balance * (percentage / 100));
      
      if (tokensToSell === 0) {
        return {
          success: false,
          error: '❌ Sell Amount Too Small',
          data: {
            code: 'AMOUNT_TOO_SMALL',
            tokenBalance: balance,
            percentage: percentage,
            calculatedAmount: tokensToSell,
            suggestion: `Your balance is ${balance} tokens. Increase the percentage or buy more tokens.`
          }
        };
      }
      
      // Check SOL balance for transaction fees
      const solBalance = await this.connection.getBalance(keypair.publicKey);
      const solBalanceInSOL = solBalance / 1e9;
      const minRequiredSOL = priorityFee + 0.00001; // Priority fee + network fee
      
      if (solBalanceInSOL < minRequiredSOL) {
        return {
          success: false,
          error: '❌ Insufficient SOL for Transaction Fees',
          data: {
            code: 'INSUFFICIENT_SOL_FOR_FEES',
            currentSOL: solBalanceInSOL.toFixed(6),
            requiredSOL: minRequiredSOL.toFixed(6),
            shortfall: (minRequiredSOL - solBalanceInSOL).toFixed(6),
            suggestion: `You need ${minRequiredSOL.toFixed(6)} SOL for fees but only have ${solBalanceInSOL.toFixed(6)} SOL. Please add more SOL to your wallet.`,
            fundingAddress: keypair.publicKey.toString()
          }
        };
      }
      
      // Execute sell
      const sellResult = await this.unifiedTrading.sell({
        token: mint,
        amount: tokensToSell,
        amountInSol: false,
        slippage: slippage,
        priorityFee: priorityFee
      });
      
      if (!sellResult.success) {
        // Record failed transaction
        this.recordTransaction({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: 'sell',
          timestamp: Date.now(),
          token: mint,
          amount: tokensToSell,
          accountName: walletName,
          status: 'failed',
          error: sellResult.error
        });

        return {
          success: false,
          error: `❌ Trade Failed: ${sellResult.error || 'Unknown error'}`,
          data: {
            code: 'TRADE_FAILED',
            details: sellResult.error,
            suggestion: 'Check token address, network status, and try again'
          }
        };
      }
      
      // Record successful transaction
      this.recordTransaction({
        id: sellResult.signature || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'sell',
        timestamp: Date.now(),
        token: mint,
        amount: tokensToSell,
        signature: sellResult.signature,
        accountName: walletName,
        status: 'success'
      });

      return {
        success: true,
        data: {
          transaction: sellResult.signature,
          tokensSold: tokensToSell,
          solReceived: sellResult.solAmount,
          percentage: percentage,
          slippage: slippage,
          priorityFee: priorityFee,
          account: walletName,
          walletAddress: keypair.publicKey.toString(),
          engine: sellResult.engine,
          timestamp: new Date().toISOString(),
          explorer: sellResult.signature ? `https://solscan.io/tx/${sellResult.signature}` : undefined,
          remainingTokens: balance - tokensToSell
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Record failed transaction (use percentage to estimate)
      this.recordTransaction({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'sell',
        timestamp: Date.now(),
        token: mint,
        amount: 0, // Unknown amount due to early failure
        accountName: accountName || this.getDefaultAccountName(),
        status: 'failed',
        error: errorMessage
      });

      return {
        success: false,
        error: `❌ Failed to sell tokens: ${errorMessage}`,
        data: {
          code: 'EXECUTION_ERROR',
          details: errorMessage,
          suggestion: 'Check error details and wallet configuration'
        }
      };
    }
  }

  /**
   * Get account balance (SOL or SPL token)
   */
  async getAccountBalance(accountName?: string, mint?: string, phantomWallet?: string): Promise<ToolResult> {
    try {
      // Use default account if not specified
      const walletName = accountName || this.getDefaultAccountName();
      
      let keypair: Keypair | null = null;
      let publicKey: PublicKey;
      let accountSource: string;

      // Try to load from internal account first
      try {
        keypair = await this.loadKeypair(walletName);
        publicKey = keypair.publicKey;
        accountSource = 'internal';
      } catch (error) {
        // If account doesn't exist and phantom wallet is provided, use it
        if (phantomWallet) {
          publicKey = new PublicKey(phantomWallet);
          accountSource = 'phantom';
          console.log(`📱 Using Phantom wallet as fallback: ${phantomWallet}`);
        } else {
          return {
            success: false,
            error: `❌ Wallet Not Found: '${walletName}'`,
            data: {
              code: 'WALLET_NOT_FOUND',
              walletName: walletName,
              suggestion: 'Create a wallet first or check the wallet name. Available wallets can be listed with listAccounts tool.'
            }
          };
        }
      }

      if (mint) {
        // Get SPL token balance
        const balance = await this.getSPLBalance(publicKey, mint);
        
        // Try to get token info for context
        let tokenInfo = null;
        try {
          const info = await this.pumpFunIntegration.getComprehensiveTokenInfo(
            new PublicKey(mint)
          );
          if (info) {
            tokenInfo = {
              name: info.name,
              symbol: info.symbol,
              priceInSOL: info.priceInSOL,
              marketCapUSD: info.marketCapUSD
            };
          }
        } catch (e) {
          // Token info not available - not critical
        }

        const valueInSOL = tokenInfo && tokenInfo.priceInSOL ? balance * tokenInfo.priceInSOL : null;
        const valueInUSD = tokenInfo && tokenInfo.marketCapUSD ? balance * tokenInfo.marketCapUSD : null;

        return {
          success: true,
          data: {
            account: walletName,
            accountSource: accountSource,
            publicKey: publicKey.toString(),
            mint: mint,
            balance: balance,
            tokenInfo: tokenInfo,
            valueInSOL: valueInSOL,
            valueInUSD: valueInUSD,
            formatted: {
              balance: balance.toLocaleString(),
              valueInSOL: valueInSOL ? `${valueInSOL.toFixed(4)} SOL` : 'N/A',
              valueInUSD: valueInUSD ? `$${valueInUSD.toFixed(2)}` : 'N/A'
            }
          }
        };
      } else {
        // Get SOL balance
        const balance = await this.connection.getBalance(publicKey);
        const balanceInSOL = balance / 1e9;

        console.log(`💰 Balance for ${walletName} (${accountSource}): ${balanceInSOL} SOL`);

        // Determine balance status
        let balanceStatus = 'healthy';
        let balanceWarning = null;
        
        if (balanceInSOL === 0) {
          balanceStatus = 'empty';
          balanceWarning = '⚠️ Wallet is empty. Fund it to start trading.';
        } else if (balanceInSOL < 0.01) {
          balanceStatus = 'low';
          balanceWarning = '⚠️ Balance is very low. You may not have enough for transactions.';
        }

        return {
          success: true,
          data: {
            account: walletName,
            accountSource: accountSource,
            publicKey: publicKey.toString(),
            balance: balanceInSOL,
            balanceInLamports: balance,
            currency: 'SOL',
            status: balanceStatus,
            warning: balanceWarning,
            formatted: {
              balance: `${balanceInSOL.toFixed(4)} SOL`,
              fiat: `~$${(balanceInSOL * 180).toFixed(2)} USD` 
            },
            fundingInstructions: balanceInSOL < 0.01 ? `Send SOL to: ${publicKey.toString()}` : null
          }
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `❌ Failed to get account balance: ${errorMessage}`,
        data: {
          code: 'BALANCE_CHECK_FAILED',
          details: errorMessage,
          suggestion: 'Check wallet name and network connection'
        }
      };
    }
  }

  /**
   * List all available accounts
   */
  async listAccounts(): Promise<ToolResult> {
    try {
      if (!fs.existsSync(this.keysDir)) {
        return {
          success: true,
          data: {
            accounts: [],
            count: 0,
            message: '📭 No wallets found',
            suggestion: 'Create your first wallet with the createAccount tool',
            keysDirectory: this.keysDir
          }
        };
      }

      const files = fs.readdirSync(this.keysDir);
      const accountFiles = files.filter(f => f.endsWith('.json'));

      console.log(`📋 Found ${accountFiles.length} account(s)`);

      if (accountFiles.length === 0) {
        return {
          success: true,
          data: {
            accounts: [],
            count: 0,
            message: '📭 No wallets found',
            suggestion: 'Create your first wallet with the createAccount tool',
            keysDirectory: this.keysDir
          }
        };
      }

      const accounts = await Promise.all(
        accountFiles.map(async (file) => {
          const accountName = file.replace('.json', '');
          try {
            const keypair = await this.loadKeypair(accountName);
            const balance = await this.connection.getBalance(keypair.publicKey);
            const balanceInSOL = balance / 1e9;
            
            return {
              name: accountName,
              publicKey: keypair.publicKey.toString(),
              balance: balanceInSOL,
              balanceInLamports: balance,
              status: balanceInSOL === 0 ? 'empty' : balanceInSOL < 0.01 ? 'low' : 'healthy',
              isDefault: accountName === this.getDefaultAccountName(),
              formatted: {
                balance: `${balanceInSOL.toFixed(4)} SOL`,
                approximate: `~$${(balanceInSOL * 180).toFixed(2)} USD`
              }
            };
          } catch (error) {
            return {
              name: accountName,
              publicKey: 'Error loading keypair',
              balance: 0,
              balanceInLamports: 0,
              status: 'error',
              error: error instanceof Error ? error.message : 'Unknown error',
              isDefault: false
            };
          }
        })
      );

      const totalBalance = accounts.reduce((sum, acc) => sum + (acc.balance || 0), 0);
      const healthyAccounts = accounts.filter(acc => acc.status === 'healthy').length;

      return {
        success: true,
        data: {
          accounts: accounts,
          count: accounts.length,
          summary: {
            total: accounts.length,
            healthy: healthyAccounts,
            lowBalance: accounts.filter(acc => acc.status === 'low').length,
            empty: accounts.filter(acc => acc.status === 'empty').length,
            totalBalance: totalBalance,
            formattedTotal: `${totalBalance.toFixed(4)} SOL (~$${(totalBalance * 180).toFixed(2)} USD)`
          },
          defaultAccount: this.getDefaultAccountName()
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `❌ Failed to list accounts: ${errorMessage}`,
        data: {
          code: 'LIST_FAILED',
          details: errorMessage,
          suggestion: 'Check .keys directory permissions and try again'
        }
      };
    }
  }

  /**
   * Create a new account
   */
  async createAccount(name: string = 'default'): Promise<ToolResult> {
    try {
      // Validate account name
      if (!name || name.trim() === '') {
        return {
          success: false,
          error: '❌ Invalid Account Name',
          data: {
            code: 'INVALID_NAME',
            suggestion: 'Provide a valid name for the account (e.g., "phantom", "main-wallet")'
          }
        };
      }

      const keyPath = path.join(this.keysDir, `${name}.json`);
      
      if (fs.existsSync(keyPath)) {
        return {
          success: false,
          error: `❌ Account '${name}' Already Exists`,
          data: {
            code: 'ACCOUNT_EXISTS',
            accountName: name,
            suggestion: 'Choose a different name or use the existing account',
            existingPath: keyPath
          }
        };
      }

      const keypair = Keypair.generate();
      const secretKey = Array.from(keypair.secretKey);
      fs.writeFileSync(keyPath, JSON.stringify(secretKey));

      const balance = await this.connection.getBalance(keypair.publicKey);

      console.log(`✅ Account '${name}' created: ${keypair.publicKey.toString()}`);

      return {
        success: true,
        data: {
          name: name,
          publicKey: keypair.publicKey.toString(),
          balance: balance / 1e9,
          balanceInLamports: balance,
          message: `✅ Account '${name}' created successfully!`,
          warning: '⚠️ IMPORTANT: Fund this wallet with SOL to start trading',
          fundingInstructions: {
            address: keypair.publicKey.toString(),
            minimumRecommended: '0.1 SOL',
            purpose: 'For trading and transaction fees'
          },
          nextSteps: [
            'Send SOL to the address above',
            'Check balance with getAccountBalance tool',
            'Start trading once funded'
          ],
          savedLocation: keyPath
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `❌ Failed to create account: ${errorMessage}`,
        data: {
          code: 'CREATE_FAILED',
          details: errorMessage,
          suggestion: 'Check .keys directory permissions and try again'
        }
      };
    }
  }

  /**
   * Import an existing account
   */
  async importAccount(name: string, secretKey: string): Promise<ToolResult> {
    try {
      // Validate account name
      if (!name || name.trim() === '') {
        return {
          success: false,
          error: '❌ Invalid Account Name',
          data: {
            code: 'INVALID_NAME',
            suggestion: 'Provide a valid name for the account (e.g., "phantom", "main-wallet")'
          }
        };
      }

      // Validate secret key is provided
      if (!secretKey || secretKey.trim() === '') {
        return {
          success: false,
          error: '❌ Secret Key Required',
          data: {
            code: 'MISSING_SECRET_KEY',
            suggestion: 'Provide the secret key as a base58 string or JSON array (e.g., [1,2,3,...])',
            formats: [
              'Base58 string (default wallet export format)',
              'JSON array of numbers [1,2,3,...,255] (64 bytes)'
            ]
          }
        };
      }

      const keyPath = path.join(this.keysDir, `${name}.json`);
      
      if (fs.existsSync(keyPath)) {
        return {
          success: false,
          error: `❌ Account '${name}' Already Exists`,
          data: {
            code: 'ACCOUNT_EXISTS',
            accountName: name,
            suggestion: 'Choose a different name or delete the existing account first',
            existingPath: keyPath
          }
        };
      }

      let keypair: Keypair;
      let keyFormat: string;

      // Try parsing as JSON array first
      try {
        const secretKeyArray = JSON.parse(secretKey);
        
        if (!Array.isArray(secretKeyArray)) {
          return {
            success: false,
            error: '❌ Invalid Secret Key Format',
            data: {
              code: 'INVALID_JSON_FORMAT',
              suggestion: 'JSON secret key must be an array of numbers: [1,2,3,...,255]'
            }
          };
        }

        if (secretKeyArray.length !== 64) {
          return {
            success: false,
            error: '❌ Invalid Secret Key Length',
            data: {
              code: 'INVALID_KEY_LENGTH',
              received: secretKeyArray.length,
              expected: 64,
              suggestion: 'Solana secret keys must be exactly 64 bytes'
            }
          };
        }

        keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray));
        keyFormat = 'JSON array';
      } catch {
        // Try as base58
        try {
          const bs58 = require('bs58');
          const decoded = bs58.decode(secretKey);
          
          if (decoded.length !== 64) {
            return {
              success: false,
              error: '❌ Invalid Base58 Secret Key Length',
              data: {
                code: 'INVALID_KEY_LENGTH',
                received: decoded.length,
                expected: 64,
                suggestion: 'Solana secret keys must be exactly 64 bytes when decoded'
              }
            };
          }

          keypair = Keypair.fromSecretKey(decoded);
          keyFormat = 'Base58 string';
        } catch (parseError) {
          return {
            success: false,
            error: '❌ Invalid Secret Key Format',
            data: {
              code: 'INVALID_SECRET_KEY',
              suggestion: 'Secret key must be either a base58 string or JSON array [1,2,3,...,255]',
              formats: [
                'Base58 string (default wallet export format)',
                'JSON array of numbers [1,2,3,...,255] (64 bytes)'
              ],
              details: parseError instanceof Error ? parseError.message : 'Parse failed'
            }
          };
        }
      }

      // Save keypair
      const secretKeyArray = Array.from(keypair.secretKey);
      fs.writeFileSync(keyPath, JSON.stringify(secretKeyArray));

      const balance = await this.connection.getBalance(keypair.publicKey);
      const balanceInSOL = balance / 1e9;

      console.log(`✅ Account '${name}' imported: ${keypair.publicKey.toString()}`);

      return {
        success: true,
        data: {
          name: name,
          publicKey: keypair.publicKey.toString(),
          balance: balanceInSOL,
          balanceInLamports: balance,
          keyFormat: keyFormat,
          message: `✅ Account '${name}' imported successfully!`,
          status: balanceInSOL === 0 ? 'empty' : balanceInSOL < 0.01 ? 'low' : 'healthy',
          warning: balanceInSOL < 0.01 ? '⚠️ Wallet has low or zero balance. Fund it to start trading.' : null,
          fundingInstructions: balanceInSOL < 0.01 ? {
            address: keypair.publicKey.toString(),
            minimumRecommended: '0.1 SOL',
            purpose: 'For trading and transaction fees'
          } : null,
          formatted: {
            balance: `${balanceInSOL.toFixed(4)} SOL`,
            approximate: `~$${(balanceInSOL * 180).toFixed(2)} USD`
          },
          savedLocation: keyPath
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `❌ Failed to import account: ${errorMessage}`,
        data: {
          code: 'IMPORT_FAILED',
          details: errorMessage,
          suggestion: 'Check secret key format and .keys directory permissions'
        }
      };
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory(
    accountName?: string,
    limit: number = 50,
    type?: 'buy' | 'sell'
  ): Promise<ToolResult> {
    try {
      let transactions = [...this.transactionHistory];

      // Filter by account if specified
      if (accountName) {
        transactions = transactions.filter(tx => tx.accountName === accountName);
      }

      // Filter by type if specified
      if (type) {
        transactions = transactions.filter(tx => tx.type === type);
      }

      // Sort by timestamp descending (newest first)
      transactions.sort((a, b) => b.timestamp - a.timestamp);

      // Limit results
      transactions = transactions.slice(0, limit);

      const stats = {
        total: transactions.length,
        successful: transactions.filter(tx => tx.status === 'success').length,
        failed: transactions.filter(tx => tx.status === 'failed').length,
        buys: transactions.filter(tx => tx.type === 'buy').length,
        sells: transactions.filter(tx => tx.type === 'sell').length
      };

      return {
        success: true,
        data: {
          transactions: transactions.map(tx => ({
            id: tx.id,
            type: tx.type,
            status: tx.status,
            token: tx.token,
            amount: tx.amount,
            price: tx.price,
            signature: tx.signature,
            accountName: tx.accountName,
            timestamp: new Date(tx.timestamp).toISOString(),
            error: tx.error,
            explorer: tx.signature ? `https://solscan.io/tx/${tx.signature}` : undefined
          })),
          stats: stats,
          filters: {
            accountName: accountName || 'all',
            type: type || 'all',
            limit: limit
          }
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `❌ Failed to get transaction history: ${errorMessage}`,
        data: {
          code: 'HISTORY_FETCH_FAILED',
          details: errorMessage
        }
      };
    }
  }

  /**
   * Get portfolio summary across all accounts
   */
  async getPortfolioSummary(accountName?: string): Promise<ToolResult> {
    try {
      const walletName = accountName || this.getDefaultAccountName();
      
      // Get all accounts or just the specified one
      const accountsToCheck = accountName 
        ? [accountName] 
        : fs.readdirSync(this.keysDir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));

      if (accountsToCheck.length === 0) {
        return {
          success: true,
          data: {
            accounts: [],
            totalSOL: 0,
            totalUSD: 0,
            message: '📭 No accounts found',
            suggestion: 'Create an account first with the createAccount tool'
          }
        };
      }

      const portfolioData = await Promise.all(
        accountsToCheck.map(async (name) => {
          try {
            const keypair = await this.loadKeypair(name);
            const solBalance = await this.connection.getBalance(keypair.publicKey);
            const solBalanceInSOL = solBalance / 1e9;

            return {
              accountName: name,
              publicKey: keypair.publicKey.toString(),
              solBalance: solBalanceInSOL,
              usdValue: solBalanceInSOL * 180, // Approximate
              status: solBalanceInSOL === 0 ? 'empty' : solBalanceInSOL < 0.01 ? 'low' : 'healthy',
              isDefault: name === this.getDefaultAccountName()
            };
          } catch (error) {
            return {
              accountName: name,
              publicKey: 'Error loading',
              solBalance: 0,
              usdValue: 0,
              status: 'error',
              error: error instanceof Error ? error.message : 'Unknown error',
              isDefault: false
            };
          }
        })
      );

      const totalSOL = portfolioData.reduce((sum, acc) => sum + acc.solBalance, 0);
      const totalUSD = totalSOL * 180;
      const healthyAccounts = portfolioData.filter(acc => acc.status === 'healthy').length;

      // Get recent transactions for this account/all accounts
      const recentTxs = this.transactionHistory
        .filter(tx => !accountName || tx.accountName === accountName)
        .slice(-10)
        .reverse();

      return {
        success: true,
        data: {
          accounts: portfolioData,
          summary: {
            totalAccounts: portfolioData.length,
            healthyAccounts: healthyAccounts,
            totalSOL: totalSOL.toFixed(4),
            totalUSD: totalUSD.toFixed(2),
            formatted: `${totalSOL.toFixed(4)} SOL (~$${totalUSD.toFixed(2)} USD)`
          },
          recentActivity: {
            transactions: recentTxs.slice(0, 5),
            totalTransactions: this.transactionHistory.length
          },
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `❌ Failed to get portfolio summary: ${errorMessage}`,
        data: {
          code: 'PORTFOLIO_FETCH_FAILED',
          details: errorMessage,
          suggestion: 'Check account names and network connection'
        }
      };
    }
  }

  /**
   * Load keypair from file
   */
  private async loadKeypair(name: string): Promise<Keypair> {
    const keyPath = path.join(this.keysDir, `${name}.json`);

    if (!fs.existsSync(keyPath)) {
      throw new Error(`Account '${name}' not found. Create it first with createAccount tool.`);
    }

    const secretKey = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
  }

  /**
   * Get SPL token balance
   */
  private async getSPLBalance(publicKey: PublicKey, mintAddress: string): Promise<number> {
    try {
      const mint = new PublicKey(mintAddress);
      const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
      
      const ata = await getAssociatedTokenAddress(mint, publicKey);
      const account = await getAccount(this.connection, ata);
      
      return Number(account.amount);
    } catch (error) {
      // Account doesn't exist or no balance
      return 0;
    }
  }
}

// Export singleton instance
export const mcpToolExecutor = new MCPToolExecutor();