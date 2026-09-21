$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$mutex = [Threading.Mutex]::new($false, 'Local\QuantSystemScheduler')
try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
if (-not $locked) { exit 0 }
try {
  while ($true) {
    & "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" scripts/local-scheduler.mjs *>> .lan/scheduler.log
    Start-Sleep -Seconds 30
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
