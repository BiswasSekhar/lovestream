import { useEffect, useRef, useState, useCallback } from 'react';
import SimplePeer from 'simple-peer';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

/**
 * Manages WebRTC peer connection for video call (webcam/mic) only.
 * Movie streaming is handled separately via data channel (useFileStream).
 */
export default function useWebRTC({
    socket,
    isHost,
    callStream,
    onCallStream,
    onConnect,
    onDisconnect,
}) {
    const peerRef = useRef(null);
    const [connectionState, setConnectionState] = useState('disconnected');
    const iceServersRef = useRef([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]);

    // Store latest callbacks in refs to avoid stale closures
    const onCallStreamRef = useRef(onCallStream);
    const onConnectRef = useRef(onConnect);
    const onDisconnectRef = useRef(onDisconnect);
    const callStreamRef = useRef(callStream);

    useEffect(() => { onCallStreamRef.current = onCallStream; }, [onCallStream]);
    useEffect(() => { onConnectRef.current = onConnect; }, [onConnect]);
    useEffect(() => { onDisconnectRef.current = onDisconnect; }, [onDisconnect]);
    useEffect(() => { callStreamRef.current = callStream; }, [callStream]);

    // Fetch ICE servers on mount
    useEffect(() => {
        fetch(`${SERVER_URL}/ice-servers`)
            .then((r) => r.json())
            .then((servers) => {
                iceServersRef.current = servers;
            })
            .catch(() => { });
    }, []);

    const createPeer = useCallback(
        (initiator) => {
            if (peerRef.current) {
                peerRef.current.destroy();
                peerRef.current = null;
            }

            console.log('[webrtc] creating peer, initiator:', initiator,
                'callStream:', !!callStreamRef.current);

            const peer = new SimplePeer({
                initiator,
                trickle: true,
                config: {
                    iceServers: iceServersRef.current,
                },
                stream: callStreamRef.current || undefined,
            });

            peer.on('signal', (data) => {
                const sock = socket.current;
                if (!sock) return;
                if (data.type === 'offer') {
                    console.log('[webrtc] sending offer');
                    sock.emit('offer', { offer: data });
                } else if (data.type === 'answer') {
                    console.log('[webrtc] sending answer');
                    sock.emit('answer', { answer: data });
                } else if (data.candidate) {
                    sock.emit('ice-candidate', { candidate: data });
                }
            });

            peer.on('connect', () => {
                console.log('[webrtc] peer connected!');
                setConnectionState('connected');
                onConnectRef.current?.();
            });

            peer.on('stream', (stream) => {
                console.log('[webrtc] received call stream, tracks:',
                    stream.getTracks().map(t => `${t.kind}:${t.label}`));
                onCallStreamRef.current?.(stream);
            });

            peer.on('close', () => {
                console.log('[webrtc] peer disconnected');
                setConnectionState('disconnected');
                onDisconnectRef.current?.();
            });

            peer.on('error', (err) => {
                // Ignore "User-Initiated Abort" (happens on clean close)
                if (err.message && err.message.includes('User-Initiated Abort')) {
                    console.log('[webrtc] peer connection closed (clean abort)');
                    return;
                }
                console.error('[webrtc] error:', err.message);
                setConnectionState('disconnected');
                onDisconnectRef.current?.();
            });

            peerRef.current = peer;
            setConnectionState('connecting');
            return peer;
        },
        [socket]
    );

    // Listen for signaling events
    useEffect(() => {
        const sock = socket.current;
        if (!sock) {
            console.warn('[webrtc] socket not available yet');
            return;
        }

        console.log('[webrtc] setting up signaling listeners, isHost:', isHost);

        const handleStartWebRTC = ({ role }) => {
            console.log('[webrtc] start-webrtc event, role:', role);
            if (peerRef.current && !peerRef.current.destroyed) {
                console.log('[webrtc] peer already active, ignoring duplicate');
                return;
            }
            if (role === 'host') {
                createPeer(true);
            }
        };

        const handleOffer = ({ offer }) => {
            console.log('[webrtc] received offer');
            if (peerRef.current && !peerRef.current.destroyed) {
                console.log('[webrtc] signaling existing peer (renegotiation)');
                peerRef.current.signal(offer);
            } else {
                const peer = createPeer(false);
                peer.signal(offer);
            }
        };

        const handleAnswer = ({ answer }) => {
            console.log('[webrtc] received answer');
            if (peerRef.current && !peerRef.current.destroyed) {
                peerRef.current.signal(answer);
            }
        };

        const handleIceCandidate = ({ candidate }) => {
            if (peerRef.current && !peerRef.current.destroyed) {
                peerRef.current.signal(candidate);
            }
        };

        const handlePeerLeft = () => {
            console.log('[webrtc] peer left');
            if (peerRef.current) {
                peerRef.current.destroy();
                peerRef.current = null;
            }
            setConnectionState('disconnected');
            onDisconnectRef.current?.();
        };

        sock.on('start-webrtc', handleStartWebRTC);
        sock.on('offer', handleOffer);
        sock.on('answer', handleAnswer);
        sock.on('ice-candidate', handleIceCandidate);
        sock.on('peer-left', handlePeerLeft);

        return () => {
            sock.off('start-webrtc', handleStartWebRTC);
            sock.off('offer', handleOffer);
            sock.off('answer', handleAnswer);
            sock.off('ice-candidate', handleIceCandidate);
            sock.off('peer-left', handlePeerLeft);
        };
    }, [socket, isHost, createPeer]);

    // When callStream becomes available after peer is already connected, add it
    useEffect(() => {
        if (peerRef.current && !peerRef.current.destroyed && callStream) {
            try {
                peerRef.current.addStream(callStream);
                console.log('[webrtc] added delayed call stream to existing peer');
            } catch (e) {
                console.warn('[webrtc] could not add call stream (might already exist):', e.message);
            }
        }
    }, [callStream]);

    const reconnect = useCallback(() => {
        if (peerRef.current) {
            peerRef.current.destroy();
        }
        createPeer(isHost);
    }, [createPeer, isHost]);

    useEffect(() => {
        return () => {
            if (peerRef.current) {
                peerRef.current.destroy();
                peerRef.current = null;
            }
        };
    }, []);

    return {
        peer: peerRef,
        connectionState,
        reconnect,
    };
}
