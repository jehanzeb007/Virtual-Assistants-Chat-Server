'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const socketio = require('socket.io');
const socketEvents = require('./utils/socket');

class Server {
    constructor() {
        this.env  = process.env.NODE_ENV || 'dev';
        this.host = process.env.HOST || '127.0.0.1';
        this.port = process.env.PORT || 3001;

        this.app = express();
        this.server = null;
        this.io = null;
    }

    appRun() {
        // =========================
        // DEV / LOCAL → HTTP ONLY
        // =========================
        if (this.env !== 'production') {
            this.server = http.createServer(this.app);

            this.io = socketio(this.server, {
                cors: { origin: "*" }
            });

            this.server.listen(this.port, this.host, () => {
                console.log(`DEV HTTP → http://${this.host}:${this.port}`);
            });
        }

        // =========================
        // PRODUCTION → HTTPS ONLY
        // =========================
        if (this.env === 'production') {
            this.server = https.createServer({
                key: fs.readFileSync('/etc/letsencrypt/live/virtualassistants.help/privkey.pem'),
                cert: fs.readFileSync('/etc/letsencrypt/live/virtualassistants.help/fullchain.pem'),
            }, this.app);

            this.io = socketio(this.server, {
                cors: { origin: "*" }
            });

            this.server.listen(this.port, this.host, () => {
                console.log(`PROD HTTPS → https://${this.host}:${this.port}`);
            });
        }

        new socketEvents(this.io).socketConfig();
        this.app.use(express.static(__dirname + '/uploads'));
    }
}

const app = new Server();
app.appRun();
