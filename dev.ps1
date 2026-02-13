# Lovestream - Local Development Script
# Starts server, client, and Cloudflare tunnels for testing
# Usage: powershell -ExecutionPolicy Bypass -File dev.ps1

Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "   Lovestream - Local Dev Launcher" -ForegroundColor Magenta  
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""

$ROOT = $PSScriptRoot

# ---- Step 1: Start the Server ----
Write-Host "[1/4] Starting server..." -ForegroundColor Cyan
$serverJob = Start-Job -ScriptBlock {
    Set-Location $using:ROOT\server
    node index.js
}
Start-Sleep -Seconds 2

# ---- Step 2: Start Cloudflare tunnel for server ----
Write-Host "[2/4] Creating tunnel for server (port 3001)..." -ForegroundColor Cyan

# Start cloudflared and capture the tunnel URL
$tunnelLogFile = "$env:TEMP\lovestream_tunnel.log"
$tunnelProcess = Start-Process -FilePath "npx" -ArgumentList "-y cloudflared tunnel --url http://localhost:3001" `
    -RedirectStandardError $tunnelLogFile -PassThru -NoNewWindow -WindowStyle Hidden

# Wait for the tunnel URL to appear in logs
$tunnelUrl = $null
$attempts = 0
while (-not $tunnelUrl -and $attempts -lt 30) {
    Start-Sleep -Seconds 1
    $attempts++
    if (Test-Path $tunnelLogFile) {
        $content = Get-Content $tunnelLogFile -Raw -ErrorAction SilentlyContinue
        if ($content -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
            $tunnelUrl = $Matches[1]
        }
    }
}

if (-not $tunnelUrl) {
    Write-Host "[ERROR] Could not get tunnel URL after 30s. Check your internet connection." -ForegroundColor Red
    Write-Host "You can manually run: npx -y cloudflared tunnel --url http://localhost:3001" -ForegroundColor Yellow
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ""
Write-Host "  Server tunnel: $tunnelUrl" -ForegroundColor Green
Write-Host ""

# ---- Step 3: Update .env.local with tunnel URL ----
Write-Host "[3/4] Updating client/.env.local..." -ForegroundColor Cyan
$envFile = "$ROOT\client\.env.local"
Set-Content -Path $envFile -Value "VITE_SERVER_URL=$tunnelUrl"
Write-Host "  Set VITE_SERVER_URL=$tunnelUrl" -ForegroundColor Gray

# ---- Step 4: Start the Client ----
Write-Host "[4/4] Starting client (Vite dev server)..." -ForegroundColor Cyan
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Everything is running!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Local:   http://localhost:5173" -ForegroundColor White
Write-Host "  Server:  $tunnelUrl" -ForegroundColor White
Write-Host ""
Write-Host "  Share the localhost URL with your" -ForegroundColor Gray
Write-Host "  friend on the same network, or use" -ForegroundColor Gray
Write-Host "  the server tunnel for remote access." -ForegroundColor Gray
Write-Host ""
Write-Host "  Press Ctrl+C to stop everything." -ForegroundColor Yellow
Write-Host ""

# Run the client in foreground so Ctrl+C stops everything
try {
    Set-Location "$ROOT\client"
    npm run dev
}
finally {
    # Cleanup on exit
    Write-Host ""
    Write-Host "Shutting down..." -ForegroundColor Yellow
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -ErrorAction SilentlyContinue
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $tunnelLogFile -ErrorAction SilentlyContinue
    Write-Host "Done!" -ForegroundColor Green
}
