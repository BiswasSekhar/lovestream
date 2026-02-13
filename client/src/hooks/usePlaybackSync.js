import { useEffect, useRef, useCallback } from 'react';

/**
 * Synchronizes playback between peers via Socket.IO.
 * Both users can control playback (play/pause/seek).
 * Uses actionId to prevent echo loops.
 */
export default function usePlaybackSync({ socket, videoRef, onSyncEvent }) {
    const lastActionIdRef = useRef(null);
    const isSyncing = useRef(false);

    // Send play event
    const emitPlay = useCallback(
        (time) => {
            if (isSyncing.current) return;
            const actionId = `${Date.now()}-${Math.random()}`;
            lastActionIdRef.current = actionId;
            socket.current?.emit('sync-play', { time, actionId });
        },
        [socket]
    );

    // Send pause event
    const emitPause = useCallback(
        (time) => {
            if (isSyncing.current) return;
            const actionId = `${Date.now()}-${Math.random()}`;
            lastActionIdRef.current = actionId;
            socket.current?.emit('sync-pause', { time, actionId });
        },
        [socket]
    );

    // Send seek event
    const emitSeek = useCallback(
        (time) => {
            if (isSyncing.current) return;
            const actionId = `${Date.now()}-${Math.random()}`;
            lastActionIdRef.current = actionId;
            socket.current?.emit('sync-seek', { time, actionId });
        },
        [socket]
    );

    // Listen for sync events from peer
    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleSyncPlay = ({ time, actionId }) => {
            if (actionId === lastActionIdRef.current) return; // Ignore own echo
            isSyncing.current = true;
            if (videoRef.current) {
                videoRef.current.currentTime = time;
                videoRef.current.play().catch(() => { });
            }
            onSyncEvent?.('play', time);
            setTimeout(() => {
                isSyncing.current = false;
            }, 100);
        };

        const handleSyncPause = ({ time, actionId }) => {
            if (actionId === lastActionIdRef.current) return;
            isSyncing.current = true;
            if (videoRef.current) {
                videoRef.current.pause();
                videoRef.current.currentTime = time;
            }
            onSyncEvent?.('pause', time);
            setTimeout(() => {
                isSyncing.current = false;
            }, 100);
        };

        const handleSyncSeek = ({ time, actionId }) => {
            if (actionId === lastActionIdRef.current) return;
            isSyncing.current = true;
            if (videoRef.current) {
                videoRef.current.currentTime = time;
            }
            onSyncEvent?.('seek', time);
            setTimeout(() => {
                isSyncing.current = false;
            }, 100);
        };

        sock.on('sync-play', handleSyncPlay);
        sock.on('sync-pause', handleSyncPause);
        sock.on('sync-seek', handleSyncSeek);

        return () => {
            sock.off('sync-play', handleSyncPlay);
            sock.off('sync-pause', handleSyncPause);
            sock.off('sync-seek', handleSyncSeek);
        };
    }, [socket, videoRef, onSyncEvent]);

    return {
        emitPlay,
        emitPause,
        emitSeek,
        isSyncing,
    };
}
