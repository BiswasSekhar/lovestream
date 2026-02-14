import { useState, useRef, useCallback, useEffect } from 'react';
import { formatTime } from '../../utils/roomCode.js';

export default function Controls({ videoRef, isHost, playbackSync, onSubtitleFile }) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [isSeeking, setIsSeeking] = useState(false);
    const hideTimer = useRef(null);
    const seekBarRef = useRef(null);

    // Track video state
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onTimeUpdate = () => {
            if (!isSeeking) setCurrentTime(video.currentTime);
        };
        const onDurationChange = () => setDuration(video.duration || 0);
        const onVolumeChange = () => {
            setVolume(video.volume);
            setIsMuted(video.muted);
        };

        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPause);
        video.addEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('durationchange', onDurationChange);
        video.addEventListener('volumechange', onVolumeChange);

        return () => {
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPause);
            video.removeEventListener('timeupdate', onTimeUpdate);
            video.removeEventListener('durationchange', onDurationChange);
            video.removeEventListener('volumechange', onVolumeChange);
        };
    }, [videoRef, isSeeking]);

    // Auto-hide controls
    const resetHideTimer = useCallback(() => {
        setShowControls(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
            if (isPlaying) setShowControls(false);
        }, 3000);
    }, [isPlaying]);

    useEffect(() => {
        resetHideTimer();
        return () => {
            if (hideTimer.current) clearTimeout(hideTimer.current);
        };
    }, [isPlaying]);

    // Toggle play/pause
    const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
            video.play().catch(() => { });
        } else {
            video.pause();
        }
    }, [videoRef]);

    // Seek
    const handleSeekStart = useCallback(() => {
        setIsSeeking(true);
    }, []);

    const handleSeekChange = useCallback(
        (e) => {
            const time = parseFloat(e.target.value);
            setCurrentTime(time);
        },
        []
    );

    const handleSeekEnd = useCallback(
        (e) => {
            const time = parseFloat(e.target.value);
            if (videoRef.current) {
                videoRef.current.currentTime = time;
            }
            setIsSeeking(false);
        },
        [videoRef]
    );

    // Volume
    const handleVolume = useCallback(
        (e) => {
            const vol = parseFloat(e.target.value);
            if (videoRef.current) {
                videoRef.current.volume = vol;
                videoRef.current.muted = vol === 0;
            }
        },
        [videoRef]
    );

    const toggleMute = useCallback(() => {
        if (videoRef.current) {
            videoRef.current.muted = !videoRef.current.muted;
        }
    }, [videoRef]);

    // Fullscreen
    const toggleFullscreen = useCallback(() => {
        const playerEl = videoRef.current?.closest('.player') || videoRef.current?.closest('.room__player-area');
        if (!playerEl) return;

        if (document.fullscreenElement) {
            document.exitFullscreen();
            setIsFullscreen(false);
        } else {
            playerEl.requestFullscreen().catch(() => { });
            setIsFullscreen(true);
        }
    }, [videoRef]);

    useEffect(() => {
        const handleFSChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFSChange);
        return () => document.removeEventListener('fullscreenchange', handleFSChange);
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKey = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            switch (e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'f':
                    e.preventDefault();
                    toggleFullscreen();
                    break;
                case 'm':
                    e.preventDefault();
                    toggleMute();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    if (videoRef.current) videoRef.current.currentTime -= 10;
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    if (videoRef.current) videoRef.current.currentTime += 10;
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (videoRef.current) videoRef.current.volume = Math.min(1, videoRef.current.volume + 0.1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    if (videoRef.current) videoRef.current.volume = Math.max(0, videoRef.current.volume - 0.1);
                    break;
            }
        };

        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [togglePlay, toggleFullscreen, toggleMute, videoRef]);

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <div
            className={`controls ${showControls ? 'controls--visible' : ''}`}
            onMouseMove={resetHideTimer}
            onTouchStart={resetHideTimer}
        >
            {/* Click to play/pause overlay */}
            <div className="controls__overlay" onClick={togglePlay} />

            {/* Bottom bar */}
            <div className="controls__bar">
                {/* Seek bar */}
                <div className="controls__seek" ref={seekBarRef}>
                    <input
                        type="range"
                        className="controls__seek-input"
                        min={0}
                        max={duration || 0}
                        step={0.1}
                        value={currentTime}
                        onMouseDown={handleSeekStart}
                        onTouchStart={handleSeekStart}
                        onChange={handleSeekChange}
                        onMouseUp={handleSeekEnd}
                        onTouchEnd={handleSeekEnd}
                        style={{ '--progress': `${progress}%` }}
                    />
                </div>

                <div className="controls__row">
                    {/* Left controls */}
                    <div className="controls__left">
                        <button className="controls__btn" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
                            {isPlaying ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                    <rect x="6" y="4" width="4" height="16" />
                                    <rect x="14" y="4" width="4" height="16" />
                                </svg>
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            )}
                        </button>

                        <div className="controls__volume">
                            <button className="controls__btn" onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}>
                                {isMuted || volume === 0 ? (
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                        <line x1="23" y1="9" x2="17" y2="15" />
                                        <line x1="17" y1="9" x2="23" y2="15" />
                                    </svg>
                                ) : (
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                    </svg>
                                )}
                            </button>
                            <input
                                type="range"
                                className="controls__volume-slider"
                                min={0}
                                max={1}
                                step={0.05}
                                value={isMuted ? 0 : volume}
                                onChange={handleVolume}
                            />
                        </div>

                        <span className="controls__time">
                            {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                    </div>

                    {/* Right controls */}
                    <div className="controls__right">
                        <button className="controls__btn" onClick={onSubtitleFile} title="Load subtitles">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="2" y="6" width="20" height="12" rx="2" />
                                <path d="M7 12h4M13 12h4M7 15h10" />
                            </svg>
                        </button>

                        <button className="controls__btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                            {isFullscreen ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
                                </svg>
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
                                </svg>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
