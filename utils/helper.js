'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

        // File upload configuration
        this.ALLOWED_IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        this.ALLOWED_DOCUMENT_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt'];
        this.MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB in bytes
        this.DEFAULT_MESSAGE_LIMIT = 20;
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
     * Get file extension
     */
    getFileExtension(filename) {
        return filename.split('.').pop().toLowerCase();
    }

    /**
     * Check if file is an image
     */
    isImageFormat(extension) {
        return this.ALLOWED_IMAGE_TYPES.includes(extension.toLowerCase());
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

            const response = await client.post('/socket/connect', {
                user_id: userId,
                socket_id: userSocketId,
                user_type: userType,
                environment: socket?.environment || 'dev'
            }, { headers });

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

            await client.post('/socket/disconnect', {
                socket_id: userSocketId,
                environment: socket?.environment || 'dev'
            }, { headers });

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

            const response = await client.get('/socket/chat-list', { headers });

            if (response.data && response.data.success) {
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
     * Insert a new message (with file attachments support)
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
                sender_id: params.fromUserId,
                sender_type: params.senderType || 'App\\Models\\User',
                receiver_id: params.toUserId,
                receiver_type: params.receiverType || 'App\\Models\\Company',
                conversation_id: params.conversation_id || null,
                message: params.message,
                date: params.date,
                time: params.time,
                ip: params.ip || null,
                attachments: params.attachments || [],
                environment: socket?.environment || 'dev'
            };

            const response = await client.post('/socket/messages', payload, { headers });

            const insertId = response.data.insertId || response.data.data?.id;

            return {
                success: true,
                insertId: insertId,
                responseData : response.data,
            };
        } catch (error) {
            console.error('insertMessages error:', {
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                params: {
                    ...params,
                    attachments: params.attachments ? `${params.attachments.length} files` : 'none'
                },
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

            await client.put(`/socket/messages/${messageId}/read`, {
                environment: socket?.environment || 'dev'
            }, { headers });

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
     * Get messages between two users with pagination support
     */
    async getMessages(userId, toUserId, token = null, socket = null, limit = null, offset = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            // Build query parameters for pagination
            const params = {};
            if (limit !== null && limit !== undefined) {
                params.limit = limit;
            }
            if (offset !== null && offset !== undefined) {
                params.offset = offset;
            }

            const response = await client.get(`/socket/messages/${userId}/${toUserId}`, {
                headers,
                params
            });

            if (response.data && response.data.success) {
                return {
                    success: true,
                    data: response.data.data || [],
                    pagination: response.data.pagination
                };
            }
            return null;
        } catch (error) {
            console.error('getMessages error:', {
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                userId,
                toUserId,
                limit,
                offset,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Create directory recursively
     */
    async mkdirSyncRecursive(directory) {
        const dir = directory.replace(/\/$/, '').split('/');
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

            const response = await client.post(
                `/socket/conversations/${conversationId}/toggle-favorite`,
                {
                    is_favorite: isFavorite,
                    environment: socket?.environment || 'dev'
                },
                { headers }
            );

            if (response.data && response.data.success) {
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
     * Get conversation media (images and documents)
     */
    async getConversationMedia(conversationId, token = null, socket = null) {
        try {
            if (!token) {
                console.error('getConversationMedia error: Token is required');
                return null;
            }

            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = {
                'Authorization': `Bearer ${token}`
            };

            const response = await client.get(`/socket/conversations/${conversationId}/media`, { headers });

            if (response.data && response.data.success) {
                return {
                    success: true,
                    conversationId: response.data.conversationId,
                    media: response.data.media
                };
            }
            return null;
        } catch (error) {
            console.error('getConversationMedia error:', {
                conversationId,
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Search messages in a conversation
     */
    async searchMessages(conversationId, searchText, userId, token = null, socket = null) {
        try {
            if (!token) {
                console.error('searchMessages error: Token is required');
                return null;
            }

            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = {
                'Authorization': `Bearer ${token}`
            };

            const response = await client.post(
                `/socket/conversations/${conversationId}/search`,
                {
                    search_text: searchText,
                    user_id: userId,
                    environment: socket?.environment || 'dev'
                },
                { headers }
            );

            if (response.data && response.data.success) {
                return {
                    success: true,
                    data: response.data.results || []
                };
            }

            return null;
        } catch (error) {
            console.error('searchMessages error:', {
                conversationId,
                searchText,
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return null;
        }
    }
}

module.exports = new Helper();