// AWS Lambda function template for counter instances
// This code will be deployed as a Lambda function for each counter

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  DeleteRuleCommand,
  RemoveTargetsCommand,
} = require("@aws-sdk/client-eventbridge");

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({
  region: process.env.AWS_REGION,
});

const TABLE_NAME = process.env.COUNTER_TABLE_NAME || "counter-state-table";

exports.handler = async (event) => {
  console.log("Counter Lambda invoked:", JSON.stringify(event, null, 2));

  const counterId = process.env.COUNTER_ID;
  const durationMinutes = parseInt(process.env.DURATION_MINUTES || "2");

  try {
    // Handle different event types
    if (event.source === "aws.events") {
      // This is a scheduled increment event
      return await handleIncrementEvent(counterId, durationMinutes);
    } else if (event.action === "initialize") {
      // Initialize the counter
      return await initializeCounter(counterId, durationMinutes);
    } else if (event.action === "getStatus") {
      // Get current counter status
      return await getCounterStatus(counterId);
    } else if (event.action === "stop") {
      // Stop the counter
      return await stopCounter(counterId);
    } else if (event.diagnostic === true) {
      // Debug/diagnostic call
      return await getCounterStatus(counterId);
    } else {
      // Default action - get status
      return await getCounterStatus(counterId);
    }
  } catch (error) {
    console.error("Error in counter Lambda:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
        counterId,
      }),
    };
  }
};

async function initializeCounter(counterId, durationMinutes) {
  const startTime = Date.now();
  const endTime = startTime + durationMinutes * 60 * 1000;

  // Create initial counter state in DynamoDB
  const counterState = {
    counterId,
    currentValue: 1,
    startTime,
    endTime,
    durationMinutes,
    status: "running",
    lastUpdateTime: startTime,
    createdAt: new Date().toISOString(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: counterState,
    })
  );

  // Set up EventBridge rule for scheduled execution
  const ruleName = `counter-increment-${counterId}`;

  try {
    // Create the rule for every 1 second
    await eventBridgeClient.send(
      new PutRuleCommand({
        Name: ruleName,
        ScheduleExpression: "rate(1 second)",
        Description: `Counter increment rule for ${counterId}`,
        State: "ENABLED",
      })
    );

    // Add the Lambda function as a target
    await eventBridgeClient.send(
      new PutTargetsCommand({
        Rule: ruleName,
        Targets: [
          {
            Id: "1",
            Arn: process.env.AWS_LAMBDA_FUNCTION_ARN,
            Input: JSON.stringify({
              source: "aws.events",
              counterId: counterId,
              action: "increment",
            }),
          },
        ],
      })
    );

    console.log(
      `Counter ${counterId} initialized with EventBridge rule ${ruleName}`
    );
  } catch (error) {
    console.error(`Failed to set up EventBridge rule: ${error.message}`);
    // Don't fail initialization if EventBridge setup fails
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      counterId,
      message: `Counter initialized for ${durationMinutes} minutes`,
      startTime,
      endTime,
      currentValue: 1,
      isRunning: true,
    }),
  };
}

async function handleIncrementEvent(counterId, durationMinutes) {
  // Get current counter state
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { counterId },
    })
  );

  if (!result.Item) {
    console.log(`Counter ${counterId} not found, may have been deleted`);
    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Counter not found" }),
    };
  }

  const counter = result.Item;
  const currentTime = Date.now();

  // Check if counter should still be running
  if (currentTime >= counter.endTime || counter.status !== "running") {
    console.log(`Counter ${counterId} has expired or been stopped`);
    await stopCounter(counterId);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Counter completed",
        finalValue: counter.currentValue,
        counterId,
      }),
    };
  }

  // Increment counter by 10
  const newValue = counter.currentValue + 10;

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { counterId },
      UpdateExpression:
        "SET currentValue = :newValue, lastUpdateTime = :updateTime",
      ExpressionAttributeValues: {
        ":newValue": newValue,
        ":updateTime": currentTime,
      },
    })
  );

  console.log(`Counter ${counterId} incremented to ${newValue}`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      counterId,
      currentValue: newValue,
      remainingTimeMs: Math.max(0, counter.endTime - currentTime),
    }),
  };
}

async function getCounterStatus(counterId) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { counterId },
    })
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        success: false,
        error: "Counter not found",
        counterId,
        currentValue: 0,
        isRunning: false,
        startTime: null,
        endTime: null,
        remainingTimeMs: null,
        elapsedTimeMs: null,
      }),
    };
  }

  const counter = result.Item;
  const currentTime = Date.now();

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      counterId: counter.counterId,
      currentValue: counter.currentValue,
      isRunning: counter.status === "running" && currentTime < counter.endTime,
      startTime: counter.startTime,
      endTime: counter.endTime,
      remainingTimeMs: Math.max(0, counter.endTime - currentTime),
      elapsedTimeMs: currentTime - counter.startTime,
      lastUpdateTime: counter.lastUpdateTime,
    }),
  };
}

async function stopCounter(counterId) {
  // Update counter status to stopped
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { counterId },
      UpdateExpression: "SET #status = :status, lastUpdateTime = :updateTime",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": "stopped",
        ":updateTime": Date.now(),
      },
    })
  );

  // Remove EventBridge rule
  const ruleName = `counter-increment-${counterId}`;

  try {
    // Remove targets first
    await eventBridgeClient.send(
      new RemoveTargetsCommand({
        Rule: ruleName,
        Ids: ["1"],
      })
    );

    // Delete the rule
    await eventBridgeClient.send(
      new DeleteRuleCommand({
        Name: ruleName,
      })
    );

    console.log(`EventBridge rule ${ruleName} deleted`);
  } catch (error) {
    console.log(`Error deleting EventBridge rule: ${error.message}`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      message: `Counter ${counterId} stopped`,
      counterId,
    }),
  };
}
