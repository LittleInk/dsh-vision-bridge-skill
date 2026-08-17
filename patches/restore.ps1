$backups = Join-Path $PSScriptRoot "backups"
$pkg = $env:DSH_PKG_ROOT
if (-not $pkg) {
  try { $npmRoot = (npm root -g).Trim(); $pkg = Join-Path $npmRoot "@deepseek-ai/dsh/node_modules/@deepseek-ai" } catch {}
}
if (-not $pkg -or -not (Test-Path (Join-Path $pkg "dsh-host-apiproxy/lib/index.js"))) {
  $pkg = Join-Path $env:APPDATA "npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
}
if (-not (Test-Path (Join-Path $pkg "dsh-host-apiproxy/lib/index.js"))) {
  Write-Error "dsh install not found. Set `$env:DSH_PKG_ROOT to the .../@deepseek-ai directory inside your dsh installation, or run: npm root -g"
  exit 1
}
$map = @{
  "apiproxy" = "dsh-host-apiproxy"
  "piai"     = "dsh-llm-pi-ai"
  "deepseek" = "dsh-llm-deepseek"
}
foreach ($k in $map.Keys) {
  $src = Join-Path $backups "$k.index.js.orig"
  $dst = Join-Path $pkg "$($map[$k])/lib/index.js"
  if (Test-Path $src) { Copy-Item $src $dst -Force; Write-Host "restored: $dst" }
  else { Write-Host "no backup for $k" }
}
Write-Host "done - restart the dsh server (the `dsh web` process) to load the restored modules"