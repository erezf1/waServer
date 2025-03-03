const WebSocket = require('ws');
const logger = require('./logger');
const { handleClientRequest } = require('./waLogic');

let wsClients = {}; // Stores connected WebSocket clients { wsid: ws }
let wsClientMap = {}; // Maps wsid to { userIds: { userId: { sendMessages: boolean } } }

/**
 * Initializes the WebSocket server.
 * @param {number} port - The port to start the WebSocket server on.
 */
function startWebSocketServer(port) {
    try {
        const wss = new WebSocket.Server({ port });
        logger.logInfo('waWSserver', 'startWebSocketServer', `WebSocket server started on port ${port}`);

        wss.on('connection', (ws) => {
            logger.logInfo('waWSserver', 'onConnection', 'New WebSocket client connected');
            const wsid = generateWsId(); // Generate a unique ID for this connection
            wsClients[wsid] = ws;
            wsClientMap[wsid] = { userIds: {} }; // Initialize empty user mapping

            ws.on('message', (message) => handleIncomingMessage(wsid, ws, message));
            ws.on('close', () => handleClientDisconnection(wsid));
            ws.on('error', (error) => {
                logger.logError('waWSserver', 'onError', `WebSocket error: ${error.message}`);
            });
        });

        return wss; // Return WebSocket server instance
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            logger.logError('waWSserver', 'startWebSocketServer', `Error: Port ${port} is already in use.`);
            logger.logInfo('waWSserver', 'startWebSocketServer', `Attempting to detect existing process...`);
            process.exit(1); // Exit if unable to recover
        } else {
            throw error;
        }
    }
}

/**
 * Handles an incoming message from a client.
 * @param {string} wsid - WebSocket connection ID.
 * @param {WebSocket} ws - The WebSocket client instance.
 * @param {string} message - The received message.
 */
function handleIncomingMessage(wsid, ws, message) {
    try {
        const data = JSON.parse(message);
        if (!data.user_id || !data.event) {
            throw new Error('Invalid message format. Must contain user_id and event.');
        }

        const userId = data.user_id;

        // Handle different event types
        switch (data.event) {
            case 'initiate':
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Client ${wsid} mapped to userId ${userId}`);
                // Ensure wsClientMap entry exists for this userId
                if (!wsClientMap[wsid]) {
                    wsClientMap[wsid] = { userIds: {} };
                }
                if (!wsClientMap[wsid].userIds[userId]) {
                    wsClientMap[wsid].userIds[userId] = { sendMessages: false };
                }
                handleClientRequest(userId, { event: 'initiate' });
                break;

            case 'get_messages':
                wsClientMap[wsid].userIds[userId].sendMessages = true;
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Client ${wsid} enabled message reception for userId ${userId}`);
                //handleClientRequest(userId, { event: 'get_messages' });
                break;

            case 'stop_messages':
                wsClientMap[wsid].userIds[userId].sendMessages = false;
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Client ${wsid} disabled message reception for userId ${userId}`);
                break;

            case 'get_groups':
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Client ${wsid} requested groups for userId ${userId}`);
                handleClientRequest(userId, { event: 'fetch_groups' });
                break;
            
            case 'send_message':
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Client ${wsid} requested send_message for userId ${userId}`);
                handleClientRequest(userId, { 
                    event: 'send_message', 
                    recipient: data.recipient, 
                    message: data.message
                });
                break;
    
            case 'get_group_messages':
                if (!data.group_id) {
                    throw new Error("Missing 'group_id' for get_group_messages request.");
                }
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Client ${wsid} requested messages for group ${data.group_id} of userId ${userId}`);
                const startTime = data.startTime || null;
                const endTime = data.endTime || null;
                handleClientRequest(userId, { 
                    event: 'fetch_messages', 
                    group_id: data.group_id, 
                    startTime: startTime, 
                    endTime: endTime 
                });
                break;

            case 'disconnect':
                sendMessageToClients(userId, { event: 'disconnected', userid: userId }, [wsid]);
                delete wsClientMap[wsid].userIds[userId];
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Client ${wsid} disconnected from userId ${userId}`);
                break;

            default:
                logger.logInfo('waWSserver', 'handleIncomingMessage', `Received event '${data.event}' from userId ${userId} (wsid: ${wsid})`);
                handleClientRequest(userId, data);
                break;
        }
    } catch (error) {
        logger.logError('waWSserver', 'handleIncomingMessage', `Failed to process message: ${error.message}`);
        if (typeof data !== 'undefined' && data.user_id) {
            sendMessageToClients(data.user_id, { status: 'error', message: error.message });
        } else {
            logger.logError('waWSserver', 'handleIncomingMessage', `Cannot send error response - user_id is undefined.`);
        }
    }
}

/**
 * Sends a message to clients connected to a user.
 * @param {string} userId - The user ID whose response should be sent.
 * @param {Object} message - The message to send.
 * @param {Array} specificClients - Optional: List of wsids to send the message to.
 */
function sendMessageToClients(userId, message, specificClients = null) {
    logger.logInfo('waWSserver', 'sendMessageToClients', `Sending message to ${userId}, message type: ${message.event}`);

    let targetClients = specificClients || Object.keys(wsClientMap)
        .filter(wsid => wsClientMap[wsid].userIds && wsClientMap[wsid].userIds[userId]);

    if (message.event === 'message') {
        targetClients = targetClients.filter(wsid => wsClientMap[wsid].userIds[userId].sendMessages);
        if (targetClients.length === 0) {
            logger.logInfo('waWSserver', 'sendMessageToClients', `No active clients found for userId ${userId} messges`);
            return;
        }
    }

    if (targetClients.length === 0) {
        logger.logError('waWSserver', 'sendMessageToClients', `No active clients found for userId ${userId}`);
        return;
    }

    targetClients.forEach(wsid => {
        const client = wsClients[wsid];

        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
            logger.logInfo('waWSserver', 'sendMessageToClients', `Sent message to wsid ${wsid} for userId ${userId}: ${JSON.stringify(message).slice(0, 200)}...`);
        } else {
            logger.logError('waWSserver', 'sendMessageToClients', `Client wsid ${wsid} for userId ${userId} is not connected. Removing from list.`);
            delete wsClientMap[wsid].userIds[userId];
        }
    });
}

/**
 * Handles client disconnection.
 * @param {string} wsid - The WebSocket ID of the disconnected client.
 */
function handleClientDisconnection(wsid) {
    delete wsClients[wsid];
    delete wsClientMap[wsid];
    logger.logInfo('waWSserver', 'handleClientDisconnection', `Client wsid ${wsid} fully disconnected.`);
}

/**
 * Generates a unique WebSocket ID (wsid) for each client.
 * @returns {string} - Unique wsid.
 */
function generateWsId() {
    return `ws_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

module.exports = {
    startWebSocketServer,
    sendMessageToClients
};
