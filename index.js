'use strict';

const express = require('express');
//const http = require('http');
const https = require('https');
const fs = require('fs');
const socketio = require('socket.io');
const socketEvents = require('./utils/socket');

class Server {
    constructor() {

        this.port = process.env.PORT || 3000;
        this.host = process.env.HOST || `localhost`;

        this.app = express();


        const sslOptions = {
            key: fs.readFileSync('/etc/letsencrypt/live/virtualassistants.help/privkey.pem'),
            cert: fs.readFileSync('/etc/letsencrypt/live/virtualassistants.help/fullchain.pem'), // Use fullchain.pem for the complete certificate
        };
        this.http = https.Server(sslOptions, this.app);




        //this.http = https.Server(this.app);
        this.socket = socketio(this.http);
        this.setupRoutes();
    }
    setupRoutes() {

        this.app.use(express.json()); // Add this middleware at the beginning

        this.app.post('/test', (req, res) => {
            const { orderId,socketIds, order } = req.body; // Extract parameters from the request body
            res.send(`Socket event sent for order ${orderId}`);
        });
    }
    appRun(){
        new socketEvents(this.socket).socketConfig();
        this.app.use(express.static(__dirname + '/uploads'));
        this.http.listen(this.port, this.host, () => {
            console.log(`Listening on https://${this.host}:${this.port}`);
    });
    }
}

const app = new Server();
app.appRun();
