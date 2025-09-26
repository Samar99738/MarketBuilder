// Real AWS deployment manager for counter functions
import {
  LambdaClient,
  CreateFunctionCommand,
  DeleteFunctionCommand,
  InvokeCommand,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  AddPermissionCommand,
  ListFunctionsCommand,
} from "@aws-sdk/client-lambda";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  IAMClient,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  GetRoleCommand,
} from "@aws-sdk/client-iam";
import { AWS_CONFIG } from "./config";
import { awsLogger } from "./logger";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);

// AWS clients
const lambdaClient = new LambdaClient({ region: AWS_CONFIG.region });
const dynamoClient = new DynamoDBClient({ region: AWS_CONFIG.region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const iamClient = new IAMClient({ region: AWS_CONFIG.region });
const logsClient = new CloudWatchLogsClient({ region: AWS_CONFIG.region });

// Constants
const COUNTER_TABLE_NAME = "counter-state-table";
const LAMBDA_ROLE_NAME = "counter-lambda-execution-role";
const LAMBDA_FUNCTION_PREFIX = "counter-function";

export class AWSCounterDeployment {
  private initialized = false;
  private deployedFunctions = new Map<string, string>(); // counterId -> functionName

  /**
   * Initialize AWS infrastructure (DynamoDB table, IAM role)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      awsLogger.info("Initializing AWS counter infrastructure");

      // Create DynamoDB table if it doesn't exist
      await this.ensureDynamoDBTable();

      // Create IAM role if it doesn't exist
      await this.ensureIAMRole();

      this.initialized = true;
      awsLogger.info("AWS counter infrastructure initialized successfully");
    } catch (error) {
      awsLogger.error("Failed to initialize AWS infrastructure", {
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Deploy a counter function to AWS Lambda
   */
  async deployCounter(
    counterId: string,
    durationMinutes: number
  ): Promise<{
    success: boolean;
    counterId: string;
    message: string;
    awsResourceArn: string;
  }> {
    // Use consistent function name without random suffix for better tracking
    const functionName = `${LAMBDA_FUNCTION_PREFIX}-${counterId}`;

    try {
      awsLogger.info("🚀 Deploying counter to AWS", {
        metadata: { counterId, durationMinutes, functionName },
      });

      // Create minimal Lambda function
      const lambdaArn = await this.createLambdaFunction(
        functionName,
        counterId,
        durationMinutes
      );

      // Track the deployed function
      this.deployedFunctions.set(counterId, functionName);

      // Wait for Lambda to become active before initialization
      awsLogger.info("Waiting for Lambda function to become active", {
        metadata: { counterId, functionName },
      });

      await this.waitForFunctionActive(functionName, counterId);

      // Initialize the counter by invoking it once
      try {
        awsLogger.info("Initializing counter", { metadata: { counterId } });
        const initResponse = await this.invokeLambda(functionName, {
          action: "initialize",
        });
        awsLogger.info("Counter initialized and started", {
          metadata: { counterId, status: initResponse },
        });
      } catch (error) {
        awsLogger.error("Counter initialization failed", {
          metadata: { counterId, error: (error as Error).message },
        });
        // Don't throw - deployment succeeded even if init failed
      }

      awsLogger.info("Counter deployment completed", {
        metadata: { counterId, resourceArn: lambdaArn },
      });

      return {
        success: true,
        counterId,
        message: `Counter deployed to AWS Lambda for ${durationMinutes} minutes`,
        awsResourceArn: lambdaArn,
      };
    } catch (error: any) {
      awsLogger.error("Failed to deploy counter", {
        metadata: { counterId, functionName },
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Get counter status from AWS with detailed diagnostics
   */
  async getCounterStatus(counterId: string): Promise<{
    counterId: string;
    currentValue: number;
    isRunning: boolean;
    startTime: number | null;
    endTime: number | null;
    remainingTimeMs: number | null;
    elapsedTimeMs: number | null;
    awsResourceArn?: string;
  }> {
    try {
      // Get the actual deployed function name
      const functionName = this.deployedFunctions.get(counterId);
      if (!functionName) {
        throw new Error(`Counter ${counterId} not found in deployed functions`);
      }

      awsLogger.info("🔍 Getting counter status with diagnostics", {
        metadata: { counterId, functionName },
      });

      // Try to get function info first
      let lambdaArn: string | undefined;
      let envVars: any = {};
      try {
        const functionInfo = await lambdaClient.send(
          new GetFunctionCommand({ FunctionName: functionName })
        );
        lambdaArn = functionInfo.Configuration?.FunctionArn;
        envVars = functionInfo.Configuration?.Environment?.Variables || {};

        awsLogger.info("Lambda function details", {
          metadata: {
            counterId,
            state: functionInfo.Configuration?.State,
            lastModified: functionInfo.Configuration?.LastModified,
            envVars: envVars,
          },
        });
      } catch (error) {
        awsLogger.error("Failed to get function info", {
          metadata: { counterId, error: (error as Error).message },
        });
      }

      // Get recent CloudWatch logs for debugging
      await this.getRecentLogs(functionName, counterId);

      // Invoke Lambda to get status
      awsLogger.info("Invoking Lambda for status", {
        metadata: { counterId },
      });

      const response = await this.invokeLambda(functionName, {
        diagnostic: true,
      });
      const status = JSON.parse(response.body || "{}");

      awsLogger.info("Lambda response received", {
        metadata: { counterId, status },
      });

      return {
        counterId: status.counterId || counterId,
        currentValue: status.currentValue || 0,
        isRunning: status.isRunning || false,
        startTime: status.startTime || null,
        endTime: status.endTime || null,
        remainingTimeMs: status.endTime
          ? Math.max(0, status.endTime - Date.now())
          : null,
        elapsedTimeMs: status.startTime ? Date.now() - status.startTime : null,
        awsResourceArn: lambdaArn,
      };
    } catch (error) {
      awsLogger.error("❌ Failed to get counter status", {
        metadata: { counterId },
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Get recent CloudWatch logs for Lambda function
   */
  private async getRecentLogs(
    functionName: string,
    counterId: string
  ): Promise<void> {
    try {
      const logGroupName = `/aws/lambda/${functionName}`;

      // Get log streams for this function
      const streamsResponse = await logsClient.send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroupName,
          orderBy: "LastEventTime",
          descending: true,
          limit: 3,
        })
      );

      if (streamsResponse.logStreams && streamsResponse.logStreams.length > 0) {
        // Get events from the most recent stream
        const mostRecentStream = streamsResponse.logStreams[0];

        const eventsResponse = await logsClient.send(
          new GetLogEventsCommand({
            logGroupName: logGroupName,
            logStreamName: mostRecentStream.logStreamName!,
            limit: 20,
            startFromHead: false,
          })
        );

        const recentLogs =
          eventsResponse.events
            ?.map(
              (event) =>
                `${new Date(event.timestamp!).toISOString()}: ${event.message}`
            )
            .join("\n") || "No log events found";

        awsLogger.info("Recent CloudWatch logs", {
          metadata: { counterId, functionName, logs: recentLogs },
        });
      } else {
        awsLogger.warn("No log streams found for function", {
          metadata: { counterId, functionName, logGroupName },
        });
      }
    } catch (error) {
      awsLogger.warn("Could not fetch CloudWatch logs", {
        metadata: { counterId, error: (error as Error).message },
      });
    }
  }

  /**
   * Stop a counter in AWS
   */
  async stopCounter(counterId: string): Promise<{
    success: boolean;
    message: string;
    finalValue?: number;
    counterId: string;
  }> {
    try {
      // Get the actual function name from tracking or use standard pattern
      const functionName =
        this.deployedFunctions.get(counterId) ||
        `${LAMBDA_FUNCTION_PREFIX}-${counterId}`;

      // Invoke Lambda to stop the counter
      const response = await this.invokeLambda(functionName, {
        action: "stop",
        counterId,
      });

      awsLogger.info("Counter stopped successfully", {
        metadata: { counterId },
      });

      return {
        success: true,
        message: `Counter ${counterId} stopped in AWS`,
        finalValue: response.currentValue,
        counterId,
      };
    } catch (error) {
      awsLogger.error("Failed to stop counter", {
        metadata: { counterId },
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Remove counter from AWS (cleanup all resources)
   */
  async removeCounter(counterId: string): Promise<{
    success: boolean;
    message: string;
    counterId: string;
  }> {
    try {
      // Get the actual function name from tracking or use standard pattern
      const functionName =
        this.deployedFunctions.get(counterId) ||
        `${LAMBDA_FUNCTION_PREFIX}-${counterId}`;

      // Stop the counter first
      try {
        await this.stopCounter(counterId);
      } catch (error) {
        // Counter might already be stopped
        awsLogger.warn("Counter was already stopped or not found", {
          metadata: { counterId },
        });
      }

      // Delete Lambda function
      try {
        await lambdaClient.send(
          new DeleteFunctionCommand({ FunctionName: functionName })
        );
        awsLogger.info("Lambda function deleted", {
          metadata: { counterId, functionName },
        });
      } catch (error) {
        awsLogger.warn("Lambda function not found or already deleted", {
          metadata: { counterId, functionName },
        });
      }

      // Delete counter record from DynamoDB
      try {
        await docClient.send(
          new DeleteCommand({
            TableName: COUNTER_TABLE_NAME,
            Key: { counterId },
          })
        );
        awsLogger.info("Counter record deleted from DynamoDB", {
          metadata: { counterId },
        });
      } catch (error) {
        awsLogger.warn("Counter record not found in DynamoDB", {
          metadata: { counterId },
        });
      }

      // Remove from tracking
      this.deployedFunctions.delete(counterId);
      awsLogger.info("Counter removed from tracking", {
        metadata: { counterId },
      });

      return {
        success: true,
        message: `Counter ${counterId} removed from AWS`,
        counterId,
      };
    } catch (error) {
      awsLogger.error("Failed to remove counter", {
        metadata: { counterId },
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * List all deployed counters
   */
  async listCounters(): Promise<{
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
      const counters = [];

      for (const [
        counterId,
        functionName,
      ] of this.deployedFunctions.entries()) {
        try {
          // Get function info
          const functionInfo = await lambdaClient.send(
            new GetFunctionCommand({ FunctionName: functionName })
          );

          // Invoke function to get current status
          const response = await this.invokeLambda(functionName, {});
          const status = JSON.parse(response.body || "{}");

          counters.push({
            counterId,
            status: status.isRunning ? "running" : "stopped",
            durationMinutes: parseInt(
              functionInfo.Configuration?.Environment?.Variables
                ?.DURATION_MINUTES || "0"
            ),
            currentValue: status.currentValue || 0,
            awsResourceArn: functionInfo.Configuration?.FunctionArn || "",
            deployedAt: new Date(
              functionInfo.Configuration?.LastModified || ""
            ).getTime(),
          });
        } catch (error) {
          // Function might have been deleted externally
          awsLogger.warn("Function not found, removing from tracking", {
            metadata: { counterId, functionName },
          });
          this.deployedFunctions.delete(counterId);
        }
      }

      return {
        success: true,
        counters,
        message: `Found ${counters.length} deployed counter(s)`,
      };
    } catch (error) {
      awsLogger.error("Failed to list counters", { error: error as Error });
      return {
        success: false,
        counters: [],
        message: "Failed to list counters",
      };
    }
  }

  // Private helper methods

  private async ensureDynamoDBTable(): Promise<void> {
    try {
      // Check if table exists
      await dynamoClient.send(
        new DescribeTableCommand({ TableName: COUNTER_TABLE_NAME })
      );
      awsLogger.info("DynamoDB table already exists", {
        metadata: { tableName: COUNTER_TABLE_NAME },
      });
    } catch (error) {
      // Table doesn't exist, create it
      awsLogger.info("Creating DynamoDB table", {
        metadata: { tableName: COUNTER_TABLE_NAME },
      });

      await dynamoClient.send(
        new CreateTableCommand({
          TableName: COUNTER_TABLE_NAME,
          KeySchema: [{ AttributeName: "counterId", KeyType: "HASH" }],
          AttributeDefinitions: [
            { AttributeName: "counterId", AttributeType: "S" },
          ],
          BillingMode: "PAY_PER_REQUEST", // Use on-demand billing for simplicity
        })
      );

      // Wait for table to be active
      let tableActive = false;
      while (!tableActive) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const result = await dynamoClient.send(
          new DescribeTableCommand({ TableName: COUNTER_TABLE_NAME })
        );
        tableActive = result.Table?.TableStatus === "ACTIVE";
      }

      awsLogger.info("DynamoDB table created successfully");
    }
  }

  private async ensureIAMRole(): Promise<string> {
    try {
      // Check if role exists
      const result = await iamClient.send(
        new GetRoleCommand({ RoleName: LAMBDA_ROLE_NAME })
      );
      return result.Role!.Arn!;
    } catch (error) {
      // Role doesn't exist, create it
      awsLogger.info("Creating IAM role for Lambda", {
        metadata: { roleName: LAMBDA_ROLE_NAME },
      });

      const trustPolicy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      };

      const createRoleResult = await iamClient.send(
        new CreateRoleCommand({
          RoleName: LAMBDA_ROLE_NAME,
          AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
          Description: "Execution role for counter Lambda functions",
        })
      );

      // Attach necessary policies
      const policies = [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess",
        "arn:aws:iam::aws:policy/AmazonEventBridgeFullAccess",
      ];

      for (const policyArn of policies) {
        await iamClient.send(
          new AttachRolePolicyCommand({
            RoleName: LAMBDA_ROLE_NAME,
            PolicyArn: policyArn,
          })
        );
      }

      awsLogger.info("IAM role created successfully");
      return createRoleResult.Role!.Arn!;
    }
  }

  private async createLambdaFunction(
    functionName: string,
    counterId: string,
    durationMinutes: number
  ): Promise<string> {
    // Get or create the proper IAM role with EventBridge permissions
    const roleArn = await this.ensureIAMRole();

    // Calculate timing for persistent counter state
    const startTime = Date.now();
    const endTime = startTime + durationMinutes * 60 * 1000;

    // Create deployment package using the template
    const zipBuffer = await this.createSimpleDeploymentPackage();

    const createFunctionResult = await lambdaClient.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        Runtime: "nodejs20.x",
        Role: roleArn,
        Handler: "index.handler",
        Code: { ZipFile: zipBuffer },
        Environment: {
          Variables: {
            COUNTER_ID: counterId,
            COUNTER_START_TIME: startTime.toString(),
            COUNTER_END_TIME: endTime.toString(),
            DEPLOY_TIME: startTime.toString(),
            DURATION_MINUTES: durationMinutes.toString(),
            COUNTER_TABLE_NAME: COUNTER_TABLE_NAME,
            AWS_REGION: AWS_CONFIG.region,
            // This will be updated after function creation
            AWS_LAMBDA_FUNCTION_ARN: `arn:aws:lambda:${AWS_CONFIG.region}:${AWS_CONFIG.accountId}:function:${functionName}`,
          },
        },
        Timeout: 15,
        MemorySize: 128,
        Description: `Counter function for ${counterId} (${durationMinutes} min)`,
        Publish: true,
      })
    );

    const functionArn = createFunctionResult.FunctionArn!;

    // Update environment variables with the actual function ARN
    await lambdaClient.send(
      new UpdateFunctionCodeCommand({
        FunctionName: functionName,
        ZipFile: zipBuffer,
      })
    );

    // Add permission for EventBridge to invoke the function
    try {
      await lambdaClient.send(
        new AddPermissionCommand({
          FunctionName: functionName,
          StatementId: `eventbridge-invoke-${counterId}`,
          Action: "lambda:InvokeFunction",
          Principal: "events.amazonaws.com",
          SourceArn: `arn:aws:events:${AWS_CONFIG.region}:${AWS_CONFIG.accountId}:rule/counter-increment-${counterId}`,
        })
      );
      awsLogger.info("EventBridge permission added to Lambda function", {
        metadata: { counterId, functionName },
      });
    } catch (error) {
      awsLogger.warn("EventBridge permission already exists or failed to add", {
        metadata: { counterId, error: (error as Error).message },
      });
    }

    return functionArn;
  }

  private async waitForFunctionActive(
    functionName: string,
    counterId: string
  ): Promise<void> {
    const maxWaitTime = 60000; // 60 seconds max wait
    const checkInterval = 3000; // Check every 3 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const functionInfo = await lambdaClient.send(
          new GetFunctionCommand({ FunctionName: functionName })
        );

        const state = functionInfo.Configuration?.State;
        awsLogger.info("Lambda function state check", {
          metadata: { counterId, functionName, state },
        });

        if (state === "Active") {
          awsLogger.info("Lambda function is now active", {
            metadata: { counterId, waitTime: Date.now() - startTime },
          });
          return;
        }

        if (state === "Failed") {
          throw new Error("Lambda function failed to activate");
        }

        // Wait before next check
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      } catch (error) {
        awsLogger.error("Error checking function state", {
          metadata: { counterId, error: (error as Error).message },
        });
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    }

    // Timeout reached
    awsLogger.warn("Lambda function did not become active within timeout", {
      metadata: { counterId, waitTime: maxWaitTime },
    });
  }

  private async robustCleanup(functionName: string): Promise<void> {
    try {
      // Force cleanup any existing function regardless of state
      const existingFunction = await lambdaClient.send(
        new GetFunctionCommand({ FunctionName: functionName })
      );

      awsLogger.info("Found existing function - forcing cleanup", {
        metadata: {
          functionName,
          state: existingFunction.Configuration?.State,
        },
      });

      await lambdaClient.send(
        new DeleteFunctionCommand({ FunctionName: functionName })
      );

      // Wait longer for deletion to propagate
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Verify deletion completed
      try {
        await lambdaClient.send(
          new GetFunctionCommand({ FunctionName: functionName })
        );
        throw new Error("Function still exists after deletion attempt");
      } catch (error: any) {
        if (error.name === "ResourceNotFoundException") {
          awsLogger.info("Function successfully deleted");
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      if (error.name === "ResourceNotFoundException") {
        awsLogger.info("No existing function to cleanup", {
          metadata: { functionName },
        });
      } else {
        awsLogger.warn("Cleanup failed", {
          metadata: { functionName, error: error.message },
        });
      }
    }
  }

  private async validateDeploymentPreconditions(): Promise<void> {
    // Validate IAM role exists and is accessible
    try {
      const roleArn = await this.ensureIAMRole();
      awsLogger.info("IAM role validated", { metadata: { roleArn } });
    } catch (error) {
      throw new Error("IAM role validation failed");
    }

    // Validate package size (should be under 50MB)
    const packageBuffer = await this.createSimpleDeploymentPackage();
    const sizeInMB = packageBuffer.length / (1024 * 1024);
    if (sizeInMB > 50) {
      throw new Error(
        `Package too large: ${sizeInMB.toFixed(2)}MB (max: 50MB)`
      );
    }
    awsLogger.info("Package size validated", {
      metadata: { sizeInMB: sizeInMB.toFixed(2) },
    });
  }

  private async cleanupExistingFunction(functionName: string): Promise<void> {
    // This method is now replaced by robustCleanup
    await this.robustCleanup(functionName);
  }

  private async createMinimalPackage(
    counterId: string,
    durationMinutes: number
  ): Promise<Buffer> {
    // Create counter Lambda with fixed initialization logic
    const minimalCode = `
exports.handler = async (event) => {
  console.log('⚡ Counter ${counterId} invoked');
  
  // Get environment variables with debugging
  const startTimeStr = process.env.COUNTER_START_TIME;
  const endTimeStr = process.env.COUNTER_END_TIME;
  const counterIdEnv = process.env.COUNTER_ID;
  
  console.log('ENV DEBUG: startTime=' + startTimeStr + ', endTime=' + endTimeStr + ', counterId=' + counterIdEnv);
  
  // Parse environment variables
  let startTime = parseInt(startTimeStr || '0');
  let endTime = parseInt(endTimeStr || '0');
  
  console.log('PARSED: startTime=' + startTime + ', endTime=' + endTime);
  
  // Validate environment variables - they should ALWAYS be set during deployment
  if (!startTime || startTime === 0 || !endTime || endTime === 0) {
    console.log('CRITICAL: Environment variables not set properly during deployment!');
    console.log('This indicates a deployment issue, not runtime initialization');
    
    // Return error state instead of trying to initialize
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: false,
        counterId: '${counterId}',
        currentValue: 0,
        startTime: null,
        endTime: null,
        isRunning: false,
        remainingTimeMs: null,
        elapsedTimeMs: null,
        message: 'Counter failed: Environment variables not set during deployment',
        error: 'DEPLOYMENT_ENV_ERROR',
        debug: {
          startTimeStr: startTimeStr,
          endTimeStr: endTimeStr,
          parsedStartTime: startTime,
          parsedEndTime: endTime
        }
      })
    };
  }
  
  // Calculate current value based on elapsed time since start
  const currentTime = Date.now();
  const elapsedSeconds = Math.floor((currentTime - startTime) / 1000);
  const currentValue = Math.max(1, elapsedSeconds * 10 + 1);
  
  // Check if counter is still running
  const isRunning = currentTime < endTime;
  const remainingTimeMs = Math.max(0, endTime - currentTime);
  const elapsedTimeMs = currentTime - startTime;
  
  console.log('SUCCESS: value=' + currentValue + ', running=' + isRunning + ', elapsed=' + elapsedSeconds + 's');
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      counterId: '${counterId}',
      currentValue: currentValue,
      startTime: startTime,
      endTime: endTime,
      isRunning: isRunning,
      remainingTimeMs: remainingTimeMs,
      elapsedTimeMs: elapsedTimeMs,
      message: isRunning ? 'Counter running' : 'Counter completed'
    })
  };
};`;

    const JSZip = require("jszip");
    const zip = new JSZip();
    zip.file("index.js", minimalCode);

    return await zip.generateAsync({ type: "nodebuffer" });
  }

  private async createSimpleDeploymentPackage(): Promise<Buffer> {
    // Read the Lambda template
    const templatePath = path.join(__dirname, "lambda-counter-template.js");
    const lambdaCode = fs.readFileSync(templatePath, "utf8");

    // Create minimal zip with just the Lambda code (AWS SDK is available in runtime)
    const JSZip = require("jszip");
    const zip = new JSZip();

    zip.file("index.js", lambdaCode);

    return await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  private async invokeLambda(functionName: string, payload: any): Promise<any> {
    const result = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionName,
        Payload: JSON.stringify(payload),
      })
    );

    if (result.Payload) {
      const response = JSON.parse(Buffer.from(result.Payload).toString());
      if (response.statusCode === 200) {
        return JSON.parse(response.body);
      } else {
        throw new Error(
          `Lambda invocation failed: ${JSON.stringify(response)}`
        );
      }
    }

    throw new Error("No response from Lambda function");
  }
}

// Export singleton instance
export const awsCounterDeployment = new AWSCounterDeployment();
