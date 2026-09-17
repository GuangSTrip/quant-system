import test from 'node:test';
import assert from 'node:assert/strict';
import {hkOverview,hkSymbol} from '../src/hk.mjs';
import {setup} from './helpers.mjs';

test('HK symbols normalize independently from US symbols',()=>{
  for(const s of ['700','0700.HK','HK.00700'])assert.equal(hkSymbol(s),'HK.00700');
  for(const s of ['SPY','SH.600000','0','700/../account'])assert.throws(()=>hkSymbol(s));
});
test('unconfigured HK channel never calls any broker',async()=>{
  const d=await hkOverview({},'700',()=>{throw Error('must not call');});
  assert.equal(d.status,'not_configured');assert.equal(d.execution_enabled,false);
});
test('bridge credentials stay server side and live environment responses are rejected',async()=>{
  const env={FUTU_BRIDGE_URL:'https://bridge.example',FUTU_BRIDGE_TOKEN:'server-only-secret'};
  const payload={ok:true,source:'Futu OpenAPI',market:'HK',environment:'SIMULATE',execution_enabled:false,symbol:'HK.00700'};
  const d=await hkOverview(env,'700',async(url,opts)=>{assert.equal(url.pathname,'/v1/hk/overview');assert.equal(opts.redirect,'manual');assert.equal(opts.headers.authorization,'Bearer server-only-secret');return Response.json(payload);});
  assert.equal(d.ok,true);assert.ok(!JSON.stringify(d).includes(env.FUTU_BRIDGE_TOKEN));
  for(const response of [()=>Response.json({...payload,environment:'REAL'}),()=>new Response('',{status:302}),()=>Response.json({...payload,symbol:'HK.00005'})])await assert.rejects(hkOverview(env,'700',async()=>response()),e=>e.code==='HK_BRIDGE_UNAVAILABLE');
  await assert.rejects(hkOverview({...env,FUTU_BRIDGE_URL:'http://bridge.example'},'700'),e=>e.code==='HK_CONFIG');
});
test('HK account route requires existing independent website login',async t=>{
  const {request,broker}=setup(t);
  assert.equal((await request('/api/v1/hk/overview',undefined,{auth:false})).status,401);
  const r=await request('/api/v1/hk/overview?symbol=700');
  assert.equal(r.status,200);assert.equal(r.data.status,'not_configured');assert.equal(broker.posts().length,0);
});
