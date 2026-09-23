$ErrorActionPreference = 'Stop'
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
# S4U stores no password and lets local background work survive sign-out.
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Limited
$tasks = @(@{Name='QuantSystemScheduler';Script='start-scheduler.ps1'},@{Name='QuantSystemPortfolioData';Script='start-portfolio.ps1';Market='US'},@{Name='QuantSystemPortfolioDataHK';Script='start-portfolio.ps1';Market='HK'},@{Name='QuantSystemPortfolioDataCN';Script='start-portfolio.ps1';Market='CN'})
foreach ($task in $tasks) {
  $scriptPath = Join-Path $PSScriptRoot $task.Script
  $extra = if ($task.Market) { ' -Market '+$task.Market } else { '' }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$scriptPath+'"'+$extra) -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
  $triggers = @((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -AtLogOn -User $taskUser))
  Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
}
foreach ($task in $tasks) { Start-ScheduledTask -TaskName $task.Name }
Write-Output 'Background tasks installed in non-admin S4U mode and started.'
