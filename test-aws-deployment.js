// Test script for AWS deployment functions
// Run this after starting the server with: npm run dev

const BASE_URL = "http://localhost:3000";

async function makeRequest(method, endpoint, body = null) {
  try {
    const options = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${BASE_URL}${endpoint}`, options);
    const data = await response.json();

    console.log(`\n=== ${method} ${endpoint} ===`);
    console.log("Status:", response.status);
    console.log("Response:", JSON.stringify(data, null, 2));

    return data;
  } catch (error) {
    console.error(`Error with ${method} ${endpoint}:`, error.message);
    return null;
  }
}

async function testAWSDeploymentFunctions() {
  console.log("🚀 Testing AWS Deployment Functions");
  console.log("Make sure the server is running with: npm run dev\n");

  // First, let's create a test strategy
  console.log(
    "📋 Note: You need to create a strategy first using the StrategyBuilder"
  );

  // 1. Test deploying a strategy
  const deployResult = await makeRequest("POST", "/api/deploy/strategy", {
    strategyId: "test-strategy",
    environment: "development",
    restartDelay: 30000,
    envVars: {
      CUSTOM_SETTING: "test-value",
    },
  });

  if (deployResult && deployResult.deploymentId) {
    const deploymentId = deployResult.deploymentId;

    // 2. Test verifying deployment
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait a bit
    await makeRequest("GET", `/api/deploy/verify/${deploymentId}`);

    // 3. Test listing deployments
    await makeRequest("GET", "/api/deploy/list");

    // 4. Test stopping deployment
    await makeRequest("POST", "/api/deploy/stop", {
      deploymentId: deploymentId,
    });

    // 5. Verify it's stopped
    await makeRequest("GET", `/api/deploy/verify/${deploymentId}`);
  }

  // Test health check
  await makeRequest("GET", "/health");

  console.log("\n✅ All tests completed!");
  console.log("📝 Note: These are currently using mock implementations.");
  console.log(
    "💡 To use real AWS, implement the TODO sections in deployment.ts"
  );
}

// Run tests if this file is executed directly
if (require.main === module) {
  testAWSDeploymentFunctions();
}

module.exports = { testAWSDeploymentFunctions, makeRequest };
