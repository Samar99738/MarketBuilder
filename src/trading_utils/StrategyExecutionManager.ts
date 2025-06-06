import {
  strategyBuilder,
  StrategyExecutionResult,
  StrategyContext,
} from "./StrategyBuilder";
import { awsLogger } from "../aws/logger";
import { AWS_CONFIG } from "../aws/config";

export interface RunningStrategy {
  id: string;
  strategyId: string;
  status: "running" | "stopped" | "paused" | "error";
  startTime: number;
  lastExecutionTime?: number;
  executionCount: number;
  currentContext?: StrategyContext;
  lastResult?: StrategyExecutionResult;
  error?: string;
  intervalId?: NodeJS.Timeout;
  restartDelay: number; // ms between strategy restarts
}

export class StrategyExecutionManager {
  private runningStrategies: Map<string, RunningStrategy> = new Map();
  private isShuttingDown = false;

  // Start a strategy for continuous execution
  async startStrategy(
    strategyId: string,
    restartDelay: number = AWS_CONFIG.defaultRestartDelayMs
  ): Promise<string> {
    const strategy = strategyBuilder.getStrategy(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const runningId = `${strategyId}-${Date.now()}`;

    if (this.isStrategyRunning(strategyId)) {
      throw new Error(`Strategy ${strategyId} is already running`);
    }

    // Check max concurrent strategies limit
    const runningCount = this.listRunningStrategies().filter(
      (s) => s.status === "running"
    ).length;
    if (runningCount >= AWS_CONFIG.maxConcurrentStrategies) {
      throw new Error(
        `Maximum concurrent strategies limit reached (${AWS_CONFIG.maxConcurrentStrategies})`
      );
    }

    const runningStrategy: RunningStrategy = {
      id: runningId,
      strategyId,
      status: "running",
      startTime: Date.now(),
      executionCount: 0,
      restartDelay,
    };

    this.runningStrategies.set(runningId, runningStrategy);
    this.executeStrategyContinuously(runningId);

    awsLogger.strategyStarted(strategyId, runningId);
    return runningId;
  }

  // Stop a running strategy
  async stopStrategy(runningId: string): Promise<boolean> {
    const runningStrategy = this.runningStrategies.get(runningId);
    if (!runningStrategy) {
      return false;
    }

    runningStrategy.status = "stopped";

    if (runningStrategy.intervalId) {
      clearTimeout(runningStrategy.intervalId);
    }

    awsLogger.strategyStopped(runningStrategy.strategyId, runningId);
    return true;
  }

  // Stop all running strategies
  async stopAllStrategies(): Promise<void> {
    this.isShuttingDown = true;
    const stopPromises = Array.from(this.runningStrategies.keys()).map((id) =>
      this.stopStrategy(id)
    );
    await Promise.all(stopPromises);
    awsLogger.info("All strategies stopped");
  }

  // Get running strategy status
  getStrategyStatus(runningId: string): RunningStrategy | undefined {
    return this.runningStrategies.get(runningId);
  }

  // List all running strategies
  listRunningStrategies(): RunningStrategy[] {
    return Array.from(this.runningStrategies.values());
  }

  // Check if a strategy is already running
  private isStrategyRunning(strategyId: string): boolean {
    return Array.from(this.runningStrategies.values()).some(
      (rs) => rs.strategyId === strategyId && rs.status === "running"
    );
  }

  // Execute strategy continuously
  private async executeStrategyContinuously(runningId: string): Promise<void> {
    const runningStrategy = this.runningStrategies.get(runningId);
    if (
      !runningStrategy ||
      runningStrategy.status !== "running" ||
      this.isShuttingDown
    ) {
      return;
    }

    try {
      awsLogger.debug("Starting strategy execution", {
        strategyId: runningStrategy.strategyId,
        runningId,
        executionCount: runningStrategy.executionCount + 1,
      });

      const result = await strategyBuilder.executeStrategy(
        runningStrategy.strategyId
      );

      runningStrategy.lastExecutionTime = Date.now();
      runningStrategy.executionCount++;
      runningStrategy.lastResult = result;
      runningStrategy.currentContext = result.context;

      awsLogger.strategyExecution(
        runningStrategy.strategyId,
        runningId,
        runningStrategy.executionCount,
        result.success
      );

      if (!result.success) {
        runningStrategy.error = result.error;
        awsLogger.warn("Strategy execution failed", {
          strategyId: runningStrategy.strategyId,
          runningId,
          executionCount: runningStrategy.executionCount,
          metadata: { error: result.error },
        });
      }

      // Schedule next execution if still running
      if (runningStrategy.status === "running" && !this.isShuttingDown) {
        runningStrategy.intervalId = setTimeout(() => {
          this.executeStrategyContinuously(runningId);
        }, runningStrategy.restartDelay);
      }
    } catch (error) {
      runningStrategy.status = "error";
      runningStrategy.error =
        error instanceof Error ? error.message : String(error);

      awsLogger.strategyError(
        runningStrategy.strategyId,
        runningId,
        error as Error
      );

      // Try to restart after delay if not shutting down
      if (!this.isShuttingDown) {
        runningStrategy.intervalId = setTimeout(() => {
          runningStrategy.status = "running";
          runningStrategy.error = undefined;
          this.executeStrategyContinuously(runningId);
        }, runningStrategy.restartDelay);
      }
    }
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    awsLogger.info("Starting graceful shutdown of StrategyExecutionManager");
    await this.stopAllStrategies();
    this.runningStrategies.clear();
    awsLogger.info("StrategyExecutionManager shutdown complete");
  }

  // Health check for AWS
  getHealthStatus(): {
    healthy: boolean;
    runningCount: number;
    errorCount: number;
    details: Array<{ id: string; status: string; executionCount: number }>;
  } {
    const strategies = this.listRunningStrategies();
    const errorCount = strategies.filter((s) => s.status === "error").length;

    return {
      healthy: !this.isShuttingDown && errorCount === 0,
      runningCount: strategies.filter((s) => s.status === "running").length,
      errorCount,
      details: strategies.map((s) => ({
        id: s.id,
        status: s.status,
        executionCount: s.executionCount,
      })),
    };
  }
}

// Export singleton instance
export const strategyExecutionManager = new StrategyExecutionManager();
