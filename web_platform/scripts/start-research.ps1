$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$mutex = [Threading.Mutex]::new($false, 'Local\QuantSystemCampusResearch')
try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
if (-not $locked) { exit 0 }
try {
  while ($true) {
    try {
      & 'C:\Users\HITSZ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/serve-campus.mjs *>> .lan/research.log
    } catch { Add-Content -LiteralPath '.lan/service-restarts.log' -Value ((Get-Date).ToString('o')+' '+$MyInvocation.MyCommand.Name+' process exited; restarting') }
    Start-Sleep -Seconds 10
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
