// logger.js
const fs = require('fs');
const path = require('path');

// Set debug mode to true if running in a terminal (TTY)
let DEBUG_MODE = process.stdout.isTTY;

// Define the log file path
const logFilePath = path.join(__dirname, 'waLogs.log');

// Function to get the current time in IST (Indian Standard Time)
function getCurrentISTTime() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const istTime = new Date(now.getTime() + istOffset);
    return istTime.toISOString().replace('T', ' ').slice(0, 19); // Format: YYYY-MM-DD HH:MM:SS
}

// Function to write logs to a file
function writeLogToFile(logMessage) {
    fs.appendFile(logFilePath, logMessage + '\n', (err) => {
        if (err) console.error('Error writing log to file:', err);
    });
}

// Function to log a message
function logMessage(type, module, functionName, message) {
    const timestamp = getCurrentISTTime();
    const finalMessage = `[${type}] [${module}] [${functionName}] [${timestamp}] - ${message}`;
    if (DEBUG_MODE) {
        console.log(finalMessage);
    }
    writeLogToFile(finalMessage);
}

// New function to log INFO messages
function logInfo(module, functionName, message) {
    logMessage('INFO', module, functionName, message);
}

// Existing function to log DEBUG messages (if needed)
function logDebug(module, functionName, message) {
    logMessage('DEBUG', module, functionName, message);
}

// Existing function to log ERROR messages
function logError(module, functionName, errorMessage) {
    logMessage('ERROR', module, functionName, errorMessage);
}

// Export log functions
module.exports = {
    logInfo,
    logDebug,
    logError,
    setDebugMode: (mode) => { DEBUG_MODE = mode; }
};
