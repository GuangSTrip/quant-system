$ErrorActionPreference='Stop'
$log=Join-Path $PSScriptRoot '../.lan/campus-network-repair.log'
Start-Transcript -LiteralPath $log -Append | Out-Null
try {
 & (Join-Path $PSScriptRoot 'enable-lan-firewall.ps1')
 $address=Get-NetIPAddress -AddressFamily IPv4 -IPAddress '10.250.27.137' | Select-Object -First 1
 $gateway=Get-NetRoute -AddressFamily IPv4 -InterfaceIndex $address.InterfaceIndex -DestinationPrefix '0.0.0.0/0' | Where-Object NextHop -like '10.250.*' | Sort-Object RouteMetric | Select-Object -First 1
 if(-not $gateway){throw 'Campus gateway could not be verified'}
 foreach($network in @('10.248.0.0','10.249.0.0','10.251.0.0','10.252.0.0','10.253.0.0','10.254.0.0','10.255.0.0')){
  $prefix=$network+'/16'
  $existing=@(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq $prefix -and $_.InterfaceIndex -eq $address.InterfaceIndex -and $_.NextHop -eq $gateway.NextHop })
  if(-not $existing.Count){
   & route.exe -p ADD $network MASK 255.255.0.0 $gateway.NextHop METRIC 5 IF $address.InterfaceIndex
   if($LASTEXITCODE -ne 0){throw ('Route command failed: '+$prefix)}
  }
 }
 @{at=(Get-Date).ToUniversalTime().ToString('o');interface=$address.InterfaceAlias;gateway=$gateway.NextHop;allowed=@('10.248.0.0/13')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot '../.lan/campus-network-repair.json') -Encoding UTF8
} catch {
 $_ | Out-String | Add-Content -LiteralPath $log
 exit 1
} finally { Stop-Transcript | Out-Null }
