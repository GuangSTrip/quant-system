import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditRecord,createGatewayAudit} from '../scripts/gateway-audit.mjs';
test('gateway audit excludes credentials and queries',()=>{
 const row=auditRecord({event:'http',ip:'10.250.61.231',path:'/api/v1/session?token=private#password',headers:{cookie:'private'},body:'private',password:'private',status:200});
 assert.equal(row.path,'/api/v1/session');assert.equal(row.ip,'10.250.61.231');assert.equal(JSON.stringify(row).includes('private'),false);
});
test('gateway audit rotates and records explicit response and rejection evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'quant-audit-'));
 try{const file=join(dir,'access.jsonl'),audit=createGatewayAudit(file,{maxBytes:200});
 audit.log({event:'connection_rejected',ip:'10.1.1.1',reason:'source_not_allowed'});await audit.flush();
 audit.log({event:'http',ip:'10.250.61.231',status:200,path:'/'});await audit.flush();
 assert.equal(JSON.parse(await readFile(file,'utf8')).status,200);
 assert.equal(JSON.parse(await readFile(file+'.previous','utf8')).reason,'source_not_allowed');assert.equal(audit.state.errors,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('audit overload or storage failure cannot stop serving requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'quant-audit-'));
 try{const audit=createGatewayAudit(join(dir,'absent','access.jsonl'),{maxQueued:1});audit.log({event:'http'});audit.log({event:'http'});await audit.flush();assert.equal(audit.state.errors,1);assert.equal(audit.state.dropped,1);}finally{await rm(dir,{recursive:true,force:true});}
});
