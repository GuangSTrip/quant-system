$ErrorActionPreference = 'Stop'
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
foreach ($task in @(@{Name='QuantSystemScheduler';Script='start-scheduler.ps1'},@{Name='QuantSystemPortfolioData';Script='start-portfolio.ps1';Market='US'},@{Name='QuantSystemPortfolioDataHK';Script='start-portfolio.ps1';Market='HK'},@{Name='QuantSystemPortfolioDataCN';Script='start-portfolio.ps1';Market='CN'})) {
  $scriptPath = Join-Path $PSScriptRoot $task.Script
  $extra = if ($task.Market) { ' -Market '+$task.Market } else { '' }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$scriptPath+'"'+$extra) -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
  Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $taskUser) -Settings $settings -Principal $principal -Force | Out-Null
}
Start-ScheduledTask -TaskName QuantSystemScheduler
Write-Output 'Background tasks installed. Producer starts after first data verification.'
