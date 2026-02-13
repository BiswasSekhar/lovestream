---
description: How to build Electron installers for Windows and macOS
---

# Build Electron Installers

## Prerequisites
- Node.js 18+ installed
- Run `npm install` in the `client` directory first
- Ensure `.env.production` exists in `client/` with `VITE_SERVER_URL=https://your-backend-url.onrender.com`

## Windows Build (run on Windows)

// turbo
1. Navigate to the client directory:
```powershell
cd client
```

// turbo
2. Build the Vite frontend:
```powershell
npx vite build
```

3. Build the Windows installer (NSIS):
```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; npx electron-builder build --win nsis --x64
```

4. The installer will be at:
```
client/dist_electron/Lovestream Setup 1.0.0.exe
```

> **Note:** If `winCodeSign` errors occur, follow the manual download steps in the setup guide.

## macOS Build (run on macOS)

// turbo
1. Navigate to the client directory:
```bash
cd client
```

// turbo
2. Install dependencies:
```bash
npm install
```

// turbo
3. Build the Vite frontend:
```bash
npx vite build
```

4. Build the macOS DMG and ZIP:
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder build --mac dmg zip --x64
```

5. The installer will be at:
```
client/dist_electron/Lovestream-1.0.0.dmg
client/dist_electron/Lovestream-1.0.0-mac.zip
```

> **Note:** For Apple Silicon (M1/M2/M3), replace `--x64` with `--arm64`, or build both with `--x64 --arm64`.

## Linux Build (run on Linux)

// turbo
1. Navigate to the client directory:
```bash
cd client
```

// turbo
2. Install dependencies:
```bash
npm install
```

// turbo
3. Build the Vite frontend:
```bash
npx vite build
```

4. Build the Linux AppImage:
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder build --linux AppImage --x64
```

5. The AppImage will be at:
```
client/dist_electron/Lovestream-1.0.0.AppImage
```

## Icon Conversion (if logo changes)

// turbo
1. Place the new logo at `client/public/logo.png`
// turbo
2. Run the conversion script:
```bash
node scripts/convert-icon.mjs
```
This creates `favicon.ico` (Windows) and `logo-256.png` (macOS/Linux).
