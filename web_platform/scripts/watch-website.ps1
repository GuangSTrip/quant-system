$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$nodePath='C:\Users\HITSZ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$targets=@(@{Name='QuantSystemCampus';Port=8792;Key='backend'},@{Name='QuantSystemCampusResearch';Port=8791;Key='gateway'})
$health=& $nodePath scripts/check-website-health.mjs | ConvertFrom-Json
$statePath=Join-Path (Get-Location) '.lan/website-watchdog.json'
$previous=if(Test-Path -LiteralPath $statePath){Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json}else{$null}
$result=@{at=(Get-Date).ToUniversalTime().ToString('o');backend=[bool]$health.backend;gateway=[bool]$health.gateway;actions=@()}
foreach($target in $targets){
  $task=Get-ScheduledTask -TaskName $target.Name
  if($task.State -ne 'Running'){
    Start-ScheduledTask -TaskName $target.Name
    $result.actions+=('started '+$target.Name)
    continue
  }
  if(-not $health.($target.Key) -and $previous -and -not $previous.($target.Key)){
    # Only kill a listener whose Node ancestor is the exact website launcher.
    $listener=Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue | Select-Object -First 1
    $rootPid=$null
    if($listener){
      $processes=Get-CimInstance Win32_Process
      $proc=$processes | Where-Object ProcessId -eq $listener.OwningProcess
      for($i=0;$proc -and $i -lt 8;$i++){
        $expected=if($target.Key -eq 'backend'){'node_modules[\\/]wrangler[\\/]bin[\\/]wrangler\.js'}else{'scripts[\\/]serve-campus\.mjs'}
        if($proc.Name -eq 'node.exe' -and $proc.CommandLine -match $expected){$rootPid=$proc.ProcessId;break}
        $proc=$processes | Where-Object ProcessId -eq $proc.ParentProcessId
      }
      if(-not $rootPid){$result.actions+=('unknown listener on '+$target.Port+'; left untouched');continue}
    }
    Stop-ScheduledTask -TaskName $target.Name
    if($rootPid){& taskkill.exe /PID $rootPid /T /F | Out-Null}
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $target.Name
    $result.actions+=('restarted unhealthy '+$target.Name)
  }
}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
