import { createInterface } from "readline";
import { z } from "zod";
import {
  buyTokens,
  sellTokens,
  getTokenPriceUSD,
  getSolPriceUSD,
  waitForPriceAbove,
  waitForPriceBelow,
} from "./trading_utils/TokenUtils";
import { strategyBuilder } from "./trading_utils/StrategyBuilder";
import {
  deployCounterToAWS,
  getCounterValueFromAWS,
  stopCounterInAWS,
  removeCounterFromAWS,
  listDeployedCounters,
  debugCounterInAWS,
} from "./trading_utils/CounterUtils";

// JSON-RPC message schema
const JSONRPCMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.any(),
  id: z.number().optional(),
});

type JSONRPCMessage = z.infer<typeof JSONRPCMessageSchema>;

// Set up stdio handling
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Function to send JSON-RPC response
function sendResponse(response: any) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

// Handle incoming messages
rl.on("line", (line) => {
  if (!line.trim()) return;

  try {
    // Parse and validate the message
    const message = JSON.parse(line);
    const validatedMessage = JSONRPCMessageSchema.parse(message);

    // Process based on method
    handleMessage(validatedMessage);
  } catch (error) {
    process.stderr.write(`❌ Error processing message: ${error}\n`);

    sendResponse({
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Parse error",
      },
      id: null,
    });
  }
});

// Sample trade tools definition
const TRADE_TOOLS = [
  {
    name: "buyTokens",
    description: "Buy tokens using Jupiter DEX",
    inputSchema: {
      type: "object",
      properties: {
        amountInSol: {
          type: "number",
          description: "Amount in SOL to spend (required)",
        },
      },
      required: ["amountInSol"],
    },
  },
  {
    name: "sellTokens",
    description:
      "Sell tokens using Jupiter DEX. Requires explicit amount: use -1 to sell ALL tokens, or specify positive number for partial sale",
    inputSchema: {
      type: "object",
      properties: {
        amountToSell: {
          type: "number",
          description:
            "Amount of tokens to sell (required: use -1 for all tokens, or positive number for specific amount)",
        },
      },
      required: ["amountToSell"],
    },
  },
  {
    name: "getTokenPrice",
    description: "Get current token price in USD",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getSolPrice",
    description: "Get current SOL price in USD",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "waitForPriceAbove",
    description:
      "Monitor token price and alert when it goes ABOVE target price",
    inputSchema: {
      type: "object",
      properties: {
        targetPrice: {
          type: "number",
          description:
            "Target price in USD to wait for (alert when price goes above this)",
        },
        checkIntervalMs: {
          type: "number",
          description: "Check interval in milliseconds (default: 5000ms)",
        },
        timeoutMs: {
          type: "number",
          description:
            "Timeout in milliseconds (default: 300000ms = 5 minutes)",
        },
      },
      required: ["targetPrice"],
    },
  },
  {
    name: "waitForPriceBelow",
    description:
      "Monitor token price and alert when it goes BELOW target price",
    inputSchema: {
      type: "object",
      properties: {
        targetPrice: {
          type: "number",
          description:
            "Target price in USD to wait for (alert when price goes below this)",
        },
        checkIntervalMs: {
          type: "number",
          description: "Check interval in milliseconds (default: 5000ms)",
        },
        timeoutMs: {
          type: "number",
          description:
            "Timeout in milliseconds (default: 300000ms = 5 minutes)",
        },
      },
      required: ["targetPrice"],
    },
  },
  {
    name: "deployCounterToAWS",
    description:
      "Deploy a counter function to AWS that will run independently and increment by 10 every second",
    inputSchema: {
      type: "object",
      properties: {
        durationMinutes: {
          type: "number",
          description:
            "Duration to run the counter in minutes (default: 2 minutes)",
        },
      },
      required: [],
    },
  },
  {
    name: "getCounterValueFromAWS",
    description: "Get counter value and status from AWS deployed counter(s)",
    inputSchema: {
      type: "object",
      properties: {
        counterId: {
          type: "string",
          description:
            "ID of specific counter to check (optional - if not provided, returns all counters)",
        },
      },
      required: [],
    },
  },
  {
    name: "stopCounterInAWS",
    description: "Stop a specific counter running on AWS",
    inputSchema: {
      type: "object",
      properties: {
        counterId: {
          type: "string",
          description: "ID of the counter to stop (required)",
        },
      },
      required: ["counterId"],
    },
  },
  {
    name: "removeCounterFromAWS",
    description:
      "Remove/cleanup a deployed counter from AWS (stops and deletes resources)",
    inputSchema: {
      type: "object",
      properties: {
        counterId: {
          type: "string",
          description: "ID of the counter to remove (required)",
        },
      },
      required: ["counterId"],
    },
  },
  {
    name: "listDeployedCounters",
    description: "List all counters deployed to AWS with their status",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "debugCounterInAWS",
    description:
      "Get detailed diagnostics for a specific counter including CloudWatch logs",
    inputSchema: {
      type: "object",
      properties: {
        counterId: {
          type: "string",
          description: "ID of the counter to debug (required)",
        },
      },
      required: ["counterId"],
    },
  },
];

// Strategy tools
const STRATEGY_TOOLS = [
  {
    name: "createStrategy",
    description: "Create a new trading strategy",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique strategy ID",
        },
        name: {
          type: "string",
          description: "Strategy name",
        },
        description: {
          type: "string",
          description: "Strategy description",
        },
        variables: {
          type: "object",
          description: "Strategy variables (optional)",
        },
      },
      required: ["id", "name", "description"],
    },
  },
  {
    name: "addStrategyStep",
    description:
      "Add a single step to a strategy. For buy steps, amountInSol is required. For sell steps, amountToSell is required (-1 for all tokens).",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "Strategy ID to add step to",
        },
        step: {
          type: "object",
          description: "Step configuration",
          properties: {
            id: { type: "string", description: "Unique step ID" },
            type: {
              type: "string",
              enum: [
                "buy",
                "sell",
                "waitPriceAbove",
                "waitPriceBelow",
                "getPrice",
                "getJupiterPrice",
                "getSolPrice",
                "wait",
                "condition",
              ],
              description: "Type of step to execute",
            },
            description: {
              type: "string",
              description: "Step description (optional)",
            },
            onSuccess: {
              type: "string",
              description: "Next step ID on success (optional)",
            },
            onFailure: {
              type: "string",
              description: "Next step ID on failure (optional)",
            },
            amountInSol: {
              type: "number",
              description: "Amount in SOL to spend (REQUIRED for buy steps)",
            },
            amountToSell: {
              type: "number",
              description:
                "Amount of tokens to sell - use -1 for all tokens (REQUIRED for sell steps)",
            },
            targetPrice: {
              type: "number",
              description: "Target price for price-based steps",
            },
            checkIntervalMs: {
              type: "number",
              description: "Check interval in milliseconds",
            },
            timeoutMs: {
              type: "number",
              description: "Timeout in milliseconds",
            },
            durationMs: {
              type: "number",
              description: "Duration in milliseconds for wait steps",
            },
            condition: {
              type: "string",
              enum: ["priceAbove", "priceBelow", "custom"],
              description: "Condition type for condition steps",
            },
            useJupiterPrice: {
              type: "boolean",
              description:
                "Use Jupiter price API for condition checks (optional)",
            },
          },
          required: ["id", "type"],
        },
      },
      required: ["strategyId", "step"],
    },
  },
  {
    name: "addStrategySteps",
    description:
      "Add multiple steps to a strategy in a single operation. More efficient than adding steps one by one. For buy steps, amountInSol is required. For sell steps, amountToSell is required (-1 for all tokens).",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "Strategy ID to add steps to",
        },
        steps: {
          type: "array",
          description: "Array of step configurations to add",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique step ID" },
              type: {
                type: "string",
                enum: [
                  "buy",
                  "sell",
                  "waitPriceAbove",
                  "waitPriceBelow",
                  "getPrice",
                  "getJupiterPrice",
                  "getSolPrice",
                  "wait",
                  "condition",
                ],
                description: "Type of step to execute",
              },
              description: {
                type: "string",
                description: "Step description (optional)",
              },
              onSuccess: {
                type: "string",
                description: "Next step ID on success (optional)",
              },
              onFailure: {
                type: "string",
                description: "Next step ID on failure (optional)",
              },
              amountInSol: {
                type: "number",
                description: "Amount in SOL to spend (REQUIRED for buy steps)",
              },
              amountToSell: {
                type: "number",
                description:
                  "Amount of tokens to sell - use -1 for all tokens (REQUIRED for sell steps)",
              },
              targetPrice: {
                type: "number",
                description: "Target price for price-based steps",
              },
              checkIntervalMs: {
                type: "number",
                description: "Check interval in milliseconds",
              },
              timeoutMs: {
                type: "number",
                description: "Timeout in milliseconds",
              },
              durationMs: {
                type: "number",
                description: "Duration in milliseconds for wait steps",
              },
              condition: {
                type: "string",
                enum: ["priceAbove", "priceBelow", "custom"],
                description: "Condition type for condition steps",
              },
              useJupiterPrice: {
                type: "boolean",
                description:
                  "Use Jupiter price API for condition checks (optional)",
              },
            },
            required: ["id", "type"],
          },
        },
      },
      required: ["strategyId", "steps"],
    },
  },
  {
    name: "executeStrategy",
    description: "Execute a trading strategy",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "Strategy ID to execute",
        },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "listStrategies",
    description: "List all available strategies",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getStrategy",
    description: "Get details of a specific strategy",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "Strategy ID to get details for",
        },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "deleteStrategy",
    description: "Delete a strategy",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "Strategy ID to delete",
        },
      },
      required: ["strategyId"],
    },
  },
];

// Combine all tools
const ALL_TOOLS = [...TRADE_TOOLS, ...STRATEGY_TOOLS];

// Handle JSON-RPC messages
async function handleMessage(message: JSONRPCMessage) {
  try {
    const PROTOCOL_VERSION = "2024-11-05";

    // Check if this is a notification
    const isNotification =
      message.method.startsWith("notifications/") && message.id === undefined;

    // Don't respond to notifications
    if (isNotification) {
      process.stderr.write(`Received notification: ${message.method}\n`);
      return;
    }

    switch (message.method) {
      case "initialize":
        process.stderr.write(
          `Handling initialize request with id: ${message.id}\n`
        );
        sendResponse({
          jsonrpc: "2.0",
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "solana-trade-server",
              version: "1.0.0",
            },
          },
          id: message.id,
        });
        break;

      case "tools/list":
        process.stderr.write(
          `Handling tools/list request with id: ${message.id}\n`
        );
        sendResponse({
          jsonrpc: "2.0",
          result: {
            tools: ALL_TOOLS,
          },
          id: message.id,
        });
        break;

      case "resources/list":
        process.stderr.write(
          `Handling resources/list request with id: ${message.id}\n`
        );
        sendResponse({
          jsonrpc: "2.0",
          result: {
            resources: [], // No resources for now
          },
          id: message.id,
        });
        break;

      case "prompts/list":
        process.stderr.write(
          `Handling prompts/list request with id: ${message.id}\n`
        );
        sendResponse({
          jsonrpc: "2.0",
          result: {
            prompts: [], // No prompts for now
          },
          id: message.id,
        });
        break;

      case "tools/call":
        const result = await handleTradeExecution(message.params);
        sendResponse({
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          },
          id: message.id,
        });
        break;

      default:
        process.stderr.write(`Unknown method: ${message.method}\n`);
        sendResponse({
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Method not found",
          },
          id: message.id,
        });
    }
  } catch (error) {
    process.stderr.write(`Error handling message: ${error}\n`);

    sendResponse({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: "Internal error",
      },
      id: message.id,
    });
  }
}

async function handleTradeExecution(params: any) {
  const { name, arguments: toolArgs } = params;

  try {
    switch (name) {
      case "buyTokens":
        const amountInSol = toolArgs?.amountInSol;
        const buySignature = await buyTokens(amountInSol);
        return {
          success: true,
          message: "Buy transaction successful",
          signature: buySignature,
        };

      case "sellTokens":
        const amountToSell = toolArgs?.amountToSell;
        const sellSignature = await sellTokens(amountToSell);
        return {
          success: true,
          message: "Sell transaction successful",
          signature: sellSignature,
        };

      case "getTokenPrice":
        const price = await getTokenPriceUSD();
        return {
          success: true,
          price: price,
          message: "Token price retrieved successfully",
        };

      case "getSolPrice":
        const solPrice = await getSolPriceUSD();
        return {
          success: true,
          price: solPrice,
          message: "SOL price retrieved successfully",
        };

      case "waitForPriceAbove":
        const targetPrice = toolArgs?.targetPrice;
        const checkIntervalMs = toolArgs?.checkIntervalMs || 5000;
        const timeoutMs = toolArgs?.timeoutMs || 300000;
        const priceResult = await waitForPriceAbove(
          targetPrice,
          checkIntervalMs,
          timeoutMs
        );
        return {
          success: priceResult.success,
          currentPrice: priceResult.currentPrice,
          message: priceResult.message,
        };

      case "waitForPriceBelow":
        const targetPriceBelow = toolArgs?.targetPrice;
        const checkIntervalMsBelow = toolArgs?.checkIntervalMs || 5000;
        const timeoutMsBelow = toolArgs?.timeoutMs || 300000;
        const priceResultBelow = await waitForPriceBelow(
          targetPriceBelow,
          checkIntervalMsBelow,
          timeoutMsBelow
        );
        return {
          success: priceResultBelow.success,
          currentPrice: priceResultBelow.currentPrice,
          message: priceResultBelow.message,
        };

      // Counter function cases
      case "deployCounterToAWS":
        const durationMinutes = toolArgs?.durationMinutes || 2;
        const counterResult = await deployCounterToAWS(durationMinutes);
        return {
          success: counterResult.success,
          message: counterResult.message,
          counterId: counterResult.counterId,
          awsResourceArn: counterResult.awsResourceArn,
        };

      case "getCounterValueFromAWS":
        const counterStatus = await getCounterValueFromAWS(toolArgs?.counterId);
        return {
          success: counterStatus.success,
          counters: counterStatus.counters,
          message: counterStatus.message,
        };

      case "stopCounterInAWS":
        const stopResult = await stopCounterInAWS(toolArgs?.counterId);
        return {
          success: stopResult.success,
          message: stopResult.message,
          finalValue: stopResult.finalValue,
          counterId: stopResult.counterId,
        };

      case "removeCounterFromAWS":
        const removeResult = await removeCounterFromAWS(toolArgs?.counterId);
        return {
          success: removeResult.success,
          message: removeResult.message,
          counterId: removeResult.counterId,
        };

      case "listDeployedCounters":
        const countersList = await listDeployedCounters();
        return {
          success: countersList.success,
          message: countersList.message,
          counters: countersList.counters,
        };

      case "debugCounterInAWS":
        const debugCounterId = toolArgs?.counterId;
        if (!debugCounterId) {
          throw new Error("counterId is required for debugging");
        }

        // Use the comprehensive debug function from CounterUtils
        const { debugCounterInAWS } = await import(
          "./trading_utils/CounterUtils"
        );
        const debugResult = await debugCounterInAWS(debugCounterId);

        return {
          success: debugResult.success,
          message: debugResult.message,
          counterId: debugResult.counterId,
          debugInfo: debugResult.debugInfo,
        };

      // Strategy management cases
      case "createStrategy":
        const { id, name: strategyName, description, variables } = toolArgs;
        const strategy = strategyBuilder.createStrategy(
          id,
          strategyName,
          description,
          variables
        );
        return {
          success: true,
          message: `Strategy '${strategyName}' created successfully`,
          strategy: strategy,
        };

      case "addStrategyStep":
        const { strategyId, step } = toolArgs;
        strategyBuilder.addStep(strategyId, step);
        return {
          success: true,
          message: `Step '${step.id}' added to strategy '${strategyId}'`,
        };

      case "addStrategySteps":
        const { strategyId: addStepsStrategyId, steps } = toolArgs;
        strategyBuilder.addSteps(addStepsStrategyId, steps);
        return {
          success: true,
          message: `${steps.length} steps added to strategy '${addStepsStrategyId}' successfully`,
          addedSteps: steps.map((step: any) => ({
            id: step.id,
            type: step.type,
          })),
        };

      case "executeStrategy":
        const { strategyId: execStrategyId } = toolArgs;
        const executionResult = await strategyBuilder.executeStrategy(
          execStrategyId
        );
        return {
          success: executionResult.success,
          message: executionResult.success
            ? "Strategy executed successfully"
            : "Strategy execution failed",
          result: executionResult,
          logs: executionResult.context.logs,
          completedSteps: executionResult.completedSteps,
          error: executionResult.error,
        };

      case "listStrategies":
        const strategies = strategyBuilder.listStrategies();
        return {
          success: true,
          message: `Found ${strategies.length} strategies`,
          strategies: strategies.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            stepCount: s.steps.length,
          })),
        };

      case "getStrategy":
        const { strategyId: getStrategyId } = toolArgs;
        const foundStrategy = strategyBuilder.getStrategy(getStrategyId);
        if (!foundStrategy) {
          return {
            success: false,
            message: `Strategy '${getStrategyId}' not found`,
          };
        }
        return {
          success: true,
          message: `Strategy '${getStrategyId}' retrieved`,
          strategy: foundStrategy,
        };

      case "deleteStrategy":
        const { strategyId: deleteStrategyId } = toolArgs;
        const deleted = strategyBuilder.deleteStrategy(deleteStrategyId);
        return {
          success: deleted,
          message: deleted
            ? `Strategy '${deleteStrategyId}' deleted`
            : `Strategy '${deleteStrategyId}' not found`,
        };

      case "executeTrade":
        // Handle the original executeTrade case
        return { success: true, message: "Trade execution handled" };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    process.stderr.write(`Error executing trade: ${error}\n`);
    return {
      success: false,
      message: `Error: ${error.message || "Unknown error occurred"}`,
    };
  }
}

// Handle process events to prevent unexpected termination
process.on("uncaughtException", (err) => {
  process.stderr.write(`Uncaught exception: ${err}\n`);
});

process.on("unhandledRejection", (reason, promise) => {
  process.stderr.write(
    `Unhandled Rejection at: ${promise}, reason: ${reason}\n`
  );
});

// Handle readline close event
rl.on("close", () => {
  process.stderr.write("Readline interface closed. Keeping process alive.\n");
});

// Keep the process alive
setInterval(() => {}, 60000);

// **START EXPRESS HTTP SERVER ALONGSIDE MCP SERVER**
import('./server/server')
  .then((serverModule) => {
    serverModule.default.startServer();
    process.stderr.write("✅ Express HTTP server started alongside MCP server\n");
  })
  .catch((error) => {
    process.stderr.write(`❌ Failed to start Express server: ${error.message}\n`);
  });

// Log startup
process.stderr.write("MCP server initialized and ready for messages\n");
