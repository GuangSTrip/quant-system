import test from 'node:test';
import assert from 'node:assert/strict';
import {myquantBridge} from '../src/myquant-transport.mjs';

const env={MYQUANT_BRIDGE_URL:'https://bridge.example.test',MYQUANT_BRIDGE_SECRET:'only-test-secret'};

test('MyQuant bridge adds secret only to the bridge request and preserves actor identity',async()=>{
  const original=globalThis.fetch;let seen;
  globalThis.fetch=async(url,init)=>{seen={url:String(url),init};return new Response(JSON.stringify({ok:true,bridge:{connected:true}}),{headers:{'content-type':'application/json'}});};
  try{
    const data=await myquantBridge(env,'/v1/status',{actor:'course_test'});
    assert.equal(data.bridge.connected,true);
    assert.equal(seen.url,'https://bridge.example.test/v1/status');
    assert.equal(seen.init.headers['x-myquant-bridge-secret'],'only-test-secret');
    assert.equal(seen.init.headers['x-myquant-actor'],'course_test');
  }finally{globalThis.fetch=original;}
});

test('MyQuant bridge rejects non-HTTPS configuration and unexpected paths before fetch',async()=>{
  await assert.rejects(()=>myquantBridge({...env,MYQUANT_BRIDGE_URL:'http://127.0.0.1:8765'},'/v1/status'),/HTTPS/);
  await assert.rejects(()=>myquantBridge(env,'/v1/../../orders'),/路径无效/);
});
