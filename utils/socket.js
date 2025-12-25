'use strict';

const moment = require('moment');
const path = require('path');
const fs = require('fs');
const helper = require('./helper');
const orderRoomPrefix = 'order_updates_';
class Socket {

    // socket.emit('event_name', data); => Sends a message back to the client that originally emitted the event:
    // socket.broadcast.emit('event_name', data); => Broadcast to All Clients Except the Sender Sends the message to all connected clients except the one that triggered the event:
    // this.io.emit('event_name', data); => Emit to All Connected Clients This emits an event to all connected clients, including the sender:
    // this.io.to('room_name').emit('event_name', data); => Sends an event to all sockets in a particular room:
    // this.io.of('/namespace').emit('event_name', data); => If using namespaces, you can emit to all clients connected to a specific namespace:
    // this.io.to(socket_id).emit('event_name', data); => To send a message to a specific socket by its unique ID:
    // socket.to('room_name').emit('event_name', data); => Broadcast Within a Room (Excluding Sender) Emits an event to all clients in a specific room except the sender:
    // socket.volatile.emit('event_name', data); => Emit with volatile (Low Priority) Emits an event but doesn’t guarantee delivery (helpful for non-essential events):

    constructor(socket) {
        this.io = socket;
    }

    socketEvents() {
        this.io.on('connection', (socket) => {

            socket.on('joinOrderRoom', (order_id) => {
                const roomName = orderRoomPrefix+order_id;
                socket.join(roomName);
                console.log(`Client joined room: ${roomName}`);
            });

            /**
            * Get Chat Listing
            */
            socket.on('get_chat_listing', async (data) => {
                //const orders_response = await helper.getDriversOrders(data);
                console.log('event called')
            });

            socket.on('disconnect', async () => {
                console.log('disconnect:'+socket.id);
                await helper.logoutUser(socket.id);
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

    socketConfig() {
        this.io.use(async (socket, next) => {
            let userId = socket.request._query['user_id'];
            let userToken = socket.request._query['token'];
            let envoirement = socket.request._query['envoirement'];
            let userSocketId = socket.id;

            console.log('userId:'+userId+'====> socket Id:'+userSocketId+'====> Token:'+userToken+'====> envoirement:'+envoirement);

            let response = true;
            if(userToken != 'web-access'){
                response = await helper.addSocketId(userId, userSocketId, userToken);
                console.log('user auth',response);
            }

            if (response && response !== null) {
                console.log(`Socket connected  user Id ${userId}.`);
                next();
            } else {
                console.error(`Socket connection failed, for  user Id ${userId}.`);
            }
        });
        this.socketEvents();
    }
}
module.exports = Socket;
