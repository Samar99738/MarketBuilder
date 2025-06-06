export interface AWSConfig {
  region: string;
  accountId: string;
  environment: "development" | "staging" | "production";
  logLevel: "debug" | "info" | "warn" | "error";

  // Health check configuration
  healthCheckPort: number;
  healthCheckPath: string;

  // Strategy execution settings
  maxConcurrentStrategies: number;
  defaultRestartDelayMs: number;
  strategyTimeoutMs: number;

  // Monitoring and alerting
  cloudWatchEnabled: boolean;
  alertingEnabled: boolean;

  // Persistence
  persistenceEnabled: boolean;
  persistenceInterval: number; // ms
}

export const AWS_CONFIG: AWSConfig = {
  region: process.env.AWS_REGION || "us-east-1",
  accountId: process.env.AWS_ACCOUNT_ID || "123456789012", // Default placeholder
  environment: (process.env.NODE_ENV as any) || "development",
  logLevel: (process.env.LOG_LEVEL as any) || "info",

  healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT || "3001"),
  healthCheckPath: process.env.HEALTH_CHECK_PATH || "/health",

  maxConcurrentStrategies: parseInt(
    process.env.MAX_CONCURRENT_STRATEGIES || "10"
  ),
  defaultRestartDelayMs: parseInt(
    process.env.DEFAULT_RESTART_DELAY_MS || "60000"
  ),
  strategyTimeoutMs: parseInt(process.env.STRATEGY_TIMEOUT_MS || "300000"),

  cloudWatchEnabled: process.env.CLOUDWATCH_ENABLED === "true",
  alertingEnabled: process.env.ALERTING_ENABLED === "true",

  persistenceEnabled: process.env.PERSISTENCE_ENABLED === "true",
  persistenceInterval: parseInt(process.env.PERSISTENCE_INTERVAL_MS || "30000"),
};

// Validate required environment variables
export function validateAWSConfig(): void {
  const requiredVars = ["AWS_REGION", "NODE_ENV"];

  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

export function getAWSConfig(): AWSConfig {
  validateAWSConfig();
  return AWS_CONFIG;
}
