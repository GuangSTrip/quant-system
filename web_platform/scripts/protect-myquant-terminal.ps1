$ErrorActionPreference='Stop'
$name='QuantSystemMyQuantTerminalLocalOnly'
if(-not(Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue)){
  New-NetFirewallRule -Name $name -DisplayName 'Quant System MyQuant terminal - block remote API access' -Direction Inbound -Action Block -Protocol TCP -LocalPort 7001,7002,7003,7004,7050,7051 -Profile Any | Out-Null
}
Get-NetFirewallRule -Name $name | Select-Object Name,Enabled,Action | Out-File (Join-Path $PSScriptRoot '../.lan/myquant-terminal-firewall.txt')
