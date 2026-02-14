import { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { RoomProvider, useRoom } from '../context/RoomContext.jsx';
import useSocket from '../hooks/useSocket.js';
import useWebRTC from '../hooks/useWebRTC.js';
import useWebTorrent from '../hooks/useWebTorrent.js';
import useMediaDevices from '../hooks/useMediaDevices.js';
import usePlaybackSync from '../hooks/usePlaybackSync.js';
import VideoPlayer from '../components/Room/VideoPlayer.jsx';
import VideoCall from '../components/Room/VideoCall.jsx';
import Chat from '../components/Room/Chat.jsx';
import Subtitles from '../components/Room/Subtitles.jsx';

const roomRoleKey = (code) => `lovestream.role.${code}`;

function RoomContent() {
    const { roomCode } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const [role, setRole] = useState(() => {
        const fromNav = location.state?.role;
        if (fromNav) return fromNav;
        try {
            return localStorage.getItem(roomRoleKey(roomCode)) || 'viewer';
        } catch {
            return 'viewer';
        }
    });
    const isHost = role === 'host';

    const { state, dispatch } = useRoom();
    const { socket, isConnected } = useSocket();
    const { localStream, cameraOn, micOn, permissionError, startMedia, stopMedia, toggleCamera, toggleMic } =
        useMediaDevices();

    // Video refs
    const hostVideoRef = useRef(null);
    const viewerVideoRef = useRef(null);
    const activeVideoRef = isHost ? hostVideoRef : viewerVideoRef;

    // Remote webcam stream
    const [remoteCallStream, setRemoteCallStream] = useState(null);

    // Subtitles
    const [subtitleCues, setSubtitleCues] = useState([]);
    const [currentTime, setCurrentTime] = useState(0);
    const [viewerPlayableReady, setViewerPlayableReady] = useState(false);
    const [downloadCompleteToast, setDownloadCompleteToast] = useState('');
    const [partnerDisconnected, setPartnerDisconnected] = useState(false);
    const [allowSoloPlayback, setAllowSoloPlayback] = useState(false);
    const autoStartedRef = useRef(false);

    useEffect(() => {
        try {
            localStorage.setItem(roomRoleKey(roomCode), role);
        } catch { }
    }, [roomCode, role]);

    // WebRTC (video call only — no movie stream)
    const {
        peer,
        connectionState,
        reconnect,
    } = useWebRTC({
        socket,
        isHost,
        callStream: localStream,
        onCallStream: (stream) => {
            console.log('[room] received call stream');
            setRemoteCallStream(stream);
        },
        onConnect: () => {
            dispatch({ type: 'SET_PEER_CONNECTED', connected: true });
            dispatch({ type: 'SET_CONNECTION_STATE', state: 'connected' });

            // Host: Sync state to new/reconnected peer
            if (isHost) {
                // 1. Resend movie metadata
                if (state.movieName) {
                    console.log('[room] syncing movie metadata to peer');
                    socket.current?.emit('movie-loaded', { name: state.movieName, duration: state.movieDuration });
                }

                // 2. Resend subtitles
                if (subtitleCues.length > 0) {
                    console.log('[room] syncing subtitles to peer');
                    socket.current?.emit('subtitle-data', { subtitles: subtitleCues, filename: state.subtitleFilename });
                }

                // 3. Reseed file (if selected)
                if (currentFileRef.current) {
                    console.log('[room] peer connected, re-seeding current file');
                    seedFile(currentFileRef.current);
                }
            }
        },
        onDisconnect: () => {
            dispatch({ type: 'SET_PEER_CONNECTED', connected: false });
            dispatch({ type: 'SET_CONNECTION_STATE', state: 'disconnected' });
            setRemoteCallStream(null);
        },
    });

    // File streaming via WebTorrent (P2P)
    const {
        seedFile,
        resetTransferState,
        movieBlobUrl,
        downloadProgress,
        transferSpeed,
        numPeers,
        isSending,
        isReceiving,
    } = useWebTorrent({
        socket,
        isHost,
        videoRef: isHost ? hostVideoRef : viewerVideoRef,
    });

    // Playback sync
    const playbackSync = usePlaybackSync({
        socket,
        videoRef: activeVideoRef,
        onSyncEvent: (type, time) => {
            dispatch({ type: 'SET_CURRENT_TIME', time });
            if (type === 'play') dispatch({ type: 'SET_PLAYING', isPlaying: true });
            if (type === 'pause') dispatch({ type: 'SET_PLAYING', isPlaying: false });

            // If host receives a remote play event, treat partner as ready.
            if (isHost && type === 'play') {
                setViewerPlayableReady(true);
            }
        },
    });

    // Initialize room
    useEffect(() => {
        dispatch({ type: 'SET_ROOM', roomCode, role });
    }, [roomCode, role, dispatch]);

    useEffect(() => {
        dispatch({ type: 'SET_ROLE', role });
    }, [dispatch, role]);

    const [mediaReady, setMediaReady] = useState(false);

    // Start webcam when entering room
    useEffect(() => {
        startMedia({ video: true, audio: true })
            .then(() => setMediaReady(true))
            .catch(err => console.error('[room] media failed:', err));
        return () => stopMedia();
    }, []);

    // Join/rejoin room and signal readiness for WebRTC connection
    useEffect(() => {
        const sock = socket.current;
        if (!sock || !isConnected || !mediaReady) return;

        sock.emit('join-room', { code: roomCode }, (response) => {
            if (!response.success) {
                console.error('[room] failed to join:', response.error);
                return;
            }

            const serverRole = response?.room?.role;
            if (serverRole === 'host' || serverRole === 'viewer') {
                setRole(serverRole);
            }

            console.log('[room] joined/rejoined, emitting ready-for-connection');
            sock.emit('ready-for-connection');
        });
    }, [isConnected, roomCode, socket, mediaReady]);

    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handlePeerLeft = ({ temporary }) => {
            setPartnerDisconnected(true);
            setViewerPlayableReady(false);
            autoStartedRef.current = false;

            // Pause local playback when partner disconnects.
            const v = activeVideoRef.current;
            if (v && !v.paused) {
                v.pause();
            }

            if (isHost) {
                setDownloadCompleteToast(temporary ? 'Partner disconnected. Playback paused.' : 'Partner left. Playback paused.');
                setTimeout(() => setDownloadCompleteToast(''), 2500);
            }
        };

        sock.on('peer-left', handlePeerLeft);
        return () => sock.off('peer-left', handlePeerLeft);
    }, [socket, activeVideoRef, isHost]);

    // Listen for subtitle data from host
    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleSubtitleData = ({ subtitles, filename }) => {
            setSubtitleCues(subtitles);
            dispatch({ type: 'SET_SUBTITLES', subtitles, filename });
        };

        sock.on('subtitle-data', handleSubtitleData);
        return () => sock.off('subtitle-data', handleSubtitleData);
    }, [socket, dispatch]);

    // Listen for movie metadata
    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleMovieLoaded = ({ name, duration }) => {
            dispatch({ type: 'SET_MOVIE', name, duration });
        };

        sock.on('movie-loaded', handleMovieLoaded);
        return () => sock.off('movie-loaded', handleMovieLoaded);
    }, [socket, dispatch]);

    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleViewerStreamReady = ({ progress, timestamp }) => {
            if (!isHost) return;

            setPartnerDisconnected(false);
            setViewerPlayableReady(true);
            console.log('[room] viewer stream-ready ack:', progress, timestamp);

            if (!autoStartedRef.current && hostVideoRef.current) {
                autoStartedRef.current = true;
                const startAt = hostVideoRef.current.currentTime || 0;
                hostVideoRef.current.play().catch(() => { });
                playbackSync.emitPlay(startAt);
            }
        };

        sock.on('viewer-stream-ready', handleViewerStreamReady);
        return () => sock.off('viewer-stream-ready', handleViewerStreamReady);
    }, [socket, isHost, playbackSync]);

    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleDownloadComplete = ({ name }) => {
            setDownloadCompleteToast(`✅ Download complete: ${name}`);
            setTimeout(() => setDownloadCompleteToast(''), 3000);
        };

        sock.on('torrent-download-complete', handleDownloadComplete);
        return () => sock.off('torrent-download-complete', handleDownloadComplete);
    }, [socket]);

    // Track current time for subtitles
    const handleTimeUpdate = useCallback(
        (time) => {
            setCurrentTime(time);
            dispatch({ type: 'SET_CURRENT_TIME', time });
        },
        [dispatch]
    );

    // Handle movie file ready from VideoPlayer (host)
    const handleFileReady = useCallback(
        (file, _url, options = {}) => {
            const isPreTranscodeSeed = Boolean(options.preTranscode);

            // New movie selected: require fresh viewer buffer confirmation.
            // Reset on first (pre) seed phase so host cannot start too early.
            if (isHost) {
                setViewerPlayableReady(false);
                setPartnerDisconnected(false);
                setAllowSoloPlayback(false);
                autoStartedRef.current = false;
            }

            // Keep reconnection source as finalized file only.
            if (!isPreTranscodeSeed) {
                currentFileRef.current = file;
            }

            // Seed current phase via WebTorrent.
            seedFile(file, { preTranscode: isPreTranscodeSeed });
        },
        [seedFile, isHost]
    );

    const currentFileRef = useRef(null);

    // Handle subtitles loaded by host
    const handleSubtitlesLoaded = useCallback(
        (cues, filename) => {
            setSubtitleCues(cues);
            dispatch({ type: 'SET_SUBTITLES', subtitles: cues, filename });
            // Send to peer via socket
            socket.current?.emit('subtitle-data', { subtitles: cues, filename });
        },
        [dispatch, socket]
    );

    // Chat
    const [chatUnread, setChatUnread] = useState(0);

    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleChat = (message) => {
            dispatch({ type: 'ADD_CHAT_MESSAGE', message });
            if (!state.chatOpen) {
                setChatUnread((prev) => prev + 1);
            }
        };

        sock.on('chat-message', handleChat);
        return () => sock.off('chat-message', handleChat);
    }, [socket, dispatch, state.chatOpen]);

    const sendChatMessage = useCallback(
        (text) => {
            socket.current?.emit('chat-message', { text });
        },
        [socket]
    );

    const toggleChat = useCallback(() => {
        dispatch({ type: 'TOGGLE_CHAT' });
        if (!state.chatOpen) setChatUnread(0);
    }, [dispatch, state.chatOpen]);

    const handleLeave = useCallback(() => {
        socket.current?.emit('leave-room');
        resetTransferState();
        stopMedia();
        navigate('/');
    }, [navigate, stopMedia, socket, resetTransferState]);

    const copyRoomLink = useCallback(() => {
        const url = `${window.location.origin}/room/${roomCode}`;
        navigator.clipboard.writeText(url).catch(() => { });
    }, [roomCode]);

    return (
        <div className={`room ${state.chatOpen ? 'room--chat-open' : ''}`}>
            {downloadCompleteToast && (
                <div style={{
                    position: 'fixed',
                    top: 16,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(20,20,35,0.95)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 10,
                    padding: '10px 14px',
                    zIndex: 3000,
                    fontSize: 13,
                }}>
                    {downloadCompleteToast}
                </div>
            )}

            {isHost && partnerDisconnected && (
                <div style={{
                    position: 'fixed',
                    top: 56,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(20,20,35,0.95)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 10,
                    padding: '10px 14px',
                    zIndex: 3000,
                    fontSize: 13,
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                }}>
                    <span>Partner disconnected. Playback paused.</span>
                    <button
                        className="landing__btn landing__btn--join"
                        style={{ padding: '6px 10px', fontSize: 12 }}
                        onClick={() => setAllowSoloPlayback((v) => !v)}
                    >
                        {allowSoloPlayback ? 'Disable Solo Play' : 'Play Anyway'}
                    </button>
                </div>
            )}
            {/* Top bar */}
            <header className="room__header">
                <div className="room__header-left">
                    <button className="room__back-btn" onClick={handleLeave} title="Leave room">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M19 12H5M12 5l-7 7 7 7" />
                        </svg>
                    </button>
                    <div className="room__info">
                        <span className="room__code" onClick={copyRoomLink} title="Click to copy room link">
                            {roomCode}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                        </span>
                        <span className={`room__status room__status--${connectionState}`}>
                            {connectionState === 'connected'
                                ? (isHost
                                    ? (viewerPlayableReady ? '● Partner ready to play' : '◌ Partner buffering...')
                                    : '● Partner connected')
                                : connectionState === 'connecting'
                                    ? '◌ Connecting...'
                                    : '○ Waiting for partner'}
                        </span>
                    </div>
                </div>
                <div className="room__header-right">
                    {state.movieName && (
                        <span className="room__movie-name" title={state.movieName}>
                            🎬 {state.movieName}
                        </span>
                    )}
                    <button
                        className={`room__chat-toggle ${chatUnread > 0 ? 'room__chat-toggle--unread' : ''}`}
                        onClick={toggleChat}
                        title="Toggle chat"
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        {chatUnread > 0 && <span className="room__badge">{chatUnread}</span>}
                    </button>
                </div>
            </header>

            {/* Main content */}
            <div className="room__body">
                <div className="room__player-area">
                    <VideoPlayer
                        isHost={isHost}
                        peerPlayableReady={!isHost || viewerPlayableReady}
                        allowHostSoloPlayback={allowSoloPlayback}
                        videoRef={isHost ? hostVideoRef : viewerVideoRef}
                        movieBlobUrl={movieBlobUrl}
                        downloadProgress={downloadProgress}
                        transferSpeed={transferSpeed}
                        numPeers={numPeers}
                        isReceiving={isReceiving}
                        onFileReady={handleFileReady}
                        onTimeUpdate={handleTimeUpdate}
                        onSubtitlesLoaded={handleSubtitlesLoaded}
                        playbackSync={playbackSync}
                        socket={socket}
                    />

                    {/* Subtitle overlay */}
                    <Subtitles cues={subtitleCues} currentTime={currentTime} />

                    {/* Video call PiP */}
                    <VideoCall
                        localStream={localStream}
                        remoteStream={remoteCallStream}
                        cameraOn={cameraOn}
                        micOn={micOn}
                        toggleCamera={toggleCamera}
                        toggleMic={toggleMic}
                        permissionError={permissionError}
                    />
                </div>

                {/* Chat sidebar */}
                {state.chatOpen && (
                    <Chat
                        messages={state.chatMessages}
                        onSend={sendChatMessage}
                        role={role}
                        onClose={toggleChat}
                    />
                )}
            </div>
        </div>
    );
}

export default function RoomPage() {
    return (
        <RoomProvider>
            <RoomContent />
        </RoomProvider>
    );
}
