'use strict';

const axios = require('axios');

// Load environment variables
require('dotenv').config();

class Helper {
    constructor() {
        // API URLs for different environments
        this.apiUrls = {
            dev: process.env.DEV_API_URL || 'https://dev.virtualassistants.help/api',
            stage: process.env.STAGE_API_URL || 'https://stage.virtualassistants.help/api',
            production: process.env.PRODUCTION_API_URL || 'https://virtualassistants.help/api'
        };

        console.log('Helper initialized with API URLs:', this.apiUrls);
    }

    /**
     * Get the appropriate API URL based on socket environment
     */
    getApiUrl(socket) {
        if (socket && socket.apiUrl) {
            return socket.apiUrl;
        }

        if (socket && socket.environment) {
            return this.apiUrls[socket.environment] || this.apiUrls.dev;
        }

        return this.apiUrls.dev;
    }

    /**
     * Get axios client based on socket's API URL
     */
    getClient(socket) {
        const apiUrl = this.getApiUrl(socket);

        return axios.create({
            baseURL: apiUrl,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
    }

    /**
     * Add socket ID when user connects
     */
    async addSocketId(userId, userSocketId, userType = 'user', token = null, socket = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            console.log(`Connecting user ${userId} to ${apiUrl}/socket/connect`);

            const response = await client.post('/socket/connect', {
                user_id: userId,
                socket_id: userSocketId,
                user_type: userType,
                environment: socket?.environment || 'dev'
            }, { headers });

            console.log(`Socket connected for user ${userId} (${userType}) [${socket?.environment || 'dev'}]`);
            return response.data ? response.data : null;
        } catch (error) {
            console.error('addSocketId error:', {
                userId,
                socketId: userSocketId,
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Logout user and remove socket ID
     */
    async logoutUser(userSocketId, token = null, socket = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            console.log(`Disconnecting socket ${userSocketId} from ${apiUrl}/socket/disconnect`);

            await client.post('/socket/disconnect', {
                socket_id: userSocketId,
                environment: socket?.environment || 'dev'
            }, { headers });

            console.log(`User disconnected [${socket?.environment || 'dev'}]:`, userSocketId);
            return true;
        } catch (error) {
            console.error('logoutUser error:', {
                socketId: userSocketId,
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return true;
        }
    }

    /**
     * Get chat list for authenticated user based on their role
     */
    async getChatList(token, socket = null) {
        try {
            if (!token) {
                console.error('getChatList error: Token is required');
                return null;
            }

            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = {
                'Authorization': `Bearer ${token}`
            };

            console.log(`Fetching chat list from ${apiUrl}/socket/chat-list`);

            const response = await client.get('/socket/chat-list', { headers });

            if (response.data && response.data.success) {
                console.log(`Chat list retrieved [${socket?.environment || 'dev'}]:`, {
                    role: response.data.role,
                    count: response.data.chatlist?.length || 0
                });
                return {
                    success: true,
                    role: response.data.role,
                    chatlist: response.data.chatlist || []
                };
            }
            return null;
        } catch (error) {
            console.error('getChatList error:', {
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Insert a new message
     */
    async insertMessages(params, token = null, socket = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            const payload = {
                message_id: params.message_id,
                type: params.type || 'text',
                file_format: params.fileFormat || null,
                file_path: params.filePath || null,
                sender_id: params.fromUserId,
                sender_type: params.senderType || 'App\\Models\\User',
                receiver_id: params.toUserId,
                receiver_type: params.receiverType || 'App\\Models\\Company',
                conversation_id: params.conversation_id || null,
                message: params.message,
                date: params.date,
                time: params.time,
                ip: params.ip || null,
                environment: socket?.environment || 'dev'
            };

            console.log(`Inserting message to ${apiUrl}/socket/messages`);

            const response = await client.post('/socket/messages', payload, { headers });

            const insertId = response.data.insertId || response.data.data?.id;

            console.log(`Message inserted [${socket?.environment || 'dev'}]:`, {
                from: params.fromUserId,
                to: params.toUserId,
                conversationId: params.conversation_id,
                messageId: insertId
            });

            return {
                success: true,
                insertId: insertId
            };
        } catch (error) {
            console.error('insertMessages error:', {
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                params,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Mark message as read
     */
    async updateMessagesRead(params, token = null, socket = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            const messageId = params.id || params.message_id;

            console.log(`Marking message as read in ${apiUrl}/socket/messages/${messageId}/read`);

            await client.put(`/socket/messages/${messageId}/read`, {
                environment: socket?.environment || 'dev'
            }, { headers });

            console.log(`Message marked as read [${socket?.environment || 'dev'}]:`, messageId);
            return true;
        } catch (error) {
            console.error('updateMessagesRead error:', {
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                messageId: params.id || params.message_id,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Get messages between two users
     */
    async getMessages(userId, toUserId, token = null, socket = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            console.log(`Fetching messages from ${apiUrl}/socket/messages/${userId}/${toUserId}`);

            const response = await client.get(`/socket/messages/${userId}/${toUserId}`, { headers });

            if (response.data && response.data.success) {
                console.log(`Messages retrieved [${socket?.environment || 'dev'}]:`, {
                    userId,
                    toUserId,
                    count: response.data.data?.length || 0
                });
                return {
                    success: true,
                    data: response.data.data || []
                };
            }
            return null;
        } catch (error) {
            console.error('getMessages error:', {
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                userId,
                toUserId,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Verify user token and get user details
     */
    async verifyToken(token, socket = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            console.log(`Verifying token at ${apiUrl}/user`);

            const response = await client.get('/user', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.data && response.data.user) {
                return {
                    valid: true,
                    user: response.data.user
                };
            }
            return { valid: false };
        } catch (error) {
            console.error('verifyToken error:', {
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return { valid: false };
        }
    }

    /**
     * Create directory recursively
     */
    async mkdirSyncRecursive(directory) {
        const fs = require('fs');
        const path = require('path');

        var dir = directory.replace(/\/$/, '').split('/');
        for (var i = 1; i <= dir.length; i++) {
            var segment = path.basename('uploads') + "/" + dir.slice(0, i).join('/');
            !fs.existsSync(segment) ? fs.mkdirSync(segment) : null;
        }
    }

    /**
     * Toggle favorite status for a conversation
     */
    async toggleFavorite(conversationId, isFavorite, token = null, socket = null) {
        try {
            if (!token) {
                console.error('toggleFavorite error: Token is required');
                return null;
            }

            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = {
                'Authorization': `Bearer ${token}`
            };

            console.log(`Toggling favorite at ${apiUrl}/socket/conversations/${conversationId}/toggle-favorite`);

            const response = await client.post(
                `/socket/conversations/${conversationId}/toggle-favorite`,
                {
                    is_favorite: isFavorite,
                    environment: socket?.environment || 'dev'
                },
                { headers }
            );

            if (response.data && response.data.success) {
                console.log(`Favorite toggled [${socket?.environment || 'dev'}]:`, {
                    conversationId,
                    isFavorite: response.data.is_favorite
                });
                return {
                    success: true,
                    is_favorite: response.data.is_favorite
                };
            }
            return null;
        } catch (error) {
            console.error('toggleFavorite error:', {
                conversationId,
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return null;
        }
    }
    /**
     * Handle file upload
     */
    async uploadFile(file, userId) {
        const fs = require('fs');
        const path = require('path');

        try {
            const uploadDir = path.join(__dirname, '../uploads', userId.toString());

            if (!fs.existsSync(uploadDir)) {
                await this.mkdirSyncRecursive(uploadDir);
            }

            const fileName = `${Date.now()}_${file.name}`;
            const filePath = path.join(uploadDir, fileName);

            fs.writeFileSync(filePath, file.data);

            return {
                success: true,
                path: `/uploads/${userId}/${fileName}`,
                fileName: fileName
            };
        } catch (error) {
            console.error('uploadFile error:', error);
            return null;
        }
    }

    /**
     * Get file extension
     */
    getFileExtension(filename) {
        const path = require('path');
        return path.extname(filename).toLowerCase().replace('.', '');
    }

    /**
     * Validate file type
     */
    isValidFileType(filename, allowedTypes = ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'doc', 'docx']) {
        const ext = this.getFileExtension(filename);
        return allowedTypes.includes(ext);
    }
}

module.exports = new Helper();