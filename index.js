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

        this.environmentStats = {
            dev: { connections: 0, users: new Set() },
            stage: { connections: 0, users: new Set() },
            production: { connections: 0, users: new Set() }
        };

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
                const toUserId   = String(payload.toUserId   ?? '');
                const fromUserId = String(payload.fromUserId ?? '');
                const event      = payload.event || 'addMessageResponse';

                console.log('═══════ /emit-message received ═══════');
                console.log('Event:', event);
                console.log('From:', fromUserId, '→ To:', toUserId);
                console.log('Conversation ID:', payload.conversation_id);

                // Guard: socketHandler must be ready
                if (!this.socketHandler || !this.socketHandler.userSockets) {
                    console.error('/emit-message: socketHandler.userSockets not available');
                    return res.status(500).json({ success: false, error: 'Socket handler not ready' });
                }

                const userSockets = this.socketHandler.userSockets;
                console.log('Connected users:', [...userSockets.keys()]);

                // ── Resolve socket ID sets ─────────────────────────────────
                // Mirrors senderSocketIds / receiverSocketIds from sendMessage event
                const senderSocketSet   = userSockets.get(fromUserId);
                const receiverSocketSet = userSockets.get(toUserId);

                const senderSocketIds   = senderSocketSet   ? [...senderSocketSet]   : [];
                const receiverSocketIds = receiverSocketSet ? [...receiverSocketSet] : [];

                console.log('Sender sockets found:',   senderSocketIds.length   ? senderSocketIds   : 'NONE');
                console.log('Receiver sockets found:',  receiverSocketIds.length ? receiverSocketIds : 'NONE');

                // ── Deduplicate — same logic as sendMessage ────────────────
                // No originating socket.id to exclude so all sender sockets
                // are treated as "otherSenderSockets"
                const notifiedSocketIds     = new Set([...senderSocketIds]);
                const uniqueReceiverSockets = receiverSocketIds.filter(
                    socketId => !notifiedSocketIds.has(socketId)
                );

                // ── Emit addMessageResponse to sender sockets ──────────────
                if (senderSocketIds.length > 0) {
                    senderSocketIds.forEach(socketId => {
                        this.io.to(socketId).emit(event, payload);
                        console.log('Emitted to sender socket:', socketId);
                    });
                } else {
                    console.warn('No sender sockets found for userId:', fromUserId);
                }

                // ── Emit addMessageResponse to unique receiver sockets ─────
                if (uniqueReceiverSockets.length > 0) {
                    uniqueReceiverSockets.forEach(socketId => {
                        this.io.to(socketId).emit(event, payload);
                        console.log('Emitted to receiver socket:', socketId);
                    });
                } else {
                    console.warn('No receiver sockets found for userId:', toUserId);
                }

                // ── Shared socket list for broadcast side-events ───────────
                const allUniqueSockets = [...new Set([...senderSocketIds, ...receiverSocketIds])];

                // ── Emit newMediaUploaded if payload has attachments ───────
                if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
                    const mediaFiles = payload.attachments.map(file => ({
                        id: `${payload.id}_${file.name}`,
                        message_id: payload.id,
                        name: file.name,
                        path: file.path,
                        size: file.size,
                        format: file.format,
                        date: new Date().toISOString()
                    }));

                    allUniqueSockets.forEach(socketId => {
                        this.io.to(socketId).emit('newMediaUploaded', {
                            conversationId: payload.conversation_id,
                            files: mediaFiles
                        });
                    });

                    console.log('Emitted newMediaUploaded to', allUniqueSockets.length, 'sockets');
                }

                // ── Emit newLinksShared if message contains URLs ───────────
                if (payload.message) {
                    const urls = this.extractUrlsFromText(payload.message);

                    if (urls.length > 0) {
                        const crypto = require('crypto');
                        const links = urls.map(url => {
                            const domain = this.getDomainFromUrl(url);
                            return {
                                id: `${payload.id}_${crypto.createHash('md5').update(url).digest('hex')}`,
                                message_id: payload.id,
                                url: url,
                                title: domain || 'Link',
                                domain: domain,
                                date: new Date().toISOString()
                            };
                        });

                        allUniqueSockets.forEach(socketId => {
                            this.io.to(socketId).emit('newLinksShared', {
                                conversationId: payload.conversation_id,
                                links: links
                            });
                        });

                        console.log('Emitted newLinksShared to', allUniqueSockets.length, 'sockets');
                    }
                }

                const totalNotified = new Set([...senderSocketIds, ...uniqueReceiverSockets]).size;
                console.log('Total unique sockets notified:', totalNotified);
                console.log('═══════════════════════════════════════');

                res.json({ success: true, notified: totalNotified });
            } catch (error) {
                console.error('/emit-message error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });
        // ────────────────────────────────────────────────────────────────────
    }

    // ── URL helpers — kept in sync with socket.js ─────────────────────────
    extractUrlsFromText(text) {
        if (!text) return [];

        const urls = [];

        const patternWithProtocol = /\b(https?:\/\/[^\s<>"']+)/gi;
        const matchesWithProtocol = text.match(patternWithProtocol);
        if (matchesWithProtocol) {
            matchesWithProtocol.forEach(url => {
                urls.push(url.replace(/[.,;:!?]+$/, ''));
            });
        }

        const patternWithoutProtocol = /(?<![\/\w])((?:www\.)[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?:\/[^\s<>"']*)?)/gi;
        const matchesWithoutProtocol = text.match(patternWithoutProtocol);
        if (matchesWithoutProtocol) {
            matchesWithoutProtocol.forEach(url => {
                urls.push('https://' + url.replace(/[.,;:!?]+$/, ''));
            });
        }

        return [...new Set(urls)];
    }

    getDomainFromUrl(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    detectEnvironment(socket) {
        const origin = socket.handshake.headers.origin ||
            socket.handshake.headers.referer ||
            '';
        const host = socket.handshake.headers.host || '';

        if (socket.handshake.query.environment) {
            return socket.handshake.query.environment;
        }

        if (origin.includes('localhost') || origin.includes('127.0.0.1') ||
            host.includes('localhost') || host.includes('127.0.0.1')) {
            return 'dev';
        }

        if (origin.includes('dev.virtualassistants.help') ||
            host.includes('dev.virtualassistants.help')) {
            return 'dev';
        }

        if (origin.includes('stage.virtualassistants.help') ||
            host.includes('stage.virtualassistants.help')) {
            return 'stage';
        }

        if (origin.includes('virtualassistants.help') ||
            host.includes('virtualassistants.help') ||
            origin.includes('virtualassistant.market') ||
            host.includes('virtualassistant.market')) {
            return 'production';
        }

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

        this.io.use((socket, next) => {
            const environment = this.detectEnvironment(socket);
            const apiUrl = environment === 'production'
                ? this.getProductionApiUrl(socket)
                : environment === 'dev'
                    ? this.getDevApiUrl(socket)
                    : this.apiUrls[environment];

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

        this.io.on('connection', (socket) => {
            const env = socket.environment || 'production';
            const userId = socket.handshake.query.id;

            this.environmentStats[env].connections++;
            if (userId) {
                this.environmentStats[env].users.add(userId);
            }

            console.log(`User ${userId} connected to ${env.toUpperCase()} environment`);
            console.log(`Current ${env} connections: ${this.environmentStats[env].connections}`);
            console.log(`API URL: ${socket.apiUrl}`);

            socket.on('disconnect', () => {
                this.environmentStats[env].connections--;
                if (userId) {
                    this.environmentStats[env].users.delete(userId);
                }
                console.log(`User ${userId} disconnected from ${env.toUpperCase()}`);
                console.log(`Current ${env} connections: ${this.environmentStats[env].connections}`);
            });
        });

        // Store handler reference so /emit-message can access userSockets
        this.socketHandler = new socketEvents(this.io, this.apiUrls);
        this.socketHandler.socketConfig();
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

        this.setupExpress();

        if (this.sslOptions) {
            this.server = https.createServer(this.sslOptions, this.app);
            console.log('Protocol: HTTPS');
        } else {
            this.server = http.createServer(this.app);
            console.log('Protocol: HTTP');
        }

        this.setupSocketIO();

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

        this.server.on('error', (error) => {
            console.error('Server error:', error.message);
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${this.port} is already in use!`);
                process.exit(1);
            }
        });

        this.setupGracefulShutdown();
    }

    /**
     * Setup graceful shutdown
     */
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            console.log(`\n ${signal} received. Shutting down gracefully...`);

            if (this.io) {
                console.log('   Closing socket connections...');
                this.io.close();
            }

            if (this.server) {
                this.server.close(() => {
                    console.log(' Server shut down gracefully');
                    process.exit(0);
                });

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