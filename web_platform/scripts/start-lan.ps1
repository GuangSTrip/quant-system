$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$nodePath = 'C:\Users\HITSZ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:WRANGLER_SEND_METRICS = 'false'
$env:CI = 'true'
$mutex = [Threading.Mutex]::new($false, 'Local\QuantSystemCampusServer')
try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
if (-not $locked) { exit 0 }
try {
  while ($true) {
    try {
      & $nodePath 'node_modules/wrangler/bin/wrangler.js' dev --local --ip 127.0.0.1 --port 8792 --inspector-ip 127.0.0.1 --config wrangler.local.json --local-protocol https --https-key-path .lan/server-key.pem --https-cert-path .lan/server-cert.pem --show-interactive-dev-session=false --log-level warn *>> .lan/server.log
    } catch { Add-Content -LiteralPath '.lan/service-restarts.log' -Value ((Get-Date).ToString('o')+' '+$MyInvocation.MyCommand.Name+' process exited; restarting') }
    Start-Sleep -Seconds 10
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
