$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location -LiteralPath $projectRoot
$mutex = [Threading.Mutex]::new($false, 'Local\QuantSystemMyQuantBridge')
try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
if (-not $locked) { exit 0 }
try {
  while ($true) {
    & (Join-Path $projectRoot '.venv-myquant/Scripts/python.exe') -u scripts/run_myquant_local.py *>> web_platform/.lan/myquant.log
    Start-Sleep -Seconds 60
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
