import { useState, useCallback, useRef, useEffect } from 'react';

export default function useMediaDevices() {
    const [localStream, setLocalStream] = useState(null);
    const [cameraOn, setCameraOn] = useState(true);
    const [micOn, setMicOn] = useState(true);
    const [permissionError, setPermissionError] = useState(null);
    const streamRef = useRef(null);

    const startMedia = useCallback(async ({ video = true, audio = true } = {}) => {
        try {
            setPermissionError(null);
            const stream = await navigator.mediaDevices.getUserMedia({
                video: video
                    ? {
                        width: { ideal: 320 },
                        height: { ideal: 240 },
                        frameRate: { ideal: 15 },
                        facingMode: 'user',
                    }
                    : false,
                audio: audio
                    ? {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: { ideal: 1 },
                        sampleRate: { ideal: 48000 },
                        sampleSize: { ideal: 16 },
                        latency: { ideal: 0.02 },
                    }
                    : false,
            });

            // Apply conferencing-style processing constraints where supported.
            stream.getAudioTracks().forEach((track) => {
                track.applyConstraints({
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                }).catch(() => { });
            });

            streamRef.current = stream;
            setLocalStream(stream);
            setCameraOn(video);
            setMicOn(audio);
            return stream;
        } catch (err) {
            console.error('[media] getUserMedia error:', err);
            if (err.name === 'NotAllowedError') {
                setPermissionError('Camera/mic permission denied. Please allow access in your browser settings.');
            } else if (err.name === 'NotFoundError') {
                setPermissionError('No camera or microphone found on this device.');
            } else {
                setPermissionError(`Could not access camera/mic: ${err.message}`);
            }
            throw err; // Re-throw so RoomPage knows media failed
        }
    }, []);

    const stopMedia = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            setLocalStream(null);
        }
    }, []);

    const toggleCamera = useCallback(() => {
        if (streamRef.current) {
            const videoTracks = streamRef.current.getVideoTracks();
            videoTracks.forEach((track) => {
                track.enabled = !track.enabled;
            });
            setCameraOn((prev) => !prev);
        }
    }, []);

    const toggleMic = useCallback(() => {
        if (streamRef.current) {
            const audioTracks = streamRef.current.getAudioTracks();
            audioTracks.forEach((track) => {
                track.enabled = !track.enabled;
            });
            setMicOn((prev) => !prev);
        }
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop());
            }
        };
    }, []);

    return {
        localStream,
        cameraOn,
        micOn,
        permissionError,
        startMedia,
        stopMedia,
        toggleCamera,
        toggleMic,
    };
}
