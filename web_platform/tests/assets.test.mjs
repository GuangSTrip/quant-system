import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,orderInput} from './helpers.mjs';

// REST shape from https://docs.alpaca.markets/us/docs/fractional-trading#supported-assets
// Deliberately no Python SDK alias `asset_class`.
const active={id:'fixture-asset',class:'us_equity',exchange:'ARCA',symbol:'SPY',name:'SPDR S&P 500 ETF Trust',status:'active',tradable:true,marginable:true,shortable:true,easy_to_borrow:true,fractionable:true};
function setAsset(broker,asset,status=200){broker.onGet=u=>u.pathname==='/v2/assets/SPY'?Response.json(asset,{status}):null;}

test('raw Alpaca class field passes preview and queued limit submission',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();broker.clock.is_open=false;setAsset(broker,active);
  const input=orderInput({allow_queued:true});
  assert.equal((await request('/api/v1/orders/preview',input)).data.ok,true);
  assert.equal(broker.posts().length,0);
  assert.equal((await request('/api/v1/orders',input)).data.ok,true);
  assert.equal(broker.posts().length,1);assert.equal(db.get('SELECT COUNT(*) n FROM orders').n,1);
});
for(const [name,value,status,code]of [
  ['not tradable',{...active,tradable:false},200,'ASSET_NOT_TRADABLE'],
  ['inactive',{...active,status:'inactive'},200,'ASSET_INACTIVE'],
  ['unsupported class',{...active,class:'crypto',asset_class:'us_equity'},200,'ASSET_CLASS_UNSUPPORTED'],
  ['missing raw class',{status:'active',tradable:true,asset_class:'us_equity'},200,'ASSET_DATA_UNAVAILABLE'],
  ['invalid tradable type',{...active,tradable:'true'},200,'ASSET_DATA_UNAVAILABLE'],
  ['missing asset',{message:'asset not found'},404,'ASSET_NOT_FOUND']
])test(`asset ${name} gives a specific error before preview or order side effects`,async t=>{
  const {request,resume,broker,db}=setup(t);await resume();setAsset(broker,value,status);
  for(const path of ['/api/v1/orders/preview','/api/v1/orders']){
    const r=await request(path,orderInput());assert.equal(r.data.code,code);assert.match(r.data.error,/SPY/);
  }
  assert.equal(broker.posts().length,0);assert.equal(db.get('SELECT COUNT(*) n FROM orders').n,0);assert.equal(db.get('SELECT lease_id FROM control').lease_id,null);
});
test('submission rechecks eligibility after a successful preview',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();setAsset(broker,active);
  const input=orderInput();assert.equal((await request('/api/v1/orders/preview',input)).data.ok,true);
  setAsset(broker,{...active,tradable:false});assert.equal((await request('/api/v1/orders',input)).data.code,'ASSET_NOT_TRADABLE');
  assert.equal(broker.posts().length,0);assert.equal(db.get('SELECT COUNT(*) n FROM orders').n,0);
});
