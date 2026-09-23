import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

// Capture this once at gateway startup; the watchdog reads disk afresh.
export function gatewayRevision(base = new URL('./', import.meta.url)) {
 const hash=createHash('sha256');
 for(const file of ['serve-campus.mjs','campus-network.mjs','gateway-runtime.mjs','gateway-audit.mjs']) {
  hash.update(file+'\0');hash.update(readFileSync(new URL(file,base)));hash.update('\0');
 }
 return hash.digest('hex');
}

export function gatewayPolicyVerified(allows) {
 const accepted=['127.0.0.1','10.249.44.186','::ffff:10.249.44.186'];
 for(let subnet=248;subnet<=255;subnet++)accepted.push(`10.${subnet}.0.0`,`10.${subnet}.255.255`);
 const denied=['10.247.255.255','11.0.0.0','192.168.1.1','8.8.8.8','10.249.256.1','garbage'];
 return accepted.every(ip=>allows(ip)===true)&&denied.every(ip=>allows(ip)===false);
}

export function gatewayRuntimeMatches(body,expectedRevision) {
 return body?.ok===true&&body.policyVerified===true&&body.revision===expectedRevision;
}
