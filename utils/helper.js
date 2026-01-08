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
     * Validate file
     */
    validateFile(file, filename) {
        const errors = [];

        // Check file size
        if (file.length > this.MAX_FILE_SIZE) {
            errors.push(`File "${filename}" exceeds 2MB limit`);
        }

        // Check file format
        const extension = this.getFileExtension(filename).toLowerCase();
        const allowedTypes = [...this.ALLOWED_IMAGE_TYPES, ...this.ALLOWED_DOCUMENT_TYPES];

        if (!allowedTypes.includes(extension)) {
            errors.push(`File "${filename}" has unsupported format (.${extension})`);
        }

        return errors;
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

            console.log(`Inserting message to ${apiUrl}/socket/messages`, {
                hasAttachments: (params.attachments || []).length > 0,
                attachmentCount: (params.attachments || []).length
            });

            const response = await client.post('/socket/messages', payload, { headers });

            const insertId = response.data.insertId || response.data.data?.id;

            console.log(`Message inserted [${socket?.environment || 'dev'}]:`, {
                from: params.fromUserId,
                to: params.toUserId,
                conversationId: params.conversation_id,
                messageId: insertId,
                hasAttachments: (params.attachments || []).length > 0
            });

            return {
                success: true,
                insertId: insertId
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
     * Upload file (legacy method for socket.io upload-image event)
     */
    async uploadFileViaSocket(fileData, fileName, conversationId, messageId, token = null, socket = null) {
        try {
            const client = this.getClient(socket);
            const apiUrl = this.getApiUrl(socket);

            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            // Validate file
            const errors = this.validateFile(fileData, fileName);
            if (errors.length > 0) {
                return {
                    success: false,
                    errors: errors
                };
            }

            // Create form data
            const FormData = require('form-data');
            const form = new FormData();

            form.append('file', fileData, fileName);
            form.append('conversation_id', conversationId);
            form.append('message_id', messageId);

            console.log(`Uploading file to ${apiUrl}/socket/upload-file`);

            const response = await client.post('/socket/upload-file', form, {
                headers: {
                    ...headers,
                    ...form.getHeaders()
                }
            });

            if (response.data && response.data.success) {
                console.log(`File uploaded successfully [${socket?.environment || 'dev'}]:`, {
                    filename: fileName,
                    path: response.data.path
                });

                return {
                    success: true,
                    path: response.data.path,
                    filename: response.data.filename,
                    original_name: response.data.original_name,
                    size: response.data.size,
                    type: response.data.type,
                    extension: response.data.extension
                };
            }

            return {
                success: false,
                message: 'File upload failed'
            };
        } catch (error) {
            console.error('uploadFileViaSocket error:', {
                fileName,
                environment: socket?.environment,
                apiUrl: this.getApiUrl(socket),
                error: error.response?.data || error.message
            });
            return {
                success: false,
                message: error.response?.data?.message || 'File upload failed',
                error: error.message
            };
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

            console.log(`Fetching messages from ${apiUrl}/socket/messages/${userId}/${toUserId}`, {
                limit: params.limit || 'default',
                offset: params.offset || 0
            });

            const response = await client.get(`/socket/messages/${userId}/${toUserId}`, {
                headers,
                params
            });

            if (response.data && response.data.success) {
                console.log(`Messages retrieved [${socket?.environment || 'dev'}]:`, {
                    userId,
                    toUserId,
                    count: response.data.data?.length || 0,
                    pagination: response.data.pagination
                });
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
     * Save uploaded file locally
     */
    async saveFileLocally(fileData, filename, userId) {
        try {
            const uploadDir = path.join(__dirname, '../uploads', userId.toString());

            if (!fs.existsSync(uploadDir)) {
                await this.mkdirSyncRecursive(uploadDir);
            }

            const uniqueFilename = `${Date.now()}_${filename}`;
            const filePath = path.join(uploadDir, uniqueFilename);

            fs.writeFileSync(filePath, fileData);

            return {
                success: true,
                path: `/uploads/${userId}/${uniqueFilename}`,
                filename: uniqueFilename
            };
        } catch (error) {
            console.error('saveFileLocally error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get file info
     */
    getFileInfo(filename) {
        const extension = this.getFileExtension(filename);
        return {
            extension: extension,
            isImage: this.isImageFormat(extension),
            isDocument: this.ALLOWED_DOCUMENT_TYPES.includes(extension),
            isAllowed: [...this.ALLOWED_IMAGE_TYPES, ...this.ALLOWED_DOCUMENT_TYPES].includes(extension)
        };
    }
}

module.exports = new Helper();