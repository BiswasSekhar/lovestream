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
    const [isDragging, setIsDragging] = useState(false);
    const [minimized, setMinimized] = useState(false);
    const dragOffset = useRef({ x: 0, y: 0 });

    // Set local video stream
    useEffect(() => {
        if (localVideoRef.current && localStream) {
            localVideoRef.current.srcObject = localStream;
        }
    }, [localStream]);

    // Set remote video stream
    useEffect(() => {
        if (remoteVideoRef.current && remoteStream) {
            remoteVideoRef.current.srcObject = remoteStream;
        }
    }, [remoteStream]);

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
            const x = Math.max(0, Math.min(parentRect.width - 200, e.clientX - parentRect.left - dragOffset.current.x));
            const y = Math.max(0, Math.min(parentRect.height - 160, e.clientY - parentRect.top - dragOffset.current.y));
            setPosition({ x, y });
        };

        const handleMouseUp = () => setIsDragging(false);

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);

    if (minimized) {
        return (
            <button
                className="videocall__expand-btn"
                onClick={() => setMinimized(false)}
                title="Show video call"
                style={{ position: 'absolute', bottom: 80, right: 16 }}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
            </button>
        );
    }

    return (
        <div
            className="videocall"
            style={{ left: position.x, top: position.y, zIndex: 100 }}
            onMouseDown={handleMouseDown}
        >
            {/* Remote video (larger) */}
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

            {/* Local video (small PiP) */}
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

            {/* Controls */}
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
                    className="videocall__btn videocall__btn--minimize"
                    onClick={() => setMinimized(true)}
                    title="Minimize"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                </button>
            </div>
        </div>
    );
}
