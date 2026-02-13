import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import TrackerServer from 'bittorrent-tracker/lib/server.js';
import RoomManager from './roomManager.js';
import registerSocketHandlers from './socketHandlers.js';

const app = express();
const httpServer = createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const PORT = process.env.PORT || 3001;

// CORS — allow any origin for tunnel/remote access
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Socket.IO
const io = new Server(httpServer, {
    cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
});

// Room manager
const roomManager = new RoomManager();

// Register socket handlers
registerSocketHandlers(io, roomManager);

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', rooms: roomManager.rooms.size });
});

// ICE server config endpoint
app.get('/ice-servers', (_req, res) => {
    const servers = [
        { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];

    if (process.env.TURN_URL) {
        servers.push({
            urls: process.env.TURN_URL,
            username: process.env.TURN_USERNAME || '',
            credential: process.env.TURN_CREDENTIAL || '',
        });
    }

    res.json(servers);
});

// WebTorrent tracker (peer discovery for P2P movie sharing)
const tracker = new TrackerServer({
    http: false,  // no HTTP tracker
    udp: false,   // no UDP tracker
    ws: true,     // WebSocket tracker only
});

tracker.on('error', (err) => {
    console.error('[tracker] error:', err.message);
});

tracker.on('warning', (err) => {
    console.warn('[tracker] warning:', err.message);
});

httpServer.listen(PORT, () => {
    console.log(`🚀 Lovestream server running on port ${PORT}`);
    console.log(`   Accepting connections from: ${CLIENT_URL}`);

    // Attach tracker to the same HTTP server
    tracker.http = httpServer;
    console.log(`   WebTorrent tracker ready on ws://localhost:${PORT}`);
});
