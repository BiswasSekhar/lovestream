export default function registerSocketHandlers(io, roomManager) {
    // Track which sockets are ready for WebRTC
    const readySockets = new Set();
    const RECONNECT_GRACE_MS = 24 * 60 * 60 * 1000;

    setInterval(() => {
        roomManager.cleanupExpired(RECONNECT_GRACE_MS);
    }, 30000);

    io.on('connection', (socket) => {
        console.log(`[connect] ${socket.id}`);

        // ─── Room Events ─────────────────────────────────────────
        socket.on('create-room', (payloadOrCb, maybeCb) => {
            const callback = typeof payloadOrCb === 'function' ? payloadOrCb : maybeCb;
            const payload = typeof payloadOrCb === 'function' ? {} : (payloadOrCb || {});
            const participantId = payload.participantId || null;
            const capabilities = payload.capabilities || {};

            const room = roomManager.createRoom(socket.id, participantId, capabilities, payload.requestedCode);
            socket.join(room.code);
            console.log(`[room] ${socket.id} created room ${room.code}`);
            callback?.({
                success: true,
                room: { code: room.code, role: 'host' },
                mode: room.mode,
                reconnectGraceMs: RECONNECT_GRACE_MS,
            });
        });

        socket.on('join-room', ({ code, participantId, capabilities } = {}, callback) => {
            const normalizedCode = (code || '').trim().toUpperCase();
            roomManager.cleanupExpired(RECONNECT_GRACE_MS);
            const result = roomManager.joinRoom(normalizedCode, socket.id, participantId || null, capabilities || {}, {
                graceMs: RECONNECT_GRACE_MS,
            });

            if (result.error) {
                callback?.({ success: false, error: result.error });
                return;
            }

            socket.join(normalizedCode);
            console.log(`[room] ${socket.id} joined room ${normalizedCode}`);

            callback?.({
                success: true,
                room: { code: normalizedCode, role: result.role || 'viewer' },
                mode: roomManager.getRoomMode(normalizedCode),
                reconnectGraceMs: RECONNECT_GRACE_MS,
            });

            io.in(normalizedCode).emit('room-mode', { mode: roomManager.getRoomMode(normalizedCode) });

            // Replay cached room state to reconnecting/joining peer.
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
            if (!room) {
                console.warn(`[sync] sync-play from ${socket.id} but no room found (server may have restarted)`);
                return;
            }
            roomManager.updateRoomCache(room.code, {
                playback: { type: 'play', time, actionId, updatedAt: Date.now() },
            });
            socket.to(room.code).emit('sync-play', { time, actionId, from: socket.id });
        });

        socket.on('sync-pause', ({ time, actionId }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (!room) {
                console.warn(`[sync] sync-pause from ${socket.id} but no room found (server may have restarted)`);
                return;
            }
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
            if (!room) {
                console.warn(`[chat] chat-message from ${socket.id} but no room found (server may have restarted)`);
                return;
            }
            if (text && text.trim()) {
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
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                roomManager.updateRoomCache(room.code, {
                    subtitles: { subtitles, filename },
                });
            }

            const peerId = roomManager.getPeerSocketId(socket.id);
            if (peerId) {
                io.to(peerId).emit('subtitle-data', { subtitles, filename });
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
        socket.on('torrent-magnet', ({ magnetURI, preTranscode, name }) => {
            const room = roomManager.getRoomBySocket(socket.id);
            if (room) {
                // Cache only finalized playable magnet for reconnect replay.
                if (!preTranscode) {
                    roomManager.updateRoomCache(room.code, {
                        magnet: {
                            magnetURI,
                            preTranscode: false,
                            name: name || '',
                        },
                    });
                }

                console.log(`[torrent] ${socket.id} sharing magnet in room ${room.code}`);
                socket.to(room.code).emit('torrent-magnet', {
                    magnetURI,
                    preTranscode: Boolean(preTranscode),
                    name: name || '',
                });
            }
        });

        // ─── Explicit Leave ────────────────────────────────────
        socket.on('leave-room', () => {
            readySockets.delete(socket.id);
            const result = roomManager.leaveRoom(socket.id);
            if (result) {
                const { code, role, peerSocketId } = result;
                if (peerSocketId) {
                    io.to(peerSocketId).emit('peer-left', {
                        role,
                        temporary: false,
                    });
                }
                io.in(code).emit('room-mode', { mode: roomManager.getRoomMode(code) });
            }
        });

        // ─── Disconnect ──────────────────────────────────────────
        socket.on('disconnect', () => {
            console.log(`[disconnect] ${socket.id}`);
            readySockets.delete(socket.id);
            const result = roomManager.leaveRoom(socket.id);
            if (result) {
                const { code, role, peerSocketId } = result;
                if (peerSocketId) {
                    io.to(peerSocketId).emit('peer-left', {
                        role,
                        temporary: true,
                        reconnectGraceMs: RECONNECT_GRACE_MS,
                    });
                }
                io.in(code).emit('room-mode', { mode: roomManager.getRoomMode(code) });
            }
        });
    });
}
