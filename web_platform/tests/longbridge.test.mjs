import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {signedHeaders,longbridgeRead,seal,unseal} from '../src/longbridge.mjs';
import {setup} from './helpers.mjs';

const credentials={app_key:'fixture-app-key',app_secret:'fixture-app-secret',access_token:'fixture-paper-token'};
const key=Buffer.alloc(32,19).toString('base64');
test('legacy signing matches independent SHA1/HMAC implementation and includes exact query',async()=>{
  const time='1700000000',path='/v1/asset/account',query='currency=HKD';
  const headers=await signedHeaders(credentials,path,query,time);
  const raw='GET|/v1/asset/account|currency=HKD|authorization:fixture-paper-token\nx-api-key:fixture-app-key\nx-timestamp:1700000000\n|authorization;x-api-key;x-timestamp|';
  const hash=createHash('sha1').update(raw).digest('hex');
  const signature=createHmac('sha256',credentials.app_secret).update('HMAC-SHA256|'+hash).digest('hex');
  assert.equal(headers['X-Api-Signature'],'HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature='+signature);
  assert.equal(headers.Authorization,credentials.access_token);
});
test('credential encryption rejects wrong keys and tampering, uses distinct nonces',async()=>{
  const env={BROKER_CREDENTIAL_KEY:key},box=await seal(env,credentials);
  assert.ok(!box.includes(credentials.app_secret));assert.deepEqual(await unseal(env,box),credentials);
  assert.notEqual(await seal(env,credentials),box);
  await assert.rejects(unseal({BROKER_CREDENTIAL_KEY:Buffer.alloc(32,20).toString('base64')},box));
  const data=JSON.parse(box);data.data='AAAA'+data.data.slice(4);await assert.rejects(unseal(env,JSON.stringify(data)));
});
test('only fixed read endpoints, manual redirects, redacted provider errors',async()=>{
  let calls=0;
  await assert.rejects(longbridgeRead(credentials,'/v1/trade/order',{},async()=>{calls++;}),e=>e.code==='LB_READ_ONLY');assert.equal(calls,0);
  await assert.rejects(longbridgeRead(credentials,'/v1/asset/account',{},async(url,options)=>{assert.equal(url,'https://openapi.longbridge.com/v1/asset/account');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');return new Response('',{status:302});}),e=>e.code==='LB_REDIRECT');
  await assert.rejects(longbridgeRead(credentials,'/v1/asset/account',{},async()=>Response.json({code:401004,message:credentials.app_secret})),e=>e.code==='LB_AUTH_OR_PERMISSION'&&!e.message.includes(credentials.app_secret));
});
test('authenticated configuration saves encrypted values only after read verification; disconnect removes them',async t=>{
  const {env,db,request}=setup(t);env.BROKER_CREDENTIAL_KEY=key;
  const payload={...credentials,paper_confirm:true};
  assert.equal((await request('/api/v1/longbridge/status',undefined,{auth:false})).status,401);
  assert.equal((await request('/api/v1/longbridge/connect',payload,{auth:false})).status,401);
  assert.equal((await request('/api/v1/longbridge/connect',payload,{headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await request('/api/v1/longbridge/connect',{...payload,paper_confirm:false})).status,400);
  const priorFetch=globalThis.fetch;let calls=[];
  globalThis.fetch=async(url,opts)=>{
    if(!String(url).startsWith('https://openapi.longbridge.com/'))return priorFetch(url,opts);
    calls.push({url,method:opts.method});
    const data=String(url).includes('/account')?{list:[{currency:'HKD',net_assets:'100000',total_cash:'100000',cash_infos:[]}]}:String(url).includes('/stock')?{list:[{stock_info:[{market:'HK',symbol:'700.HK',quantity:'100'},{market:'US',symbol:'SPY'}]}]}:{orders:[{symbol:'700.HK',order_id:'17',status:'FilledStatus',executed_quantity:'100'}]};
    return Response.json({code:0,data});
  };
  let r=await request('/api/v1/longbridge/connect',payload);assert.equal(r.status,200);assert.equal(r.data.execution_enabled,false);assert.equal(r.data.environment_verified,false);
  const row=db.get('SELECT * FROM longbridge_connection WHERE id=1');assert.ok(row.ciphertext);assert.ok(!JSON.stringify(row).includes(credentials.access_token));
  assert.ok(!JSON.stringify(db.rows('SELECT * FROM events')).includes(credentials.app_secret));
  r=await request('/api/v1/longbridge/status');assert.equal(r.data.configured,true);assert.ok(!JSON.stringify(r.data).includes(credentials.app_key));
  db.sqlite.exec("DELETE FROM auth_limits WHERE bucket='longbridge-read'");
  r=await request('/api/v1/longbridge/overview');assert.equal(r.data.ok,true);assert.equal(r.data.positions.length,1);assert.equal(r.data.orders[0].order_id,'17');assert.ok(calls.every(c=>c.method==='GET'));
  db.sqlite.exec("DELETE FROM auth_limits WHERE bucket='longbridge-read'");globalThis.fetch=async()=>Response.json({code:401004,message:'sensitive'});
  r=await request('/api/v1/longbridge/connect',{...payload,app_key:'replacement-key'});assert.equal(r.status,502);assert.equal(db.get('SELECT ciphertext FROM longbridge_connection WHERE id=1').ciphertext,row.ciphertext);
  r=await request('/api/v1/longbridge/disconnect',{confirm:true});assert.equal(r.data.configured,false);assert.equal(db.get('SELECT COUNT(*) n FROM longbridge_connection').n,0);
});
test('missing encryption key prevents broker access and no plaintext is persisted',async t=>{
  const {request,db}=setup(t);
  const r=await request('/api/v1/longbridge/connect',{...credentials,paper_confirm:true});assert.equal(r.status,503);assert.equal(r.data.code,'LB_STORAGE_KEY');assert.equal(db.get('SELECT COUNT(*) n FROM longbridge_connection').n,0);
});
