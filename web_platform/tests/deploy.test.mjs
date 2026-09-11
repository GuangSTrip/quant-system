import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,stat,readdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {configuration,deploymentURL,withSecrets,checkPaper,verifyDeployment,PAPER} from '../scripts/deploy/core.mjs';

test('portable configuration isolates cloud resources and includes both migration versions',()=>{
  const c=configuration({name:'quant-test-123',accountId:'a'.repeat(32),username:'course',databaseId:'test-id'});
  assert.equal(c.main,'../worker/index.js');assert.equal(c.d1_databases[0].migrations_dir,'../drizzle');
  assert.equal(c.d1_databases[0].database_id,'test-id');
  assert.equal(c.vars.AUTH_USERNAME,'course');assert.ok(!JSON.stringify(c).includes('appgprj_'));
  assert.throws(()=>configuration({name:'../other',accountId:'a'.repeat(32)}));
});
test('deployment only accepts the exact worker public URL',()=>{
  assert.equal(deploymentURL('docs https://docs.workers.dev\nhttps://quant-demo.member.workers.dev','quant-demo'),'https://quant-demo.member.workers.dev');
  assert.throws(()=>deploymentURL('https://other.member.workers.dev','quant-demo'));
});
test('temporary secret upload is private and cleaned up after success and failure',async()=>{
  const parent=fileURLToPath(new URL('../.quant-deploy/',import.meta.url));
  await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'test-'));
  try{for(const fail of [false,true]){
    const operation=withSecrets(directory,{TEST_SECRET:'fixture-only'},async path=>{
      assert.equal(JSON.parse(await readFile(path,'utf8')).TEST_SECRET,'fixture-only');
      if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
      if(fail)throw Error('upload interrupted');return 'ok';
    });
    if(fail)await assert.rejects(operation,/interrupted/);else assert.equal(await operation,'ok');
    assert.deepEqual(await readdir(directory),[]);
  }}finally{await rm(directory,{recursive:true,force:true});}
});
test('Paper preflight uses only readonly fixed endpoint and rejects redirects or blocked accounts',async()=>{
  await checkPaper('fixture-key','fixture-secret',async(url,options)=>{
    assert.equal(url,PAPER+'/v2/account');assert.equal(options.redirect,'manual');assert.equal(options.method,undefined);
    return Response.json({id:'account',status:'ACTIVE'});
  });
  await assert.rejects(checkPaper('k','s',async()=>new Response(null,{status:302})),/302/);
  await assert.rejects(checkPaper('k','s',async()=>Response.json({id:'account',status:'ACTIVE',trading_blocked:true})),/受限/);
  await assert.rejects(checkPaper('private-key','private-secret',async()=>{throw Error('private-secret');}),error=>!error.message.includes('private-secret'));
});
function remote(failOverview=false){
  const calls=[];
  return {calls,fetch:async(url,options)=>{
    const path=new URL(url).pathname;calls.push(path);
    assert.equal(options.redirect,'manual');
    if(options.method==='POST'){assert.equal(options.headers.origin,'https://quant.member.workers.dev');assert.equal(options.headers['x-quant-action'],'1');}
    if(path.endsWith('/login'))return Response.json({ok:true},{headers:{'set-cookie':'__Host-quant_session=fixture; HttpOnly; Secure'}});
    if(path.endsWith('/session'))return Response.json({auth_mode:'password',login_enabled:true,operator:Boolean(options.headers.cookie)});
    if(path.endsWith('/overview'))return Response.json({ok:!failOverview});
    if(path.endsWith('/logout'))return Response.json({ok:true});
    throw Error('Unexpected path '+path);
  }};
}
test('online smoke test verifies login, authenticated session, Paper reads and logout without orders',async()=>{
  const r=remote();assert.deepEqual(await verifyDeployment('https://quant.member.workers.dev',{username:'fixture',password:'fixture'},r.fetch),{login:'passed',paper:'passed'});
  assert.deepEqual(r.calls,['/api/v1/session','/api/v1/auth/login','/api/v1/session','/api/v1/overview','/api/v1/auth/logout']);
});
test('failed live reads still revoke verification session and do not report readiness',async()=>{
  const r=remote(true);await assert.rejects(verifyDeployment('https://quant.member.workers.dev',{username:'fixture',password:'fixture'},r.fetch),/未全部通过/);
  assert.equal(r.calls.at(-1),'/api/v1/auth/logout');
});
test('redeployment does not rotate or falsely claim rechecking credentials',async()=>{
  const r=remote();assert.equal((await verifyDeployment('https://quant.member.workers.dev',undefined,r.fetch)).login,'not_repeated');
  assert.deepEqual(r.calls,['/api/v1/session','/api/v1/overview']);
});
