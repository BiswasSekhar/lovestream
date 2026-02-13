import { HashRouter, Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import RoomPage from './pages/RoomPage.jsx';

export default function App() {
    return (
        <HashRouter>
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/room/:roomCode" element={<RoomPage />} />
            </Routes>
        </HashRouter>
    );
}
