import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyScheduler} from '../src/scheduler-auth.mjs';
const env={SCHEDULER_REPOSITORY:'course/platform',SCHEDULER_REPOSITORY_ID:'123',SCHEDULER_OWNER_ID:'456',SCHEDULER_AUDIENCE:'https://platform.example'};
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'fixture-key'};
const b64=value=>Buffer.from(value).toString('base64url');
const claims=()=>({iss:'https://token.actions.githubusercontent.com',aud:env.SCHEDULER_AUDIENCE,sub:'repo:course/platform:ref:refs/heads/main',repository:env.SCHEDULER_REPOSITORY,repository_id:'123',repository_owner_id:'456',ref:'refs/heads/main',workflow_ref:'course/platform/.github/workflows/paper-scheduler.yml@refs/heads/main',event_name:'schedule',iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+300,run_id:'fixture-run'});
async function request(payload,header={alg:'RS256',kid:'fixture-key'}){const body=b64(JSON.stringify(header))+'.'+b64(JSON.stringify(payload));const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(body));return new Request('https://platform.example/api/v1/scheduler/tick',{method:'POST',headers:{authorization:'Bearer '+body+'.'+b64(signature)}});}
const fetcher=async(url,opts)=>{assert.equal(url,'https://token.actions.githubusercontent.com/.well-known/jwks');assert.equal(opts.redirect,'manual');return Response.json({keys:[jwk]});};
test('scheduler accepts a verified exact workflow identity with both GitHub subject formats',async()=>{for(const sub of ['repo:course/platform:ref:refs/heads/main','repo:course@456/platform@123:ref:refs/heads/main'])assert.equal((await verifyScheduler(await request({...claims(),sub}),env,fetcher)).source,'github');});
test('scheduler rejects foreign repositories, workflows, audiences, events and expired identities',async()=>{
 for(const change of [{repository_id:'999'},{repository_owner_id:'999'},{aud:'elsewhere'},{sub:'repo:course/platform:pull_request'},{workflow_ref:'course/platform/.github/workflows/untrusted.yml@refs/heads/main'},{event_name:'pull_request'},{exp:1},{nbf:Date.now()/1000+300},{iat:1},{ref:'refs/heads/other'}])await assert.rejects(verifyScheduler(await request({...claims(),...change}),env,fetcher));
});
test('scheduler rejects unsigned or modified tokens and missing configuration',async()=>{
 await assert.rejects(verifyScheduler(await request(claims(),{alg:'none',kid:'fixture-key'}),env,fetcher));
 const original=await request(claims());const token=original.headers.get('authorization');const parts=token.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
 await assert.rejects(verifyScheduler(new Request(original,{headers:{authorization:parts.join('.')}}),env,fetcher));
 await assert.rejects(verifyScheduler(original,{},fetcher));
});
