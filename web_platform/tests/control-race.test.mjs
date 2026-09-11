import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers.mjs';
test('an in-flight resume cannot override a newer halt decision',async t=>{
  const {request,broker,db}=setup(t);let calls=0;
  broker.onGet=async url=>{if(url.pathname==='/v2/account'&&++calls===2)await request('/api/v1/control',{halted:true});return null;};
  const r=await request('/api/v1/control',{halted:false,confirm:'恢复模拟盘'});
  assert.equal(r.data.code,'CONTROL_CHANGED');assert.equal(db.get('SELECT halted FROM control').halted,1);
});
