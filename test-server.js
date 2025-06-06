const { spawn } = require("child_process");
const process = require("process");

// Start the MCP server as a child process
const server = spawn("pnpm", ["dev"], {
  stdio: ["pipe", "pipe", process.stderr],
});

// Sample test messages
const testMessages = [
  { jsonrpc: "2.0", method: "initialize", params: {}, id: 1 },
  { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
  {
    jsonrpc: "2.0",
    method: "execute",
    params: { name: "getTokenPrice", parameters: {} },
    id: 3,
  },
  {
    jsonrpc: "2.0",
    method: "execute",
    params: { name: "buyTokens", parameters: { amountInSol: 0.01 } },
    id: 4,
  },
];

// Process server output
server.stdout.on("data", (data) => {
  const responses = data.toString().trim().split("\n");
  responses.forEach((response) => {
    if (response) {
      try {
        const parsedResponse = JSON.parse(response);
        console.log("\nReceived response:");
        console.log(JSON.stringify(parsedResponse, null, 2));
      } catch (e) {
        console.log("\nReceived raw output:", response);
      }
    }
  });
});

// Send test messages with delay
let messageIndex = 0;
const sendNextMessage = () => {
  if (messageIndex < testMessages.length) {
    const message = testMessages[messageIndex++];
    console.log(`\nSending message: ${JSON.stringify(message)}`);
    server.stdin.write(JSON.stringify(message) + "\n");

    // Schedule next message
    setTimeout(sendNextMessage, 1000);
  } else {
    // End the test after a delay
    setTimeout(() => {
      console.log("\nTests completed, shutting down");
      server.kill();
      process.exit(0);
    }, 1000);
  }
};

// Start sending messages after a brief delay
setTimeout(sendNextMessage, 500);
