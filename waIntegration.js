// waIntegration.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const fs = require('fs');
const logger = require('./logger');

// Stores active WhatsApp clients { userId: client }
let waClients = {};

/**
 * Ensures that the WhatsApp client for a given user is connected.
 * If the client is not present or its state is not 'CONNECTED',
 * it attempts to (re)initialize the client.
 * @param {string} userId - The unique user ID.
 * @returns {Promise<Client>} - Returns the connected client instance.
 */
async function ensureClientConnected(userId) {
  let client = waClients[userId];
  if (!client) {
    logger.logInfo('waIntegration', 'ensureClientConnected', `No client found for userId ${userId}. Initializing new client.`);
    await initializeWhatsAppClient(userId);
    client = waClients[userId];
    return client;
  }
  try {
    const state = await client.getState();
    if (state !== 'CONNECTED') {
      logger.logInfo('waIntegration', 'ensureClientConnected', `Client state for userId ${userId} is ${state}. Attempting to reconnect.`);
      await client.initialize();
      client = waClients[userId];
    }
  } catch (error) {
    logger.logError('waIntegration', 'ensureClientConnected', `Error checking state for userId ${userId}: ${error.message}. Reinitializing.`);
    delete waClients[userId];
    await initializeWhatsAppClient(userId);
    client = waClients[userId];
  }
  return client;
}

/**
 * Initializes a WhatsApp client for a given userId.
 * Uses LocalAuth for session persistence.
 * @param {string} userId - The unique user ID.
 * @returns {Promise<boolean>} - Returns true if successful, false otherwise.
 */
async function initializeWhatsAppClient(userId) {
  // If a client already exists, check its state
  if (waClients[userId]) {
    let existingClient = waClients[userId];
    try {
      const state = await existingClient.getState();
      if (state === 'CONNECTED') {
        logger.logDebug('waIntegration', 'initializeWhatsAppClient', `Client for userId ${userId} already connected.`);
        handleWhatsAppEvent(userId, 'ready');
        return true;
      } else {
        logger.logDebug('waIntegration', 'initializeWhatsAppClient', `Client for userId ${userId} exists but state is ${state}. Attempting reconnection.`);
        await existingClient.initialize();
        return true;
      }
    } catch (error) {
      logger.logError('waIntegration', 'initializeWhatsAppClient', `Error checking state for userId ${userId}: ${error.message}. Reinitializing new client.`);
      delete waClients[userId];
    }
  }

  logger.logDebug('waIntegration', 'initializeWhatsAppClient', `Creating new client for userId ${userId}`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: userId,
      dataPath: './sessions'
    }),
    puppeteer: {
      headless: true,
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    }
  });

  waClients[userId] = client;
  setupClientListeners(client, userId);

  try {
    logger.logDebug('waIntegration', 'initializeWhatsAppClient', `Calling client.initialize() for userId ${userId}`);
    await client.initialize();
    logger.logDebug('waIntegration', 'initializeWhatsAppClient', `Client initialized successfully for userId ${userId}`);

    const state = await client.getState();
    logger.logDebug('waIntegration', 'initializeWhatsAppClient', `After initialization, state for userId ${userId}: ${state}`);

    
    return true;
  } catch (error) {
    logger.logError('waIntegration', 'initializeWhatsAppClient', `Initialization failed for userId ${userId}: ${error.message}`);
    delete waClients[userId];
    return false;
  }
}

/**
 * Returns the active WhatsApp client for a user if it exists and is connected.
 * @param {string} userId - The unique user ID.
 * @returns {Promise<Client|null>} - Returns the connected client instance or null.
 */
async function getConnectedClient(userId) {
  const client = waClients[userId];
  if (!client) {
    logger.logError('waIntegration', 'getConnectedClient', `No client found for userId ${userId}`);
    return null;
  }
  try {
    const state = await client.getState();
    if (state !== 'CONNECTED') {
      logger.logError('waIntegration', 'getConnectedClient', `Client state for userId ${userId} is ${state}`);
      return null;
    }
    return client;
  } catch (error) {
    logger.logError('waIntegration', 'getConnectedClient', `Error checking state for userId ${userId}: ${error.message}`);
    return null;
  }
}

/**
 * Sets up event listeners for a WhatsApp client.
 * @param {Client} client - The WhatsApp client instance.
 * @param {string} userId - The user ID associated with this client.
 */
function setupClientListeners(client, userId) {
  logger.logDebug('waIntegration', 'setupClientListeners', `Setting up listeners for userId ${userId}`);
  let firstConnection = false;
  let QRrequest = 0;

  client.on('qr', (qr) => {
    QRrequest++;
    logger.logDebug('waIntegration', 'setupClientListeners', `QR code received for userId ${userId}, attempt ${QRrequest}/10`);
    firstConnection = true;
    handleWhatsAppEvent(userId, 'qr', qr);
    if (QRrequest >= 10) {
      logger.logError('waIntegration', 'setupClientListeners', `Too many QR requests (10) for userId ${userId}. Terminating client.`);
      terminateWhatsAppClient(userId);
    }
  });

  client.on('authenticated', () => {
    logger.logDebug('waIntegration', 'setupClientListeners', `User ${userId} authenticated`);
    handleWhatsAppEvent(userId, 'authenticated');
  });

  client.on('ready', () => {
    logger.logDebug('waIntegration', 'setupClientListeners', `WhatsApp client for userId ${userId} is ready`);
    handleWhatsAppEvent(userId, 'ready');
  });

  client.on('message', (message) => {
    logger.logDebug('waIntegration', 'setupClientListeners', `Message received from userId ${userId}: ${message.body.slice(0, 100)}`);
    require('./waLogic').handleWhatsAppEvent(userId, 'message', message);
  });

  client.on('disconnected', (reason) => {
    logger.logDebug('waIntegration', 'setupClientListeners', `WhatsApp client for userId ${userId} disconnected: ${reason}`);
    handleWhatsAppEvent(userId, 'disconnected', reason);
    restartWhatsAppClient(userId);
  });

  client.on('error', (error) => {
    logger.logError('waIntegration', 'setupClientListeners', `Error for userId ${userId}: ${error.message}`);
    handleWhatsAppEvent(userId, 'error', error.message);
  });
}

/**
 * Restarts the WhatsApp client safely by terminating and reinitializing.
 * @param {string} userId - The user ID.
 */
async function restartWhatsAppClient(userId) {
  logger.logDebug('waIntegration', 'restartWhatsAppClient', `Restarting WhatsApp client for userId ${userId}`);
  if (waClients[userId]) {
    try {
      const state = await waClients[userId].getState();
      if (state === 'LOGGED_OUT' || state === 'UNPAIRED') {
        logger.logError('waIntegration', 'restartWhatsAppClient', `Client for userId ${userId} was logged out. Terminating session.`);
        terminateWhatsAppClient(userId);
        require('./waWSserver').sendMessageToClients(userId, { event: 'error', userid: userId, message: "WhatsApp session expired. Please re-login." });
        return;
      }
    } catch (error) {
      logger.logError('waIntegration', 'restartWhatsAppClient', `Error checking client state before restart: ${error.message}`);
    }
  }
  setTimeout(async () => {
    await initializeWhatsAppClient(userId);
  }, 5000);
}

/**
 * Terminates the WhatsApp client for a user and closes its Puppeteer page.
 * @param {string} userId - The user ID.
 */
async function terminateWhatsAppClient(userId) {
  if (!waClients[userId]) {
    logger.logDebug('waIntegration', 'terminateWhatsAppClient', `No active client to terminate for userId ${userId}`);
    return;
  }
  try {
    const client = waClients[userId];
    const page = client.pupPage;
    await client.destroy();
    delete waClients[userId];
    if (page) {
      await page.close();
    }
    logger.logDebug('waIntegration', 'terminateWhatsAppClient', `Successfully terminated WhatsApp client for userId ${userId}`);
  } catch (error) {
    logger.logError('waIntegration', 'terminateWhatsAppClient', `Error terminating client for userId ${userId}: ${error.message}`);
  }
}

/**
 * Returns the active WhatsApp client for a user.
 * @param {string} userId - The user ID.
 * @returns {Client|null}
 */
function getWhatsAppClient(userId) {
  return waClients[userId] || null;
}

/**
 * Handles WhatsApp events and relays them to the WebSocket server.
 * @param {string} userId - The user ID.
 * @param {string} event - The event type.
 * @param {any} data - Event data.
 */
function handleWhatsAppEvent(userId, event, data = null) {
  const { sendMessageToClients } = require('./waWSserver');
  logger.logDebug('waIntegration', 'handleWhatsAppEvent', `Event received: ${event} for userId ${userId}`);
  switch (event) {
    case 'qr':
      sendMessageToClients(userId, { event: 'qr', userid: userId, qr_code: data });
      break;
    case 'authenticated':
      sendMessageToClients(userId, { event: 'authenticated', userid: userId });
      break;
    case 'ready':
      sendMessageToClients(userId, { event: 'ready', userid: userId });
      break;
    case 'disconnected':
      sendMessageToClients(userId, { event: 'disconnected', userid: userId });
      break;
    case 'error':
      sendMessageToClients(userId, { event: 'error', userid: userId, message: data });
      break;
    case 'message':
      const parsedMessage = {
        id: data.id._serialized,
        isGroups: data.isGroupMsg,
        timestamp: data.timestamp * 1000,
        sender: data.author,
        from: data.from,
        body: data.body,
        type: data.type,
        reply: data.quotedMsgId || null
      };
      sendMessageToClients(userId, { event: 'message', userid: userId, message: parsedMessage });
      break;
    default:
      sendMessageToClients(userId, { event, userid: userId, data });
  }
}

module.exports = {
  initializeWhatsAppClient,
  terminateWhatsAppClient,
  restartWhatsAppClient,
  getWhatsAppClient,
  getConnectedClient,
  handleWhatsAppEvent
};
