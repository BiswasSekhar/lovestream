import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useSocket from '../../hooks/useSocket.js';

export default function Landing() {
    const [joinCode, setJoinCode] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { isConnected, createRoom, joinRoom } = useSocket();
    const navigate = useNavigate();

    const handleCreate = async () => {
        setError('');
        setLoading(true);
        try {
            const room = await createRoom();
            navigate(`/room/${room.code}`, { state: { role: 'host' } });
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleJoin = async (e) => {
        e.preventDefault();
        if (!joinCode.trim()) {
            setError('Please enter a room code');
            return;
        }
        setError('');
        setLoading(true);
        try {
            const room = await joinRoom(joinCode.trim().toUpperCase());
            navigate(`/room/${room.code}`, { state: { role: 'viewer' } });
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="landing">
            <div className="landing__bg">
                <div className="landing__orb landing__orb--1" />
                <div className="landing__orb landing__orb--2" />
                <div className="landing__orb landing__orb--3" />
            </div>

            <div className="landing__content">
                <div className="landing__hero">
                    <div className="landing__icon">
                        <svg viewBox="0 0 64 64" width="80" height="80">
                            <defs>
                                <linearGradient id="hero-g" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" style={{ stopColor: '#ec4899' }} />
                                    <stop offset="100%" style={{ stopColor: '#8b5cf6' }} />
                                </linearGradient>
                            </defs>
                            <circle cx="32" cy="32" r="30" fill="url(#hero-g)" opacity="0.9" />
                            <path d="M26 20 L26 44 L46 32 Z" fill="white" opacity="0.95" />
                        </svg>
                    </div>
                    <h1 className="landing__title">Lovestream</h1>
                    <p className="landing__tagline">Your private cinema for two</p>
                </div>

                <div className="landing__card">
                    <div className="landing__status">
                        <span className={`landing__dot ${isConnected ? 'landing__dot--on' : ''}`} />
                        {isConnected ? 'Connected to server' : 'Connecting...'}
                    </div>

                    <button
                        className="landing__btn landing__btn--create"
                        onClick={handleCreate}
                        disabled={!isConnected || loading}
                    >
                        {loading ? (
                            <span className="landing__spinner" />
                        ) : (
                            <>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M12 5v14M5 12h14" />
                                </svg>
                                Create a Room
                            </>
                        )}
                    </button>

                    <div className="landing__divider">
                        <span>or join one</span>
                    </div>

                    <form className="landing__join" onSubmit={handleJoin}>
                        <input
                            type="text"
                            className="landing__input"
                            placeholder="Enter room code"
                            value={joinCode}
                            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                            maxLength={6}
                            disabled={!isConnected || loading}
                        />
                        <button
                            type="submit"
                            className="landing__btn landing__btn--join"
                            disabled={!isConnected || loading || !joinCode.trim()}
                        >
                            Join
                        </button>
                    </form>

                    {error && <div className="landing__error">{error}</div>}
                </div>

                <div className="landing__features">
                    <div className="landing__feature">
                        <span className="landing__feature-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="23 7 16 12 23 17 23 7" />
                                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                            </svg>
                        </span>
                        <span>Stream movies P2P</span>
                    </div>
                    <div className="landing__feature">
                        <span className="landing__feature-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                <circle cx="12" cy="7" r="4" />
                            </svg>
                        </span>
                        <span>Video call while watching</span>
                    </div>
                    <div className="landing__feature">
                        <span className="landing__feature-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                        </span>
                        <span>Chat in real-time</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
