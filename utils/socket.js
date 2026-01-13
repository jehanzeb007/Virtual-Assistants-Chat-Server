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

                // Store multiple sockets per user
                if (!this.userSockets.has(userId)) {
                    this.userSockets.set(userId, new Set());
                }
                this.userSockets.get(userId).add(socket.id);

                this.socketUsers.set(socket.id, userId);
                this.socketEnvironments.set(socket.id, environment);

                console.log(`User ${userId} (${userType}) connected`);
                console.log(`Socket ID: ${socket.id}`);
                console.log(`Total sessions for user: ${this.userSockets.get(userId).size}`);
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
                            const userSocketSet = this.userSockets.get(String(lookupId));
                            const recipientSocketId = userSocketSet && userSocketSet.size > 0
                                ? Array.from(userSocketSet)[0]
                                : null;

                            return {
                                ...chat,
                                isOnline: !!(userSocketSet && userSocketSet.size > 0),
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
             * Get messages between users with pagination support
             */
            socket.on('getMessages', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);

                    // Extract pagination parameters
                    const limit = data.limit || null;
                    const offset = data.offset || null;

                    console.log(`Getting messages [${socket.environment}]: ${data.fromUserId} → ${data.toUserId}`, {
                        limit: limit || 'default (20)',
                        offset: offset || 0
                    });

                    const result = await helper.getMessages(
                        data.fromUserId,
                        data.toUserId,
                        token,
                        socket,
                        limit,
                        offset
                    );

                    if (result === null || !result.success) {
                        this.io.to(socket.id).emit('getMessagesResponse', {
                            result: [],
                            toUserId: data.toUserId,
                            pagination: {
                                limit: limit || 20,
                                offset: offset || 0,
                                hasMore: false,
                                total: 0
                            }
                        });
                    } else {
                        this.io.to(socket.id).emit('getMessagesResponse', {
                            result: result.data,
                            toUserId: data.toUserId,
                            pagination: result.pagination
                        });

                        console.log(`Messages sent to client:`, {
                            count: result.data.length,
                            pagination: result.pagination
                        });
                    }
                } catch (error) {
                    console.error('getMessages event error:', error);
                    this.io.to(socket.id).emit('getMessagesResponse', {
                        result: [],
                        toUserId: data.toUserId,
                        error: true,
                        pagination: {
                            limit: data.limit || 20,
                            offset: data.offset || 0,
                            hasMore: false,
                            total: 0
                        }
                    });
                }
            });

            /**
             * Send message (with file attachments support)
             */
            socket.on('sendMessage', async (response) => {
                try {
                    const env = socket.environment || 'dev';

                    console.log(`Message received [${env.toUpperCase()}]:`, {
                        from: response.fromUserId,
                        to: response.toUserId,
                        conversationId: response.conversation_id,
                        hasAttachments: !!(response.attachments && response.attachments.length > 0),
                        attachmentCount: response.attachments?.length || 0,
                        apiUrl: socket.apiUrl
                    });

                    response.date = moment().format("YYYY-MM-DD");
                    response.time = moment().format("hh:mm A");

                    const token = this.userTokens.get(socket.id);

                    // Insert message with attachments
                    const responseInsert = await this.insertMessage(response, socket, token);

                    const insertId = responseInsert?.insertId;
                    if (insertId) {
                        response.id = insertId;

                        const senderSocketIds = responseInsert.responseData.senderSocketIds || [];
                        const receiverSocketIds = responseInsert.responseData.receiverSocketIds || [];

                        const otherSenderSockets = senderSocketIds.filter(
                            socketId => socketId !== socket.id
                        );

                        const notifiedSocketIds = new Set([...otherSenderSockets, socket.id]);
                        const uniqueReceiverSockets = receiverSocketIds.filter(
                            socketId => !notifiedSocketIds.has(socketId)
                        );

                        this.emitToMultipleSockets(this.io, otherSenderSockets, 'addMessageResponse', response);
                        this.emitToMultipleSockets(this.io, uniqueReceiverSockets, 'addMessageResponse', response);

                        // Update the temp message ID for the current sender socket
                        this.io.to(socket.id).emit('messageIdUpdate', {
                            tempMessageId: responseInsert.responseData.data.message_id,
                            insertedId: insertId
                        });

                        // Confirm message sent successfully to current sender
                        this.io.to(socket.id).emit('messageSent', {
                            tempId: response.tempId || response.id,
                            id: insertId,
                            success: true,
                            conversation_id: response.conversation_id
                        });

                        // Emit new media uploaded event if message has attachments
                        if (response.attachments && response.attachments.length > 0) {
                            const mediaFiles = response.attachments.map(file => ({
                                id: `${insertId}_${file.name}`,
                                message_id: insertId,
                                name: file.name,
                                path: file.path,
                                size: file.size,
                                format: file.format,
                                date: new Date().toISOString()
                            }));

                            const allUniqueSockets = [...new Set([...senderSocketIds, ...receiverSocketIds])];

                            this.emitToMultipleSockets(this.io, allUniqueSockets, 'newMediaUploaded', {
                                conversationId: response.conversation_id,
                                files: mediaFiles
                            });

                            console.log(`New media emitted: ${mediaFiles.length} file(s) for conversation ${response.conversation_id}`);
                        }
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
                    const userSocketSet = this.userSockets.get(String(data.toUserId));
                    if (userSocketSet && userSocketSet.size > 0) {
                        targetSocketId = Array.from(userSocketSet)[0];
                    }
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

                    const result = await helper.toggleFavorite(
                        data.conversationId,
                        data.isFavorite,
                        token,
                        socket
                    );

                    if (result && result.success) {
                        // Get all sockets for this user
                        const userSocketSet = this.userSockets.get(userId);
                        if (userSocketSet) {
                            userSocketSet.forEach(socketId => {
                                this.io.to(socketId).emit('favoriteUpdated', {
                                    success: true,
                                    conversationId: data.conversationId,
                                    isFavorite: data.isFavorite
                                });
                            });
                        }

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
             * Get conversation media (images and documents)
             */
            socket.on('getConversationMedia', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);

                    if (!token) {
                        console.error('No token found for socket:', socket.id);
                        this.io.to(socket.id).emit('conversationMediaResponse', {
                            success: false,
                            message: 'Authentication required',
                            conversationId: data.conversationId,
                            media: { images: [], documents: [], total: 0 }
                        });
                        return;
                    }

                    console.log(`Fetching conversation media [${socket.environment}]:`, {
                        conversationId: data.conversationId
                    });

                    const result = await helper.getConversationMedia(
                        data.conversationId,
                        token,
                        socket
                    );

                    if (result && result.success) {
                        this.io.to(socket.id).emit('conversationMediaResponse', {
                            success: true,
                            conversationId: result.conversationId,
                            media: result.media
                        });

                        console.log(`Conversation media sent [${socket.environment}]:`, {
                            conversationId: result.conversationId,
                            imagesCount: result.media.images?.length || 0,
                            documentsCount: result.media.documents?.length || 0
                        });
                    } else {
                        this.io.to(socket.id).emit('conversationMediaResponse', {
                            success: false,
                            message: 'Failed to fetch conversation media',
                            conversationId: data.conversationId,
                            media: { images: [], documents: [], total: 0 }
                        });
                    }
                } catch (error) {
                    console.error('getConversationMedia event error:', error);
                    this.io.to(socket.id).emit('conversationMediaResponse', {
                        success: false,
                        message: 'Failed to fetch conversation media',
                        conversationId: data.conversationId,
                        media: { images: [], documents: [], total: 0 },
                        error: error.message
                    });
                }
            });

            /**
             * Upload image (legacy support)
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
                            const userSocketSet = this.userSockets.get(String(response.toUserId));
                            if (userSocketSet && userSocketSet.size > 0) {
                                recipientSocketId = Array.from(userSocketSet)[0];
                            }
                        }

                        if (recipientSocketId) {
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
                const onlineUsers = [];
                this.userSockets.forEach((socketSet, userId) => {
                    socketSet.forEach(socketId => {
                        onlineUsers.push({
                            userId,
                            socketId,
                            environment: this.socketEnvironments.get(socketId)
                        });
                    });
                });
                socket.emit('onlineUsersResponse', onlineUsers);
            });


            socket.on('searchMessages', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);

                    if (!token) {
                        console.error('No token found for socket:', socket.id);
                        this.io.to(socket.id).emit('searchMessagesResponse', {
                            success: false,
                            message: 'Authentication required',
                            results: []
                        });
                        return;
                    }

                    console.log(`Searching messages [${socket.environment}]:`, {
                        conversationId: data.conversation_id,
                        searchText: data.search_text,
                        userId: data.user_id
                    });

                    const result = await helper.searchMessages(
                        data.conversation_id,
                        data.search_text,
                        data.user_id,
                        token,
                        socket
                    );

                    if (result && result.success) {
                        // Log pagination info for debugging
                        if (result.data && result.data.length > 0) {
                            console.log(`Search results with pagination:`,
                                result.data.map(r => ({
                                    id: r.id,
                                    page: r.pagination_info?.page_number
                                }))
                            );
                        }

                        this.io.to(socket.id).emit('searchMessagesResponse', {
                            success: true,
                            results: result.data,
                            count: result.data.length
                        });
                    } else {
                        this.io.to(socket.id).emit('searchMessagesResponse', {
                            success: false,
                            message: 'Search failed',
                            results: []
                        });
                    }
                } catch (error) {
                    console.error('searchMessages event error:', error);
                    this.io.to(socket.id).emit('searchMessagesResponse', {
                        success: false,
                        message: 'Internal server error',
                        results: [],
                        error: error.message
                    });
                }
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

    emitToMultipleSockets(io, socketIds, eventName, data){
        if (!socketIds || socketIds.length === 0) {
            console.log('No socket IDs provided.');
            return;
        }
        try {
            socketIds.forEach(socketId => {
                console.log(socketId,eventName);
                io.to(socketId).emit(eventName, data);
            });
        } catch (error) {
            console.log(error);
        }
    }

    async insertMessage(data, socket, token) {
        try {
            console.log(`Inserting message [${socket.environment}] via ${socket.apiUrl}`, {
                hasAttachments: !!(data.attachments && data.attachments.length > 0),
                attachmentCount: data.attachments?.length || 0
            });

            const sqlResult = await helper.insertMessages({
                message_id: data.id,
                type: data.type || 'text',
                fromUserId: data.fromUserId,
                toUserId: data.toUserId,
                conversation_id: data.conversation_id,
                senderType: data.senderType,
                receiverType: data.receiverType,
                message: data.message,
                date: data.date,
                time: data.time,
                ip: socket.request.connection.remoteAddress,
                attachments: data.attachments || []
            }, token, socket);

            return sqlResult;
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