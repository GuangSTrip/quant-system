import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gatewayRevision,gatewayPolicyVerified,gatewayRuntimeMatches} from '../scripts/gateway-runtime.mjs';
import {campusIP} from '../scripts/campus-network.mjs';

test('runtime check rejects the old four-subnet policy even when HTTP is healthy',()=>{
 const oldPolicy=ip=>ip==='127.0.0.1'||/^10\.(250|251|252|253)\./.test(ip);
 assert.equal(gatewayPolicyVerified(oldPolicy),false);
 assert.equal(gatewayPolicyVerified(campusIP),true);
 assert.equal(gatewayRuntimeMatches({ok:true,revision:'same',policyVerified:false},'same'),false);
 assert.equal(gatewayRuntimeMatches({ok:true},'same'),false);
});

test('a policy edit invalidates the old process until it loads the new revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'quant-gateway-test-'));
 try {
  const base=pathToFileURL(dir+'/');
  for(const file of ['serve-campus.mjs','campus-network.mjs','gateway-runtime.mjs','gateway-audit.mjs'])writeFileSync(join(dir,file),'original');
  const running={ok:true,policyVerified:true,revision:gatewayRevision(base)};
  assert.equal(gatewayRuntimeMatches(running,gatewayRevision(base)),true);
  writeFileSync(join(dir,'campus-network.mjs'),'updated campus allowlist');
  const expected=gatewayRevision(base);
  assert.equal(gatewayRuntimeMatches(running,expected),false);
  assert.equal(gatewayRuntimeMatches({...running,revision:expected},expected),true);
 } finally {
  for(const file of ['serve-campus.mjs','campus-network.mjs','gateway-runtime.mjs','gateway-audit.mjs'])unlinkSync(join(dir,file));
  rmdirSync(dir);
 }
});
