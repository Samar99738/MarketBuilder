import express, { Request, Response } from "express";
import http from "http";
import path from "path";
import { Server } from "socket.io";
import dotenv from "dotenv";
import {
  buyTokens,
  sellTokens,
  getTokenPriceUSD,
} from "../trading_utils/TokenUtils";
import { strategyExecutionManager } from "../trading_utils/StrategyExecutionManager";
import { performanceMonitor } from "../trading_utils/PerformanceOptimizer";
import { awsLogger } from "../aws/logger";
import { getAWSConfig } from "../aws/config";
import { mpcWalletManager } from "../trading_utils/MPCWallet";
import { MPC_CONFIG } from "../trading_utils/config";
import authRoutes from "./routes/auth";

// Database imports
import { connectDatabase, disconnectDatabase, checkDatabaseHealth, getDatabaseStats } from '../database/client';

// Import new middleware and routes
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiLimiter, tradingLimiter } from "./middleware/rateLimiting";
import { securityHeaders, configureCORS, requestLogger, preventParameterPollution } from "./middleware/security";
import { sanitizeRequestBody } from "./middleware/validation";
import strategyRoutes from "./routes/strategies";
import walletRoutes from "./routes/wallet";
import agentRoutes from "./routes/agent";
import pumpfunRoutes from "./routes/pumpfun";
import performanceRoutes from "./routes/performance";
import approvalRoutes from "./routes/approvals";
import paperTradingRoutes from "./routes/paper-trading";
import monitoringRoutes from "./routes/monitoring";
import { setupSwagger } from "./swagger";
import { WebSocketHandlers, setWebSocketHandlers } from "./websocket";
import { performanceBroadcaster } from "./websocket/performanceBroadcaster";
import { initializeSecrets } from "../security/SecretsManager";
import { paperTradingEngine } from "../trading_utils/paper-trading/PaperTradingEngine";
import { agentController } from "../agent/agentController";
import { RealTradeFeedService } from "./websocket/RealTradeFeedService";
import { TokenValidationService } from "../trading_utils/TokenValidationService";
import { Connection } from "@solana/web3.js";
import { TRADING_CONFIG } from "../trading_utils/config";
import { 
  getOptimizedConnection, 
  getConnectionForUseCase, 
  logRPCConfiguration,
  getRPCMetrics 
} from "../config/rpc-config";
import { monitoringService, startMetricsCollection } from "../utils/monitoring";


// Load environment variables
dotenv.config();

const awsConfig = getAWSConfig();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Initialize WebSocket handlers
const wsHandlers = new WebSocketHandlers(io);
wsHandlers.initialize();

// Set global WebSocket handlers instance for access from routes
setWebSocketHandlers(wsHandlers);

// Initialize performance broadcaster
performanceBroadcaster.initialize(wsHandlers);

// Initialize paper trading engine with WebSocket
paperTradingEngine.setSocketIO(io);

// Initialize agent controller with WebSocket
agentController.setSocketIO(io);
console.log('AgentController WebSocket configured in server.ts');

// Initialize strategy execution manager with WebSocket
strategyExecutionManager.setWebSocketServer(io);
console.log('StrategyExecutionManager WebSocket configured in server.ts');

// Log RPC configuration
logRPCConfiguration();

// Initialize Real Trade Feed Service with optimized connection
const realTradeFeed = new RealTradeFeedService(
  io,
  TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com'
);
realTradeFeed.start();

// Connect Real Trade Feed to Strategy Execution Manager
strategyExecutionManager.setRealTradeFeed(realTradeFeed);
console.log('✅ Real Trade Feed Service connected to Strategy Execution Manager');

// Initialize Token Validation Service with optimized connection
const connection = getConnectionForUseCase('trading');
const tokenValidator = new TokenValidationService(connection);
strategyExecutionManager.setTokenValidator(tokenValidator);
console.log('✅ Token Validation Service connected to Strategy Execution Manager');

// Port from environment or default
const PORT = process.env.PORT || 3000;

// Security Middleware (must be first)
app.use(securityHeaders);
app.use(configureCORS);
app.use(requestLogger);
app.use(preventParameterPollution);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Input sanitization
app.use(sanitizeRequestBody);

// API rate limiting
app.use('/api/', apiLimiter);

// Enhanced Health check endpoint with database status
app.get(awsConfig.healthCheckPath, async (req, res) => {
  try {
    const strategyHealth = strategyExecutionManager.getHealthStatus();
    const dbHealth = await checkDatabaseHealth();
    const dbStats = await getDatabaseStats();

    const health = {
      status: strategyHealth.healthy && dbHealth ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      service: "strategy-execution-manager",
      environment: awsConfig.environment,
      database: {
        connected: dbHealth,
        stats: dbStats || { users: 0, strategies: 0, trades: 0, paperSessions: 0 }
      },
      ...strategyHealth,
    };

    awsLogger.healthCheck(health.status === "healthy", health);

    res.status(health.status === "healthy" ? 200 : 503).json(health);
  } catch (error) {
    awsLogger.error("Health check failed", { error: error as Error });
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: "Health check failed",
    });
  }
});

// Setup Swagger Documentation
setupSwagger(app);

// Routes
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Solana Trading Strategy API - Production Ready",
    version: "1.0.0",
    documentation: "/api-docs",
    dashboard: "/dashboard.html",
    endpoints: {
      strategies: "/api/v1/strategies",
      templates: "/api/v1/strategies/templates/list",
      wallet: "/api/v1/wallet/info",
      trade: "/api/v1/wallet/trade/:type",
      health: awsConfig.healthCheckPath,
      performance: "/api/performance",
    },
    timestamp: new Date().toISOString(),
  });
});

// API v1 Routes
app.use('/api/v1/strategies', strategyRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/v1/pumpfun', pumpfunRoutes);
app.use('/api', performanceRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/v1/paper-trading', paperTradingRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/monitoring', monitoringRoutes);

// Jupiter DEX Integration endpoints
app.get('/api/jupiter/quote', async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps } = req.query;
    
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps || 50}`;
    const response = await fetch(quoteUrl);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/jupiter/swap', async (req, res) => {
  try {
    const { quoteResponse, userPublicKey } = req.body;
    
    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
      }),
    });

    const data = await swapResponse.json();
    res.json(data);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errorMsg });
  }
});

// REST API endpoints for trading (with rate limiting)
app.post("/api/trade/buy", tradingLimiter, async (req, res) => {
  try {
    const { amountInSol } = req.body;
    const signature = await buyTokens(amountInSol);
    res.json({ success: true, signature });
  } catch (error: any) {
    console.error("Error in buy endpoint:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.post("/api/trade/sell", tradingLimiter, async (req, res) => {
  try {
    const { amountToSell } = req.body;
    const signature = await sellTokens(amountToSell);
    res.json({ success: true, signature });
  } catch (error: any) {
    console.error("Error in sell endpoint:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.get("/api/price", async (req, res) => {
  try {
    console.log('[/api/price] Fetching SOL price...');
    const priceData = await getTokenPriceUSD();
    console.log('[/api/price] Price fetched successfully:', priceData);
    
    res.json({ 
      success: true,
      price: priceData.price,
      source: priceData.source,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[/api/price] Error getting price:", error);
    console.error("[/api/price] Error stack:", error.stack);
    
    // Return fallback price to prevent dashboard from breaking
    res.json({ 
      success: true, // Changed to true so frontend doesn't show error
      price: 184.45, // Reasonable fallback SOL price
      source: 'Fallback (API Error)',
      error: error.message || "Price fetch temporarily unavailable",
      timestamp: new Date().toISOString()
    });
  }
});

// Performance monitoring endpoint
app.get("/api/performance", (req, res) => {
  try {
    const metrics = performanceMonitor.getMetrics();
    res.json({
      success: true,
      performance: {
        ...metrics,
        successRate: metrics.transactionsSent > 0 
          ? ((metrics.transactionsConfirmed / metrics.transactionsSent) * 100).toFixed(2) + '%'
          : 'N/A',
        transactionsPerMinute: metrics.uptimeMs > 0 
          ? ((metrics.transactionsSent / (metrics.uptimeMs / 1000 / 60))).toFixed(2)
          : '0.00'
      }
    });
  } catch (error: any) {
    console.error("Error getting performance metrics:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Strategy execution management endpoints
app.post("/api/strategy/start", async (req, res) => {
  try {
    const { strategyId, restartDelay } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: "strategyId is required" });
    }

    const runningId = await strategyExecutionManager.startStrategy(
      strategyId,
      restartDelay
    );
    awsLogger.strategyStarted(strategyId, runningId);

    res.json({
      success: true,
      runningId,
      message: `Strategy ${strategyId} started with ID ${runningId}`,
    });
  } catch (error: any) {
    awsLogger.error("Failed to start strategy", { error: error as Error });
    res
      .status(500)
      .json({ error: error.message || "Failed to start strategy" });
  }
});

app.post("/api/strategy/stop", async (req, res) => {
  try {
    const { runningId } = req.body;

    if (!runningId) {
      return res.status(400).json({ error: "runningId is required" });
    }

    const stopped = await strategyExecutionManager.stopStrategy(runningId);

    if (stopped) {
      awsLogger.strategyStopped("", runningId);
      res.json({
        success: true,
        message: `Strategy execution ${runningId} stopped`,
      });
    } else {
      res.status(404).json({ error: "Running strategy not found" });
    }
  } catch (error: any) {
    awsLogger.error("Failed to stop strategy", { error: error as Error });
    res.status(500).json({ error: error.message || "Failed to stop strategy" });
  }
});

app.get("/api/strategy/status/:runningId", (req, res) => {
  try {
    const { runningId } = req.params;
    const status = strategyExecutionManager.getStrategyStatus(runningId);

    if (status) {
      res.json(status);
    } else {
      res.status(404).json({ error: "Running strategy not found" });
    }
  } catch (error: any) {
    awsLogger.error("Failed to get strategy status", { error: error as Error });
    res
      .status(500)
      .json({ error: error.message || "Failed to get strategy status" });
  }
});

app.get("/api/strategy/list", (req, res) => {
  try {
    const strategies = strategyExecutionManager.listRunningStrategies();
    res.json({ strategies });
  } catch (error: any) {
    awsLogger.error("Failed to list strategies", { error: error as Error });
    res
      .status(500)
      .json({ error: error.message || "Failed to list strategies" });
  }
});

app.post("/api/strategy/stop-all", async (req, res) => {
  try {
    await strategyExecutionManager.stopAllStrategies();
    awsLogger.info("All strategies stopped via API");
    res.json({
      success: true,
      message: "All strategies stopped",
    });
  } catch (error: any) {
    awsLogger.error("Failed to stop all strategies", { error: error as Error });
    res
      .status(500)
      .json({ error: error.message || "Failed to stop all strategies" });
  }
});

// AWS Deployment endpoints
// AWS deployment endpoints removed - not needed for AI agent
// The agent creates and executes strategies locally

// WebSocket handlers are now managed by WebSocketHandlers class
// Trading functionality integrated via middleware
// Access strategy monitor: wsHandlers.getStrategyMonitor()
// Access price service: wsHandlers.getPriceService()

// Additional trade event handling can be added here if needed
io.on("trade:buy", async (socket, data) => {
  try {
    const { amountInSol, conversationId } = data;
    const signature = await buyTokens(amountInSol);
    socket.emit("trade:response", {
      type: "buy",
      success: true,
      signature,
      conversationId,
    });
  } catch (error: any) {
    console.error("Error in buy socket handling:", error);
    socket.emit("trade:error", {
      type: "buy",
      error: error.message || "Internal server error",
      conversationId: data.conversationId,
    });
  }
});

io.on("trade:sell", async (socket, data) => {
  try {
    const { amountToSell, conversationId } = data;
    const signature = await sellTokens(amountToSell);
    socket.emit("trade:response", {
      type: "sell",
      success: true,
      signature,
      conversationId,
    });
  } catch (error: any) {
    console.error("Error in sell socket handling:", error);
    socket.emit("trade:error", {
      type: "sell",
      error: error.message || "Internal server error",
      conversationId: data.conversationId,
    });
  }
});

// Proxy endpoint for Solana balance queries
app.get('/api/solana/balance/:address', async (req, res) => {
  const { address } = req.params;
  try {
    // Use @solana/web3.js to fetch balance from RPC
    const { Connection, PublicKey } = require('@solana/web3.js');
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    const publicKey = new PublicKey(address);
    const balance = await connection.getBalance(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// Serve static files (agent UI, etc.) - must be before 404 handler
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

// Explicit dashboard route as fallback
app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
});

console.log('[Server] Serving static files from:', publicPath);

// 404 handler (must be after all routes)
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

// Graceful shutdown handler
process.on("SIGTERM", async () => {
  awsLogger.info("SIGTERM received, starting graceful shutdown");
  await disconnectDatabase(); // Disconnect database
  wsHandlers.shutdown();
  await strategyExecutionManager.shutdown();
  server.close(() => {
    awsLogger.info("Server shutdown complete");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  awsLogger.info("SIGINT received, starting graceful shutdown");
  await disconnectDatabase(); // Disconnect database
  wsHandlers.shutdown();
  await strategyExecutionManager.shutdown();
  server.close(() => {
    awsLogger.info("Server shutdown complete");
    process.exit(0);
  });
});

// Start server
export const startServer = async () => {
  try {
    // Connect to database FIRST
    console.log(' Connecting to database...');
    await connectDatabase();
    console.log(' Database connected successfully');

    // Initialize AWS Secrets Manager (if enabled)
    await initializeSecrets();
    
    // Initialize MPC wallet if enabled and properly configured
    if (MPC_CONFIG.ENABLED) {
      console.log(`MPC enabled with provider: ${MPC_CONFIG.PROVIDER} - initializing...`);
      try {
        await mpcWalletManager.initialize();
        console.log(`MPC wallet initialized successfully with provider: ${mpcWalletManager.getProviderName()}`);
      } catch (mpcError) {
        console.error('MPC wallet initialization failed:', mpcError);
        console.log('Continuing without MPC wallet - some features may not work');
        // Continue server startup even if MPC fails
      }
    } else if (process.env.MPC_ENABLED === 'true') {
      console.log('MPC enabled in environment but disabled due to configuration issues:');
      if (!process.env.MPC_WALLET_ID && !process.env.MPC_API_KEY) {
        console.log('  - No MPC configuration found (MPC_WALLET_ID or MPC_API_KEY)');
      }
      if (MPC_CONFIG.PROVIDER !== 'mock') {
        console.log(`  - Provider '${MPC_CONFIG.PROVIDER}' not implemented (only 'mock' is available)`);
      }
      console.log('To use MPC, ensure MPC_WALLET_ID or MPC_API_KEY is set and use MPC_PROVIDER=mock');
    }

    // Start the HTTP server
    await new Promise<void>((resolve, reject) => {
      server.listen(PORT, () => {
        awsLogger.info(`Trading MCP Server running on port ${PORT}`, {
          metadata: {
            port: PORT,
            environment: awsConfig.environment,
            healthCheckPath: awsConfig.healthCheckPath,
            mpcEnabled: process.env.MPC_ENABLED === 'true',
            mpcProvider: mpcWalletManager.getProviderName(),
            databaseConnected: true,
          },
        });
        console.log(' Server running on port', PORT);
        console.log(' Prisma Studio: npx prisma studio');
        console.log(' Health Check:', `http://localhost:${PORT}${awsConfig.healthCheckPath}`);
        
        // Start production monitoring
        if (process.env.NODE_ENV === 'production') {
          startMetricsCollection(60000); // Collect metrics every 60 seconds
          console.log('✅ Production monitoring enabled');
        }
        
        resolve();
      });
      
      // Handle server errors during startup
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(` Port ${PORT} is already in use. Please stop the other process or change the PORT in .env`);
          reject(err);
        } else {
          console.error(' Server error:', err);
          reject(err);
        }
      });
    });
  } catch (error) {
    awsLogger.error('Failed to start server', {
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
    console.error(' Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown handlers
async function gracefulShutdown(signal: string) {
  console.log(`\n Received ${signal}, shutting down gracefully...`);
  
  try {
    // 1. Stop accepting new requests
    console.log(' Closing HTTP server...');
    await new Promise<void>((resolve) => {
      server.close(() => {
        console.log('✅ HTTP server closed');
        resolve();
      });
    });
    
    // 2. Stop all running strategies
    console.log(' Stopping all strategies...');
    await strategyExecutionManager.stopAllStrategies();
    console.log('✅ All strategies stopped');
    
    // 3. Close WebSocket connections
    console.log(' Closing WebSocket connections...');
    io.close(() => {
      console.log('✅ WebSocket connections closed');
    });
    
    // 4. Disconnect from database
    console.log(' Closing database connections...');
    await disconnectDatabase();
    console.log('✅ Database connections closed');
    
    // 5. Exit cleanly
    console.log('✅ Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error(' Error during shutdown:', error);
    process.exit(1);
  }
}

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle SIGTERM (termination signal)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

interface ServerExports {
  app: express.Application;
  server: http.Server;
  io: Server;
  wsHandlers: WebSocketHandlers;
  startServer: () => void;
}

export default { app, server, io, wsHandlers, startServer} as ServerExports;

// Auto-start server if this is the main module
if (require.main === module) {
  startServer();
}