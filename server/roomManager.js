import { nanoid } from 'nanoid';

class RoomManager {
    constructor() {
        this.rooms = new Map();
        this.socketToRoom = new Map();
    }

    createRoom(socketId, participantId) {
        const code = this.#generateUniqueCode();
        const room = {
            code,
            host: socketId,
            viewer: null,
            hostParticipantId: participantId || null,
            viewerParticipantId: null,
            hostDisconnectedAt: null,
            viewerDisconnectedAt: null,
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

    joinRoom(code, socketId, participantId, { graceMs = 120000 } = {}) {
        const room = this.rooms.get(code);
        if (!room) {
            return { error: 'Room not found. Check the code and try again.' };
        }

        this.#pruneRoomReservations(room, graceMs);

        if (room.host === socketId) return { room, role: 'host' };
        if (room.viewer === socketId) return { room, role: 'viewer' };

        const participant = participantId || null;

        if (!room.host && room.hostParticipantId && participant && room.hostParticipantId === participant) {
            room.host = socketId;
            room.hostDisconnectedAt = null;
            this.socketToRoom.set(socketId, code);
            return { room, role: 'host', reclaimed: true };
        }

        if (!room.viewer && room.viewerParticipantId && participant && room.viewerParticipantId === participant) {
            room.viewer = socketId;
            room.viewerDisconnectedAt = null;
            this.socketToRoom.set(socketId, code);
            return { room, role: 'viewer', reclaimed: true };
        }

        if (!room.viewer) {
            if (room.viewerParticipantId && room.viewerParticipantId !== participant) {
                return { error: 'Partner is reconnecting. Please try again in a moment.' };
            }

            room.viewer = socketId;
            room.viewerParticipantId = participant;
            room.viewerDisconnectedAt = null;
            this.socketToRoom.set(socketId, code);
            return { room, role: 'viewer' };
        }

        return { error: 'Room is full. Only 1-on-1 sessions are supported.' };
    }

    leaveRoom(socketId) {
        const code = this.socketToRoom.get(socketId);
        if (!code) return null;

        const room = this.rooms.get(code);
        this.socketToRoom.delete(socketId);
        if (!room) return null;

        let role = null;
        let peerSocketId = null;

        if (room.host === socketId) {
            role = 'host';
            peerSocketId = room.viewer;
            room.host = null;
            room.hostDisconnectedAt = Date.now();
        } else if (room.viewer === socketId) {
            role = 'viewer';
            peerSocketId = room.host;
            room.viewer = null;
            room.viewerDisconnectedAt = Date.now();
        }

        return { code, role, peerSocketId };
    }

    cleanupExpired(graceMs = 120000) {
        const now = Date.now();

        for (const [code, room] of this.rooms.entries()) {
            this.#pruneRoomReservations(room, graceMs, now);

            const noConnectedPeers = !room.host && !room.viewer;
            const noReservations = !room.hostParticipantId && !room.viewerParticipantId;
            if (noConnectedPeers && noReservations) {
                this.rooms.delete(code);
            }
        }
    }

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
        if (room.host === socketId) return 'host';
        if (room.viewer === socketId) return 'viewer';
        return null;
    }

    getPeerSocketId(socketId) {
        const room = this.getRoomBySocket(socketId);
        if (!room) return null;
        if (room.host === socketId) return room.viewer;
        if (room.viewer === socketId) return room.host;
        return null;
    }

    updateRoomCache(code, patch) {
        const room = this.rooms.get(code);
        if (!room) return;

        room.cache = {
            ...room.cache,
            ...patch,
            updatedAt: Date.now(),
        };
    }

    getRoomSnapshot(code) {
        const room = this.rooms.get(code);
        if (!room) return null;
        return room.cache || null;
    }

    #pruneRoomReservations(room, graceMs, now = Date.now()) {
        if (!room.host && room.hostParticipantId && room.hostDisconnectedAt && now - room.hostDisconnectedAt > graceMs) {
            room.hostParticipantId = null;
            room.hostDisconnectedAt = null;
        }

        if (!room.viewer && room.viewerParticipantId && room.viewerDisconnectedAt && now - room.viewerDisconnectedAt > graceMs) {
            room.viewerParticipantId = null;
            room.viewerDisconnectedAt = null;
        }
    }

    #generateUniqueCode() {
        let code = nanoid(6).toUpperCase();
        while (this.rooms.has(code)) {
            code = nanoid(6).toUpperCase();
        }
        return code;
    }
}

export default RoomManager;
