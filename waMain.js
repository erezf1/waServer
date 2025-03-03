const logger = require('./logger');
const { startWebSocketServer } = require('./waWSserver');

require('dotenv').config(); // Load .env file if present

const WS_PORT = process.env.WS_PORT || 3000; // Set WebSocket Port from environment
let wsServer = null;

/**
 * Starts the WebSocket server.
 */
function initializeSystem() {
    logger.logInfo('waMain', 'initializeSystem', 'Server initiated.');
    try {
        wsServer = startWebSocketServer(WS_PORT);

        wsServer.on('close', () => {
            logger.logError('waMain', 'initializeSystem', 'WebSocket server closed unexpectedly. Restarting...');
            restartWebSocketServer();
        });

        logger.logInfo('waMain', 'initializeSystem', 'Server started successfully.');
    } catch (error) {
        logger.logError('waMain', 'initializeSystem', `Startup failed: ${error.message}`);
    }
}

/**
 * Restarts the WebSocket server if it crashes.
 */
function restartWebSocketServer() {
    setTimeout(() => {
        logger.logInfo('waMain', 'restartWebSocketServer', 'Restarting WebSocket server...');
        wsServer = startWebSocketServer(WS_PORT);
    }, 5000);
}

/**
 * Gracefully shuts down the system.
 */
function shutdownSystem() {
    logger.logInfo('waMain', 'shutdownSystem', 'Server shutting down...');
    if (wsServer) {
        wsServer.close();
    }
    logger.logInfo('waMain', 'shutdownSystem', 'Server shutdown complete.');
}

// Start the system
initializeSystem();

// Handle process exit
process.on('SIGINT', () => {
    logger.logInfo('waMain', 'process.on(SIGINT)', 'SIGINT received. Shutting down server.');
    shutdownSystem();
    process.exit();
});
