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
const roomRoleMetaKey = (code) => `lovestream.role.meta.${code}`;
const DEFAULT_RECONNECT_GRACE_MS = 24 * 60 * 60 * 1000;

function getStoredRoomRole(code) {
    try {
        const role = localStorage.getItem(roomRoleKey(code));
        const rawMeta = localStorage.getItem(roomRoleMetaKey(code));
        if (!role) return null;

        if (rawMeta) {
            const meta = JSON.parse(rawMeta);
            if (meta?.expiresAt && Date.now() > meta.expiresAt) {
                localStorage.removeItem(roomRoleKey(code));
                localStorage.removeItem(roomRoleMetaKey(code));
                return null;
            }
        }

        return role;
    } catch {
        return null;
    }
}

function setStoredRoomRole(code, role, ttlMs = DEFAULT_RECONNECT_GRACE_MS) {
    try {
        localStorage.setItem(roomRoleKey(code), role);
        localStorage.setItem(roomRoleMetaKey(code), JSON.stringify({
            expiresAt: Date.now() + Math.max(1000, ttlMs),
        }));
    } catch { }
}

function RoomContent() {
    const { roomCode } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const [role, setRole] = useState(() => {
        const fromNav = location.state?.role;
        if (fromNav) return fromNav;
        return getStoredRoomRole(roomCode) || 'viewer';
    });
    const isHost = role === 'host';

    const { state, dispatch } = useRoom();
    const { socket, isConnected, getParticipantId, getClientCapabilities } = useSocket();
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
    const [roomMode, setRoomMode] = useState('web-compatible');
    const [usingLocalPlayback, setUsingLocalPlayback] = useState(false);
    const [peerUsingLocalPlayback, setPeerUsingLocalPlayback] = useState(false);
    const [manualSeedMode, setManualSeedMode] = useState(true);
    const [pendingSeedFile, setPendingSeedFile] = useState(null);
    const autoStartedRef = useRef(false);
    const currentFileRef = useRef(null);
    const seedFileRef = useRef(null);

    useEffect(() => {
        setStoredRoomRole(roomCode, role, DEFAULT_RECONNECT_GRACE_MS);
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
                if (currentFileRef.current && !peerUsingLocalPlayback && !manualSeedMode) {
                    console.log('[room] peer connected, re-seeding current file');
                    seedFileRef.current?.(currentFileRef.current);
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
        completedDownload,
        clearCompletedDownload,
    } = useWebTorrent({
        socket,
        isHost,
        roomCode,
        videoRef: isHost ? hostVideoRef : viewerVideoRef,
        disableViewerTorrent: !isHost && usingLocalPlayback,
    });

    useEffect(() => {
        seedFileRef.current = seedFile;
    }, [seedFile]);

    useEffect(() => {
        if (!isHost || manualSeedMode || !pendingSeedFile) return;
        const { file, streamPath } = pendingSeedFile;
        seedFile(file, { preTranscode: false, streamPath });
        setPendingSeedFile(null);
    }, [isHost, manualSeedMode, pendingSeedFile, seedFile]);

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

        let retryTimer = null;
        let retryCount = 0;
        const MAX_VIEWER_RETRIES = 5;
        const RETRY_DELAY_MS = 3000;

        const handleJoinResponse = (response) => {
            if (!response.success) {
                console.error('[room] failed to join:', response.error);

                // If room not found (server restarted), host re-creates it
                if (isHost && /not found/i.test(response.error || '')) {
                    console.log('[room] server lost room state — host re-creating room', roomCode);
                    sock.emit('create-room', {
                        participantId: getParticipantId(),
                        capabilities: getClientCapabilities(),
                        requestedCode: roomCode,
                    }, (createResp) => {
                        if (createResp.success) {
                            console.log('[room] room re-created, joining…');
                            sock.emit('join-room', {
                                code: roomCode,
                                participantId: getParticipantId(),
                                capabilities: getClientCapabilities(),
                            }, handleJoinResponse);
                        } else {
                            console.error('[room] re-create failed:', createResp.error);
                        }
                    });
                }

                // Viewer: room not found → host may not have re-created it yet, retry
                if (!isHost && /not found/i.test(response.error || '') && retryCount < MAX_VIEWER_RETRIES) {
                    retryCount++;
                    console.log(`[room] viewer retrying join in ${RETRY_DELAY_MS}ms (attempt ${retryCount}/${MAX_VIEWER_RETRIES})`);
                    retryTimer = setTimeout(() => {
                        sock.emit('join-room', {
                            code: roomCode,
                            participantId: getParticipantId(),
                            capabilities: getClientCapabilities(),
                        }, handleJoinResponse);
                    }, RETRY_DELAY_MS);
                }
                return;
            }

            retryCount = 0;
            const serverRole = response?.room?.role;
            const mode = response?.mode || 'web-compatible';
            const reconnectGraceMs = response?.reconnectGraceMs || DEFAULT_RECONNECT_GRACE_MS;
            setRoomMode(mode);
            if (serverRole === 'host' || serverRole === 'viewer') {
                setStoredRoomRole(roomCode, serverRole, reconnectGraceMs);
                setRole(serverRole);
            }

            console.log('[room] joined/rejoined, emitting ready-for-connection');
            sock.emit('ready-for-connection');

            // After reconnect, host re-syncs playback position so viewer catches up
            const videoEl = isHost ? hostVideoRef.current : viewerVideoRef.current;
            if (isHost && videoEl && videoEl.currentTime > 0) {
                setTimeout(() => {
                    const time = videoEl.currentTime;
                    const paused = videoEl.paused;
                    console.log('[room] re-syncing playback position:', time, paused ? 'paused' : 'playing');
                    sock.emit('sync-seek', { time, actionId: `resync-${Date.now()}` });
                    if (!paused) {
                        sock.emit('sync-play', { time, actionId: `resync-play-${Date.now()}` });
                    } else {
                        sock.emit('sync-pause', { time, actionId: `resync-pause-${Date.now()}` });
                    }
                }, 2000); // wait for viewer to also reconnect
            }
        };

        sock.emit('join-room', {
            code: roomCode,
            participantId: getParticipantId(),
            capabilities: getClientCapabilities(),
        }, handleJoinResponse);

        return () => {
            if (retryTimer) clearTimeout(retryTimer);
        };
    }, [isConnected, roomCode, socket, mediaReady, isHost, getParticipantId, getClientCapabilities]);

    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleRoomMode = ({ mode }) => {
            setRoomMode(mode || 'web-compatible');
        };

        sock.on('room-mode', handleRoomMode);
        return () => sock.off('room-mode', handleRoomMode);
    }, [socket]);

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
            if (!isHost && usingLocalPlayback) return;
            setSubtitleCues(subtitles);
            dispatch({ type: 'SET_SUBTITLES', subtitles, filename });
        };

        sock.on('subtitle-data', handleSubtitleData);
        return () => sock.off('subtitle-data', handleSubtitleData);
    }, [socket, dispatch, isHost, usingLocalPlayback]);

    // Listen for movie metadata
    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleMovieLoaded = ({ name, duration }) => {
            dispatch({ type: 'SET_MOVIE', name, duration });
        };

        const handlePlaybackSnapshot = ({ playback }) => {
            if (!playback || typeof playback.time !== 'number') return;
            const video = activeVideoRef.current;
            if (!video) return;

            const time = Math.max(0, playback.time || 0);
            video.currentTime = time;
            dispatch({ type: 'SET_CURRENT_TIME', time });

            if (playback.type === 'play') {
                video.play().catch(() => { });
                dispatch({ type: 'SET_PLAYING', isPlaying: true });
            } else {
                video.pause();
                dispatch({ type: 'SET_PLAYING', isPlaying: false });
            }
        };

        sock.on('movie-loaded', handleMovieLoaded);
        sock.on('playback-snapshot', handlePlaybackSnapshot);
        return () => {
            sock.off('movie-loaded', handleMovieLoaded);
            sock.off('playback-snapshot', handlePlaybackSnapshot);
        };
    }, [socket, dispatch, activeVideoRef]);

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

        const handleViewerLocalPlayback = ({ enabled }) => {
            if (!isHost) return;
            const localEnabled = Boolean(enabled);
            setPeerUsingLocalPlayback(localEnabled);

            if (localEnabled) {
                resetTransferState();
                setDownloadCompleteToast('Partner switched to local copy. P2P transfer stopped.');
                setTimeout(() => setDownloadCompleteToast(''), 2500);
            }
        };

        sock.on('viewer-local-playback', handleViewerLocalPlayback);
        return () => sock.off('viewer-local-playback', handleViewerLocalPlayback);
    }, [socket, isHost, resetTransferState]);

    useEffect(() => {
        const sock = socket.current;
        if (!sock) return;

        const handleDownloadComplete = ({ name }) => {
            setDownloadCompleteToast(`Download complete: ${name}`);
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
            const streamPath = options.streamPath || 'direct';

            // New movie selected: require fresh viewer buffer confirmation.
            // Reset on first (pre) seed phase so host cannot start too early.
            if (isHost) {
                setViewerPlayableReady(false);
                setPartnerDisconnected(false);
                setAllowSoloPlayback(false);
                setPeerUsingLocalPlayback(false);
                autoStartedRef.current = false;
            }

            // Keep reconnection source as finalized file only.
            if (!isPreTranscodeSeed) {
                currentFileRef.current = file;

                if (isHost && manualSeedMode) {
                    resetTransferState();
                    setPendingSeedFile({ file, streamPath });
                    setDownloadCompleteToast('Movie ready. Click Start Seeding when you want to share.');
                    setTimeout(() => setDownloadCompleteToast(''), 2500);
                    return;
                }
            }

            // Seed current phase via WebTorrent — include streamPath so viewer
            // knows which playback pipeline to use (direct / remux / transcode).
            seedFile(file, { preTranscode: isPreTranscodeSeed, streamPath });
        },
        [seedFile, isHost, manualSeedMode, resetTransferState]
    );

    const handleStartSeeding = useCallback(() => {
        if (!pendingSeedFile) return;
        const { file, streamPath } = pendingSeedFile;
        seedFile(file, { preTranscode: false, streamPath });
        setPendingSeedFile(null);
    }, [pendingSeedFile, seedFile]);

    // Handle subtitles loaded by host
    const handleSubtitlesLoaded = useCallback(
        (cues, filename, options = {}) => {
            setSubtitleCues(cues);
            dispatch({ type: 'SET_SUBTITLES', subtitles: cues, filename });
            if (!options.localOnly) {
                socket.current?.emit('subtitle-data', { subtitles: cues, filename });
            }
        },
        [dispatch, socket]
    );

    const handleLocalPlaybackToggle = useCallback((enabled) => {
        const localEnabled = Boolean(enabled);
        setUsingLocalPlayback(localEnabled);
        if (!isHost) {
            socket.current?.emit('viewer-local-playback', {
                enabled: localEnabled,
                timestamp: Date.now(),
            });
        }
    }, [isHost, socket]);

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
                <div className="toast">
                    {downloadCompleteToast}
                </div>
            )}

            {isHost && partnerDisconnected && (
                <div className="toast toast--warning">
                    <span>Partner disconnected. Playback paused.</span>
                    <button
                        className="toast__btn"
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
                    {isHost && (
                        <button
                            className={`room__seed-toggle ${manualSeedMode ? 'room__seed-toggle--active' : ''}`}
                            onClick={() => setManualSeedMode((v) => !v)}
                            title="Toggle manual seeding mode"
                        >
                            {manualSeedMode ? 'Manual Seed: ON' : 'Manual Seed: OFF'}
                        </button>
                    )}
                    {isHost && manualSeedMode && pendingSeedFile && (
                        <button
                            className="room__seed-start"
                            onClick={handleStartSeeding}
                            title="Start seeding now"
                        >
                            Start Seeding
                        </button>
                    )}
                    <span className="room__movie-name" title={`Room mode: ${roomMode}`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            {roomMode === 'native'
                                ? <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                                : <circle cx="12" cy="12" r="10" />
                            }
                        </svg>
                        {roomMode === 'native' ? 'Native' : 'Web'}
                    </span>
                    {state.movieName && (
                        <span className="room__movie-name" title={state.movieName}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polygon points="23 7 16 12 23 17 23 7" />
                                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                            </svg>
                            {state.movieName}
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
                        roomCode={roomCode}
                        isHost={isHost}
                        roomMode={roomMode}
                        movieName={state.movieName}
                        peerPlayableReady={!isHost || viewerPlayableReady}
                        allowHostSoloPlayback={allowSoloPlayback}
                        videoRef={isHost ? hostVideoRef : viewerVideoRef}
                        movieBlobUrl={movieBlobUrl}
                        downloadProgress={downloadProgress}
                        transferSpeed={transferSpeed}
                        numPeers={numPeers}
                        isSending={isSending}
                        isReceiving={isReceiving}
                        resetTransferState={resetTransferState}
                        usingLocalPlayback={usingLocalPlayback}
                        onLocalPlaybackToggle={handleLocalPlaybackToggle}
                        onFileReady={handleFileReady}
                        onTimeUpdate={handleTimeUpdate}
                        onSubtitlesLoaded={handleSubtitlesLoaded}
                        playbackSync={playbackSync}
                        socket={socket}
                        completedDownload={completedDownload}
                        clearCompletedDownload={clearCompletedDownload}
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
