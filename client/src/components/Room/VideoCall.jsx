import { useRef, useEffect, useState, useCallback } from 'react';

export default function VideoCall({
    localStream,
    remoteStream,
    cameraOn,
    micOn,
    toggleCamera,
    toggleMic,
    permissionError,
}) {
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const [position, setPosition] = useState({ x: 16, y: 16 });
    const [size, setSize] = useState(180);
    const [isDragging, setIsDragging] = useState(false);
    const [minimized, setMinimized] = useState(false);
    const dragOffset = useRef({ x: 0, y: 0 });

    const attachStream = useCallback((videoEl, stream, muted = false) => {
        if (!videoEl) return;
        videoEl.muted = muted;

        if (videoEl.srcObject !== stream) {
            videoEl.srcObject = stream || null;
        }

        if (stream) {
            const playPromise = videoEl.play?.();
            if (playPromise?.catch) {
                playPromise.catch(() => { });
            }
        }
    }, []);

    // Keep streams attached even after minimize/expand toggles
    useEffect(() => {
        attachStream(localVideoRef.current, localStream, true);
    }, [localStream, minimized, attachStream]);

    useEffect(() => {
        attachStream(remoteVideoRef.current, remoteStream, false);
    }, [remoteStream, minimized, attachStream]);

    // Dragging
    const handleMouseDown = useCallback((e) => {
        if (e.target.closest('button')) return;
        setIsDragging(true);
        const rect = e.currentTarget.getBoundingClientRect();
        dragOffset.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
    }, []);

    useEffect(() => {
        if (!isDragging) return;

        const handleMouseMove = (e) => {
            const parent = document.querySelector('.room__player-area');
            if (!parent) return;
            const parentRect = parent.getBoundingClientRect();
            const diameter = minimized ? 56 : size;
            const x = Math.max(0, Math.min(parentRect.width - diameter, e.clientX - parentRect.left - dragOffset.current.x));
            const y = Math.max(0, Math.min(parentRect.height - diameter, e.clientY - parentRect.top - dragOffset.current.y));
            setPosition({ x, y });
        };

        const handleMouseUp = () => setIsDragging(false);

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, minimized, size]);

    const decreaseSize = useCallback(() => {
        setSize((prev) => Math.max(140, prev - 20));
    }, []);

    const increaseSize = useCallback(() => {
        setSize((prev) => Math.min(320, prev + 20));
    }, []);

    const diameter = minimized ? 56 : size;

    return (
        <div
            className={`videocall ${minimized ? 'videocall--minimized' : ''}`}
            style={{ left: position.x, top: position.y, width: diameter, height: diameter, zIndex: 100 }}
            onMouseDown={handleMouseDown}
        >
            <div className="videocall__remote">
                {remoteStream ? (
                    <video
                        ref={remoteVideoRef}
                        className="videocall__video"
                        autoPlay
                        playsInline
                    />
                ) : (
                    <div className="videocall__placeholder">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                        </svg>
                    </div>
                )}
            </div>

            <div className="videocall__local">
                {localStream ? (
                    <video
                        ref={localVideoRef}
                        className="videocall__video videocall__video--local"
                        autoPlay
                        playsInline
                        muted
                    />
                ) : (
                    <div className="videocall__placeholder videocall__placeholder--small">
                        {permissionError ? '🚫' : '📷'}
                    </div>
                )}
            </div>

            <div className="videocall__controls">
                <button
                    className={`videocall__btn ${!cameraOn ? 'videocall__btn--off' : ''}`}
                    onClick={toggleCamera}
                    title={cameraOn ? 'Turn off camera' : 'Turn on camera'}
                >
                    {cameraOn ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="23 7 16 12 23 17 23 7" />
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M16.5 7.5L23 7v10l-6.5-.5" />
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                    )}
                </button>
                <button
                    className={`videocall__btn ${!micOn ? 'videocall__btn--off' : ''}`}
                    onClick={toggleMic}
                    title={micOn ? 'Mute mic' : 'Unmute mic'}
                >
                    {micOn ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="1" y1="1" x2="23" y2="23" />
                            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                            <path d="M17 16.95A7 7 0 0 1 5 12v-2M19 10v2a7 7 0 0 1-.11 1.23" />
                            <path d="M12 19v4M8 23h8" />
                        </svg>
                    )}
                </button>
                <button
                    className="videocall__btn"
                    onClick={decreaseSize}
                    title="Decrease size"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                </button>
                <button
                    className="videocall__btn"
                    onClick={increaseSize}
                    title="Increase size"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                </button>
                <button
                    className="videocall__btn videocall__btn--minimize"
                    onClick={() => setMinimized(true)}
                    title="Minimize"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                </button>
            </div>

            <button
                className="videocall__expand-btn"
                onClick={() => setMinimized(false)}
                title="Show video call"
            >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
            </button>
        </div>
    );
}
