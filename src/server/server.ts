import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import {
  buyTokens,
  sellTokens,
  getTokenPriceUSD,
} from "../trading_utils/TokenUtils.js";
import { strategyExecutionManager } from "../trading_utils/StrategyExecutionManager.js";
import { awsLogger } from "../aws/logger.js";
import { getAWSConfig } from "../aws/config.js";
import { awsDeploymentManager } from "../aws/deployment.js";

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

// Port from environment or default
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check endpoint for AWS
app.get(awsConfig.healthCheckPath, (req, res) => {
  try {
    const health = strategyExecutionManager.getHealthStatus();
    awsLogger.healthCheck(health.healthy, health);

    res.status(health.healthy ? 200 : 503).json({
      status: health.healthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      service: "strategy-execution-manager",
      environment: awsConfig.environment,
      ...health,
    });
  } catch (error) {
    awsLogger.error("Health check failed", { error: error as Error });
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: "Health check failed",
    });
  }
});

// Routes
app.get("/", (req, res) => {
  res.send("Trading MCP Server is running");
});

// REST API endpoints for trading
app.post("/api/trade/buy", async (req, res) => {
  try {
    const { amountInSol } = req.body;
    const signature = await buyTokens(amountInSol);
    res.json({ success: true, signature });
  } catch (error: any) {
    console.error("Error in buy endpoint:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.post("/api/trade/sell", async (req, res) => {
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
    const price = await getTokenPriceUSD();
    res.json({ price });
  } catch (error: any) {
    console.error("Error getting price:", error);
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
app.post("/api/deploy/strategy", async (req, res) => {
  try {
    const {
      strategyId,
      environment = "production",
      restartDelay,
      envVars,
    } = req.body;

    if (!strategyId) {
      return res.status(400).json({ error: "strategyId is required" });
    }

    const deploymentId = await awsDeploymentManager.deployStrategy({
      strategyId,
      environment,
      restartDelay,
      envVars,
    });

    res.json({
      success: true,
      deploymentId,
      message: `Strategy ${strategyId} deployed to AWS with ID ${deploymentId}`,
    });
  } catch (error: any) {
    awsLogger.error("Failed to deploy strategy", { error: error as Error });
    res
      .status(500)
      .json({ error: error.message || "Failed to deploy strategy" });
  }
});

app.post("/api/deploy/stop", async (req, res) => {
  try {
    const { deploymentId } = req.body;

    if (!deploymentId) {
      return res.status(400).json({ error: "deploymentId is required" });
    }

    const stopped = await awsDeploymentManager.stopDeployedStrategy(
      deploymentId
    );

    if (stopped) {
      res.json({
        success: true,
        message: `Deployed strategy ${deploymentId} stopped`,
      });
    } else {
      res.status(404).json({ error: "Deployment not found" });
    }
  } catch (error: any) {
    awsLogger.error("Failed to stop deployed strategy", {
      error: error as Error,
    });
    res
      .status(500)
      .json({ error: error.message || "Failed to stop deployed strategy" });
  }
});

app.get("/api/deploy/verify/:deploymentId", async (req, res) => {
  try {
    const { deploymentId } = req.params;
    const deployment = await awsDeploymentManager.verifyStrategyDeployment(
      deploymentId
    );

    if (deployment) {
      res.json(deployment);
    } else {
      res.status(404).json({ error: "Deployment not found" });
    }
  } catch (error: any) {
    awsLogger.error("Failed to verify deployment", { error: error as Error });
    res
      .status(500)
      .json({ error: error.message || "Failed to verify deployment" });
  }
});

app.get("/api/deploy/list", (req, res) => {
  try {
    const deployments = awsDeploymentManager.listDeployedStrategies();
    res.json({ deployments });
  } catch (error: any) {
    awsLogger.error("Failed to list deployments", { error: error as Error });
    res
      .status(500)
      .json({ error: error.message || "Failed to list deployments" });
  }
});

// Socket.io connection for real-time trading
io.on("connection", (socket) => {
  process.stderr.write(`Trading client connected: ${socket.id}\n`);

  // Handle buy request
  socket.on("trade:buy", async (data) => {
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

  // Handle sell request
  socket.on("trade:sell", async (data) => {
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

  // Handle price check
  socket.on("trade:price", async (data) => {
    try {
      const { conversationId } = data;
      const price = await getTokenPriceUSD();
      socket.emit("trade:price", {
        price,
        conversationId,
      });
    } catch (error: any) {
      console.error("Error in price socket handling:", error);
      socket.emit("trade:error", {
        type: "price",
        error: error.message || "Internal server error",
        conversationId: data.conversationId,
      });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    process.stderr.write(`Trading client disconnected: ${socket.id}\n`);
  });
});

// Graceful shutdown handler
process.on("SIGTERM", async () => {
  awsLogger.info("SIGTERM received, starting graceful shutdown");
  await strategyExecutionManager.shutdown();
  server.close(() => {
    awsLogger.info("Server shutdown complete");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  awsLogger.info("SIGINT received, starting graceful shutdown");
  await strategyExecutionManager.shutdown();
  server.close(() => {
    awsLogger.info("Server shutdown complete");
    process.exit(0);
  });
});

// Start server
export const startServer = () => {
  server.listen(PORT, () => {
    awsLogger.info(`Trading MCP Server running on port ${PORT}`, {
      metadata: {
        port: PORT,
        environment: awsConfig.environment,
        healthCheckPath: awsConfig.healthCheckPath,
      },
    });
  });
};

interface ServerExports {
  app: express.Application;
  server: http.Server;
  io: Server;
  startServer: () => void;
}

export default { app, server, io, startServer } as ServerExports;
