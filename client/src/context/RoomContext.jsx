import { createContext, useContext, useReducer, useCallback } from 'react';

const RoomContext = createContext(null);

const initialState = {
    roomCode: null,
    role: null, // 'host' | 'viewer'
    peerConnected: false,
    movieName: null,
    movieDuration: 0,
    isPlaying: false,
    currentTime: 0,
    subtitles: [],
    subtitleFile: null,
    chatMessages: [],
    chatOpen: false,
    connectionState: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
};

function roomReducer(state, action) {
    switch (action.type) {
        case 'SET_ROOM':
            return { ...state, roomCode: action.roomCode, role: action.role };
        case 'SET_PEER_CONNECTED':
            return { ...state, peerConnected: action.connected };
        case 'SET_MOVIE':
            return { ...state, movieName: action.name, movieDuration: action.duration };
        case 'SET_PLAYING':
            return { ...state, isPlaying: action.isPlaying };
        case 'SET_CURRENT_TIME':
            return { ...state, currentTime: action.time };
        case 'SET_SUBTITLES':
            return { ...state, subtitles: action.subtitles, subtitleFile: action.filename || null };
        case 'ADD_CHAT_MESSAGE':
            return { ...state, chatMessages: [...state.chatMessages, action.message] };
        case 'TOGGLE_CHAT':
            return { ...state, chatOpen: !state.chatOpen };
        case 'SET_CHAT_OPEN':
            return { ...state, chatOpen: action.open };
        case 'SET_CONNECTION_STATE':
            return { ...state, connectionState: action.state };
        case 'SET_ROLE':
            return { ...state, role: action.role };
        case 'RESET':
            return { ...initialState };
        default:
            return state;
    }
}

export function RoomProvider({ children }) {
    const [state, dispatch] = useReducer(roomReducer, initialState);

    return (
        <RoomContext.Provider value={{ state, dispatch }}>
            {children}
        </RoomContext.Provider>
    );
}

export function useRoom() {
    const ctx = useContext(RoomContext);
    if (!ctx) throw new Error('useRoom must be used within RoomProvider');
    return ctx;
}

export default RoomContext;
