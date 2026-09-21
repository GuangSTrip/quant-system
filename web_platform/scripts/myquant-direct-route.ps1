param([switch]$Remove)
$ErrorActionPreference='Stop'
$prefix='119.23.163.23/32'
$gateway='10.250.0.1'
$index=8
$marker=Join-Path $PSScriptRoot '../.lan/myquant-direct-route.json'
if($Remove){
  if(Test-Path $marker){
    $record=Get-Content $marker -Raw | ConvertFrom-Json
    if($record.created -eq $true -and $record.prefix -eq $prefix){
      Get-NetRoute -DestinationPrefix $prefix -InterfaceIndex $index -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object NextHop -EQ $gateway | Remove-NetRoute -Confirm:$false
      @{created=$false;removed=$true;prefix=$prefix} | ConvertTo-Json | Set-Content $marker
    }
  }
  exit
}
if(-not (Resolve-DnsName api.myquant.cn -Type A | Where-Object IPAddress -EQ '119.23.163.23')){throw 'Official DNS address changed; aborting'}
if(-not (Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 | Where-Object IPAddress -EQ '10.250.27.137')){throw 'Campus adapter changed; aborting'}
$existing=Get-NetRoute -DestinationPrefix $prefix -ErrorAction SilentlyContinue
if($existing){throw 'Existing specific route found; not overwriting'}
New-NetRoute -DestinationPrefix $prefix -InterfaceIndex $index -NextHop $gateway -RouteMetric 1 -PolicyStore ActiveStore | Out-Null
@{created=$true;prefix=$prefix;gateway=$gateway;interfaceIndex=$index;temporary=$true} | ConvertTo-Json | Set-Content $marker
