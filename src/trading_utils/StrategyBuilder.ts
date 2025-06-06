import {
  buyTokens,
  sellTokens,
  getTokenPriceUSD,
  getJupiterTokenPrice,
  getSolPriceUSD,
  waitForPriceAbove,
  waitForPriceBelow,
} from "./TokenUtils";

// Strategy step types
export type StrategyStepType =
  | "buy"
  | "sell"
  | "waitPriceAbove"
  | "waitPriceBelow"
  | "getPrice"
  | "getJupiterPrice"
  | "getSolPrice"
  | "wait"
  | "condition";

// Base strategy step interface
export interface BaseStrategyStep {
  id: string;
  type: StrategyStepType;
  description?: string;
  onSuccess?: string; // ID of next step on success
  onFailure?: string; // ID of next step on failure
}

// Specific step interfaces
export interface BuyStep extends BaseStrategyStep {
  type: "buy";
  amountInSol: number; // Required: Amount in SOL to spend on buying tokens
}

export interface SellStep extends BaseStrategyStep {
  type: "sell";
  amountToSell: number; // Required: Amount of tokens to sell (-1 for all tokens)
}

export interface WaitPriceAboveStep extends BaseStrategyStep {
  type: "waitPriceAbove";
  targetPrice: number;
  checkIntervalMs?: number;
  timeoutMs?: number;
}

export interface WaitPriceBelowStep extends BaseStrategyStep {
  type: "waitPriceBelow";
  targetPrice: number;
  checkIntervalMs?: number;
  timeoutMs?: number;
}

export interface GetPriceStep extends BaseStrategyStep {
  type: "getPrice";
}

export interface GetJupiterPriceStep extends BaseStrategyStep {
  type: "getJupiterPrice";
}

export interface GetSolPriceStep extends BaseStrategyStep {
  type: "getSolPrice";
}

export interface WaitStep extends BaseStrategyStep {
  type: "wait";
  durationMs: number;
}

export interface ConditionStep extends BaseStrategyStep {
  type: "condition";
  condition: "priceAbove" | "priceBelow" | "custom";
  targetPrice?: number;
  useJupiterPrice?: boolean; // For trading consistency
  customCondition?: (context: StrategyContext) => boolean;
}

// Union type for all step types
export type StrategyStep =
  | BuyStep
  | SellStep
  | WaitPriceAboveStep
  | WaitPriceBelowStep
  | GetPriceStep
  | GetJupiterPriceStep
  | GetSolPriceStep
  | WaitStep
  | ConditionStep;

// Strategy definition
export interface Strategy {
  id: string;
  name: string;
  description: string;
  steps: StrategyStep[];
  startStepId: string;
  variables?: Record<string, any>; // Strategy-level variables
}

// Strategy execution context
export interface StrategyContext {
  strategyId: string;
  currentStepId: string;
  variables: Record<string, any>;
  stepResults: Record<string, any>;
  startTime: number;
  logs: string[];
}

// Strategy execution result
export interface StrategyExecutionResult {
  success: boolean;
  context: StrategyContext;
  error?: string;
  completedSteps: string[];
  finalResult?: any;
}

// Strategy builder class
export class StrategyBuilder {
  private strategies: Map<string, Strategy> = new Map();

  // Create a new strategy
  createStrategy(
    id: string,
    name: string,
    description: string,
    variables?: Record<string, any>
  ): Strategy {
    // Check if strategy with this ID already exists
    if (this.strategies.has(id)) {
      throw new Error(
        `Strategy with ID '${id}' already exists. Use a different ID or delete the existing strategy first.`
      );
    }

    const strategy: Strategy = {
      id,
      name,
      description,
      steps: [],
      startStepId: "",
      variables: variables || {},
    };

    this.strategies.set(id, strategy);
    return strategy;
  }

  // Add a single step to a strategy
  addStep(strategyId: string, step: StrategyStep): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Check for duplicate step IDs within the same strategy
    const existingStep = strategy.steps.find((s) => s.id === step.id);
    if (existingStep) {
      throw new Error(
        `Step with ID '${step.id}' already exists in strategy '${strategyId}'. Each step must have a unique ID.`
      );
    }

    strategy.steps.push(step);

    // Set as start step if it's the first step
    if (strategy.steps.length === 1) {
      strategy.startStepId = step.id;
    }
  }

  // Add multiple steps to a strategy in a single operation
  addSteps(strategyId: string, steps: StrategyStep[]): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    if (!steps || steps.length === 0) {
      throw new Error("At least one step must be provided");
    }

    // Check for duplicate step IDs within the provided steps
    const stepIds = steps.map((step) => step.id);
    const duplicateIds = stepIds.filter(
      (id, index) => stepIds.indexOf(id) !== index
    );
    if (duplicateIds.length > 0) {
      throw new Error(
        `Duplicate step IDs found in provided steps: ${duplicateIds.join(
          ", "
        )}. Each step must have a unique ID.`
      );
    }

    // Check for duplicate step IDs with existing steps in the strategy
    const existingStepIds = strategy.steps.map((step) => step.id);
    const conflictingIds = stepIds.filter((id) => existingStepIds.includes(id));
    if (conflictingIds.length > 0) {
      throw new Error(
        `Step IDs already exist in strategy '${strategyId}': ${conflictingIds.join(
          ", "
        )}. Each step must have a unique ID.`
      );
    }

    // Add all steps
    const wasEmpty = strategy.steps.length === 0;
    strategy.steps.push(...steps);

    // Set the first added step as start step if strategy was empty
    if (wasEmpty && steps.length > 0) {
      strategy.startStepId = steps[0].id;
    }
  }

  // Set the starting step for a strategy
  setStartStep(strategyId: string, stepId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const stepExists = strategy.steps.some((step) => step.id === stepId);
    if (!stepExists) {
      throw new Error(`Step ${stepId} not found in strategy ${strategyId}`);
    }

    strategy.startStepId = stepId;
  }

  // Get a strategy
  getStrategy(strategyId: string): Strategy | undefined {
    return this.strategies.get(strategyId);
  }

  // List all strategies
  listStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  // Delete a strategy
  deleteStrategy(strategyId: string): boolean {
    return this.strategies.delete(strategyId);
  }

  // Execute a strategy
  async executeStrategy(strategyId: string): Promise<StrategyExecutionResult> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const context: StrategyContext = {
      strategyId,
      currentStepId: strategy.startStepId,
      variables: { ...strategy.variables },
      stepResults: {},
      startTime: Date.now(),
      logs: [],
    };

    const completedSteps: string[] = [];

    try {
      context.logs.push(`Starting strategy execution: ${strategy.name}`);

      while (context.currentStepId) {
        const step = strategy.steps.find((s) => s.id === context.currentStepId);
        if (!step) {
          throw new Error(`Step ${context.currentStepId} not found`);
        }

        context.logs.push(`Executing step: ${step.id} (${step.type})`);

        try {
          const result = await this.executeStep(step, context);
          context.stepResults[step.id] = result;
          completedSteps.push(step.id);

          // Determine next step
          if (result.success && step.onSuccess) {
            context.currentStepId = step.onSuccess;
          } else if (!result.success && step.onFailure) {
            context.currentStepId = step.onFailure;
          } else {
            // No next step defined, strategy complete
            context.currentStepId = "";
          }

          context.logs.push(
            `Step ${step.id} completed: ${
              result.success ? "SUCCESS" : "FAILURE"
            }`
          );
        } catch (stepError) {
          context.logs.push(`Step ${step.id} failed: ${stepError}`);

          if (step.onFailure) {
            context.currentStepId = step.onFailure;
          } else {
            throw stepError;
          }
        }
      }

      context.logs.push(`Strategy execution completed successfully`);
      return {
        success: true,
        context,
        completedSteps,
        finalResult: context.stepResults,
      };
    } catch (error) {
      context.logs.push(`Strategy execution failed: ${error}`);
      return {
        success: false,
        context,
        error: error instanceof Error ? error.message : String(error),
        completedSteps,
      };
    }
  }

  // Execute a single step
  private async executeStep(
    step: StrategyStep,
    context: StrategyContext
  ): Promise<{ success: boolean; data?: any; message?: string }> {
    switch (step.type) {
      case "buy":
        const buyStep = step as BuyStep;
        try {
          // Validate amount is specified and positive
          if (
            buyStep.amountInSol === undefined ||
            buyStep.amountInSol === null
          ) {
            throw new Error(
              "Buy amount in SOL is required. Please specify amountInSol."
            );
          }
          if (buyStep.amountInSol <= 0) {
            throw new Error("Buy amount must be greater than 0 SOL.");
          }

          const signature = await buyTokens(buyStep.amountInSol);
          return {
            success: true,
            data: { signature, amountInSol: buyStep.amountInSol },
            message: `Buy order executed: ${signature} (Amount: ${buyStep.amountInSol} SOL)`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Buy failed: ${error}`,
          };
        }

      case "sell":
        const sellStep = step as SellStep;
        try {
          // Validate amount is specified
          if (
            sellStep.amountToSell === undefined ||
            sellStep.amountToSell === null
          ) {
            throw new Error(
              "Sell amount is required. Please specify amountToSell (-1 for all tokens, or positive number for specific amount)."
            );
          }
          if (sellStep.amountToSell === 0) {
            throw new Error(
              "Sell amount cannot be 0. Use -1 to sell all tokens or specify a positive amount."
            );
          }
          if (sellStep.amountToSell < -1) {
            throw new Error(
              "Invalid sell amount. Use -1 to sell all tokens or specify a positive amount."
            );
          }

          const signature = await sellTokens(sellStep.amountToSell);
          return {
            success: true,
            data: { signature, amountToSell: sellStep.amountToSell },
            message: `Sell order executed: ${signature} (Amount: ${
              sellStep.amountToSell === -1
                ? "ALL tokens"
                : sellStep.amountToSell + " tokens"
            })`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Sell failed: ${error}`,
          };
        }

      case "waitPriceAbove":
        const waitAboveStep = step as WaitPriceAboveStep;
        try {
          const result = await waitForPriceAbove(
            waitAboveStep.targetPrice,
            waitAboveStep.checkIntervalMs,
            waitAboveStep.timeoutMs
          );
          return {
            success: result.success,
            data: { currentPrice: result.currentPrice },
            message: result.message,
          };
        } catch (error) {
          return {
            success: false,
            message: `Wait for price above failed: ${error}`,
          };
        }

      case "waitPriceBelow":
        const waitBelowStep = step as WaitPriceBelowStep;
        try {
          const result = await waitForPriceBelow(
            waitBelowStep.targetPrice,
            waitBelowStep.checkIntervalMs,
            waitBelowStep.timeoutMs
          );
          return {
            success: result.success,
            data: { currentPrice: result.currentPrice },
            message: result.message,
          };
        } catch (error) {
          return {
            success: false,
            message: `Wait for price below failed: ${error}`,
          };
        }

      case "getPrice":
        try {
          const priceData = await getTokenPriceUSD();
          context.variables.currentPrice = priceData.price;
          context.variables.priceSource = priceData.source;
          return {
            success: true,
            data: { price: priceData.price, source: priceData.source },
            message: `Current token price: $${priceData.price} (from ${priceData.source})`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Get price failed: ${error}`,
          };
        }

      case "getJupiterPrice":
        try {
          const priceData = await getJupiterTokenPrice();
          context.variables.currentPrice = priceData.price;
          context.variables.priceSource = priceData.source;
          return {
            success: true,
            data: { price: priceData.price, source: priceData.source },
            message: `Current token price: $${priceData.price} (from ${priceData.source})`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Get Jupiter price failed: ${error}`,
          };
        }

      case "getSolPrice":
        try {
          const price = await getSolPriceUSD();
          context.variables.solPrice = price;
          return {
            success: true,
            data: { price },
            message: `Current SOL price: $${price}`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Get SOL price failed: ${error}`,
          };
        }

      case "wait":
        const waitStep = step as WaitStep;
        try {
          await new Promise((resolve) =>
            setTimeout(resolve, waitStep.durationMs)
          );
          return {
            success: true,
            message: `Waited for ${waitStep.durationMs}ms`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Wait failed: ${error}`,
          };
        }

      case "condition":
        const conditionStep = step as ConditionStep;
        try {
          let conditionMet = false;

          if (
            conditionStep.condition === "priceAbove" &&
            conditionStep.targetPrice
          ) {
            const currentPriceData = conditionStep.useJupiterPrice
              ? await getJupiterTokenPrice()
              : await getTokenPriceUSD();
            conditionMet = currentPriceData.price >= conditionStep.targetPrice;
          } else if (
            conditionStep.condition === "priceBelow" &&
            conditionStep.targetPrice
          ) {
            const currentPriceData = conditionStep.useJupiterPrice
              ? await getJupiterTokenPrice()
              : await getTokenPriceUSD();
            conditionMet = currentPriceData.price <= conditionStep.targetPrice;
          } else if (
            conditionStep.condition === "custom" &&
            conditionStep.customCondition
          ) {
            conditionMet = conditionStep.customCondition(context);
          }

          return {
            success: conditionMet,
            data: { conditionMet },
            message: `Condition ${conditionMet ? "met" : "not met"}`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Condition check failed: ${error}`,
          };
        }

      default:
        return {
          success: false,
          message: `Unknown step type: ${(step as any).type}`,
        };
    }
  }
}

// Export singleton instance
export const strategyBuilder = new StrategyBuilder();
