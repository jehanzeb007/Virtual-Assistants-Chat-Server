'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const socketio = require('socket.io');
const socketEvents = require('./utils/socket');
require('dotenv').config();

class Server {
    constructor() {
        this.env  = process.env.NODE_ENV || 'dev';
        this.host = process.env.HOST || '127.0.0.1';
        this.port = process.env.PORT || 3001;

        // API URLs for different environments
        this.apiUrls = {
            dev: process.env.DEV_API_URL || 'https://dev.virtualassistants.help/api',
            devLocal: process.env.DEV_LOCAL_API_URL || process.env.LOCAL_API_URL || '',
            stage: process.env.STAGE_API_URL || 'https://stage.virtualassistants.help/api',
            production: process.env.PRODUCTION_API_URL || 'https://virtualassistants.help/api',
            productionMarket: process.env.PRODUCTION_API_URL_MARKET || 'https://virtualassistant.market/api'
        };

        this.app = express();
        this.server = null;
        this.io = null;
        this.socketHandler = null;

        // Track connections by environment
        this.environmentStats = {
            dev: { connections: 0, users: new Set() },
            stage: { connections: 0, users: new Set() },
            production: { connections: 0, users: new Set() }
        };

        // SSL options for HTTPS
        this.sslOptions = this.loadSSLCertificates();
    }

    /**
     * Load SSL certificates if available
     */
    loadSSLCertificates() {
        const certPath = '/etc/letsencrypt/live/virtualassistants.help';
        const keyPath = `${certPath}/privkey.pem`;
        const certFullPath = `${certPath}/fullchain.pem`;

        if (fs.existsSync(keyPath) && fs.existsSync(certFullPath)) {
            console.log('SSL certificates found - HTTPS enabled');
            return {
                key: fs.readFileSync(keyPath),
                cert: fs.readFileSync(certFullPath)
            };
        }

        console.log('SSL certificates not found - HTTP only');
        return null;
    }

    /**
     * Setup express middleware and routes
     */
    setupExpress() {
        // Static file serving
        this.app.use('/uploads', express.static(__dirname + '/uploads'));
        this.app.use(express.json());

        // ─── Laravel pushes messages to this endpoint ───────────────────────
        this.app.post('/emit-message', (req, res) => {
            try {
                const payload    = req.body;
                const toUserId   = String(payload.toUserId);
                const fromUserId = String(payload.fromUserId);
                const event      = payload.event || 'addMessageResponse';

                console.log(`/emit-message → event: ${event}, from: ${fromUserId}, to: ${toUserId}`);

                const receiverSockets = this.socketHandler?.userSockets?.get(toUserId);
                const senderSockets   = this.socketHandler?.userSockets?.get(fromUserId);

                [receiverSockets, senderSockets].forEach(socketSet => {
                    if (socketSet && socketSet.size > 0) {
                        socketSet.forEach(socketId => {
                            this.io.to(socketId).emit(event, payload);
                        });
                    }
                });

                res.json({ success: true });
            } catch (error) {
                console.error('/emit-message error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });
        // ────────────────────────────────────────────────────────────────────
    }

    detectEnvironment(socket) {
        const origin = socket.handshake.headers.origin ||
            socket.handshake.headers.referer ||
            '';

        const host = socket.handshake.headers.host || '';

        // Check query parameter first (highest priority)
        if (socket.handshake.query.environment) {
            return socket.handshake.query.environment;
        }

        // Check localhost/127.0.0.1 (development)
        if (origin.includes('localhost') || origin.includes('127.0.0.1') ||
            host.includes('localhost') || host.includes('127.0.0.1')) {
            return 'dev';
        }

        // Check dev subdomain
        if (origin.includes('dev.virtualassistants.help') ||
            host.includes('dev.virtualassistants.help')) {
            return 'dev';
        }

        // Check stage subdomain
        if (origin.includes('stage.virtualassistants.help') ||
            host.includes('stage.virtualassistants.help')) {
            return 'stage';
        }

        // Check production (must be after dev/stage checks)
        if (origin.includes('virtualassistants.help') ||
            host.includes('virtualassistants.help') ||
            origin.includes('virtualassistant.market') ||
            host.includes('virtualassistant.market')) {
            return 'production';
        }

        // Default to dev for local development
        return 'dev';
    }

    /**
     * Select production API URL based on client domain
     */
    getProductionApiUrl(socket) {
        const origin = socket.handshake.headers.origin ||
            socket.handshake.headers.referer ||
            '';
        const host = socket.handshake.headers.host || '';

        if (origin.includes('virtualassistant.market') || host.includes('virtualassistant.market')) {
            return this.apiUrls.productionMarket;
        }

        return this.apiUrls.production;
    }

    /**
     * Select dev API URL based on client domain
     */
    getDevApiUrl(socket) {
        const origin = socket.handshake.headers.origin ||
            socket.handshake.headers.referer ||
            '';
        const host = socket.handshake.headers.host || '';

        const isLocalDev = origin.includes('localhost') ||
            origin.includes('127.0.0.1') ||
            host.includes('localhost') ||
            host.includes('127.0.0.1');

        if (isLocalDev && this.apiUrls.devLocal) {
            return this.apiUrls.devLocal;
        }

        return this.apiUrls.dev;
    }

    /**
     * Setup Socket.IO with environment awareness
     */
    setupSocketIO() {
        // Configure Socket.IO with CORS for all environments
        this.io = socketio(this.server, {
            cors: {
                origin: [
                    'http://localhost',
                    'http://127.0.0.1',
                    'http://localhost:8080',
                    'http://localhost:3000',
                    'http://127.0.0.1:8080',
                    'http://127.0.0.1:3000',
                    'https://dev.virtualassistants.help',
                    'https://stage.virtualassistants.help',
                    'https://virtualassistants.help',
                    'https://virtualassistant.market'
                ],
                methods: ['GET', 'POST'],
                credentials: true,
                allowedHeaders: ['*']
            },
            transports: ['websocket', 'polling'],
            allowEIO3: true
        });

        // Middleware to detect environment from connection
        this.io.use((socket, next) => {
            // Detect environment
            const environment = this.detectEnvironment(socket);
            const apiUrl = environment === 'production'
                ? this.getProductionApiUrl(socket)
                : environment === 'dev'
                    ? this.getDevApiUrl(socket)
                    : this.apiUrls[environment];

            // Store in socket instance
            socket.environment = environment;
            socket.apiUrl = apiUrl;

            const origin = socket.handshake.headers.origin ||
                socket.handshake.headers.referer ||
                'unknown';

            console.log('═══════════════════════════════════════════════════════');
            console.log(' NEW SOCKET CONNECTION');
            console.log(`   Environment: ${environment.toUpperCase()}`);
            console.log(`   Origin: ${origin}`);
            console.log(`   API URL: ${apiUrl}`);
            console.log(`   Socket ID: ${socket.id}`);
            console.log('═══════════════════════════════════════════════════════');

            next();
        });

        // Track connections by environment
        this.io.on('connection', (socket) => {
            const env = socket.environment || 'production';
            const userId = socket.handshake.query.id;

            // Update stats
            this.environmentStats[env].connections++;
            if (userId) {
                this.environmentStats[env].users.add(userId);
            }

            console.log(`User ${userId} connected to ${env.toUpperCase()} environment`);
            console.log(`Current ${env} connections: ${this.environmentStats[env].connections}`);
            console.log(`API URL: ${socket.apiUrl}`);

            // Handle disconnect
            socket.on('disconnect', () => {
                this.environmentStats[env].connections--;
                if (userId) {
                    this.environmentStats[env].users.delete(userId);
                }
                console.log(`User ${userId} disconnected from ${env.toUpperCase()}`);
                console.log(`Current ${env} connections: ${this.environmentStats[env].connections}`);
            });
        });

        // ─── Store handler reference so /emit-message can access userSockets ─
        this.socketHandler = new socketEvents(this.io, this.apiUrls);
        this.socketHandler.socketConfig();
        // ─────────────────────────────────────────────────────────────────────
    }

    /**
     * Start the unified server
     */
    start() {
        console.log('═══════════════════════════════════════════════════════');
        console.log('MULTI-ENVIRONMENT SOCKET SERVER');
        console.log('═══════════════════════════════════════════════════════');
        console.log(`   Node Environment: ${this.env}`);
        console.log(`   Port: ${this.port}`);
        console.log(`   Host: ${this.host}`);

        // Setup Express
        this.setupExpress();

        // Create server (HTTPS if certificates available, otherwise HTTP)
        if (this.sslOptions) {
            this.server = https.createServer(this.sslOptions, this.app);
            console.log('Protocol: HTTPS');
        } else {
            this.server = http.createServer(this.app);
            console.log('Protocol: HTTP');
        }

        // Setup Socket.IO
        this.setupSocketIO();

        // Start listening
        this.server.listen(this.port, this.host, () => {
            const protocol = this.sslOptions ? 'https' : 'http';
            const displayHost = this.host === '0.0.0.0' ? 'localhost' : this.host;

            console.log('═══════════════════════════════════════════════════════');
            console.log(`Server running on ${protocol}://${displayHost}:${this.port}`);
            console.log('═══════════════════════════════════════════════════════');
            console.log('Supported Environments:');
            console.log(`   • DEV             → ${this.apiUrls.dev}`);
            console.log(`   • DEV (localhost) → ${this.apiUrls.devLocal || this.apiUrls.dev}`);
            console.log(`   • STAGE           → ${this.apiUrls.stage}`);
            console.log(`   • PRODUCTION      → ${this.apiUrls.production}`);
            console.log(`   • PRODUCTION MKT  → ${this.apiUrls.productionMarket}`);
            console.log('═══════════════════════════════════════════════════════');
        });

        // Error handling
        this.server.on('error', (error) => {
            console.error('Server error:', error.message);
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${this.port} is already in use!`);
                process.exit(1);
            }
        });

        // Graceful shutdown
        this.setupGracefulShutdown();
    }

    /**
     * Setup graceful shutdown
     */
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            console.log(`\n ${signal} received. Shutting down gracefully...`);

            // Close socket connections
            if (this.io) {
                console.log('   Closing socket connections...');
                this.io.close();
            }

            // Close HTTP/HTTPS server
            if (this.server) {
                this.server.close(() => {
                    console.log(' Server shut down gracefully');
                    process.exit(0);
                });

                // Force close after 10 seconds
                setTimeout(() => {
                    console.error('  Forcing shutdown after timeout');
                    process.exit(1);
                }, 10000);
            }
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('uncaughtException', (err) => {
            console.error(' Uncaught Exception:', err);
            shutdown('UNCAUGHT_EXCEPTION');
        });
        process.on('unhandledRejection', (reason, promise) => {
            console.error(' Unhandled Rejection at:', promise, 'reason:', reason);
        });
    }
}

// ═══════════════════════════════════════════════════════
// START THE SERVER
// ═══════════════════════════════════════════════════════

const server = new Server();
server.start();

module.exports = Server;
