/**
 * MCP Server Integration for Advanced Agent Capabilities
 * Implements Model Context Protocol for pump.fun trading operations
 * Production-ready with comprehensive error handling
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { getPumpFunAPI } from '../trading_utils/PumpFunAPI';
import { PumpFunIntegration } from '../trading_utils/PumpFunIntegration';
import { UnifiedTrading } from '../trading_utils/UnifiedTrading';
import { TRADING_CONFIG } from '../trading_utils/config';
import * as fs from 'fs';
import * as path from 'path';
import bs58 from 'bs58';

// Schema definitions using Zod
const GetTokenInfoSchema = z.object({
  mint: z.string().describe('The token mint address'),
});

const BuyTokenSchema = z.object({
  mint: z.string().describe('The token mint address'),
  amount: z.number().describe('Amount in SOL to spend'),
  slippage: z.number().optional().default(5).describe('Slippage tolerance percentage'),
  priorityFee: z.number().optional().default(0.0001).describe('Priority fee in SOL'),
});

const SellTokenSchema = z.object({
  mint: z.string().describe('The token mint address'),
  percentage: z.number().optional().default(100).describe('Percentage of tokens to sell (1-100)'),
  slippage: z.number().optional().default(5).describe('Slippage tolerance percentage'),
  priorityFee: z.number().optional().default(0.0001).describe('Priority fee in SOL'),
});

const ListAccountsSchema = z.object({});

const GetAccountBalanceSchema = z.object({
  accountName: z.string().describe('Name of the account'),
  mint: z.string().optional().describe('Optional token mint to get SPL token balance'),
});

const CreateAccountSchema = z.object({
  name: z.string().optional().describe('Name for the new account (default: "default")'),
});

const ImportAccountSchema = z.object({
  name: z.string().describe('Name for the imported account'),
  secretKey: z.string().describe('Secret key as base58 string or JSON array'),
});

// MCP Server Class
export class MCPPumpFunServer {
  private server: Server;
  private connection: Connection;
  private keysDir: string;
  private defaultAccount: string | null = null;
  private pumpFunIntegration: PumpFunIntegration;
  private unifiedTrading: UnifiedTrading;

  constructor() {
    this.server = new Server(
      {
        name: 'pumpfun-trading-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize Solana connection
    this.connection = new Connection(
      TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );

    // Initialize trading services
    this.pumpFunIntegration = new PumpFunIntegration(this.connection);
    this.unifiedTrading = new UnifiedTrading(this.connection);

    // Setup keys directory
    // Use absolute path from project root, not process.cwd() (which could be Claude Desktop's dir)
    const projectRoot = path.resolve(__dirname, '../../..');
    this.keysDir = path.join(projectRoot, '.keys');
    if (!fs.existsSync(this.keysDir)) {
      fs.mkdirSync(this.keysDir, { recursive: true });
    }

    this.setupHandlers();
    this.setupErrorHandling();
  }

  /**
   * Setup all MCP tool handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'get-token-info':
            return await this.handleGetTokenInfo(args);
          case 'buy-token':
            return await this.handleBuyToken(args);
          case 'sell-token':
            return await this.handleSellToken(args);
          case 'list-accounts':
            return await this.handleListAccounts(args);
          case 'get-account-balance':
            return await this.handleGetAccountBalance(args);
          case 'create-account':
            return await this.handleCreateAccount(args);
          case 'import-account':
            return await this.handleImportAccount(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }

  /**
   * Define available MCP tools
   */
  private getTools(): Tool[] {
    return [
      {
        name: 'get-token-info',
        description: 'Get comprehensive information about a pump.fun token including bonding curve state, price, and metadata',
        inputSchema: {
          type: 'object',
          properties: {
            mint: {
              type: 'string',
              description: 'The token mint address',
            },
          },
          required: ['mint'],
        },
      },
      {
        name: 'buy-token',
        description: 'Buy a pump.fun token with SOL',
        inputSchema: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'The token mint address' },
            amount: { type: 'number', description: 'Amount in SOL to spend' },
            slippage: { type: 'number', description: 'Slippage tolerance percentage (default: 5)' },
            priorityFee: { type: 'number', description: 'Priority fee in SOL (default: 0.0001)' },
          },
          required: ['mint', 'amount'],
        },
      },
      {
        name: 'sell-token',
        description: 'Sell pump.fun tokens for SOL',
        inputSchema: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'The token mint address' },
            percentage: { type: 'number', description: 'Percentage of tokens to sell (1-100, default: 100)' },
            slippage: { type: 'number', description: 'Slippage tolerance percentage (default: 5)' },
            priorityFee: { type: 'number', description: 'Priority fee in SOL (default: 0.0001)' },
          },
          required: ['mint'],
        },
      },
      {
        name: 'list-accounts',
        description: 'List all available trading accounts (keypairs)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get-account-balance',
        description: 'Get SOL or SPL token balance for an account',
        inputSchema: {
          type: 'object',
          properties: {
            accountName: { type: 'string', description: 'Name of the account' },
            mint: { type: 'string', description: 'Optional token mint to get SPL token balance' },
          },
          required: ['accountName'],
        },
      },
      {
        name: 'create-account',
        description: 'Create a new trading account (keypair)',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for the new account (default: "default")' },
          },
        },
      },
      {
        name: 'import-account',
        description: 'Import an existing keypair from secret key',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for the imported account' },
            secretKey: { type: 'string', description: 'Secret key as base58 string or JSON array' },
          },
          required: ['name', 'secretKey'],
        },
      },
    ];
  }

  /**
   * Handle get-token-info tool
   */
  private async handleGetTokenInfo(args: unknown) {
    const parsed = GetTokenInfoSchema.parse(args);

    try {
      const mint = new PublicKey(parsed.mint);
      const tokenInfo = await this.pumpFunIntegration.getComprehensiveTokenInfo(mint);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(tokenInfo, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to get token info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle buy-token tool
   */
  private async handleBuyToken(args: unknown) {
    const parsed = BuyTokenSchema.parse(args);

    try {
      const keypair = await this.getOrCreateDefaultKeypair();
      
      // Check balance
      const balance = await this.connection.getBalance(keypair.publicKey);
      const balanceInSol = balance / 1e9;
      
      if (balanceInSol < parsed.amount) {
        throw new Error(`Insufficient balance. Account has ${balanceInSol.toFixed(4)} SOL but trying to spend ${parsed.amount} SOL`);
      }

      const result = await this.unifiedTrading.buy({
        token: parsed.mint,
        amount: parsed.amount,
        amountInSol: true,
        slippage: parsed.slippage,
        priorityFee: parsed.priorityFee,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              signature: result.signature,
              account: keypair.publicKey.toString(),
              message: `Successfully bought ${parsed.amount} SOL worth of tokens`,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to buy token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle sell-token tool
   */
  private async handleSellToken(args: unknown) {
    const parsed = SellTokenSchema.parse(args);

    try {
      const keypair = await this.getOrCreateDefaultKeypair();

      const result = await this.unifiedTrading.sell({
        token: parsed.mint,
        amount: parsed.percentage,
        slippage: parsed.slippage,
        priorityFee: parsed.priorityFee,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              signature: result.signature,
              account: keypair.publicKey.toString(),
              message: `Successfully sold ${parsed.percentage}% of tokens`,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to sell token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle list-accounts tool
   */
  private async handleListAccounts(args: unknown) {
    ListAccountsSchema.parse(args);

    try {
      // Ensure .keys directory exists
      if (!fs.existsSync(this.keysDir)) {
        fs.mkdirSync(this.keysDir, { recursive: true });
      }

      const files = fs.readdirSync(this.keysDir);
      const accounts = files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));


      // If no accounts exist, create a default one
      if (accounts.length === 0) {
        const defaultKeypair = await this.getOrCreateDefaultKeypair();
        const balance = await this.connection.getBalance(defaultKeypair.publicKey);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Created new default trading account',
                accounts: [{
                  name: this.defaultAccount || 'default',
                  publicKey: defaultKeypair.publicKey.toString(),
                  balance: balance / 1e9,
                  note: 'This is a newly created account. Please fund it with SOL to start trading.',
                }],
              }, null, 2),
            },
          ],
        };
      }

      const accountsWithBalances = await Promise.all(
        accounts.map(async (name) => {
          try {
            const keypair = await this.loadKeypair(name);
            const balance = await this.connection.getBalance(keypair.publicKey);
            return {
              name,
              publicKey: keypair.publicKey.toString(),
              balance: balance / 1e9, // Convert lamports to SOL
            };
          } catch (error) {
            return {
              name,
              publicKey: 'Error loading keypair',
              balance: 0,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              totalAccounts: accountsWithBalances.length,
              accounts: accountsWithBalances,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to list accounts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle get-account-balance tool
   */
  private async handleGetAccountBalance(args: unknown) {
    const parsed = GetAccountBalanceSchema.parse(args);

    try {
      const keypair = await this.loadKeypair(parsed.accountName);

      if (parsed.mint) {
        // Get SPL token balance
        const balance = await this.getSPLBalance(keypair.publicKey, parsed.mint);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                account: parsed.accountName,
                publicKey: keypair.publicKey.toString(),
                mint: parsed.mint,
                balance,
              }, null, 2),
            },
          ],
        };
      } else {
        // Get SOL balance
        const balance = await this.connection.getBalance(keypair.publicKey);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                account: parsed.accountName,
                publicKey: keypair.publicKey.toString(),
                balance: balance / 1e9, // Convert lamports to SOL
              }, null, 2),
            },
          ],
        };
      }
    } catch (error) {
      throw new Error(`Failed to get account balance: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get or create default keypair
   */
  private async getOrCreateDefaultKeypair(): Promise<Keypair> {
    if (!this.defaultAccount) {
      // Try to find first available account, prefer 'phantom' or 'default'
      const files = fs.readdirSync(this.keysDir);
      const accounts = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
      
      if (accounts.includes('phantom')) {
        this.defaultAccount = 'phantom';
      } else if (accounts.includes('default')) {
        this.defaultAccount = 'default';
      } else if (accounts.length > 0) {
        this.defaultAccount = accounts[0];
      } else {
        this.defaultAccount = 'default';
      }
    }
    return this.getOrCreateKeypair(this.defaultAccount);
  }

  /**
   * Get or create a named keypair
   */
  private async getOrCreateKeypair(name: string): Promise<Keypair> {
    const keyPath = path.join(this.keysDir, `${name}.json`);

    if (fs.existsSync(keyPath)) {
      return this.loadKeypair(name);
    }

    // Create new keypair
    const keypair = Keypair.generate();
    const secretKey = Array.from(keypair.secretKey);
    fs.writeFileSync(keyPath, JSON.stringify(secretKey));
    return keypair;
  }

  /**
   * Load keypair from file
   */
  private async loadKeypair(name: string): Promise<Keypair> {
    const keyPath = path.join(this.keysDir, `${name}.json`);

    if (!fs.existsSync(keyPath)) {
      throw new Error(`Keypair not found: ${name}`);
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

  /**
   * Handle create-account tool
   */
  private async handleCreateAccount(args: unknown) {
    const parsed = CreateAccountSchema.parse(args);
    const accountName = parsed.name || 'default';

    try {
      // Check if account already exists
      const keyPath = path.join(this.keysDir, `${accountName}.json`);
      if (fs.existsSync(keyPath)) {
        throw new Error(`Account '${accountName}' already exists`);
      }

      const keypair = await this.getOrCreateKeypair(accountName);
      const balance = await this.connection.getBalance(keypair.publicKey);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              name: accountName,
              publicKey: keypair.publicKey.toString(),
              balance: balance / 1e9,
              message: `Account '${accountName}' created successfully. Please fund it with SOL to start trading.`,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to create account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle import-account tool
   */
  private async handleImportAccount(args: unknown) {
    const parsed = ImportAccountSchema.parse(args);

    try {
      // Check if account already exists
      const keyPath = path.join(this.keysDir, `${parsed.name}.json`);
      if (fs.existsSync(keyPath)) {
        throw new Error(`Account '${parsed.name}' already exists`);
      }

      let keypair: Keypair;
      
      // Try to parse as base58
      try {
        const decoded = bs58.decode(parsed.secretKey);
        keypair = Keypair.fromSecretKey(decoded);
      } catch {
        // Try to parse as JSON array
        try {
          const secretKeyArray = JSON.parse(parsed.secretKey);
          keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyArray));
        } catch {
          throw new Error('Invalid secret key format. Expected base58 string or JSON array.');
        }
      }

      // Save keypair
      const secretKey = Array.from(keypair.secretKey);
      fs.writeFileSync(keyPath, JSON.stringify(secretKey));

      const balance = await this.connection.getBalance(keypair.publicKey);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              name: parsed.name,
              publicKey: keypair.publicKey.toString(),
              balance: balance / 1e9,
              message: `Account '${parsed.name}' imported successfully.`,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to import account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Setup error handling
   */
  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
       console.error('MCP Server Error:', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
  const transport = new StdioServerTransport();
  await this.server.connect(transport);
  }
}

// Singleton instance
let mcpServerInstance: MCPPumpFunServer | null = null;

/**
 * Get MCP server instance
 */
export function getMCPServer(): MCPPumpFunServer {
  if (!mcpServerInstance) {
    mcpServerInstance = new MCPPumpFunServer();
  }
  return mcpServerInstance;
}

/**
 * Start MCP server
 */
export async function startMCPServer(): Promise<void> {
  const server = getMCPServer();
  await server.start();
}
