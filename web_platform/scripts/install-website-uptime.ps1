$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$identity='DESKTOP-QEFDBDF\HITSZ'
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
# S4U avoids storing a password and keeps the web processes non-administrative.
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited
foreach($name in @('QuantSystemCampus','QuantSystemCampusResearch')){
 $task=Get-ScheduledTask -TaskName $name
 Set-ScheduledTask -TaskName $name -Action $task.Actions -Trigger @((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -AtLogOn -User $identity)) -Principal $principal -Settings $settings | Out-Null
}
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'watch-website.ps1')+'"') -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$watchSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName QuantSystemWebsiteWatchdog -Action $action -Trigger @($trigger,(New-ScheduledTaskTrigger -AtStartup)) -Principal $principal -Settings $watchSettings -Force | Out-Null
& powercfg.exe /change standby-timeout-ac 0
if($LASTEXITCODE -ne 0){throw 'Failed to disable AC sleep'}
& powercfg.exe /change hibernate-timeout-ac 0
if($LASTEXITCODE -ne 0){throw 'Failed to disable AC hibernation'}
Start-ScheduledTask -TaskName QuantSystemWebsiteWatchdog
@{installed_at=(Get-Date).ToUniversalTime().ToString('o');mode='non-admin S4U';watchdog_minutes=1;ac_sleep='disabled'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root '.lan/uptime-install.json') -Encoding UTF8
