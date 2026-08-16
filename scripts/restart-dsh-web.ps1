<#
.SYNOPSIS
Restart the dsh web server (kills the port listener, starts a fresh `dsh web`).

.DESCRIPTION
Kills the process listening on the web port, then starts a fresh `dsh web`
with the same DSH_HOME and working directory, polling http://127.0.0.1:<Port>/
until healthy. Output is written to %TEMP%\dsh-web-restart.{out,err}.log.

IMPORTANT: this kills the very server that may be hosting the current agent
session. Run it DETACHED from the server's process tree (e.g. via a one-shot
scheduled task) and give the current turn time to finish: the script sleeps
20s before killing. When run via a scheduled task the working directory is
%SystemRoot%\System32 by default, so pass -WorkingDirectory explicitly.
Example detached run:

    $st = (Get-Date).AddMinutes(1).ToString("HH:mm")
    schtasks /Create /TN "dsh-restart-web" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PWD\scripts\restart-dsh-web.ps1`" -WorkingDirectory `"D:\path\to\workspace`"" /SC ONCE /ST $st /F

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh-web.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\restart-dsh-web.ps1 -WorkingDirectory "D:\path\to\workspace"
#>
param(
    [string]$DshHome = $env:DSH_HOME,
    [int]$Port = 3080,
    [string]$Node = "",
    [string]$DshBin = "",
    [string]$WorkingDirectory = ""
)
$ErrorActionPreference = "Continue"
if (-not $DshHome) { $DshHome = Join-Path $HOME ".dsh" }
if (-not $WorkingDirectory) { $WorkingDirectory = (Get-Location).Path }

# discover node if not given
if (-not $Node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $Node = $cmd.Source }
}
if (-not $Node -or -not (Test-Path $Node)) { throw "node not found; pass -Node <path to node.exe>" }

# discover the dsh CLI bin if not given
if (-not $DshBin) {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd) { $DshBin = $cmd.Source }
    if (-not $DshBin) {
        $cand = Get-ChildItem (Join-Path $env:LOCALAPPDATA "npm-cache\_npx") -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "node_modules\@deepseek-ai\dsh\lib\bin.js" } |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($cand) { $DshBin = $cand }
    }
}
if (-not $DshBin -or -not (Test-Path $DshBin)) { throw "dsh bin not found; pass -DshBin <path to dsh/lib/bin.js>" }

# give the current turn time to deliver its final message
Write-Host "waiting 20s for the current turn to flush..."
Start-Sleep -Seconds 20

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $conn) {
    Write-Host "killing pid $($conn.OwningProcess)"
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
}
$freed = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if ($null -eq (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { $freed = $true; break }
}
Write-Host "port $Port freed: $freed"

$env:DSH_HOME = $DshHome
$outLog = Join-Path $env:TEMP "dsh-web-restart.out.log"
$errLog = Join-Path $env:TEMP "dsh-web-restart.err.log"
$p = Start-Process -FilePath $Node -ArgumentList @($DshBin, "web") `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
    -WindowStyle Hidden -PassThru
Write-Host "started new pid $($p.Id)"

$ok = $false
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if ($null -eq (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
        Write-Host "new process exited early; see $errLog"
        break
    }
    try {
        if ((Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ok = $true; break }
    } catch {}
}
if ($ok) { Write-Host "HEALTHY" } else { Write-Host "UNHEALTHY" }
