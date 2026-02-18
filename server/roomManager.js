import { nanoid } from 'nanoid';

class RoomManager {
    constructor() {
        this.rooms = new Map();
        this.socketToRoom = new Map();
    }

    createRoom(socketId, participantId, capabilities = {}, requestedCode = null, name = 'Host') {
        let code;
        if (requestedCode) {
            const normalized = requestedCode.trim().toUpperCase();
            code = this.rooms.has(normalized) ? this.#generateUniqueCode() : normalized;
        } else {
            code = this.#generateUniqueCode();
        }

        const participant = {
            socketId,
            participantId: participantId || null,
            role: 'host',
            name,
            capabilities: this.#normalizeCapabilities(capabilities),
            disconnectedAt: null,
            joinedAt: Date.now(),
        };

        const room = {
            code,
            participants: [participant],
            maxParticipants: 6,
            createdAt: Date.now(),
            cache: {
                movie: null,
                subtitles: null,
                magnet: null,
                playback: null,
                updatedAt: Date.now(),
            },
        };

        this.rooms.set(code, room);
        this.socketToRoom.set(socketId, code);
        return room;
    }

    joinRoom(code, socketId, participantId, capabilities = {}, { graceMs = 120000, name = 'Guest' } = {}) {
        const room = this.rooms.get(code);
        if (!room) {
            return { error: 'Room not found. Check the code and try again.' };
        }

        this.#pruneDisconnected(room, graceMs);

        // Already in room?
        const existing = room.participants.find(p => p.socketId === socketId);
        if (existing) return { room, role: existing.role };

        // Reconnecting participant?
        if (participantId) {
            const stale = room.participants.find(
                p => p.participantId === participantId && !p.socketId
            );
            if (stale) {
                stale.socketId = socketId;
                stale.disconnectedAt = null;
                stale.capabilities = this.#normalizeCapabilities(capabilities);
                if (name) stale.name = name;
                this.socketToRoom.set(socketId, code);
                return { room, role: stale.role, reclaimed: true };
            }

            // Force-evict stale socket with same participantId
            const staleConnected = room.participants.find(
                p => p.participantId === participantId && p.socketId !== socketId
            );
            if (staleConnected) {
                console.log(`[room] force-evicting stale socket ${staleConnected.socketId} for participant ${participantId}`);
                this.socketToRoom.delete(staleConnected.socketId);
                staleConnected.socketId = socketId;
                staleConnected.disconnectedAt = null;
                staleConnected.capabilities = this.#normalizeCapabilities(capabilities);
                if (name) staleConnected.name = name;
                this.socketToRoom.set(socketId, code);
                return { room, role: staleConnected.role, reclaimed: true };
            }
        }

        // Check capacity
        const activeCount = room.participants.filter(p => p.socketId || p.disconnectedAt).length;
        if (activeCount >= room.maxParticipants) {
            return { error: `Room is full (max ${room.maxParticipants} participants).` };
        }

        // New participant joins as viewer
        const participant = {
            socketId,
            participantId: participantId || null,
            role: 'viewer',
            name,
            capabilities: this.#normalizeCapabilities(capabilities),
            disconnectedAt: null,
            joinedAt: Date.now(),
        };
        room.participants.push(participant);
        this.socketToRoom.set(socketId, code);
        return { room, role: 'viewer' };
    }

    leaveRoom(socketId) {
        const code = this.socketToRoom.get(socketId);
        if (!code) return null;

        const room = this.rooms.get(code);
        this.socketToRoom.delete(socketId);
        if (!room) return null;

        const participant = room.participants.find(p => p.socketId === socketId);
        if (!participant) return null;

        const role = participant.role;
        const otherSocketIds = room.participants
            .filter(p => p.socketId && p.socketId !== socketId)
            .map(p => p.socketId);

        // Mark as disconnected (keep reservation for reconnect)
        participant.socketId = null;
        participant.disconnectedAt = Date.now();

        // If host left, promote the next connected participant
        if (role === 'host') {
            const nextHost = room.participants.find(p => p.socketId && p.role !== 'host');
            if (nextHost) {
                nextHost.role = 'host';
            }
        }

        return { code, role, otherSocketIds };
    }

    cleanupExpired(graceMs = 120000) {
        for (const [code, room] of this.rooms.entries()) {
            this.#pruneDisconnected(room, graceMs);

            const hasAnyone = room.participants.some(p => p.socketId || p.disconnectedAt);
            if (!hasAnyone) {
                this.rooms.delete(code);
            }
        }
    }

    // ─── Query helpers ─────────────────────────────────────────

    getRoom(code) {
        return this.rooms.get(code) || null;
    }

    getRoomBySocket(socketId) {
        const code = this.socketToRoom.get(socketId);
        return code ? this.rooms.get(code) : null;
    }

    getRoleInRoom(socketId) {
        const room = this.getRoomBySocket(socketId);
        if (!room) return null;
        const p = room.participants.find(p => p.socketId === socketId);
        return p ? p.role : null;
    }

    getParticipantName(socketId) {
        const room = this.getRoomBySocket(socketId);
        if (!room) return null;
        const p = room.participants.find(p => p.socketId === socketId);
        return p ? p.name : null;
    }

    /**
     * Returns all other connected participants' socket IDs (for mesh WebRTC).
     */
    getOtherParticipants(socketId) {
        const room = this.getRoomBySocket(socketId);
        if (!room) return [];
        return room.participants
            .filter(p => p.socketId && p.socketId !== socketId)
            .map(p => p.socketId);
    }

    /**
     * Returns the full participant list for UI display.
     */
    getParticipantList(code) {
        const room = this.rooms.get(code);
        if (!room) return [];
        return room.participants
            .filter(p => p.socketId) // only connected
            .map(p => ({
                id: p.socketId,
                participantId: p.participantId,
                name: p.name,
                role: p.role,
            }));
    }

    // ─── Legacy compat — getPeerSocketId for 1:1 fallback ────
    getPeerSocketId(socketId) {
        const others = this.getOtherParticipants(socketId);
        return others.length > 0 ? others[0] : null;
    }

    updateRoomCache(code, patch) {
        const room = this.rooms.get(code);
        if (!room) return;
        room.cache = { ...room.cache, ...patch, updatedAt: Date.now() };
    }

    getRoomSnapshot(code) {
        const room = this.rooms.get(code);
        if (!room) return null;
        return room.cache || null;
    }

    getRoomMode(code) {
        const room = this.rooms.get(code);
        if (!room) return 'web-compatible';
        return this.#computeRoomMode(room);
    }

    getRoomModeBySocket(socketId) {
        const room = this.getRoomBySocket(socketId);
        if (!room) return 'web-compatible';
        return this.#computeRoomMode(room);
    }

    // ─── Private ──────────────────────────────────────────────

    #pruneDisconnected(room, graceMs, now = Date.now()) {
        room.participants = room.participants.filter(p => {
            if (p.socketId) return true; // connected
            if (p.disconnectedAt && now - p.disconnectedAt > graceMs) return false; // expired
            return true; // still within grace period
        });
    }

    #generateUniqueCode() {
        let code = nanoid(6).toUpperCase();
        while (this.rooms.has(code)) {
            code = nanoid(6).toUpperCase();
        }
        return code;
    }

    #normalizeCapabilities(capabilities = {}) {
        return {
            nativePlayback: Boolean(capabilities.nativePlayback),
        };
    }

    #computeRoomMode(room) {
        const connected = room.participants.filter(p => p.socketId);
        if (connected.length < 2) return 'web-compatible';
        const allNative = connected.every(p => p.capabilities?.nativePlayback);
        return allNative ? 'native' : 'web-compatible';
    }
}

export default RoomManager;
