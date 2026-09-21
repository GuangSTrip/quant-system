import {isIP} from 'node:net';
// Explicitly confirmed campus networks. Do not replace with all private ranges.
export function campusIP(value){
 const ip=String(value||'').replace(/^::ffff:/,'');
 if(isIP(ip)!==4)return false;
 if(ip==='127.0.0.1')return true;
 const [first,second]=ip.split('.').map(Number);
 return first===10&&second>=250&&second<=253;
}
