/**
 * Server Startup Script
 * Starts the Solana Trading Platform REST API server
 */

const path = require('path');

// Set production environment
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Start the compiled server
const serverModule = require(path.join(__dirname, 'dist', 'src', 'server', 'server.js'));

// Call the startServer function to actually start listening
if (serverModule.default && serverModule.default.startServer) {
    serverModule.default.startServer().catch((error) => {
        console.error('❌ Error starting server:', error instanceof Error ? error.message : error);
        process.exit(1);
    });
} else if (serverModule.startServer) {
    serverModule.startServer().catch((error) => {
        console.error('❌ Error starting server:', error instanceof Error ? error.message : error);
        process.exit(1);
    });
} else {
    console.error('❌ Error: startServer function not found in server module');
    process.exit(1);
}

