'use strict';

const moment = require('moment');
const path = require('path');
const fs = require('fs');
const helper = require('./helper');

class Socket {
    constructor(socket, apiUrls) {
        this.io = socket;
        this.apiUrls = apiUrls;
        this.userTokens = new Map();
        this.userSockets = new Map();
        this.socketUsers = new Map();
        this.socketEnvironments = new Map();
    }

    socketEvents() {
        this.io.on('connection', (socket) => {
            const token = socket.handshake.query.token;
            const userId = socket.handshake.query.id;
            const userType = socket.handshake.query.user_type || 'user';
            const environment = socket.environment || 'dev';
            const apiUrl = socket.apiUrl || this.apiUrls.dev;

            if (token && userId) {
                this.userTokens.set(socket.id, token);
                this.userSockets.set(userId, socket.id);
                this.socketUsers.set(socket.id, userId);
                this.socketEnvironments.set(socket.id, environment);

                console.log(`User ${userId} (${userType}) connected`);
                console.log(`Socket ID: ${socket.id}`);
                console.log(`Environment: ${environment.toUpperCase()}`);
                console.log(`API URL: ${apiUrl}`);
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

                    console.log(`Fetching chat list for user [${socket.environment}]`);
                    const result = await helper.getChatList(token, socket);

                    if (result && result.success) {
                        const enrichedChatList = result.chatlist.map(chat => {
                            const lookupId = chat.socket_lookup_id || chat.id || chat.user_id || chat.company_id;
                            const recipientSocketId = this.userSockets.get(String(lookupId));

                            return {
                                ...chat,
                                isOnline: !!recipientSocketId,
                                socket_id: recipientSocketId
                            };
                        });

                        this.io.to(socket.id).emit('chatListRes', {
                            userConnected: false,
                            role: result.role,
                            environment: socket.environment,
                            chatList: enrichedChatList
                        });

                        socket.broadcast.emit('chatListRes', {
                            userConnected: true,
                            userId: userId,
                            socket_id: socket.id,
                            environment: socket.environment
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
                    console.log(`Getting messages [${socket.environment}]: ${data.fromUserId} → ${data.toUserId}`);

                    const result = await helper.getMessages(data.fromUserId, data.toUserId, token, socket);

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
             * Send message
             */
            socket.on('sendMessage', async (response) => {
                try {
                    const env = socket.environment || 'dev';

                    console.log(`Message received [${env.toUpperCase()}]:`, {
                        from: response.fromUserId,
                        to: response.toUserId,
                        conversationId: response.conversation_id,
                        apiUrl: socket.apiUrl
                    });

                    response.date = moment().format("YYYY-MM-DD");
                    response.time = moment().format("hh:mm A");

                    const token = this.userTokens.get(socket.id);
                    const insertId = await this.insertMessage(response, socket, token);

                    if (insertId) {
                        response.id = insertId;

                        let recipientSocketId = response.toSocketId;

                        if (!recipientSocketId) {
                            recipientSocketId = this.userSockets.get(String(response.toUserId));
                        }

                        const recipientSocket = recipientSocketId ?
                            this.io.sockets.sockets.get?.(recipientSocketId) ??
                            this.io.sockets.connected?.[recipientSocketId] : null;

                        if (recipientSocket) {
                            const recipientEnv = this.socketEnvironments.get(recipientSocketId);
                            console.log(`Sending to recipient [${recipientEnv}]: ${recipientSocketId}`);
                            this.io.to(recipientSocketId).emit('addMessageResponse', response);
                        } else {
                            console.log(`Recipient ${response.toUserId} is offline`);
                        }

                        this.io.to(socket.id).emit('messageSent', {
                            tempId: response.tempId || response.id,
                            id: insertId,
                            success: true
                        });
                    } else {
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
             * Typing indicator
             */
            socket.on('typing', (data) => {
                let targetSocketId = data.socket_id;

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
             * Toggle favorite
             */
            socket.on('toggleFavorite', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);
                    const userId = this.socketUsers.get(socket.id);

                    if (!token) {
                        console.error('No token found for socket:', socket.id);
                        this.io.to(socket.id).emit('favoriteUpdated', {
                            success: false,
                            message: 'Authentication required',
                            conversationId: data.conversationId
                        });
                        return;
                    }

                    console.log(`Toggling favorite [${socket.environment}]:`, {
                        userId,
                        conversationId: data.conversationId,
                        isFavorite: data.isFavorite
                    });

                    // Call API to update favorite status
                    const result = await helper.toggleFavorite(
                        data.conversationId,
                        data.isFavorite,
                        token,
                        socket
                    );

                    if (result && result.success) {
                        // Emit success to the requesting user
                        this.io.to(socket.id).emit('favoriteUpdated', {
                            success: true,
                            conversationId: data.conversationId,
                            isFavorite: data.isFavorite
                        });

                        // Broadcast to user's other connected devices (same user, different sockets)
                        const userSockets = Array.from(this.socketUsers.entries())
                            .filter(([socketId, uId]) => uId === userId && socketId !== socket.id)
                            .map(([socketId]) => socketId);

                        userSockets.forEach(socketId => {
                            this.io.to(socketId).emit('favoriteUpdated', {
                                success: true,
                                conversationId: data.conversationId,
                                isFavorite: data.isFavorite
                            });
                        });

                        console.log(`Favorite toggled successfully for conversation ${data.conversationId}`);
                    } else {
                        this.io.to(socket.id).emit('favoriteUpdated', {
                            success: false,
                            message: 'Failed to toggle favorite',
                            conversationId: data.conversationId
                        });
                    }
                } catch (error) {
                    console.error('toggleFavorite event error:', error);
                    this.io.to(socket.id).emit('favoriteUpdated', {
                        success: false,
                        message: 'Failed to toggle favorite',
                        conversationId: data.conversationId,
                        error: error.message
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

                        const recipientSocket = recipientSocketId ?
                            this.io.sockets.sockets.get?.(recipientSocketId) ??
                            this.io.sockets.connected?.[recipientSocketId] : null;

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
             * Get online users
             */
            socket.on('getOnlineUsers', () => {
                const onlineUsers = Array.from(this.userSockets.entries()).map(([userId, socketId]) => ({
                    userId,
                    socketId,
                    environment: this.socketEnvironments.get(socketId)
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
                    const environment = this.socketEnvironments.get(socket.id);

                    await helper.logoutUser(socket.id, token, socket);

                    this.userTokens.delete(socket.id);
                    if (userId) {
                        this.userSockets.delete(userId);
                    }
                    this.socketUsers.delete(socket.id);
                    this.socketEnvironments.delete(socket.id);

                    socket.broadcast.emit('chatListRes', {
                        userDisconnected: true,
                        socket_id: socket.id,
                        userId: userId,
                        environment: environment
                    });

                    console.log(`User ${userId} disconnected [${environment}] (socket: ${socket.id})`);
                } catch (error) {
                    console.error('disconnect event error:', error);
                }
            });
        });
    }

    async insertMessage(data, socket, token) {
        try {
            console.log(`Inserting message [${socket.environment}] via ${socket.apiUrl}`);

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
            }, token, socket);

            if (sqlResult && sqlResult.insertId) {
                let insertId = sqlResult.insertId;
                this.io.to(socket.id).emit('messageIdUpdate', {
                    tempMessageId: data.id,
                    insertedId: insertId
                });
                console.log(`Message saved with ID: ${insertId}`);
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
            }, token, socket);

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
                let environment = socket.environment || 'dev';

                console.log(`Socket authentication [${environment.toUpperCase()}]:`, {
                    userId,
                    userType,
                    apiUrl: socket.apiUrl
                });

                if (!userId || !token) {
                    console.error('Missing userId or token');
                    return next(new Error('Authentication error'));
                }

                let userSocketId = socket.id;
                const response = await helper.addSocketId(userId, userSocketId, userType, token, socket);

                if (response && response !== null) {
                    console.log(`Socket authenticated [${environment.toUpperCase()}]: ${userId} (${userType})`);
                    next();
                } else {
                    console.error(`Socket authentication failed [${environment.toUpperCase()}]: ${userId}`);
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