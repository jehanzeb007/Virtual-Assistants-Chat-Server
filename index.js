'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const socketio = require('socket.io');
const socketEvents = require('./utils/socket');

class Server {
    constructor() {
        this.httpPort = 3000;   // HTTP
        this.httpsPort = 3001;  // HTTPS
        this.host = '0.0.0.0';

        this.app = express();

        // HTTP server
        this.httpServer = http.createServer(this.app);

        // HTTPS server (dev.teamery.net SSL)
        this.httpsServer = https.createServer({
            key: fs.readFileSync('/etc/letsencrypt/live/dev.teamery.net/privkey.pem'),
            cert: fs.readFileSync('/etc/letsencrypt/live/dev.teamery.net/fullchain.pem'),
        }, this.app);

        // Socket.IO over HTTPS (recommended)
        this.io = socketio(this.httpsServer, {
            cors: {
                origin: "*",
            }
        });
    }

    appRun() {
        new socketEvents(this.io).socketConfig();

        this.app.use(express.static(__dirname + '/uploads'));

        this.httpServer.listen(this.httpPort, this.host, () => {
            console.log(`HTTP listening on http://${this.host}:${this.httpPort}`);
        });

        this.httpsServer.listen(this.httpsPort, this.host, () => {
            console.log(`HTTPS listening on https://${this.host}:${this.httpsPort}`);
        });
    }
}

const app = new Server();
app.appRun();
