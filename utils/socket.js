'use strict';

const moment = require('moment');
const path = require('path');
const fs = require('fs');
const helper = require('./helper');

class Socket{

    constructor(socket){
        this.io = socket;
        // Store user tokens in memory
        this.userTokens = new Map();
    }

    socketEvents(){
        this.io.on('connection', (socket) => {

            // Store token for this socket connection
            const token = socket.handshake.query.token;
            const userId = socket.handshake.query.id;

            if (token && userId) {
                this.userTokens.set(socket.id, token);
                console.log(`Token stored for socket ${socket.id}, user ${userId}`);
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
                        // Emit to the requesting user
                        this.io.to(socket.id).emit('chatListRes', {
                            userConnected: false,
                            role: result.role,
                            chatList: result.chatlist
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
             * Send message
             */
            socket.on('sendMessage', async (response) => {
                try {
                    response.date = moment().format("YYYY-MM-DD");
                    response.time = moment().format("hh:mm A");

                    const token = this.userTokens.get(socket.id);
                    const insertId = await this.insertMessage(response, socket, token);

                    if (insertId) {
                        response.id = insertId;
                        // Send to receiver
                        socket.to(response.toSocketId).emit('addMessageResponse', response);

                        // Confirm to sender
                        this.io.to(socket.id).emit('messageSent', {
                            tempId: response.tempId,
                            id: insertId,
                            success: true
                        });
                    }
                } catch (error) {
                    console.error('sendMessage event error:', error);
                    this.io.to(socket.id).emit('messageSent', {
                        tempId: response.tempId,
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
            socket.on('typing', function (data) {
                socket.to(data.socket_id).emit('typing', {
                    typing: data.typing,
                    to_socket_id: socket.id
                });
            });

            /**
             * Upload image
             */
            socket.on('upload-image', async (response) => {
                try {
                    let dir = moment().format("D-M-YYYY") + "/" + moment().format('x') + "/" + response.fromUserId;
                    await helper.mkdirSyncRecursive(dir);

                    let filepath = dir + "/" + response.fileName;
                    var writer = fs.createWriteStream(path.basename('uploads') + "/" + filepath, { encoding: 'base64'});

                    writer.write(response.message);
                    writer.end();

                    writer.on('finish', async function () {
                        response.message = response.fileName;
                        response.filePath = filepath;
                        response.date = moment().format("YYYY-MM-DD");
                        response.time = moment().format("hh:mm A");

                        const token = this.userTokens.get(socket.id);
                        const insertId = await this.insertMessage(response, socket, token);

                        response.id = insertId;
                        socket.to(response.toSocketId).emit('addMessageResponse', response);
                        socket.emit('image-uploaded', response);
                    }.bind(this));
                } catch (error) {
                    console.error('upload-image event error:', error);
                    socket.emit('image-upload-error', {
                        error: 'Failed to upload image'
                    });
                }
            });

            /**
             * Disconnect
             */
            socket.on('disconnect', async () => {
                try {
                    const token = this.userTokens.get(socket.id);
                    await helper.logoutUser(socket.id, token);

                    // Remove token from memory
                    this.userTokens.delete(socket.id);

                    socket.broadcast.emit('chatListRes', {
                        userDisconnected: true,
                        socket_id: socket.id
                    });

                    console.log(`User disconnected: ${socket.id}`);
                } catch (error) {
                    console.error('disconnect event error:', error);
                }
            });
        });
    }

    async insertMessage(data, socket, token){
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

    async updateMessageRead(data, socket, token){
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

    socketConfig(){
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
                    console.log(`Socket authenticated for user ${userId}`);
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