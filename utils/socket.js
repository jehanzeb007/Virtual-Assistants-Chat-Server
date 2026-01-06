'use strict';

const moment = require('moment');
const path = require('path');
const fs = require('fs');
const helper = require('./helper');

class Socket {
    constructor(socket) {
        this.io = socket;
        // Store user tokens in memory
        this.userTokens = new Map();
        // Store user socket mappings for direct messaging
        this.userSockets = new Map(); // userId -> socketId
        this.socketUsers = new Map(); // socketId -> userId
    }

    socketEvents() {
        this.io.on('connection', (socket) => {
            const token = socket.handshake.query.token;
            const userId = socket.handshake.query.id;
            const userType = socket.handshake.query.user_type || 'user';

            if (token && userId) {
                this.userTokens.set(socket.id, token);
                this.userSockets.set(userId, socket.id);
                this.socketUsers.set(socket.id, userId);
                console.log(`User ${userId} (${userType}) connected with socket ${socket.id}`);
            }

            /**
             * Get the user's Chat list
             */
            socket.on('chatList', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);

                    if (!token) {
                        console.error('No token found for socket:', socket.id);
                        this.io.to(socket.id).emit('chatListRes', {
                            error: true,
                            message: 'Authentication required',
                            chatList: []
                        });
                        return;
                    }

                    const result = await helper.getChatList(token);

                    if (result && result.success) {
                        // Enrich chat list with online status using socket_lookup_id
                        const enrichedChatList = result.chatlist.map(chat => {
                            // Use socket_lookup_id if available, otherwise fall back to id
                            const lookupId = chat.socket_lookup_id || chat.id || chat.user_id || chat.company_id;
                            const recipientSocketId = this.userSockets.get(String(lookupId));

                            console.log('Socket lookup for chat:', {
                                chatName: chat.name,
                                chatId: chat.id,
                                lookupId: lookupId,
                                foundSocket: recipientSocketId,
                                isOnline: !!recipientSocketId
                            });

                            return {
                                ...chat,
                                isOnline: !!recipientSocketId,
                                socket_id: recipientSocketId
                            };
                        });

                        // Emit to the requesting user
                        this.io.to(socket.id).emit('chatListRes', {
                            userConnected: false,
                            role: result.role,
                            chatList: enrichedChatList
                        });

                        // Broadcast to others that user is online
                        socket.broadcast.emit('chatListRes', {
                            userConnected: true,
                            userId: userId,
                            socket_id: socket.id
                        });
                    } else {
                        this.io.to(socket.id).emit('chatListRes', {
                            error: true,
                            message: 'Failed to fetch chat list',
                            chatList: []
                        });
                    }
                } catch (error) {
                    console.error('chatList event error:', error);
                    this.io.to(socket.id).emit('chatListRes', {
                        error: true,
                        message: 'Internal server error',
                        chatList: []
                    });
                }
            });

            /**
             * Get messages between users
             */
            socket.on('getMessages', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);
                    const result = await helper.getMessages(data.fromUserId, data.toUserId, token);

                    if (result === null || !result.success) {
                        this.io.to(socket.id).emit('getMessagesResponse', {
                            result: [],
                            toUserId: data.toUserId
                        });
                    } else {
                        this.io.to(socket.id).emit('getMessagesResponse', {
                            result: result.data,
                            toUserId: data.toUserId
                        });
                    }
                } catch (error) {
                    console.error('getMessages event error:', error);
                    this.io.to(socket.id).emit('getMessagesResponse', {
                        result: [],
                        toUserId: data.toUserId,
                        error: true
                    });
                }
            });

            /**
             * Send message - FIXED: Properly route messages between users
             */
            socket.on('sendMessage', async (response) => {
                try {
                    console.log('sendMessage received:', {
                        from: response.fromUserId,
                        to: response.toUserId,
                        toSocketId: response.toSocketId,
                        conversationId: response.conversation_id,
                        message: response.message?.substring(0, 50)
                    });

                    response.date = moment().format("YYYY-MM-DD");
                    response.time = moment().format("hh:mm A");

                    const token = this.userTokens.get(socket.id);
                    const insertId = await this.insertMessage(response, socket, token);

                    if (insertId) {
                        response.id = insertId;

                        // FIX: Get recipient socket ID
                        let recipientSocketId = response.toSocketId;

                        // If toSocketId is not provided or invalid, look up by user ID
                        if (!recipientSocketId) {
                            recipientSocketId = this.userSockets.get(String(response.toUserId));
                            console.log(`Looked up socket for user ${response.toUserId}: ${recipientSocketId}`);
                        }

                        // Send to receiver if they're online - VERSION COMPATIBLE CHECK
                        const recipientSocket = recipientSocketId ? this.io.sockets.sockets.get?.(recipientSocketId) ?? this.io.sockets.connected?.[recipientSocketId] : null;

                        if (recipientSocket) {
                            console.log(`Sending message to socket: ${recipientSocketId}`);
                            this.io.to(recipientSocketId).emit('addMessageResponse', response);
                        } else {
                            console.log(`Recipient ${response.toUserId} is offline, message stored in DB`);
                        }

                        // Confirm to sender
                        this.io.to(socket.id).emit('messageSent', {
                            tempId: response.tempId || response.id,
                            id: insertId,
                            success: true
                        });
                    } else {
                        // Message insertion failed
                        this.io.to(socket.id).emit('messageSent', {
                            tempId: response.tempId || response.id,
                            success: false,
                            error: 'Failed to save message'
                        });
                    }
                } catch (error) {
                    console.error('sendMessage event error:', error);
                    this.io.to(socket.id).emit('messageSent', {
                        tempId: response.tempId || response.id,
                        success: false,
                        error: 'Failed to send message'
                    });
                }
            });

            /**
             * Read Message
             */
            socket.on('messageRead', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);
                    await this.updateMessageRead(data, socket, token);
                } catch (error) {
                    console.error('messageRead event error:', error);
                }
            });

            /**
             * Typing indicator - FIXED: Proper socket targeting
             */
            socket.on('typing', (data) => {
                let targetSocketId = data.socket_id;

                // If socket_id is not provided, look up by user ID
                if (!targetSocketId && data.toUserId) {
                    targetSocketId = this.userSockets.get(String(data.toUserId));
                }

                if (targetSocketId) {
                    socket.to(targetSocketId).emit('typing', {
                        typing: data.typing,
                        to_socket_id: socket.id,
                        fromUserId: this.socketUsers.get(socket.id)
                    });
                }
            });

            /**
             * Upload image
             */
            socket.on('upload-image', async (response) => {
                try {
                    let dir = moment().format("D-M-YYYY") + "/" + moment().format('x') + "/" + response.fromUserId;
                    await helper.mkdirSyncRecursive(dir);

                    let filepath = dir + "/" + response.fileName;
                    var writer = fs.createWriteStream(path.basename('uploads') + "/" + filepath, { encoding: 'base64' });

                    writer.write(response.message);
                    writer.end();

                    writer.on('finish', async () => {
                        response.message = response.fileName;
                        response.filePath = filepath;
                        response.date = moment().format("YYYY-MM-DD");
                        response.time = moment().format("hh:mm A");

                        const token = this.userTokens.get(socket.id);
                        const insertId = await this.insertMessage(response, socket, token);

                        response.id = insertId;

                        let recipientSocketId = response.toSocketId;
                        if (!recipientSocketId) {
                            recipientSocketId = this.userSockets.get(String(response.toUserId));
                        }

                        const recipientSocket = recipientSocketId ? this.io.sockets.sockets.get?.(recipientSocketId) ?? this.io.sockets.connected?.[recipientSocketId] : null;

                        if (recipientSocket) {
                            this.io.to(recipientSocketId).emit('addMessageResponse', response);
                        }

                        socket.emit('image-uploaded', response);
                    });
                } catch (error) {
                    console.error('upload-image event error:', error);
                    socket.emit('image-upload-error', {
                        error: 'Failed to upload image'
                    });
                }
            });

            /**
             * Get online users - helper endpoint
             */
            socket.on('getOnlineUsers', () => {
                const onlineUsers = Array.from(this.userSockets.entries()).map(([userId, socketId]) => ({
                    userId,
                    socketId
                }));
                socket.emit('onlineUsersResponse', onlineUsers);
            });

            /**
             * Disconnect
             */
            socket.on('disconnect', async () => {
                try {
                    const token = this.userTokens.get(socket.id);
                    const userId = this.socketUsers.get(socket.id);

                    await helper.logoutUser(socket.id, token);

                    // Remove from all maps
                    this.userTokens.delete(socket.id);
                    if (userId) {
                        this.userSockets.delete(userId);
                    }
                    this.socketUsers.delete(socket.id);

                    // Broadcast disconnect to all clients
                    socket.broadcast.emit('chatListRes', {
                        userDisconnected: true,
                        socket_id: socket.id,
                        userId: userId
                    });

                    console.log(`User ${userId} disconnected (socket: ${socket.id})`);
                } catch (error) {
                    console.error('disconnect event error:', error);
                }
            });
        });
    }

    async insertMessage(data, socket, token) {
        try {
            const sqlResult = await helper.insertMessages({
                message_id: data.id,
                type: data.type || 'text',
                fileFormat: data.fileFormat,
                filePath: data.filePath,
                fromUserId: data.fromUserId,
                toUserId: data.toUserId,
                conversation_id: data.conversation_id,
                senderType: data.senderType,
                receiverType: data.receiverType,
                message: data.message,
                date: data.date,
                time: data.time,
                ip: socket.request.connection.remoteAddress
            }, token);

            if (sqlResult && sqlResult.insertId) {
                let insertId = sqlResult.insertId;
                this.io.to(socket.id).emit('messageIdUpdate', {
                    tempMessageId: data.id,
                    insertedId: insertId
                });
                return insertId;
            }
            return null;
        } catch (error) {
            console.error('insertMessage error:', error);
            return null;
        }
    }

    async updateMessageRead(data, socket, token) {
        try {
            await helper.updateMessagesRead({
                id: data.id
            }, token);

            // Emit to both sender and receiver
            this.io.emit('readMessageTick', data);
        } catch (error) {
            console.error('updateMessageRead error:', error);
        }
    }

    socketConfig() {
        this.io.use(async (socket, next) => {
            try {
                let userId = socket.handshake.query['id'];
                let token = socket.handshake.query['token'];
                let userType = socket.handshake.query['user_type'] || 'user';

                console.log('Socket connection attempt:', { userId, userType });

                if (!userId || !token) {
                    console.error('Missing userId or token in socket connection');
                    return next(new Error('Authentication error'));
                }

                let userSocketId = socket.id;
                const response = await helper.addSocketId(userId, userSocketId, userType, token);

                if (response && response !== null) {
                    console.log(`Socket authenticated for user ${userId} (${userType})`);
                    next();
                } else {
                    console.error(`Socket connection failed for user ${userId}`);
                    next(new Error('Authentication failed'));
                }
            } catch (error) {
                console.error('Socket authentication error:', error);
                next(new Error('Authentication error'));
            }
        });

        this.socketEvents();
    }
}

module.exports = Socket;