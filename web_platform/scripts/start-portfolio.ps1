param([ValidateSet('US','HK','CN')][string]$Market='US')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$mutex = [Threading.Mutex]::new($false, ('Local\QuantSystemPortfolioData'+$Market))
try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
if (-not $locked) { exit 0 }
try {
  while ($true) {
    & "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" scripts/run-portfolio.mjs --market $Market *>> (".lan/portfolio-data-"+$Market+".log")
    Start-Sleep -Seconds 60
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
