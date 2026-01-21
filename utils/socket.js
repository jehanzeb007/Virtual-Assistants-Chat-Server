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

                        this.io.to(socket.id).emit('messageIdUpdate', {
                            tempMessageId: responseInsert.responseData.data.message_id,
                            insertedId: insertId
                        });

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
                        }
                        if (response.message) {
                            const urls = this.extractUrlsFromText(response.message);

                            if (urls.length > 0) {
                                const links = urls.map(url => {
                                    const domain = this.getDomainFromUrl(url);
                                    return {
                                        id: `${insertId}_${require('crypto').createHash('md5').update(url).digest('hex')}`,
                                        message_id: insertId,
                                        url: url,
                                        title: domain || 'Link',
                                        domain: domain,
                                        date: new Date().toISOString()
                                    };
                                });

                                const allUniqueSockets = [...new Set([...senderSocketIds, ...receiverSocketIds])];

                                this.emitToMultipleSockets(this.io, allUniqueSockets, 'newLinksShared', {
                                    conversationId: response.conversation_id,
                                    links: links
                                });
                            }
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

                    } else {
                        this.io.to(socket.id).emit('conversationMediaResponse', {
                            success: false,
                            message: 'Failed to fetch conversation media',
                            conversationId: data.conversationId,
                            media: { images: [], documents: [], total: 0 }
                        });
                    }
                } catch (error) {
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

            /**
             * Edit Message
             */
            socket.on('editMessage', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);

                    const result = await helper.editMessage(
                        data.messageId,
                        data.message,
                        token,
                        socket
                    );

                    if (result && result.success) {
                        const senderSocketIds = result.responseData.senderSocketIds || [];
                        const receiverSocketIds = result.responseData.receiverSocketIds || [];

                        const editedMessage = {
                            id: data.messageId,
                            message: data.message,
                            is_edited: true,
                            edited_at: new Date().toISOString(),
                            conversation_id: data.conversation_id
                        };

                        // Notify all connected sockets (sender and receiver)
                        const allSocketIds = [...new Set([...senderSocketIds, ...receiverSocketIds])];
                        this.emitToMultipleSockets(this.io, allSocketIds, 'messageEdited', editedMessage);

                        // Confirm to sender
                        this.io.to(socket.id).emit('editMessageResponse', {
                            success: true,
                            messageId: data.messageId
                        });
                    } else {
                        this.io.to(socket.id).emit('editMessageResponse', {
                            success: false,
                            error: 'Failed to edit message'
                        });
                    }
                } catch (error) {
                    console.error('editMessage event error:', error);
                    this.io.to(socket.id).emit('editMessageResponse', {
                        success: false,
                        error: 'Failed to edit message'
                    });
                }
            });

            /**
             * Create Reply
             */
            socket.on('createReply', async (response) => {
                try {
                    response.date = moment().format("YYYY-MM-DD");
                    response.time = moment().format("hh:mm A");

                    const token = this.userTokens.get(socket.id);

                    const responseInsert = await helper.createReply(response, socket, token);
                    const insertId = responseInsert?.insertId;

                    if (insertId) {
                        response.id = insertId;

                        // ADD: Include reply_snapshot from the response
                        if (responseInsert.responseData?.data) {
                            response.reply_snapshot = responseInsert.responseData.data.reply_snapshot;
                            response.reply_to_message_id = responseInsert.responseData.data.reply_to_message_id;
                        }

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

                        this.io.to(socket.id).emit('messageSent', {
                            tempId: response.tempId || response.id,
                            id: insertId,
                            success: true,
                            conversation_id: response.conversation_id
                        });
                    } else {
                        this.io.to(socket.id).emit('messageSent', {
                            tempId: response.tempId || response.id,
                            success: false,
                            error: 'Failed to create reply'
                        });
                    }
                } catch (error) {
                    console.error('createReply event error:', error);
                    this.io.to(socket.id).emit('messageSent', {
                        tempId: response.tempId || response.id,
                        success: false,
                        error: 'Failed to create reply'
                    });
                }
            });

            socket.on('searchMessages', async (data) => {
                try {
                    const token = this.userTokens.get(socket.id);

                    if (!token) {
                        this.io.to(socket.id).emit('searchMessagesResponse', {
                            success: false,
                            message: 'Authentication required',
                            results: []
                        });
                        return;
                    }

                    const result = await helper.searchMessages(
                        data.conversation_id,
                        data.search_text,
                        data.user_id,
                        token,
                        socket
                    );

                    if (result && result.success) {
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

                } catch (error) {
                    console.error('disconnect event error:', error);
                }
            });
        });
    }

    emitToMultipleSockets(io, socketIds, eventName, data){
        if (!socketIds || socketIds.length === 0) {
            return;
        }
        try {
            socketIds.forEach(socketId => {
                io.to(socketId).emit(eventName, data);
            });
        } catch (error) {
            console.log(error);
        }
    }

    extractUrlsFromText(text) {
        if (!text) return [];

        const urls = [];

        const patternWithProtocol = /\b(https?:\/\/[^\s<>"']+)/gi;
        const matchesWithProtocol = text.match(patternWithProtocol);

        if (matchesWithProtocol) {
            matchesWithProtocol.forEach(url => {
                const cleanUrl = url.replace(/[.,;:!?]+$/, '');
                urls.push(cleanUrl);
            });
        }

        const patternWithoutProtocol = /(?<![\/\w])((?:www\.)[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?:\/[^\s<>"']*)?)/gi;
        const matchesWithoutProtocol = text.match(patternWithoutProtocol);

        if (matchesWithoutProtocol) {
            matchesWithoutProtocol.forEach(url => {
                const cleanUrl = url.replace(/[.,;:!?]+$/, '');
                urls.push('https://' + cleanUrl);
            });
        }

        return [...new Set(urls)];
    }

    getDomainFromUrl(url) {
        try {
            const parsedUrl = new URL(url);
            const host = parsedUrl.hostname;
            return host.replace(/^www\./, '');
        } catch (error) {
            return '';
        }
    }

    async insertMessage(data, socket, token) {
        try {
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

                if (!userId || !token) {
                    return next(new Error('Authentication error'));
                }

                let userSocketId = socket.id;
                const response = await helper.addSocketId(userId, userSocketId, userType, token, socket);

                if (response && response !== null) {
                    next();
                } else {
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