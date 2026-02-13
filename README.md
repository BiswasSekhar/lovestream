# 💕 Lovestream

**Watch movies together, no matter the distance.** Stream a movie from your laptop to your partner with synchronized playback, video call, and real-time chat — all peer-to-peer.

## Features

- 🎬 **P2P Movie Streaming** — Stream MP4/MKV files directly from your browser
- 🔄 **Synchronized Playback** — Both users can play, pause, and seek
- 📹 **Video Call** — Draggable picture-in-picture webcam overlay
- 💬 **Real-time Chat** — Text chat alongside the movie
- 📝 **Subtitle Support** — Load SRT and ASS subtitle files
- 📱 **Mobile Friendly** — Responsive design works on any device
- 🔗 **Room Links** — Share a simple link to invite your partner

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Backend | Node.js + Express + Socket.IO |
| P2P | WebRTC via simple-peer |
| MKV Support | ffmpeg.wasm (remux, no re-encode) |

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
npm run install:all
```

### Development

```bash
npm run dev
```

This starts both the frontend (http://localhost:5173) and the signaling server (http://localhost:3001).

### Testing Locally

1. Open http://localhost:5173 in Chrome/Edge
2. Click **Create a Room**
3. Copy the room link
4. Open the link in a second browser tab
5. The host can now select a movie file and start streaming!

## Deployment

### Frontend → Vercel

1. Push to GitHub
2. Import in [vercel.com](https://vercel.com)
3. Set env var: `VITE_SERVER_URL` = your Render backend URL
4. Deploy

### Backend → Render

1. Create a new **Web Service** on [render.com](https://render.com)
2. Point it to the `server/` directory
3. Build command: `npm install`
4. Start command: `npm start`
5. Set env vars:
   - `CLIENT_URL` = your Vercel frontend URL
   - `PORT` = 3001

### TURN Server (Optional)

For users behind strict NATs (mobile networks), add a TURN server:

1. Sign up at [metered.ca](https://metered.ca) (free tier: 500MB/month)
2. Set `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` env vars on the backend

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Space / K | Play/Pause |
| F | Fullscreen |
| M | Mute/Unmute |
| ← / → | Seek -/+ 10s |
| ↑ / ↓ | Volume up/down |

## License

MIT
