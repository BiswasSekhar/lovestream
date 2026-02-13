import { nanoid } from 'nanoid';

class RoomManager {
    constructor() {
        /** @type {Map<string, {code: string, host: string|null, viewer: string|null, createdAt: number}>} */
        this.rooms = new Map();
        /** @type {Map<string, string>} socketId -> roomCode */
        this.socketToRoom = new Map();
    }

    createRoom(socketId) {
        const code = nanoid(6).toUpperCase();
        const room = {
            code,
            host: socketId,
            viewer: null,
            createdAt: Date.now(),
        };
        this.rooms.set(code, room);
        this.socketToRoom.set(socketId, code);
        return room;
    }

    joinRoom(code, socketId) {
        const room = this.rooms.get(code);
        if (!room) {
            return { error: 'Room not found. Check the code and try again.' };
        }
        // Already in this room — return success (idempotent)
        if (room.host === socketId || room.viewer === socketId) {
            return { room };
        }
        if (room.viewer) {
            return { error: 'Room is full. Only 1-on-1 sessions are supported.' };
        }
        room.viewer = socketId;
        this.socketToRoom.set(socketId, code);
        return { room };
    }

    leaveRoom(socketId) {
        const code = this.socketToRoom.get(socketId);
        if (!code) return null;

        const room = this.rooms.get(code);
        if (!room) {
            this.socketToRoom.delete(socketId);
            return null;
        }

        let peerSocketId = null;
        let newRole = null;

        if (room.host === socketId) {
            peerSocketId = room.viewer;
            if (room.viewer) {
                // Promote viewer to host
                room.host = room.viewer;
                room.viewer = null;
                newRole = 'host';
            } else {
                // No one left, delete room
                this.rooms.delete(code);
            }
        } else if (room.viewer === socketId) {
            peerSocketId = room.host;
            room.viewer = null;
        }

        this.socketToRoom.delete(socketId);
        return { code, peerSocketId, newRole };
    }

    getRoom(code) {
        return this.rooms.get(code) || null;
    }

    getRoomBySocket(socketId) {
        const code = this.socketToRoom.get(socketId);
        return code ? this.rooms.get(code) : null;
    }

    getRoleInRoom(socketId) {
        const code = this.socketToRoom.get(socketId);
        if (!code) return null;
        const room = this.rooms.get(code);
        if (!room) return null;
        if (room.host === socketId) return 'host';
        if (room.viewer === socketId) return 'viewer';
        return null;
    }

    getPeerSocketId(socketId) {
        const code = this.socketToRoom.get(socketId);
        if (!code) return null;
        const room = this.rooms.get(code);
        if (!room) return null;
        if (room.host === socketId) return room.viewer;
        if (room.viewer === socketId) return room.host;
        return null;
    }
}

export default RoomManager;
