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

### Instant Share (No Deployment Needed!)

Want to use this *right now* without deploying to a server? We have a magic script for that!

**For Windows Users:**
1. Clone the repo
2. Run the all-in-one development script:
   ```powershell
   powershell -ExecutionPolicy Bypass -File dev.ps1
   ```
3. This script will:
   - Start the backend server
   - Start the frontend client
   - **Create public Cloudflare tunnels** for both! 🤯
4. Look for the **"OTHER LAPTOP"** link in the terminal output. Send that link to your partner, and you're good to go!

---

## Deployment

### 1. Backend (The Signal Tower)
*The backend is just a small signaling server. It doesn't handle video traffic.*

**Deploy to Render.com (Free Tier):**
1. Create a new **Web Service** connected to your repo.
2. Root Directory: `server`
3. Build Command: `npm install`
4. Start Command: `npm start`
5. **Environment Variables:**
   - `CLIENT_URL`: The URL of your frontend (e.g., `https://my-lovestream.vercel.app`)
   - `PORT`: `3001`
   - *(Optional) TURN config if needed*

### 2. Frontend (The Theater)
**Deploy to Vercel (Free Tier):**
1. Import your repo into Vercel.
2. Root Directory: `client`
3. Build Command: `npm run build`
4. **Environment Variables:**
   - `VITE_SERVER_URL`: The URL of your Render backend (e.g., `https://my-lovestream-api.onrender.com`)

### 3. Connection Issues? (Optional TURN Server)
If you can't connect (likely due to strict firewalls or mobile data), you need a TURN server.
1. Sign up for a free account at [Metered.ca](https://metered.ca) (500MB free is plenty for signaling).
2. Add these env vars to your **Backend (Render)**:
   - `TURN_URL`: `turn:global.turn.metered.ca:80`
   - `TURN_USERNAME`: `your_metered_username`
   - `TURN_CREDENTIAL`: `your_metered_password`

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
