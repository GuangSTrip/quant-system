import test from 'node:test';
import assert from 'node:assert/strict';
import {broker} from '../src/transport.mjs';
test('transport rejects redirects without following them and redacts synchronous failures',async t=>{
  const fetch=globalThis.fetch,log=console.error;t.after(()=>{globalThis.fetch=fetch;console.error=log;});let calls=0;const events=[];console.error=v=>events.push(v);
  const env={ALPACA_PAPER_API_KEY:'fake-key',ALPACA_PAPER_API_SECRET:'fake-secret'};
  globalThis.fetch=async(url,opts)=>{calls++;assert.equal(opts.redirect,'manual');return Response.redirect('https://untrusted.invalid/',307);};
  await assert.rejects(broker(env,'/v2/orders',{method:'POST',payload:{symbol:'SPY'}}),e=>e.code==='BROKER_REDIRECT');assert.equal(calls,1);
  globalThis.fetch=async()=>{throw new TypeError('Invalid redirect fake-key fake-secret');};
  await assert.rejects(broker(env,'/v2/account'),e=>e.code==='BROKER_CLIENT_ERROR');assert.ok(events.length);assert.ok(!events.join('').includes('fake-key'));assert.ok(!events.join('').includes('fake-secret'));
});
