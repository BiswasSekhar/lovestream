[CmdletBinding()]
param(
    [switch]$SkipInstall
)

# Lovestream - One-command bootstrap + launcher
# - Validates Node/npm
# - Installs dependencies
# - Starts server/client
# - Opens Cloudflare tunnels
# Usage: powershell -ExecutionPolicy Bypass -File dev.ps1

$ErrorActionPreference = 'Stop'
$ROOT = $PSScriptRoot
$SERVER_PORT = 3001
$CLIENT_PORT = 5173

$serverJob = $null
$clientJob = $null
$serverTunnel = $null
$clientTunnel = $null
$serverTunnelLog = "$env:TEMP\lovestream_server_tunnel.log"
$clientTunnelLog = "$env:TEMP\lovestream_client_tunnel.log"

function Test-CommandExists {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-Dependencies {
    Write-Host "[1/7] Installing dependencies..." -ForegroundColor Cyan

    Push-Location $ROOT
    try {
        npm install
    }
    finally {
        Pop-Location
    }

    Push-Location "$ROOT\client"
    try {
        npm install
    }
    finally {
        Pop-Location
    }

    Push-Location "$ROOT\server"
    try {
        npm install
    }
    finally {
        Pop-Location
    }
}

function Wait-TunnelUrl {
    param(
        [string]$LogPath,
        [int]$TimeoutSeconds = 60
    )

    $url = $null
    $attempts = 0
    while (-not $url -and $attempts -lt $TimeoutSeconds) {
        Start-Sleep -Seconds 1
        $attempts++
        if (Test-Path $LogPath) {
            $content = Get-Content $LogPath -Raw -ErrorAction SilentlyContinue
            if ($content -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
                $url = $Matches[1]
            }
        }
    }
    return $url
}

function Cleanup-All {
    Write-Host "";
    Write-Host "Shutting down..." -ForegroundColor Yellow

    if ($serverJob) {
        Stop-Job $serverJob -ErrorAction SilentlyContinue
        Remove-Job $serverJob -ErrorAction SilentlyContinue
    }
    if ($clientJob) {
        Stop-Job $clientJob -ErrorAction SilentlyContinue
        Remove-Job $clientJob -ErrorAction SilentlyContinue
    }
    if ($serverTunnel -and -not $serverTunnel.HasExited) {
        Stop-Process -Id $serverTunnel.Id -Force -ErrorAction SilentlyContinue
    }
    if ($clientTunnel -and -not $clientTunnel.HasExited) {
        Stop-Process -Id $clientTunnel.Id -Force -ErrorAction SilentlyContinue
    }

    Remove-Item $serverTunnelLog, $clientTunnelLog -ErrorAction SilentlyContinue
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host "Done!" -ForegroundColor Green
}

try {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Magenta
    Write-Host "   Lovestream - One Command Launcher" -ForegroundColor Magenta
    Write-Host "========================================" -ForegroundColor Magenta
    Write-Host ""

    if (-not (Test-CommandExists 'node')) {
        Write-Host "Node.js is not installed." -ForegroundColor Red
        Write-Host "Download Node.js (LTS) from:" -ForegroundColor Yellow
        Write-Host "  https://nodejs.org/en/download" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "After installing Node.js, run this script again." -ForegroundColor Yellow
        exit 1
    }

    if (-not (Test-CommandExists 'npm')) {
        Write-Host "npm is not available in PATH." -ForegroundColor Red
        Write-Host "Reinstall Node.js from:" -ForegroundColor Yellow
        Write-Host "  https://nodejs.org/en/download" -ForegroundColor Cyan
        exit 1
    }

    $nodeVersion = node -v
    $npmVersion = npm -v
    Write-Host "Node: $nodeVersion | npm: $npmVersion" -ForegroundColor Green

    if (-not $SkipInstall) {
        Install-Dependencies
    }
    else {
        Write-Host "[1/7] Skipping dependency install (-SkipInstall)" -ForegroundColor Yellow
    }

    Write-Host "[2/7] Starting server..." -ForegroundColor Cyan
    $serverJob = Start-Job -ScriptBlock {
        Set-Location "$using:ROOT\server"
        npm run dev
    }
    Start-Sleep -Seconds 3

    Write-Host "[3/7] Creating server tunnel (port $SERVER_PORT)..." -ForegroundColor Cyan
    Remove-Item $serverTunnelLog -ErrorAction SilentlyContinue
    $serverTunnel = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c npx -y cloudflared tunnel --url http://localhost:$SERVER_PORT 2>$serverTunnelLog" `
        -PassThru -WindowStyle Hidden

    $serverTunnelUrl = Wait-TunnelUrl -LogPath $serverTunnelLog -TimeoutSeconds 60
    if (-not $serverTunnelUrl) {
        throw "Could not get server tunnel URL after 60s."
    }
    Write-Host "  Server tunnel: $serverTunnelUrl" -ForegroundColor Green

    Write-Host "[4/7] Updating client/.env.local..." -ForegroundColor Cyan
    Set-Content -Path "$ROOT\client\.env.local" -Value "VITE_SERVER_URL=$serverTunnelUrl"

    Write-Host "[5/7] Starting client..." -ForegroundColor Cyan
    $clientJob = Start-Job -ScriptBlock {
        Set-Location "$using:ROOT\client"
        npm run dev -- --host
    }
    Start-Sleep -Seconds 5

    Write-Host "[6/7] Creating client tunnel (port $CLIENT_PORT)..." -ForegroundColor Cyan
    Remove-Item $clientTunnelLog -ErrorAction SilentlyContinue
    $clientTunnel = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c npx -y cloudflared tunnel --url http://localhost:$CLIENT_PORT 2>$clientTunnelLog" `
        -PassThru -WindowStyle Hidden

    $clientTunnelUrl = Wait-TunnelUrl -LogPath $clientTunnelLog -TimeoutSeconds 60
    if (-not $clientTunnelUrl) {
        $clientTunnelUrl = 'N/A'
        Write-Host "[WARNING] Could not get client tunnel URL." -ForegroundColor Yellow
    }

    Write-Host "[7/7] All services started." -ForegroundColor Green
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Lovestream is running" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  YOUR PC:" -ForegroundColor White
    Write-Host "    http://localhost:$CLIENT_PORT" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  SHARE THIS LINK:" -ForegroundColor White
    Write-Host "    $clientTunnelUrl" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Server URL (auto-set in client/.env.local):" -ForegroundColor Gray
    Write-Host "    $serverTunnelUrl" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Press ENTER to stop everything." -ForegroundColor Yellow
    Read-Host ""
}
catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    Cleanup-All
}
