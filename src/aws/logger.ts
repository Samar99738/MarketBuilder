import { AWS_CONFIG } from "./config";

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  strategyId?: string;
  runningId?: string;
  executionCount?: number;
  metadata?: Record<string, any>;
}

export class AWSLogger {
  private logLevel: "debug" | "info" | "warn" | "error";
  private cloudWatchEnabled: boolean;

  constructor() {
    this.logLevel = AWS_CONFIG.logLevel;
    this.cloudWatchEnabled = AWS_CONFIG.cloudWatchEnabled;
  }

  private shouldLog(level: "debug" | "info" | "warn" | "error"): boolean {
    const levels = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private formatLog(entry: LogEntry): string {
    const {
      timestamp,
      level,
      message,
      strategyId,
      runningId,
      executionCount,
      metadata,
    } = entry;

    // AWS CloudWatch friendly JSON format
    const logObject = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...(strategyId && { strategyId }),
      ...(runningId && { runningId }),
      ...(executionCount !== undefined && { executionCount }),
      ...(metadata && { metadata }),
      environment: AWS_CONFIG.environment,
      service: "strategy-execution-manager",
    };

    return JSON.stringify(logObject);
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: {
      strategyId?: string;
      runningId?: string;
      executionCount?: number;
      metadata?: Record<string, any>;
    }
  ): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };

    const formattedLog = this.formatLog(entry);

    // Output to console (which AWS services can capture)
    if (level === "error") {
      console.error(formattedLog);
    } else if (level === "warn") {
      console.warn(formattedLog);
    } else {
      process.stderr.write(formattedLog + "\n");
    }

    // TODO: Add CloudWatch Logs integration when deploying
    // if (this.cloudWatchEnabled) {
    //   this.sendToCloudWatch(entry);
    // }
  }

  debug(
    message: string,
    context?: {
      strategyId?: string;
      runningId?: string;
      executionCount?: number;
      metadata?: Record<string, any>;
    }
  ): void {
    this.log("debug", message, context);
  }

  info(
    message: string,
    context?: {
      strategyId?: string;
      runningId?: string;
      executionCount?: number;
      metadata?: Record<string, any>;
    }
  ): void {
    this.log("info", message, context);
  }

  warn(
    message: string,
    context?: {
      strategyId?: string;
      runningId?: string;
      executionCount?: number;
      metadata?: Record<string, any>;
    }
  ): void {
    this.log("warn", message, context);
  }

  error(
    message: string,
    context?: {
      strategyId?: string;
      runningId?: string;
      executionCount?: number;
      metadata?: Record<string, any>;
      error?: Error;
    }
  ): void {
    const metadata = context?.metadata || {};
    if (context?.error) {
      metadata.error = {
        name: context.error.name,
        message: context.error.message,
        stack: context.error.stack,
      };
    }

    this.log("error", message, {
      ...context,
      metadata,
    });
  }

  // Strategy-specific logging methods
  strategyStarted(strategyId: string, runningId: string): void {
    this.info("Strategy execution started", { strategyId, runningId });
  }

  strategyStopped(strategyId: string, runningId: string): void {
    this.info("Strategy execution stopped", { strategyId, runningId });
  }

  strategyExecution(
    strategyId: string,
    runningId: string,
    executionCount: number,
    success: boolean
  ): void {
    const message = `Strategy execution ${success ? "completed" : "failed"}`;
    if (success) {
      this.info(message, { strategyId, runningId, executionCount });
    } else {
      this.warn(message, { strategyId, runningId, executionCount });
    }
  }

  strategyError(strategyId: string, runningId: string, error: Error): void {
    this.error("Strategy execution error", {
      strategyId,
      runningId,
      error,
      metadata: { errorType: "strategy_execution" },
    });
  }

  // Health check logging
  healthCheck(healthy: boolean, details: any): void {
    const message = `Health check ${healthy ? "passed" : "failed"}`;
    if (healthy) {
      this.debug(message, { metadata: details });
    } else {
      this.warn(message, { metadata: details });
    }
  }
}

// Export singleton instance
export const awsLogger = new AWSLogger();
