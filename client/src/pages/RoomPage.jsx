import { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { RoomProvider, useRoom } from '../context/RoomContext.jsx';
import useSocket from '../hooks/useSocket.js';
import useWebRTC from '../hooks/useWebRTC.js';
import useFileStream from '../hooks/useFileStream.js';
import useMediaDevices from '../hooks/useMediaDevices.js';
import usePlaybackSync from '../hooks/usePlaybackSync.js';
import VideoPlayer from '../components/Room/VideoPlayer.jsx';
import VideoCall from '../components/Room/VideoCall.jsx';
import Chat from '../components/Room/Chat.jsx';
import Subtitles from '../components/Room/Subtitles.jsx';

function RoomContent() {
    const { roomCode } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const role = location.state?.role || 'viewer';
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

                // 3. Resend file (if selected)
                if (currentFileRef.current) {
                    console.log('[room] peer connected, offering current file');
                    sendFile(currentFileRef.current);
                }
            }
        },
        onDisconnect: () => {
            dispatch({ type: 'SET_PEER_CONNECTED', connected: false });
            dispatch({ type: 'SET_CONNECTION_STATE', state: 'disconnected' });
            setRemoteCallStream(null);
        },
    });

    // Stream handlers (bridge between useFileStream and VideoPlayer)
    const streamHandlersRef = useRef({
        onMeta: null,
        onChunk: null,
    });

    // File streaming over data channel
    const {
        sendFile,
        movieBlobUrl,
        downloadProgress,
        isSending,
        isReceiving,
    } = useFileStream({
        peer,
        isHost,
        onMeta: (meta) => streamHandlersRef.current.onMeta?.(meta),
        onChunk: (chunk) => streamHandlersRef.current.onChunk?.(chunk),
    });

    // Playback sync
    const playbackSync = usePlaybackSync({
        socket,
        videoRef: activeVideoRef,
        onSyncEvent: (type, time) => {
            dispatch({ type: 'SET_CURRENT_TIME', time });
            if (type === 'play') dispatch({ type: 'SET_PLAYING', isPlaying: true });
            if (type === 'pause') dispatch({ type: 'SET_PLAYING', isPlaying: false });
        },
    });

    // Initialize room
    useEffect(() => {
        dispatch({ type: 'SET_ROOM', roomCode, role });
    }, [roomCode, role, dispatch]);

    const [mediaReady, setMediaReady] = useState(false);

    // Start webcam when entering room
    useEffect(() => {
        startMedia({ video: true, audio: true }).then(() => setMediaReady(true));
        return () => stopMedia();
    }, []);

    // Signal readiness for WebRTC connection
    useEffect(() => {
        const sock = socket.current;
        if (!sock || !isConnected || !mediaReady) return;

        // If viewer, also re-join the room socket room (for reconnection)
        if (!isHost) {
            sock.emit('join-room', { code: roomCode }, (response) => {
                if (!response.success) {
                    console.error('[room] failed to join:', response.error);
                    return;
                }
                // Now signal we're ready for WebRTC
                console.log('[room] viewer ready, emitting ready-for-connection');
                sock.emit('ready-for-connection');
            });
        } else {
            // Host is already in the room, just signal readiness
            console.log('[room] host ready, emitting ready-for-connection');
            sock.emit('ready-for-connection');
        }
    }, [isConnected, isHost, roomCode, socket, mediaReady]);

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
        (file) => {
            // Track current file for reconnection sync
            currentFileRef.current = file;

            // Send the file to the viewer via data channel
            if (connectionState === 'connected') {
                sendFile(file);
            } else {
                console.log('[room] peer not connected yet, will send when connected');
                // Store file ref to send when connected
                pendingFileRef.current = file;
            }
        },
        [connectionState, sendFile]
    );

    const pendingFileRef = useRef(null);
    const currentFileRef = useRef(null);

    // Send pending file when connection establishes
    useEffect(() => {
        if (connectionState === 'connected' && pendingFileRef.current) {
            sendFile(pendingFileRef.current);
            pendingFileRef.current = null;
        }
    }, [connectionState, sendFile]);

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
        stopMedia();
        navigate('/');
    }, [navigate, stopMedia]);

    const copyRoomLink = useCallback(() => {
        const url = `${window.location.origin}/room/${roomCode}`;
        navigator.clipboard.writeText(url).catch(() => { });
    }, [roomCode]);

    return (
        <div className={`room ${state.chatOpen ? 'room--chat-open' : ''}`}>
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
                            {connectionState === 'connected' ? '● Partner connected' : connectionState === 'connecting' ? '◌ Connecting...' : '○ Waiting for partner'}
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
                        videoRef={isHost ? hostVideoRef : viewerVideoRef}
                        movieBlobUrl={movieBlobUrl}
                        downloadProgress={downloadProgress}
                        isReceiving={isReceiving}
                        onFileReady={handleFileReady}
                        onTimeUpdate={handleTimeUpdate}
                        onSubtitlesLoaded={handleSubtitlesLoaded}
                        playbackSync={playbackSync}
                        socket={socket}
                        streamHandlersRef={streamHandlersRef}
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
