export default function registerSocketHandlers(io, roomManager) {
    // Track which sockets are ready for WebRTC
    const readySockets = new Set();

    io.on('connection', (socket) => {
        console.log(`[connect] ${socket.id}`);

        // ─── Room Events ─────────────────────────────────────────
        socket.on('create-room', (callback) => {
            const room = roomManager.createRoom(socket.id);
            socket.join(room.code);
            console.log(`[room] ${socket.id} created room ${room.code}`);
            callback({ success: true, room: { code: room.code, role: 'host' } });
        });

        socket.on('join-room', ({ code }, callback) => {
            const normalizedCode = (code || '').trim().toUpperCase();
            const result = roomManager.joinRoom(normalizedCode, socket.id);

            if (result.error) {
                callback({ success: false, error: result.error });
                return;
            }

            socket.join(normalizedCode);
            console.log(`[room] ${socket.id} joined room ${normalizedCode}`);

            callback({
                success: true,
                room: { code: normalizedCode, role: 'viewer' },
            });
        });

        // Client emits this when its WebRTC hooks are fully set up
        socket.on('ready-for-connection', () => {
            readySockets.add(socket.id);
            const room = roomManager.getRoomBySocket(socket.id);
            if (!room) return;

            const role = roomManager.getRoleInRoom(socket.id);
            const peerId = roomManager.getPeerSocketId(socket.id);
            console.log(`[ready] ${socket.id} (${role}) is ready, peer: ${peerId}, peerReady: ${peerId ? readySockets.has(peerId) : 'N/A'}`);

            // Check if both peers are ready
            if (peerId && readySockets.has(peerId)) {
                console.log(`[ready] BOTH peers are ready! Telling host to initiate WebRTC`);
                // Tell the HOST to start as initiator
                const hostId = room.host;
                const viewerId = room.viewer;
                if (hostId && viewerId) {
                    io.to(hostId).emit('start-webrtc', { peerId: viewerId, role: 'host' });
                    io.to(viewerId).emit('start-webrtc', { peerId: hostId, role: 'viewer' });
                }
            }
        });

        // ─── WebRTC Signaling ────────────────────────────────────
        socket.on('offer', ({ offer }) => {
            const peerId = roomManager.getPeerSocketId(socket.id);
            if (peerId) {
                console.log(`[signal] relaying offer from ${socket.id} to ${peerId}`);
                io.to(peerId).emit('offer', { offer, from: socket.id });
            }
        });

        socket.on('answer', ({ answer }) => {
            const peerId = roomManager.getPeerSocketId(socket.id);
            if (peerId) {
                console.log(`[signal] relaying answer from ${socket.id} to ${peerId}`);
                io.to(peerId).emit('answer', { answer, from: socket.id });
            }
        });

        socket.on('ice-candidate', ({ candidate }) => {
            const peerId = roomManager.getPeerSocketId(socket.id);
            if (peerId) {
                io.to(peerId).emit('ice-candidate', { candidate, from: socket.id });
            }
        });

        // ─── Playback Sync ──────────────────────────────────────
        socket.on('sync-play', ({ time, actionId }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                socket.to(room.code).emit('sync-play', { time, actionId, from: socket.id });
            }
        });

        socket.on('sync-pause', ({ time, actionId }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                socket.to(room.code).emit('sync-pause', { time, actionId, from: socket.id });
            }
        });

        socket.on('sync-seek', ({ time, actionId }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                socket.to(room.code).emit('sync-seek', { time, actionId, from: socket.id });
            }
        });

        // ─── Chat ────────────────────────────────────────────────
        socket.on('chat-message', ({ text }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room && text && text.trim()) {
                const role = roomManager.getRoleInRoom(socket.id);
                const message = {
                    id: `${socket.id}-${Date.now()}`,
                    text: text.trim(),
                    sender: role,
                    timestamp: Date.now(),
                };
                io.in(room.code).emit('chat-message', message);
            }
        });

        // ─── Subtitle sharing ───────────────────────────────────
        socket.on('subtitle-data', ({ subtitles, filename }) => {
            const peerId = roomManager.getPeerSocketId(socket.id);
            if (peerId) {
                io.to(peerId).emit('subtitle-data', { subtitles, filename });
            }
        });

        // ─── Movie metadata ─────────────────────────────────────
        socket.on('movie-loaded', ({ name, duration }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                socket.to(room.code).emit('movie-loaded', { name, duration });
            }
        });

        // ─── Disconnect ──────────────────────────────────────────
        socket.on('disconnect', () => {
            console.log(`[disconnect] ${socket.id}`);
            readySockets.delete(socket.id);
            const result = roomManager.leaveRoom(socket.id);
            if (result) {
                const { code, peerSocketId, newRole } = result;
                if (peerSocketId) {
                    io.to(peerSocketId).emit('peer-left', { newRole });
                }
            }
        });
    });
}
