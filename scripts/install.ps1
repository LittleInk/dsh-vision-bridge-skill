<#
.SYNOPSIS
Install the dsh vision bridge into a dsh web profile.

.DESCRIPTION
1. Copies plugin/ -> <DSH_HOME>/profiles/node_modules/dsh-llm-vision-bridge
2. Replaces profiles/<ProfileName>/cordis.patch.yml with templates/cordis.patch.yml (backup first)
3. Ensures DASHSCOPE_API_KEY exists in <DSH_HOME>/.credentials.yaml
   (read from $env:DASHSCOPE_API_KEY, then <DSH_HOME>/.env, then a sibling
   claude-vision-skill/.env if present)
4. Prints the restart reminder.

SAFETY: never prints a full API key; keys are only echoed masked (last 4 chars).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DshHome C:\Users\me\.dsh -SkipCredentials
#>
param(
    [string]$DshHome = $env:DSH_HOME,
    [string]$ProfileName = "web",
    [switch]$SkipCredentials
)
$ErrorActionPreference = "Stop"

if (-not $DshHome) { $DshHome = Join-Path $HOME ".dsh" }
$profilesNodeModules = Join-Path $DshHome "profiles\node_modules"
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$pluginSrc = Join-Path $PSScriptRoot "..\plugin"
$dest = Join-Path $profilesNodeModules "dsh-llm-vision-bridge"

# [0] preflight
if (-not (Test-Path $profileDir)) { throw "profile directory not found: $profileDir (is dsh installed with profile '$ProfileName'?)" }
$required = @("dsh-llm", "dsh-llm-deepseek", "dsh-credentials", "dsh-launch-environment", "dsh-settings", "dsh-home-paths", "dsh-anonymous-user-id", "dsh-timeout", "schemastery")
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $profilesNodeModules "@deepseek-ai\$_")) })
if ($missing.Count -gt 0) { throw "missing peer packages in $profilesNodeModules\@deepseek-ai: $($missing -join ', ')" }
Write-Host "[0/4] preflight OK (profile '$ProfileName', peer packages present)"

# [1/4] plugin
if (-not (Test-Path $pluginSrc)) { throw "plugin source not found: $pluginSrc" }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $pluginSrc $dest -Recurse
Write-Host "[1/4] plugin installed -> $dest"

# [2/4] profile patch (replace whole file, keep a timestamped backup)
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$patchTemplate = Join-Path $PSScriptRoot "..\templates\cordis.patch.yml"
if (-not (Test-Path $patchTemplate)) { throw "patch template not found: $patchTemplate" }
if (Test-Path $patchFile) {
    $bak = "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $patchFile $bak -Force
    Write-Host "[2/4] backup saved -> $bak"
}
Copy-Item $patchTemplate $patchFile -Force
Write-Host "[2/4] profile patch replaced -> $patchFile"

# [3/4] credentials (masked only)
if (-not $SkipCredentials) {
    $credFile = Join-Path $DshHome ".credentials.yaml"
    $key = $null
    if ($env:DASHSCOPE_API_KEY) { $key = $env:DASHSCOPE_API_KEY }
    elseif (Test-Path (Join-Path $DshHome ".env")) {
        $m = [regex]::Match([IO.File]::ReadAllText((Join-Path $DshHome ".env")), "(?m)^DASHSCOPE_API_KEY\s*=\s*(\S+)")
        if ($m.Success) { $key = $m.Groups[1].Value }
    }
    if (-not $key) {
        $cand = Join-Path $PSScriptRoot "..\..\.dsh\skills\claude-vision-skill\.env"
        if (Test-Path $cand) {
            $m = [regex]::Match([IO.File]::ReadAllText($cand), "(?m)^DASHSCOPE_API_KEY\s*=\s*(\S+)")
            if ($m.Success) { $key = $m.Groups[1].Value }
        }
    }
    if ($key) {
        $content = ""
        if (Test-Path $credFile) { $content = [IO.File]::ReadAllText($credFile) }
        if ($content -notmatch "(?m)^DASHSCOPE_API_KEY\s*:") {
            if ($content -and -not $content.EndsWith("`n")) { $content += "`n" }
            $content += "DASHSCOPE_API_KEY: $key`n"
            [IO.File]::WriteAllText($credFile, $content, (New-Object System.Text.UTF8Encoding($false)))
        }
        $tail = $key.Substring([Math]::Max(0, $key.Length - 4))
        Write-Host "[3/4] DASHSCOPE_API_KEY ensured in $credFile (ends ...$tail, masked)"
    } else {
        Write-Host "[3/4] DASHSCOPE_API_KEY not found in env/.env. Add it manually to $credFile as a line 'DASHSCOPE_API_KEY: sk-...' then restart."
    }
    # DEEPSEEK_API_KEY is only a hint: the stock dsh install usually already has it.
    if (-not (Test-Path $credFile) -or -not ([IO.File]::ReadAllText($credFile) -match "(?m)^DEEPSEEK_API_KEY\s*:")) {
        Write-Host "[3/4] note: DEEPSEEK_API_KEY not found in $credFile. New installs must add it too ('DEEPSEEK_API_KEY: sk-...' or set it on the web Models page), or chat requests will fail with MISSING_CREDENTIAL."
    }
}

# [4/4]
Write-Host "[4/4] install complete. Restart dsh web to load the bridge, then run scripts/verify.ps1"
