import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

// Module-level singleton — NEVER disconnects during app lifecycle
let sharedSocket = null;

function getSocket() {
    if (!sharedSocket) {
        sharedSocket = io(SERVER_URL, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });
        sharedSocket.on('connect', () => {
            console.log('[socket] connected:', sharedSocket.id);
        });
        sharedSocket.on('disconnect', (reason) => {
            console.log('[socket] disconnected:', reason);
        });
        sharedSocket.on('connect_error', (err) => {
            console.error('[socket] connection error:', err.message);
        });
    }
    return sharedSocket;
}

export default function useSocket() {
    const socketRef = useRef(null);
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        const socket = getSocket();
        socketRef.current = socket;

        const onConnect = () => setIsConnected(true);
        const onDisconnect = () => setIsConnected(false);

        // Sync current state
        setIsConnected(socket.connected);

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);

        return () => {
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
            // NEVER disconnect — socket persists for entire app session
        };
    }, []);

    const createRoom = useCallback(() => {
        return new Promise((resolve, reject) => {
            if (!socketRef.current) return reject(new Error('Not connected'));
            socketRef.current.emit('create-room', (response) => {
                if (response.success) resolve(response.room);
                else reject(new Error(response.error));
            });
        });
    }, []);

    const joinRoom = useCallback((code) => {
        return new Promise((resolve, reject) => {
            if (!socketRef.current) return reject(new Error('Not connected'));
            socketRef.current.emit('join-room', { code }, (response) => {
                if (response.success) resolve(response.room);
                else reject(new Error(response.error));
            });
        });
    }, []);

    return {
        socket: socketRef,
        isConnected,
        createRoom,
        joinRoom,
    };
}
