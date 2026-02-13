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
Write-Host "[1/5] Starting server..." -ForegroundColor Cyan
$serverJob = Start-Job -ScriptBlock {
    Set-Location "$using:ROOT\server"
    node index.js
}
Start-Sleep -Seconds 2

# ---- Step 2: Create tunnel for server ----
Write-Host "[2/5] Creating tunnel for server (port 3001)..." -ForegroundColor Cyan

$serverTunnelLog = "$env:TEMP\lovestream_server_tunnel.log"
$serverTunnel = Start-Process -FilePath "npx" -ArgumentList "-y cloudflared tunnel --url http://localhost:3001" `
    -RedirectStandardError $serverTunnelLog -PassThru -NoNewWindow -WindowStyle Hidden

# Wait for server tunnel URL
$serverTunnelUrl = $null
$attempts = 0
while (-not $serverTunnelUrl -and $attempts -lt 30) {
    Start-Sleep -Seconds 1
    $attempts++
    if (Test-Path $serverTunnelLog) {
        $content = Get-Content $serverTunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
            $serverTunnelUrl = $Matches[1]
        }
    }
}

if (-not $serverTunnelUrl) {
    Write-Host "[ERROR] Could not get server tunnel URL." -ForegroundColor Red
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "  Server tunnel: $serverTunnelUrl" -ForegroundColor Green

# ---- Step 3: Update .env.local ----
Write-Host "[3/5] Updating client/.env.local..." -ForegroundColor Cyan
Set-Content -Path "$ROOT\client\.env.local" -Value "VITE_SERVER_URL=$serverTunnelUrl"

# ---- Step 4: Start the Client (background) ----
Write-Host "[4/5] Starting client..." -ForegroundColor Cyan
$clientJob = Start-Job -ScriptBlock {
    Set-Location "$using:ROOT\client"
    npx vite --host
}
Start-Sleep -Seconds 5

# ---- Step 5: Create tunnel for client ----
Write-Host "[5/5] Creating tunnel for client (port 5173)..." -ForegroundColor Cyan

$clientTunnelLog = "$env:TEMP\lovestream_client_tunnel.log"
$clientTunnel = Start-Process -FilePath "npx" -ArgumentList "-y cloudflared tunnel --url http://localhost:5173" `
    -RedirectStandardError $clientTunnelLog -PassThru -NoNewWindow -WindowStyle Hidden

# Wait for client tunnel URL
$clientTunnelUrl = $null
$attempts = 0
while (-not $clientTunnelUrl -and $attempts -lt 30) {
    Start-Sleep -Seconds 1
    $attempts++
    if (Test-Path $clientTunnelLog) {
        $content = Get-Content $clientTunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
            $clientTunnelUrl = $Matches[1]
        }
    }
}

if (-not $clientTunnelUrl) {
    Write-Host "[WARNING] Could not get client tunnel URL. Remote access may not work." -ForegroundColor Yellow
    $clientTunnelUrl = "N/A"
}

# ---- Done! ----
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Everything is running!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  YOUR PC:" -ForegroundColor White
Write-Host "    http://localhost:5173" -ForegroundColor Cyan
Write-Host ""
Write-Host "  OTHER LAPTOP (share this link):" -ForegroundColor White
Write-Host "    $clientTunnelUrl" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Server API:" -ForegroundColor Gray
Write-Host "    $serverTunnelUrl" -ForegroundColor Gray
Write-Host ""
Write-Host "  Press ENTER to stop everything." -ForegroundColor Yellow
Write-Host ""

# Wait for user to press Enter
Read-Host "Press ENTER to shut down"

# Cleanup
Write-Host ""
Write-Host "Shutting down..." -ForegroundColor Yellow
Stop-Job $serverJob -ErrorAction SilentlyContinue
Remove-Job $serverJob -ErrorAction SilentlyContinue
Stop-Job $clientJob -ErrorAction SilentlyContinue
Remove-Job $clientJob -ErrorAction SilentlyContinue
if ($serverTunnel -and -not $serverTunnel.HasExited) {
    Stop-Process -Id $serverTunnel.Id -Force -ErrorAction SilentlyContinue
}
if ($clientTunnel -and -not $clientTunnel.HasExited) {
    Stop-Process -Id $clientTunnel.Id -Force -ErrorAction SilentlyContinue
}
Remove-Item $serverTunnelLog, $clientTunnelLog -ErrorAction SilentlyContinue

# Kill any remaining cloudflared processes
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Done!" -ForegroundColor Green
