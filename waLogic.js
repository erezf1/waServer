// waLogic.js
const logger = require('./logger');
const { getWhatsAppClient, initializeWhatsAppClient, getConnectedClient, handleWhatsAppEvent } = require('./waIntegration');

/**
 * Handles incoming WebSocket client requests.
 * @param {string} userId - The user making the request.
 * @param {Object} requestData - The request data.
 */
async function handleClientRequest(userId, requestData) {
    logger.logDebug('waLogic', 'handleClientRequest', `Received request: ${JSON.stringify(requestData)}`);
    switch (requestData.event) {
        case 'initiate':
            await initializeWhatsAppClient(userId);
            break;
        case 'fetch_groups':
            await getWhatsAppGroups(userId);
            break;
        case 'fetch_messages':
            await getGroupMessages(
                userId,
                requestData.group_id,
                requestData.startTime || null,
                requestData.endTime || null
            );
            break;
        case 'send_message':
            await UserSendMessage(userId, requestData.recipient, requestData.message);
            break;
        case 'get_messages':
            await enableReceivingMessages(userId);
            break;
        default:
            logger.logError('waLogic', 'handleClientRequest', `Unhandled event: ${requestData.event}`);
    }
}



/**
 * Fetches WhatsApp groups for a user.
 * Checks for a connected client; if not connected, returns an error.
 * @param {string} userId - The user ID requesting the group list.
 */
async function getWhatsAppGroupsContacts(userId) {
    const { sendMessageToClients } = require('./waWSserver');

    try {
        logger.logDebug('waLogic', 'getWhatsAppGroups', `Fetching groups for userId ${userId} using getContacts()`);

        const client = await getConnectedClient(userId);
        if (!client) {
            throw new Error(`WhatsApp client not connected for userId ${userId}`);
        }
        
        // Fetch all contacts and filter only groups
    const contacts = await client.getContacts();
    const groupContacts = contacts.filter(contact => contact.isGroup);
    logger.logDebug('waLogic', 'getWhatsAppGroups', `[DEBUG] Total contact groups retrieved: ${groupContacts.length}`);

    // Fetch timestamp and archived status for each group
    const groupDetails = [];
    for (const group of groupContacts) {
        try {
            const chat = await client.getChatById(group.id._serialized);
            logger.logDebug('waLogic', 'getWhatsAppGroups', `[DEBUG] retrived group details: ${chat.name}`);

            // Only push if the group is NOT archived
            if (!chat.archived) {
                groupDetails.push({
                    id: chat.id._serialized,
                    name: chat.name || "Unknown",
                    timestamp: chat.timestamp || null,  // Last activity time
                });
            }
        } catch (error) {
            console.error(`Error fetching chat data for group ${group.id._serialized}:`, error.message);
        }
    }
        logger.logDebug('waLogic', 'getWhatsAppGroups', `[DEBUG] Filtered groups: ${groupContacts.length}`);

        // Send the group list to the WebSocket client
        sendMessageToClients(userId, {
            event: 'group_list',
            userid: userId,
            groups: groupDetails
        });

        logger.logDebug('waLogic', 'getWhatsAppGroups', `Groups fetched and sent for user ${userId}`);

    } catch (error) {
        logger.logError('waLogic', 'getWhatsAppGroups', `Error fetching groups for userId ${userId}: ${error.message}`);
        sendMessageToClients(userId, { event: 'error', userid: userId, message: error.message });
    }
}



async function getWhatsAppGroups(userId) {
    const { sendMessageToClients } = require('./waWSserver');

    try {
        logger.logDebug('waLogic', 'getWhatsAppGroups', `Fetching groups for userId ${userId}`);
        const client = await getConnectedClient(userId);
        if (!client) {
            throw new Error(`WhatsApp client not connected for userId ${userId}`);
        }
        // Use before calling getChats()
        // Wait for WhatsApp Web's chat list container to be available
        await client.pupPage.waitForSelector('div#pane-side', { timeout: 30000 });
        logger.logDebug('waLogic', 'getWhatsAppGroups', `finish waiting for == waitForSelector`);

        const chats = await client.getGroupChats();
        logger.logDebug('waLogic', 'getWhatsAppGroups', `[DEBUG] Total chats retrieved: ${chats.length}`);
        const chatsJSON = chats.map(chat => ({
            id: chat.id._serialized || null,
            name: chat.name || "Unknown",
            isGroup: chat.id.server === 'g.us',
            archived: chat.archived || false,
            timestamp: chat.timestamp || null
        }));
        const groups = chatsJSON
            .filter(chat => chat.isGroup && !chat.archived)
            .map(group => ({
                id: group.id,
                name: group.name,
                timestamp: group.timestamp
            }));
        logger.logDebug('waLogic', 'getWhatsAppGroups', `[DEBUG] Filtered non-archived groups: ${groups.length} groups`);
        sendMessageToClients(userId, {
            event: 'group_list',
            userid: userId,
            groups: groups
        });
        logger.logDebug('waLogic', 'getWhatsAppGroups', `Groups fetched and sent for user ${userId}`);
    } catch (error) {
        logger.logError('waLogic', 'getWhatsAppGroups', `Error fetching groups for userId ${userId}: ${error.message}`);
        sendMessageToClients(userId, { event: 'error', userid: userId, message: error.message });
    }
}

/**
 * Retrieves messages from a specific WhatsApp group with pagination and time filtering.
 * Checks for a connected client; if not connected, returns an error.
 * @param {string} userId - The user ID.
 * @param {string} groupId - The group ID.
 * @param {string} startTime - (Optional) Start timestamp (ISO format).
 * @param {string} endTime - (Optional) End timestamp (ISO format).
 */
async function getGroupMessages(userId, groupId, startTime = null, endTime = null) {
    const { sendMessageToClients } = require('./waWSserver');

    try {
        logger.logDebug('waLogic', 'getGroupMessages', `Fetching messages for userId ${userId}, groupId ${groupId}`);
        const client = await getConnectedClient(userId);
        if (!client) {
            throw new Error(`WhatsApp client not connected for userId ${userId}`);
        }
        const chat = await client.getChatById(groupId);
        if (!chat) {
            throw new Error(`Chat not found for group ${groupId}`);
        }
        const startTimestamp = startTime ? new Date(startTime).getTime() : null;
        const endTimestamp = endTime ? new Date(endTime).getTime() : null;
        if ((startTimestamp && isNaN(startTimestamp)) || (endTimestamp && isNaN(endTimestamp))) {
            throw new Error("Invalid startTime or endTime format");
        }
        let allMessages = [];
        const fetchLimits = [50, 200, 500];
        let fetched = false;
        for (const limit of fetchLimits) {
            const messages = await chat.fetchMessages({ limit });
            if (messages.length > 0) {
                const oldestMessageDate = new Date(messages[0].timestamp * 1000);
                if (startTimestamp && oldestMessageDate.getTime() < startTimestamp) {
                    allMessages = messages;
                    fetched = true;
                    logger.logDebug('waLogic', 'getGroupMessages', `Fetched ${messages.length} messages with limit ${limit}.`);
                    break;
                }
            }
        }
        if (!fetched) {
            logger.logDebug('waLogic', 'getGroupMessages', `Unable to fetch messages older than the start time.`);
        }
        const filteredMessages = allMessages.filter((msg) => {
            const msgTimestamp = msg.timestamp * 1000;
            return (!startTimestamp || msgTimestamp >= startTimestamp) &&
                   (!endTimestamp || msgTimestamp <= endTimestamp);
        });
        if (filteredMessages.length === 0) {
            logger.logDebug('waLogic', 'getGroupMessages', `No messages found within the specified timeframe.`);
        }
        filteredMessages.sort((a, b) => a.timestamp - b.timestamp);
        logger.logDebug('waLogic', 'getGroupMessages', `Filtered ${filteredMessages.length} messages.`);
        sendMessageToClients(userId, {
            event: 'group_messages',
            userid: userId,
            group_id: groupId,
            messages: filteredMessages.map((msg) => ({
                id: msg.id._serialized,
                timestamp: msg.timestamp * 1000,
                sender: msg.author || msg.from,
                body: msg.body,
                type: msg.type,
                reply: msg.quotedMsgId || null
            })),
            date: startTime ? startTime.split("T")[0] : null
        });
        logger.logDebug('waLogic', 'getGroupMessages', `Successfully sent filtered messages for userId ${userId}, group ${groupId}`);
    } catch (error) {
        logger.logError('waLogic', 'getGroupMessages', `Error fetching messages for userId ${userId}, groupId ${groupId}: ${error.message}`);
        sendMessageToClients(userId, { event: 'error', userid: userId, message: error.message });
    }
}

/**
 * Sends a message to a WhatsApp recipient (group or contact).
 * This function now resides in waLogic.js.
 * Checks if the client is connected; if not, returns an error.
 * @param {string} userId - The user ID.
 * @param {string} recipient - The group ID or phone number.
 * @param {string} message - The message content.
 */
async function UserSendMessage(userId, recipient, message) {
    const { sendMessageToClients } = require('./waWSserver');

    const client = await getConnectedClient(userId);
    if (!client) {
        logger.logError('waLogic', 'UserSendMessage', `No active WhatsApp client for userId ${userId}`);
        sendMessageToClients(userId, { event: 'error', userid: userId, message: 'WhatsApp client not connected' });
        return;
    }
    logger.logDebug('waLogic', 'UserSendMessage', `Request to send from ${userId} to ${recipient} message: ${message}`);
    let recipientId;
    // If recipient is a phone number (10+ digits), convert it to a WhatsApp ID.
    if (/^\d{10,}$/.test(recipient)) {
        recipientId = convertPhoneNumberToWaId(recipient);
    } else {
        recipientId = recipient;
    }
    try {
        await client.sendMessage(recipientId, message);
        logger.logDebug('waLogic', 'UserSendMessage', `Message sent to ${recipientId} by user ${userId}`);
        sendMessageToClients(userId, { event: 'message_sent', userid: userId, recipientId, message });
    } catch (error) {
        logger.logError('waLogic', 'UserSendMessage', `Failed to send message from userId ${userId}: ${error.message}`);
        sendMessageToClients(userId, { event: 'error', userid: userId, message: error.message });
    }
}

/**
 * Converts a phone number to a WhatsApp user ID.
 * @param {string} phoneNumber - The phone number in local or international format.
 * @returns {string} - WhatsApp user ID in the format "<number>@c.us".
 */
function convertPhoneNumberToWaId(phoneNumber) {
    if (phoneNumber.startsWith("972")) {
        return `${phoneNumber}@c.us`;
    } else if (phoneNumber.startsWith("0")) {
        return `972${phoneNumber.slice(1)}@c.us`;
    }
    return `${phoneNumber}@c.us`;
}

async function enableReceivingMessages(userId) {
    const client = await getConnectedClient(userId);
    if (!client) {
        logger.logError('waLogic', 'enableReceivingMessages', `No active WhatsApp client for userId ${userId}`);
        return;
    }
    if (!client.messageListenerAttached) {
        const messageListener = (message) => {
            logger.logDebug('waIntegration', 'messageListener', `Message received for userId ${userId}: ${message.body.slice(0, 100)}`);
            handleWhatsAppEvent(userId, 'message', message);
        };
        client.on('message', messageListener);
        client.messageListenerAttached = true;
        client.messageListener = messageListener; // Save the listener reference for later removal
        logger.logDebug('waLogic', 'enableReceivingMessages', `Enabled message reception for userId ${userId}`);
    } else {
        logger.logDebug('waLogic', 'enableReceivingMessages', `Message listener already attached for userId ${userId}`);
    }
}

module.exports = {
    handleClientRequest,
    getWhatsAppGroups,
    getGroupMessages,
    UserSendMessage
};
