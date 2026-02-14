import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

function resolveServerUrl() {
    const envUrl = import.meta.env.VITE_SERVER_URL;

    if (typeof window !== 'undefined') {
        const origin = window.location.origin;
        const isTunnel = (value) => typeof value === 'string' && value.includes('trycloudflare.com');

        // In tunnel-based dev, tunnel URLs rotate often. Prefer the active page origin
        // so /socket.io can flow through the same tunnel/proxy.
        if (isTunnel(origin) && isTunnel(envUrl) && envUrl !== origin) {
            return origin;
        }

        if (!envUrl) return origin;
    }

    return envUrl || 'http://localhost:3001';
}

const SERVER_URL = resolveServerUrl();
const PARTICIPANT_ID_KEY = 'lovestream.participantId';

function getClientCapabilities() {
    try {
        const hasNativeTranscoderBridge = Boolean(window?.electron?.nativeTranscoder)
            && typeof window.electron.nativeTranscoder.isAvailable === 'function';
        return {
            nativePlayback: hasNativeTranscoderBridge,
        };
    } catch {
        return { nativePlayback: false };
    }
}

function getOrCreateParticipantId() {
    try {
        let participantId = localStorage.getItem(PARTICIPANT_ID_KEY);
        if (!participantId) {
            participantId = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
            localStorage.setItem(PARTICIPANT_ID_KEY, participantId);
        }
        return participantId;
    } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }
}

// Module-level singleton — NEVER disconnects during app lifecycle
let sharedSocket = null;

function getSocket() {
    if (!sharedSocket) {
        sharedSocket = io(SERVER_URL, {
            path: '/socket.io',
            transports: ['polling', 'websocket'],
            upgrade: true,
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
            console.error('[socket] connection error:', err.message, 'url:', SERVER_URL);
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
            socketRef.current.emit('create-room', {
                participantId: getOrCreateParticipantId(),
                capabilities: getClientCapabilities(),
            }, (response) => {
                if (response.success) resolve({ ...response.room, mode: response.mode || 'web-compatible' });
                else reject(new Error(response.error));
            });
        });
    }, []);

    const joinRoom = useCallback((code) => {
        return new Promise((resolve, reject) => {
            if (!socketRef.current) return reject(new Error('Not connected'));
            socketRef.current.emit('join-room', {
                code,
                participantId: getOrCreateParticipantId(),
                capabilities: getClientCapabilities(),
            }, (response) => {
                if (response.success) resolve({ ...response.room, mode: response.mode || 'web-compatible' });
                else reject(new Error(response.error));
            });
        });
    }, []);

    return {
        socket: socketRef,
        isConnected,
        createRoom,
        joinRoom,
        getParticipantId: getOrCreateParticipantId,
        getClientCapabilities,
    };
}
