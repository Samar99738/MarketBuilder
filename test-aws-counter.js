// Test script for Real AWS Counter deployment
// This tests the actual AWS Lambda deployment functionality

const { spawn } = require("child_process");

async function testAWSCounterDeployment() {
  console.log("🧪 Testing Real AWS Counter Deployment");
  console.log(
    "⚠️  This will create actual AWS resources (Lambda, DynamoDB, IAM roles)"
  );
  console.log(
    "💰 Make sure you have AWS credentials configured and understand the costs"
  );

  // Start the MCP server
  const serverProcess = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let serverReady = false;

  // Wait for server to be ready
  serverProcess.stderr.on("data", (data) => {
    const output = data.toString();
    console.log("Server:", output.trim());
    if (output.includes("MCP server running")) {
      serverReady = true;
    }
  });

  // Helper function to send JSON-RPC message
  function sendMessage(method, params = {}, id = 1) {
    const message = {
      jsonrpc: "2.0",
      method: method,
      params: params,
      id: id,
    };

    console.log(`\n📤 Sending: ${JSON.stringify(message)}`);
    serverProcess.stdin.write(JSON.stringify(message) + "\n");
  }

  // Handle server responses
  serverProcess.stdout.on("data", (data) => {
    try {
      const response = JSON.parse(data.toString());
      console.log(`📥 Response: ${JSON.stringify(response, null, 2)}`);
    } catch (error) {
      console.log(`📥 Raw response: ${data.toString()}`);
    }
  });

  // Wait for server to be ready
  await new Promise((resolve) => {
    const checkReady = setInterval(() => {
      if (serverReady) {
        clearInterval(checkReady);
        resolve();
      }
    }, 100);
  });

  console.log("\n🚀 Server ready, starting AWS counter tests...\n");

  // Test 1: Initialize MCP
  sendMessage("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Test 2: List available tools
  sendMessage("tools/list");

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Test 3: Deploy counter to AWS (1 minute for quick test)
  console.log("\n🔥 Deploying counter to AWS Lambda...");
  sendMessage("tools/call", {
    name: "deployCounterToAWS",
    arguments: { durationMinutes: 1 },
  });

  await new Promise((resolve) => setTimeout(resolve, 15000)); // Wait for deployment

  // Test 4: Get counter value
  console.log("\n📊 Getting counter value from AWS...");
  sendMessage("tools/call", {
    name: "getCounterValueFromAWS",
  });

  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Test 5: List all deployed counters
  console.log("\n📋 Listing all deployed counters...");
  sendMessage("tools/call", {
    name: "listDeployedCounters",
  });

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("\n✅ AWS Counter deployment test completed!");
  console.log("🧹 Remember to clean up AWS resources if needed");

  // Cleanup
  serverProcess.kill();
}

// Run the test
testAWSCounterDeployment().catch(console.error);
