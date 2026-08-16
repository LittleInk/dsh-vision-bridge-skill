<#
.SYNOPSIS
Verify the dsh vision bridge: active provider route, model catalog, and a real
qwen-vl-max vision call with the stored key.

.DESCRIPTION
1. Probes /api/llm.providers  -> expects deepseek-official active (视觉桥接)
2. Probes /api/llm.models     -> expects deepseek-v4-flash + deepseek-v4-pro, no failures
3. Generates a 120x120 test PNG, calls qwen-vl-max with the DASHSCOPE_API_KEY
   from <DSH_HOME>/.credentials.yaml, prints the returned description.

SAFETY: keys are only ever echoed masked (last 4 chars). The test image is
deleted afterwards.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -Port 3080
#>
param(
    [int]$Port = 3080,
    [string]$DshHome = $env:DSH_HOME
)
$ErrorActionPreference = "Stop"
if (-not $DshHome) { $DshHome = Join-Path $HOME ".dsh" }
$base = "http://127.0.0.1:$Port"

function Invoke-Rpc([string]$method) {
    $body = @{ type = "client-request"; rpcId = "verify"; method = $method; payload = @{} } | ConvertTo-Json -Compress
    $r = Invoke-WebRequest -Uri "$base/api/$method" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 10
    return ($r.Content | ConvertFrom-Json).result
}

# [1] providers
$prov = Invoke-Rpc "llm.providers"
$active = @($prov.value.providers | Where-Object { $_.active })
if ($active.Count -eq 0) { Write-Host "FAIL: no active provider"; exit 1 }
foreach ($p in $active) { Write-Host ("provider: {0} -> {1} (active)" -f $p.provider, $p.displayName) }
if ($active.provider -notcontains "deepseek-official") { Write-Host "FAIL: deepseek-official not active"; exit 1 }

# [2] model catalog (scoped to the deepseek-official group)
$cat = Invoke-Rpc "llm.models"
foreach ($g in $cat.value.groups) { Write-Host ("group: {0} ({1}) models={2}" -f $g.name, $g.id, ($g.models.id -join ",")) }
$dsGroup = @($cat.value.groups | Where-Object { $_.id -eq "deepseek-official" })
if ($dsGroup.Count -eq 0) { Write-Host "FAIL: no deepseek-official group in catalog"; exit 1 }
$ids = @($dsGroup[0].models | ForEach-Object { $_.id })
if ($ids -notcontains "deepseek-v4-flash" -or $ids -notcontains "deepseek-v4-pro") { Write-Host "FAIL: expected deepseek-v4-flash and deepseek-v4-pro in deepseek-official group"; exit 1 }
if (@($cat.value.failures).Count -gt 0) { Write-Host ("WARN catalog failures: " + (($cat.value.failures | ForEach-Object { $_.message }) -join "; ")) }

# [3] real vision call (masked key only)
$cred = Join-Path $DshHome ".credentials.yaml"
if (-not (Test-Path $cred)) { Write-Host "SKIP: no credentials file at $cred"; Write-Host "VERIFY PARTIAL (provider+catalog OK, vision call skipped)"; exit 2 }
$text = [IO.File]::ReadAllText($cred)
if ($text -notmatch "(?m)^DASHSCOPE_API_KEY:\s*(\S+)\s*$") { Write-Host "SKIP: DASHSCOPE_API_KEY not found in credentials"; Write-Host "VERIFY PARTIAL (provider+catalog OK, vision call skipped)"; exit 2 }
$key = $Matches[1]
Write-Host ("vision key: ..." + $key.Substring($key.Length - 4) + " (masked)")

Add-Type -AssemblyName System.Drawing
$tmp = Join-Path $env:TEMP ("dsh-vision-verify-" + [guid]::NewGuid().ToString("N") + ".png")
$bmp = New-Object System.Drawing.Bitmap 120, 120
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Red)
$g.DrawString("DSH", (New-Object System.Drawing.Font("Arial", 32)), [System.Drawing.Brushes]::White, 15, 30)
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
try {
    $env:DSH_VISION_KEY = $key
    $env:DSH_VISION_IMG = $tmp
    node -e "
(async () => {
  const { readFileSync } = await import('node:fs');
  const b64 = readFileSync(process.env.DSH_VISION_IMG).toString('base64');
  const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.DSH_VISION_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-vl-max', messages: [{ role: 'user', content: [
      { type: 'text', text: '请用一句话中文描述这张图片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
    ] }], max_tokens: 256, stream: false })
  });
  console.log('vision HTTP', r.status);
  const j = await r.json();
  if (j.choices?.[0]?.message?.content) console.log('vision content:', j.choices[0].message.content);
  else { console.log('vision error:', JSON.stringify(j.error ?? j).slice(0, 300)); process.exit(1); }
})().catch(e => { console.error('vision call failed:', e.message); process.exit(1); });
"
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\DSH_VISION_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\DSH_VISION_IMG -ErrorAction SilentlyContinue
}
Write-Host "VERIFY OK"
