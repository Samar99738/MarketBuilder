/**
 * MCP Server Setup
 * MUST be imported FIRST before any other modules
 * Redirects all console output to stderr for MCP protocol compliance
 */

// Set MCP mode flag
process.env.MCP_MODE = 'true';

// Override ALL console methods to redirect to stderr
// This prevents ANY stdout pollution which breaks MCP's JSON-only protocol
console.log = (...args: any[]) => console.error(...args);
console.warn = (...args: any[]) => console.error(...args);
console.info = (...args: any[]) => console.error(...args);
console.table = (data: any) => console.error(JSON.stringify(data, null, 2));
console.dir = (...args: any[]) => console.error(...args);

// Export a marker to confirm setup ran
export const MCP_SETUP_COMPLETE = true;
