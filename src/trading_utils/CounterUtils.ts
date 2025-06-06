// AWS Counter deployment and management utilities

import { AWS_CONFIG } from "../aws/config";
import { awsLogger } from "../aws/logger";
import { awsCounterDeployment } from "../aws/counter-deployment";

// AWS Counter state tracking
interface AWSCounterInstance {
  counterId: string;
  status: "deploying" | "running" | "stopped" | "failed";
  deployedAt: number;
  startTime?: number;
  endTime?: number;
  durationMinutes: number;
  awsResourceArn?: string;
  currentValue?: number;
  lastUpdateTime?: number;
}

// Global tracking of deployed counters
let deployedCounters: Map<string, AWSCounterInstance> = new Map();

/**
 * Deploy a counter function to AWS that will run independently
 * @param durationMinutes - Duration to run the counter in minutes (default: 2 minutes)
 * @returns Promise with deployment information
 */
async function deployCounterToAWS(durationMinutes: number = 2): Promise<{
  success: boolean;
  counterId: string;
  message: string;
  awsResourceArn?: string;
}> {
  try {
    const counterId = `counter-${Date.now()}`;

    awsLogger.info("Starting counter deployment to AWS", {
      metadata: { counterId, durationMinutes, region: AWS_CONFIG.region },
    });

    // Create deployment record
    const counterInstance: AWSCounterInstance = {
      counterId,
      status: "deploying",
      deployedAt: Date.now(),
      durationMinutes,
    };

    deployedCounters.set(counterId, counterInstance);

    // Deploy counter to AWS using real AWS deployment
    const deploymentResult = await awsCounterDeployment.deployCounter(
      counterId,
      durationMinutes
    );

    // Update deployment status
    counterInstance.status = "running";
    counterInstance.awsResourceArn = deploymentResult.awsResourceArn;
    counterInstance.startTime = Date.now();
    counterInstance.endTime =
      counterInstance.startTime + durationMinutes * 60 * 1000;
    counterInstance.currentValue = 1;
    counterInstance.lastUpdateTime = Date.now();

    awsLogger.info("Counter deployment completed", {
      metadata: { counterId, resourceArn: deploymentResult.awsResourceArn },
    });

    process.stderr.write(
      `✅ Counter ${counterId} deployed to AWS and started\n`
    );

    return {
      success: true,
      counterId,
      message: `Counter deployed to AWS and started. Duration: ${durationMinutes} minutes`,
      awsResourceArn: deploymentResult.awsResourceArn,
    };
  } catch (error) {
    awsLogger.error("Counter deployment failed", { error: error as Error });
    process.stderr.write(`❌ Error deploying counter to AWS: ${error}\n`);
    throw error;
  }
}

/**
 * Get counter value from AWS deployed counter
 * @param counterId - ID of the deployed counter
 * @returns Counter status and value information
 */
async function getCounterValueFromAWS(counterId?: string): Promise<{
  success: boolean;
  counters: Array<{
    counterId: string;
    currentValue: number;
    isRunning: boolean;
    startTime: number | null;
    endTime: number | null;
    remainingTimeMs: number | null;
    elapsedTimeMs: number | null;
    awsResourceArn?: string;
  }>;
  message: string;
}> {
  try {
    if (counterId) {
      // Get specific counter from AWS
      const awsStatus = await awsCounterDeployment.getCounterStatus(counterId);

      // Update local tracking
      const counter = deployedCounters.get(counterId);
      if (counter) {
        counter.currentValue = awsStatus.currentValue;
        counter.lastUpdateTime = Date.now();
        counter.status = awsStatus.isRunning ? "running" : "stopped";
      }

      return {
        success: true,
        counters: [awsStatus],
        message: `Counter ${counterId} status retrieved from AWS`,
      };
    } else {
      // Get all counters from AWS
      const awsCounters = await awsCounterDeployment.listCounters();

      const counterResults = awsCounters.counters.map((counter) => ({
        counterId: counter.counterId,
        currentValue: counter.currentValue || 1,
        isRunning: counter.status === "running",
        startTime: counter.deployedAt,
        endTime: counter.deployedAt + counter.durationMinutes * 60 * 1000,
        remainingTimeMs: Math.max(
          0,
          counter.deployedAt + counter.durationMinutes * 60 * 1000 - Date.now()
        ),
        elapsedTimeMs: Date.now() - counter.deployedAt,
        awsResourceArn: counter.awsResourceArn,
      }));

      return {
        success: true,
        counters: counterResults,
        message: `${counterResults.length} counter(s) status retrieved from AWS`,
      };
    }
  } catch (error) {
    awsLogger.error("Failed to get counter value from AWS", {
      error: error as Error,
    });
    process.stderr.write(`❌ Error getting counter value from AWS: ${error}\n`);
    throw error;
  }
}

/**
 * Stop a counter running on AWS
 * @param counterId - ID of the counter to stop
 * @returns Stop operation result
 */
async function stopCounterInAWS(counterId: string): Promise<{
  success: boolean;
  message: string;
  finalValue?: number;
  counterId: string;
}> {
  try {
    awsLogger.info("Stopping counter in AWS", {
      metadata: { counterId },
    });

    // Stop the counter using real AWS deployment
    const stopResult = await awsCounterDeployment.stopCounter(counterId);

    // Update local tracking
    const counter = deployedCounters.get(counterId);
    if (counter) {
      counter.status = "stopped";
      counter.currentValue = stopResult.finalValue;
    }

    process.stderr.write(
      `🛑 Counter ${counterId} stopped in AWS. Final value: ${stopResult.finalValue}\n`
    );

    return stopResult;
  } catch (error) {
    awsLogger.error("Failed to stop counter in AWS", {
      metadata: { counterId },
      error: error as Error,
    });
    process.stderr.write(`❌ Error stopping counter in AWS: ${error}\n`);
    throw error;
  }
}

/**
 * Remove/cleanup a deployed counter from AWS
 * @param counterId - ID of the counter to remove
 * @returns Cleanup operation result
 */
async function removeCounterFromAWS(counterId: string): Promise<{
  success: boolean;
  message: string;
  counterId: string;
}> {
  try {
    awsLogger.info("Removing counter from AWS", {
      metadata: { counterId },
    });

    // Remove counter using real AWS deployment
    const removeResult = await awsCounterDeployment.removeCounter(counterId);

    // Remove from local tracking
    deployedCounters.delete(counterId);

    process.stderr.write(`🗑️ Counter ${counterId} removed from AWS\n`);

    return removeResult;
  } catch (error) {
    awsLogger.error("Failed to remove counter from AWS", {
      metadata: { counterId },
      error: error as Error,
    });
    process.stderr.write(`❌ Error removing counter from AWS: ${error}\n`);
    throw error;
  }
}

/**
 * List all deployed counters
 * @returns List of all deployed counters
 */
async function listDeployedCounters(): Promise<{
  success: boolean;
  counters: Array<{
    counterId: string;
    status: string;
    durationMinutes: number;
    currentValue?: number;
    awsResourceArn?: string;
    deployedAt: number;
  }>;
  message: string;
}> {
  try {
    // Get counters from AWS
    const awsCounters = await awsCounterDeployment.listCounters();

    const message = `Found ${awsCounters.counters.length} deployed counter(s)`;
    process.stderr.write(`📋 ${message}\n`);

    return awsCounters;
  } catch (error) {
    awsLogger.error("Failed to list deployed counters", {
      error: error as Error,
    });
    process.stderr.write(`❌ Error listing deployed counters: ${error}\n`);
    throw error;
  }
}

/**
 * Debug counter in AWS with comprehensive diagnostics
 * @param counterId - ID of the counter to debug
 * @returns Detailed debugging information
 */
async function debugCounterInAWS(counterId: string): Promise<{
  success: boolean;
  counterId: string;
  debugInfo: {
    counterStatus: any;
    lambdaFunction: any;
    cloudWatchLogs: string[];
    eventBridgeRules: any[];
    dynamoDbRecord: any;
    executionHistory: any;
  };
  message: string;
}> {
  try {
    awsLogger.info("Starting comprehensive counter debugging", {
      metadata: { counterId },
    });

    const debugInfo: any = {
      counterStatus: null,
      lambdaFunction: null,
      cloudWatchLogs: [],
      eventBridgeRules: [],
      dynamoDbRecord: null,
      executionHistory: null,
    };

    // 1. Get counter status
    try {
      debugInfo.counterStatus = await awsCounterDeployment.getCounterStatus(
        counterId
      );
    } catch (error) {
      debugInfo.counterStatus = { error: (error as Error).message };
    }

    // 2. Get Lambda function details
    try {
      const {
        LambdaClient,
        GetFunctionCommand,
      } = require("@aws-sdk/client-lambda");
      const lambdaClient = new LambdaClient({ region: AWS_CONFIG.region });
      const functionName = `counter-function-${counterId}`;

      const functionInfo = await lambdaClient.send(
        new GetFunctionCommand({ FunctionName: functionName })
      );

      debugInfo.lambdaFunction = {
        state: functionInfo.Configuration?.State,
        lastModified: functionInfo.Configuration?.LastModified,
        environment: functionInfo.Configuration?.Environment?.Variables,
        timeout: functionInfo.Configuration?.Timeout,
        memorySize: functionInfo.Configuration?.MemorySize,
        runtime: functionInfo.Configuration?.Runtime,
        role: functionInfo.Configuration?.Role,
      };
    } catch (error) {
      debugInfo.lambdaFunction = { error: (error as Error).message };
    }

    // 3. Get CloudWatch logs
    try {
      const {
        CloudWatchLogsClient,
        DescribeLogStreamsCommand,
        GetLogEventsCommand,
      } = require("@aws-sdk/client-cloudwatch-logs");
      const logsClient = new CloudWatchLogsClient({
        region: AWS_CONFIG.region,
      });
      const logGroupName = `/aws/lambda/counter-function-${counterId}`;

      const streamsResponse = await logsClient.send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroupName,
          orderBy: "LastEventTime",
          descending: true,
          limit: 5,
        })
      );

      if (streamsResponse.logStreams && streamsResponse.logStreams.length > 0) {
        for (const stream of streamsResponse.logStreams.slice(0, 2)) {
          const eventsResponse = await logsClient.send(
            new GetLogEventsCommand({
              logGroupName: logGroupName,
              logStreamName: stream.logStreamName!,
              limit: 50,
              startFromHead: false,
            })
          );

          const streamLogs =
            eventsResponse.events?.map(
              (event: any) =>
                `${new Date(event.timestamp!).toISOString()}: ${event.message}`
            ) || [];

          debugInfo.cloudWatchLogs.push(
            `=== Stream: ${stream.logStreamName} ===`
          );
          debugInfo.cloudWatchLogs.push(...streamLogs);
        }
      }
    } catch (error) {
      debugInfo.cloudWatchLogs = [
        `Error fetching logs: ${(error as Error).message}`,
      ];
    }

    // 4. Get EventBridge rules
    try {
      const {
        EventBridgeClient,
        ListRulesCommand,
        DescribeRuleCommand,
      } = require("@aws-sdk/client-eventbridge");
      const eventBridgeClient = new EventBridgeClient({
        region: AWS_CONFIG.region,
      });
      const ruleName = `counter-increment-${counterId}`;

      const ruleInfo = await eventBridgeClient.send(
        new DescribeRuleCommand({ Name: ruleName })
      );

      debugInfo.eventBridgeRules.push({
        name: ruleInfo.Name,
        state: ruleInfo.State,
        scheduleExpression: ruleInfo.ScheduleExpression,
        description: ruleInfo.Description,
      });
    } catch (error) {
      debugInfo.eventBridgeRules = [{ error: (error as Error).message }];
    }

    // 5. Get DynamoDB record
    try {
      const {
        DynamoDBDocumentClient,
        GetCommand,
      } = require("@aws-sdk/lib-dynamodb");
      const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
      const dynamoClient = new DynamoDBClient({ region: AWS_CONFIG.region });
      const docClient = DynamoDBDocumentClient.from(dynamoClient);

      const result = await docClient.send(
        new GetCommand({
          TableName: "counter-state-table",
          Key: { counterId },
        })
      );

      debugInfo.dynamoDbRecord = result.Item || { error: "No record found" };
    } catch (error) {
      debugInfo.dynamoDbRecord = { error: (error as Error).message };
    }

    const message = `Debug information collected for counter ${counterId}`;
    process.stderr.write(`🔍 ${message}\n`);

    return {
      success: true,
      counterId,
      debugInfo,
      message,
    };
  } catch (error) {
    awsLogger.error("Failed to debug counter", {
      metadata: { counterId },
      error: error as Error,
    });
    process.stderr.write(`❌ Error debugging counter: ${error}\n`);
    throw error;
  }
}

export {
  deployCounterToAWS,
  getCounterValueFromAWS,
  stopCounterInAWS,
  removeCounterFromAWS,
  listDeployedCounters,
  debugCounterInAWS,
};
