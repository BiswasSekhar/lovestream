export default function registerSocketHandlers(io, roomManager) {
    const readySockets = new Set();
    const RECONNECT_GRACE_MS = 24 * 60 * 60 * 1000;

    setInterval(() => {
        roomManager.cleanupExpired(RECONNECT_GRACE_MS);
    }, 30000);

    // Helper: broadcast updated participant list to the entire room
    function broadcastParticipants(code) {
        const list = roomManager.getParticipantList(code);
        io.in(code).emit('participant-list', { participants: list });
    }

    io.on('connection', (socket) => {
        console.log(`[connect] ${socket.id}`);

        // ─── Room Events ─────────────────────────────────────────
        socket.on('create-room', (payloadOrCb, maybeCb) => {
            const callback = typeof payloadOrCb === 'function' ? payloadOrCb : maybeCb;
            const payload = typeof payloadOrCb === 'function' ? {} : (payloadOrCb || {});
            const participantId = payload.participantId || null;
            const capabilities = payload.capabilities || {};
            const name = payload.name || 'Host';

            const room = roomManager.createRoom(socket.id, participantId, capabilities, payload.requestedCode, name);
            socket.join(room.code);
            console.log(`[room] ${socket.id} (${name}) created room ${room.code}`);

            callback?.({
                success: true,
                room: { code: room.code, role: 'host' },
                mode: roomManager.getRoomMode(room.code),
                reconnectGraceMs: RECONNECT_GRACE_MS,
            });

            broadcastParticipants(room.code);
        });

        socket.on('join-room', ({ code, participantId, capabilities, name } = {}, callback) => {
            const normalizedCode = (code || '').trim().toUpperCase();
            roomManager.cleanupExpired(RECONNECT_GRACE_MS);
            const result = roomManager.joinRoom(normalizedCode, socket.id, participantId || null, capabilities || {}, {
                graceMs: RECONNECT_GRACE_MS,
                name: name || 'Guest',
            });

            if (result.error) {
                callback?.({ success: false, error: result.error });
                return;
            }

            socket.join(normalizedCode);
            console.log(`[room] ${socket.id} (${name || 'Guest'}) joined room ${normalizedCode} as ${result.role}`);

            callback?.({
                success: true,
                room: { code: normalizedCode, role: result.role || 'viewer' },
                mode: roomManager.getRoomMode(normalizedCode),
                reconnectGraceMs: RECONNECT_GRACE_MS,
            });

            io.in(normalizedCode).emit('room-mode', { mode: roomManager.getRoomMode(normalizedCode) });

            // Notify existing participants about the new joiner
            socket.to(normalizedCode).emit('participant-joined', {
                id: socket.id,
                name: name || 'Guest',
                role: result.role || 'viewer',
            });

            // Send full participant list
            broadcastParticipants(normalizedCode);

            // Replay cached room state to the joining peer
            const snapshot = roomManager.getRoomSnapshot(normalizedCode);
            if (snapshot?.movie) {
                io.to(socket.id).emit('movie-loaded', snapshot.movie);
            }
            if (snapshot?.subtitles) {
                io.to(socket.id).emit('subtitle-data', snapshot.subtitles);
            }
            if (snapshot?.magnet) {
                io.to(socket.id).emit('torrent-magnet', snapshot.magnet);
            }
            if (snapshot?.playback) {
                io.to(socket.id).emit('playback-snapshot', { playback: snapshot.playback });
            }
        });

        // Client emits this when its WebRTC hooks are fully set up
        socket.on('ready-for-connection', () => {
            readySockets.add(socket.id);
            const room = roomManager.getRoomBySocket(socket.id);
            if (!room) return;

            const role = roomManager.getRoleInRoom(socket.id);
            const others = roomManager.getOtherParticipants(socket.id);
            console.log(`[ready] ${socket.id} (${role}) is ready, ${others.length} other peers`);

            // Tell this peer to initiate WebRTC with all already-ready peers
            others.forEach(peerId => {
                if (readySockets.has(peerId)) {
                    console.log(`[ready] telling ${socket.id} to connect with ${peerId}`);
                    // The new peer initiates connections to existing peers
                    io.to(socket.id).emit('start-webrtc', { peerId, initiator: true });
                    io.to(peerId).emit('start-webrtc', { peerId: socket.id, initiator: false });
                }
            });
        });

        // ─── WebRTC Signaling (targeted for mesh) ─────────────────
        socket.on('offer', ({ offer, to }) => {
            if (to) {
                console.log(`[signal] relaying offer from ${socket.id} to ${to}`);
                io.to(to).emit('offer', { offer, from: socket.id });
            } else {
                // Legacy fallback: send to first peer
                const peerId = roomManager.getPeerSocketId(socket.id);
                if (peerId) {
                    console.log(`[signal] relaying offer from ${socket.id} to ${peerId} (legacy)`);
                    io.to(peerId).emit('offer', { offer, from: socket.id });
                }
            }
        });

        socket.on('answer', ({ answer, to }) => {
            if (to) {
                console.log(`[signal] relaying answer from ${socket.id} to ${to}`);
                io.to(to).emit('answer', { answer, from: socket.id });
            } else {
                const peerId = roomManager.getPeerSocketId(socket.id);
                if (peerId) {
                    console.log(`[signal] relaying answer from ${socket.id} to ${peerId} (legacy)`);
                    io.to(peerId).emit('answer', { answer, from: socket.id });
                }
            }
        });

        socket.on('ice-candidate', ({ candidate, to }) => {
            if (to) {
                io.to(to).emit('ice-candidate', { candidate, from: socket.id });
            } else {
                const peerId = roomManager.getPeerSocketId(socket.id);
                if (peerId) {
                    io.to(peerId).emit('ice-candidate', { candidate, from: socket.id });
                }
            }
        });

        // ─── Playback Sync ──────────────────────────────────────
        socket.on('sync-play', ({ time, actionId }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (!room) return;
            roomManager.updateRoomCache(room.code, {
                playback: { type: 'play', time, actionId, updatedAt: Date.now() },
            });
            socket.to(room.code).emit('sync-play', { time, actionId, from: socket.id });
        });

        socket.on('sync-pause', ({ time, actionId }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (!room) return;
            roomManager.updateRoomCache(room.code, {
                playback: { type: 'pause', time, actionId, updatedAt: Date.now() },
            });
            socket.to(room.code).emit('sync-pause', { time, actionId, from: socket.id });
        });

        socket.on('sync-seek', ({ time, actionId }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                roomManager.updateRoomCache(room.code, {
                    playback: { type: 'seek', time, actionId, updatedAt: Date.now() },
                });
                socket.to(room.code).emit('sync-seek', { time, actionId, from: socket.id });
            }
        });

        // ─── Chat ────────────────────────────────────────────────
        socket.on('chat-message', ({ text }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (!room) return;
            if (text && text.trim()) {
                const name = roomManager.getParticipantName(socket.id) || 'Unknown';
                const role = roomManager.getRoleInRoom(socket.id);
                const message = {
                    id: `${socket.id}-${Date.now()}`,
                    text: text.trim(),
                    sender: name,
                    senderRole: role,
                    senderId: socket.id,
                    timestamp: Date.now(),
                };
                io.in(room.code).emit('chat-message', message);
            }
        });

        // ─── Subtitle sharing ───────────────────────────────────
        socket.on('subtitle-data', ({ subtitles, filename }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                roomManager.updateRoomCache(room.code, {
                    subtitles: { subtitles, filename },
                });
                // Broadcast to all others in room
                socket.to(room.code).emit('subtitle-data', { subtitles, filename });
            }
        });

        // ─── Movie metadata ─────────────────────────────────────
        socket.on('movie-loaded', ({ name, duration }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                roomManager.updateRoomCache(room.code, {
                    movie: { name, duration },
                });
                socket.to(room.code).emit('movie-loaded', { name, duration });
            }
        });

        // ─── Viewer stream readiness ─────────────────────────
        socket.on('viewer-stream-ready', ({ progress, timestamp }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                socket.to(room.code).emit('viewer-stream-ready', {
                    progress: typeof progress === 'number' ? progress : 0,
                    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
                    from: socket.id,
                });
            }
        });

        socket.on('viewer-playable', ({ timestamp }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                socket.to(room.code).emit('viewer-playable', {
                    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
                    from: socket.id,
                });
            }
        });

        socket.on('viewer-local-playback', ({ enabled, timestamp }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                socket.to(room.code).emit('viewer-local-playback', {
                    enabled: Boolean(enabled),
                    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
                    from: socket.id,
                });
            }
        });

        socket.on('torrent-download-complete', ({ name }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                io.in(room.code).emit('torrent-download-complete', {
                    name: name || 'Movie',
                    timestamp: Date.now(),
                });
            }
        });

        // ─── WebTorrent magnet sharing ──────────────────────────
        socket.on('torrent-magnet', ({ magnetURI, preTranscode, name, streamPath }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                if (!preTranscode) {
                    roomManager.updateRoomCache(room.code, {
                        magnet: {
                            magnetURI,
                            preTranscode: false,
                            name: name || '',
                            streamPath: streamPath || 'direct',
                        },
                    });
                }

                console.log(`[torrent] ${socket.id} sharing magnet in room ${room.code} (streamPath: ${streamPath || 'direct'})`);
                socket.to(room.code).emit('torrent-magnet', {
                    magnetURI,
                    preTranscode: Boolean(preTranscode),
                    name: name || '',
                    streamPath: streamPath || 'direct',
                });
            }
        });

        // ─── Explicit Leave ────────────────────────────────────
        socket.on('leave-room', () => {
            readySockets.delete(socket.id);
            const result = roomManager.leaveRoom(socket.id);
            if (result) {
                const { code, role, otherSocketIds } = result;
                // Notify remaining participants
                io.in(code).emit('participant-left', {
                    id: socket.id,
                    role,
                    temporary: false,
                });
                broadcastParticipants(code);
                io.in(code).emit('room-mode', { mode: roomManager.getRoomMode(code) });
            }
        });

        // ─── Disconnect ──────────────────────────────────────────
        socket.on('disconnect', () => {
            console.log(`[disconnect] ${socket.id}`);
            readySockets.delete(socket.id);
            const result = roomManager.leaveRoom(socket.id);
            if (result) {
                const { code, role, otherSocketIds } = result;
                io.in(code).emit('participant-left', {
                    id: socket.id,
                    role,
                    temporary: true,
                    reconnectGraceMs: RECONNECT_GRACE_MS,
                });
                broadcastParticipants(code);
                io.in(code).emit('room-mode', { mode: roomManager.getRoomMode(code) });
            }
        });
    });
}
