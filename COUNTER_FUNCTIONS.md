# AWS Counter Functions

This document describes the AWS-based counter functions that deploy counter instances to real AWS infrastructure and can be managed from Claude Desktop.

## Overview

The counter functions deploy actual counter instances to AWS that run independently in the cloud. These functions start at 1 and increment by 10 every second for a specified duration. Unlike local counters, these run on AWS infrastructure and can be accessed from anywhere.

## Functions

### 1. deployCounterToAWS

**Description**: Deploys a counter function to AWS that will run independently and increment by 10 every second.

**Parameters**:

- `durationMinutes` (optional): Duration to run the counter in minutes (default: 2 minutes)

**Example Usage**:

```json
{
  "name": "deployCounterToAWS",
  "arguments": {
    "durationMinutes": 5
  }
}
```

**Response**:

```json
{
  "success": true,
  "counterId": "counter-1749033927029",
  "message": "Counter deployed to AWS and started. Duration: 5 minutes",
  "awsResourceArn": "arn:aws:lambda:us-east-1:123456789012:function:counter-1749033927029"
}
```

### 2. getCounterValueFromAWS

**Description**: Retrieves counter value and status from AWS deployed counter(s).

**Parameters**:

- `counterId` (optional): ID of specific counter to check. If not provided, returns all counters.

**Example Usage**:

```json
{
  "name": "getCounterValueFromAWS",
  "arguments": {
    "counterId": "counter-1749033927029"
  }
}
```

**Response**:

```json
{
  "success": true,
  "counters": [
    {
      "counterId": "counter-1749033927029",
      "currentValue": 51,
      "isRunning": true,
      "startTime": 1749033927029,
      "endTime": 1749034227029,
      "remainingTimeMs": 150000,
      "elapsedTimeMs": 150000,
      "awsResourceArn": "arn:aws:lambda:us-east-1:123456789012:function:counter-1749033927029"
    }
  ],
  "message": "Counter counter-1749033927029 status retrieved from AWS"
}
```

### 3. stopCounterInAWS

**Description**: Stops a specific counter running on AWS.

**Parameters**:

- `counterId` (required): ID of the counter to stop

**Example Usage**:

```json
{
  "name": "stopCounterInAWS",
  "arguments": {
    "counterId": "counter-1749033927029"
  }
}
```

**Response**:

```json
{
  "success": true,
  "message": "Counter counter-1749033927029 stopped in AWS",
  "finalValue": 81,
  "counterId": "counter-1749033927029"
}
```

### 4. removeCounterFromAWS

**Description**: Removes/cleans up a deployed counter from AWS (stops and deletes resources).

**Parameters**:

- `counterId` (required): ID of the counter to remove

**Example Usage**:

```json
{
  "name": "removeCounterFromAWS",
  "arguments": {
    "counterId": "counter-1749033927029"
  }
}
```

**Response**:

```json
{
  "success": true,
  "message": "Counter counter-1749033927029 removed from AWS",
  "counterId": "counter-1749033927029"
}
```

### 5. listDeployedCounters

**Description**: Lists all counters deployed to AWS with their status.

**Parameters**: None

**Example Usage**:

```json
{
  "name": "listDeployedCounters",
  "arguments": {}
}
```

**Response**:

```json
{
  "success": true,
  "counters": [
    {
      "counterId": "counter-1749033927029",
      "status": "running",
      "durationMinutes": 5,
      "currentValue": 51,
      "awsResourceArn": "arn:aws:lambda:us-east-1:123456789012:function:counter-1749033927029",
      "deployedAt": 1749033927029
    }
  ],
  "message": "Found 1 deployed counter(s)"
}
```

## How It Works

1. **AWS Deployment**: Counter functions are deployed to AWS as Lambda functions or ECS tasks
2. **Independent Execution**: Counters run independently in AWS, not tied to your local MCP server
3. **Real-time Tracking**: Each counter maintains state in AWS (DynamoDB or CloudWatch)
4. **Resource Management**: Each counter gets its own AWS resources with unique ARNs
5. **Remote Monitoring**: Query status and values from AWS in real-time

## AWS Infrastructure

The current implementation uses:

- **AWS Lambda Functions** for counter execution
- **EventBridge** for scheduling increment events
- **DynamoDB** (planned) for state persistence
- **CloudWatch** for monitoring and logging

## Deployment Architecture

```
Claude Desktop (MCP Client)
    ↓
Local MCP Server
    ↓
AWS Deployment Manager
    ↓
AWS Lambda Function (Counter Instance)
    ↓
DynamoDB (Counter State)
```

## Usage Examples from Claude Desktop

### Deploy and Monitor a Counter:

```
"Deploy a counter to AWS for 3 minutes, then check its value every 30 seconds"
```

### Multiple Counters:

```
"Deploy 3 different counters to AWS with different durations and monitor them all"
```

### Stop and Cleanup:

```
"Stop the counter and remove it from AWS to clean up resources"
```

## Current Implementation Status

- ✅ **MCP Integration**: Full integration with Claude Desktop
- ✅ **Function Framework**: Complete function signatures and structure
- ✅ **AWS Deployment**: Real AWS Lambda deployment with DynamoDB and EventBridge
- ✅ **State Persistence**: DynamoDB for counter state storage
- ✅ **Real Scheduling**: EventBridge for real-time incrementing
- ✅ **IAM Management**: Automatic IAM role creation and policy attachment
- ✅ **Resource Cleanup**: Complete AWS resource lifecycle management

## AWS Infrastructure Implementation

The implementation now uses real AWS services:

- **AWS Lambda Functions** for counter execution (Node.js 18.x runtime)
- **EventBridge Rules** for scheduling increment events every minute
- **DynamoDB Table** for persistent counter state storage
- **IAM Roles** with proper permissions for Lambda execution
- **CloudWatch Logs** for monitoring and debugging

## Deployment Process

1. **Infrastructure Setup**: Creates DynamoDB table and IAM roles automatically
2. **Lambda Deployment**: Packages and deploys counter code as Lambda function
3. **EventBridge Configuration**: Sets up scheduled rules for counter increments
4. **State Initialization**: Creates initial counter record in DynamoDB
5. **Monitoring**: All operations logged to CloudWatch

## Cost Considerations

- **Lambda**: Pay per invocation (very low cost for counters)
- **DynamoDB**: Pay per request (minimal for counter operations)
- **EventBridge**: Pay per rule evaluation (minimal cost)
- **CloudWatch Logs**: Pay for log storage (minimal for short-term counters)

**Estimated cost per counter**: < $0.01 USD for a 2-minute counter

## Prerequisites for Real AWS Deployment

1. **AWS Credentials**: Valid AWS access key and secret key
2. **AWS Account ID**: Your 12-digit AWS account identifier
3. **IAM Permissions**: Ability to create Lambda functions, DynamoDB tables, IAM roles
4. **Region Access**: Access to your specified AWS region (default: us-east-1)

## Environment Variables Required

```env
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012  # Your actual AWS account ID
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

## Testing Real AWS Deployment

Use the provided test script to verify AWS deployment:

```bash
npm run build
node test-aws-counter.js
```

**⚠️ Warning**: This will create real AWS resources and may incur costs.

## Benefits of Real AWS Implementation

- ✅ **True Cloud Deployment**: Counters run independently in AWS
- ✅ **Scalable**: Can handle multiple concurrent counters
- ✅ **Persistent**: Survives local server restarts
- ✅ **Monitored**: Full CloudWatch integration
- ✅ **Secure**: Proper IAM role-based permissions
- ✅ **Cost-Effective**: Pay only for actual usage
- ✅ **Production Ready**: Real AWS infrastructure
