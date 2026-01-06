'use strict';

const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Load environment variables
require('dotenv').config();

class Helper{

    constructor(app){
        this.baseUrl = process.env.LARAVEL_API_URL;
        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // Log the API URL being used
        console.log('Laravel API URL:', this.baseUrl);
    }

    /**
     * Add socket ID when user connects
     */
    async addSocketId(userId, userSocketId, userType = 'user', token = null) {
        try {
            // Use provided token or default token
            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            const response = await this.client.post('/socket/connect', {
                user_id: userId,
                socket_id: userSocketId,
                user_type: userType
            }, { headers });

            console.log('Socket connected for user:', userId, 'Type:', userType);
            return response.data ? response.data : null;
        } catch (error) {
            console.error('addSocketId error:', {
                userId,
                socketId: userSocketId,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Logout user and remove socket ID
     */
    async logoutUser(userSocketId, token = null) {
        try {
            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            await this.client.post('/socket/disconnect', {
                socket_id: userSocketId
            }, { headers });

            console.log('User disconnected:', userSocketId);
            return true;
        } catch (error) {
            console.error('logoutUser error:', {
                socketId: userSocketId,
                error: error.response?.data || error.message
            });
            return true; // Return true even on error to prevent blocking
        }
    }

    /**
     * Get chat list for authenticated user based on their role
     */
    async getChatList(token) {
        try {
            if (!token) {
                console.error('getChatList error: Token is required');
                return null;
            }

            const headers = {
                'Authorization': `Bearer ${token}`
            };

            const response = await this.client.get('/socket/chat-list', { headers });

            if (response.data && response.data.success) {
                console.log('Chat list retrieved successfully:', {
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
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Insert a new message
     */
    async insertMessages(params, token = null) {
        try {
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
                ip: params.ip || null
            };

            const response = await this.client.post('/socket/messages', payload, { headers });

            console.log('Message inserted:', {
                from: params.fromUserId,
                to: params.toUserId,
                conversationId: params.conversation_id,
                messageId: response.data.insertId || response.data.data?.id
            });

            return {
                success: true,
                insertId: response.data.insertId || response.data.data?.id
            };
        } catch (error) {
            console.error('insertMessages error:', {
                params,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Mark message as read
     */
    async updateMessagesRead(params, token = null) {
        try {
            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            const messageId = params.id || params.message_id;

            await this.client.put(`/socket/messages/${messageId}/read`, {}, { headers });

            console.log('Message marked as read:', messageId);
            return true;
        } catch (error) {
            console.error('updateMessagesRead error:', {
                messageId: params.id || params.message_id,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    /**
     * Get messages between two users
     */
    async getMessages(userId, toUserId, token = null) {
        try {
            const headers = token ? {
                'Authorization': `Bearer ${token}`
            } : {};

            const response = await this.client.get(`/socket/messages/${userId}/${toUserId}`, { headers });

            if (response.data && response.data.success) {
                console.log('Messages retrieved:', {
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
    async verifyToken(token) {
        try {
            const response = await this.client.get('/user', {
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
            console.error('verifyToken error:', error.response?.data || error.message);
            return { valid: false };
        }
    }

    /**
     * Create directory recursively
     */
    async mkdirSyncRecursive(directory) {
        var dir = directory.replace(/\/$/, '').split('/');
        for (var i = 1; i <= dir.length; i++) {
            var segment = path.basename('uploads') + "/" + dir.slice(0, i).join('/');
            !fs.existsSync(segment) ? fs.mkdirSync(segment) : null;
        }
    }

    /**
     * Handle file upload
     */
    async uploadFile(file, userId) {
        try {
            const uploadDir = path.join(__dirname, '../uploads', userId.toString());

            // Create directory if it doesn't exist
            if (!fs.existsSync(uploadDir)) {
                await this.mkdirSyncRecursive(uploadDir);
            }

            const fileName = `${Date.now()}_${file.name}`;
            const filePath = path.join(uploadDir, fileName);

            // Save file
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