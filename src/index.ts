/**
 * MCP Server Entry Point
 * Starts the Model Context Protocol server for pump.fun trading
 */

// CRITICAL: Import mcp-setup FIRST to override console methods
import './mcp-setup';

import { startMCPServer } from './agent/MCPServer';

// Start MCP server
startMCPServer().catch((error) => {
  console.error(' Failed to start MCP server:', error);
  process.exit(1);
});
