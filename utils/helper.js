'user strict';

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

    async addSocketId(userId, userSocketId){
        try {
            const response = await this.client.post('/socket/connect', {
                user_id: userId,
                socket_id: userSocketId,
                user_type: 'user'
            });
            return response.data ? true : null;
        } catch (error) {
            console.log('addSocketId error:', error.response?.data || error.message);
            return null;
        }
    }

    async logoutUser(userSocketId){
        try {
            await this.client.post('/socket/disconnect', {
                socket_id: userSocketId
            });
            return true;
        } catch (error) {
            console.error('logoutUser error:', error.response?.data || error.message);
            return true;
        }
    }

    getChatList(userId){
        try {
            return this.client.get(`/socket/chat-list/${userId}`)
                .then((response) => {
                    if (response.data && response.data.success) {
                        return {
                            chatlist: response.data.chatlist
                        };
                    }
                    return null;
                })
                .catch((error) => {
                    console.warn('getChatList error:', error.response?.data || error.message);
                    return null;
                });
        } catch (error) {
            console.warn('getChatList error:', error);
            return null;
        }
    }

    async insertMessages(params){
        try {
            const response = await this.client.post('/socket/messages', {
                message_id: params.message_id,
                type: params.type,
                file_format: params.fileFormat,
                file_path: params.filePath,
                sender_id: params.fromUserId,
                sender_type: params.senderType || 'user',
                receiver_id: params.toUserId,
                receiver_type: params.receiverType || 'user',
                conversation_id: params.conversation_id || 1,
                message: params.message,
                date: params.date,
                time: params.time,
                ip: params.ip
            });

            return { insertId: response.data.insertId };
        } catch (error) {
            console.warn('insertMessages error:', error.response?.data || error.message);
            return null;
        }
    }

    async updateMessagesRead(params){
        try {
            await this.client.put(`/socket/messages/${params.id}/read`);
            return true;
        } catch (error) {
            console.warn('updateMessagesRead error:', error.response?.data || error.message);
            return null;
        }
    }

    async getMessages(userId, toUserId){
        try {
            const response = await this.client.get(`/socket/messages/${userId}/${toUserId}`);

            if (response.data && response.data.success) {
                return response.data.data;
            }
            return null;
        } catch (error) {
            console.warn('getMessages error:', error.response?.data || error.message);
            return null;
        }
    }

    async mkdirSyncRecursive(directory){
        var dir = directory.replace(/\/$/, '').split('/');
        for (var i = 1; i <= dir.length; i++) {
            var segment = path.basename('uploads') + "/" + dir.slice(0, i).join('/');
            !fs.existsSync(segment) ? fs.mkdirSync(segment) : null ;
        }
    }
}

module.exports = new Helper();