import { useState, useRef, useEffect } from 'react';

export default function Chat({ messages, onSend, role, onClose }) {
    const [text, setText] = useState('');
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSend(text.trim());
        setText('');
        inputRef.current?.focus();
    };

    const formatTimestamp = (ts) => {
        const date = new Date(ts);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <aside className="chat">
            <div className="chat__header">
                <h3 className="chat__title">Chat</h3>
                <button className="chat__close" onClick={onClose} title="Close chat">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>

            <div className="chat__messages">
                {messages.length === 0 && (
                    <div className="chat__empty">
                        <p>No messages yet</p>
                        <p className="chat__empty-hint">Say hi to your partner! 💕</p>
                    </div>
                )}
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`chat__message ${msg.sender === role ? 'chat__message--mine' : 'chat__message--theirs'}`}
                    >
                        <div className="chat__bubble">
                            <span className="chat__text">{msg.text}</span>
                            <span className="chat__timestamp">{formatTimestamp(msg.timestamp)}</span>
                        </div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>

            <form className="chat__form" onSubmit={handleSubmit}>
                <input
                    ref={inputRef}
                    type="text"
                    className="chat__input"
                    placeholder="Type a message..."
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    maxLength={500}
                />
                <button type="submit" className="chat__send" disabled={!text.trim()}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                    </svg>
                </button>
            </form>
        </aside>
    );
}
