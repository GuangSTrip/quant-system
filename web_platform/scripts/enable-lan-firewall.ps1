param(
  [string[]]$CampusSubnets = @('10.248.0.0/13')
)
$ErrorActionPreference = 'Stop'
if (-not $CampusSubnets.Count -or ($CampusSubnets | Where-Object { $_ -in @('Any','*','0.0.0.0/0','::/0') })) {
  throw 'Please specify confirmed campus subnets, not unrestricted Internet access.'
}
$ruleName = 'QuantSystemCampusHTTPS8792'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
  Disable-NetFirewallRule -Name $ruleName | Out-Null
}
$researchRule = 'QuantSystemCampusResearch8791'
if (-not (Get-NetFirewallRule -Name $researchRule -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name $researchRule -DisplayName 'Quant System Campus Research HTTP 8791' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8791 -RemoteAddress $CampusSubnets -Profile Any | Out-Null
} else {
  Set-NetFirewallRule -Name $researchRule -Enabled True -Direction Inbound -Action Allow -Profile Any -RemoteAddress $CampusSubnets | Out-Null
}
Get-NetFirewallRule -Name $researchRule | Select-Object Name,Enabled,Action | Out-File (Join-Path $PSScriptRoot '../.lan/firewall-status.txt')
Get-NetFirewallRule -Name $researchRule | Get-NetFirewallAddressFilter | Select-Object RemoteAddress | Out-File (Join-Path $PSScriptRoot '../.lan/firewall-status.txt') -Append
