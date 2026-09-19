import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {setup} from './helpers.mjs';

test('main database upgrades to Longbridge without altering existing tables or records',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const entries=JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url))).entries;
    const apply=e=>db.exec(readFileSync(new URL('../drizzle/'+e.tag+'.sql',import.meta.url),'utf8'));
    entries.slice(0,3).forEach(apply);
    db.exec("INSERT INTO control(id,halted,max_daily,updated_at) VALUES(1,1,35000,'fixture'); INSERT INTO artifacts VALUES('research','backtest','saved report','{}','test','fixture'); INSERT INTO orders(client_id,request_hash,payload,status,estimated_notional,actor,created_at,updated_at) VALUES('us-existing','hash','{}','filled',100,'test','fixture','fixture'); INSERT INTO auto_strategy(id,enabled,budget,updated_at) VALUES(1,0,9000,'fixture')");
    const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const before=tables.map(t=>({schema:t,rows:db.prepare('SELECT * FROM '+t.name).all()}));
    entries.slice(3).forEach(apply);
    assert.deepEqual(tables.map(t=>({schema:db.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(t.name),rows:db.prepare('SELECT * FROM '+t.name).all()})),before);
    for(const name of ['longbridge_connection','lb_control','lb_orders','lb_auto'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+name).get().n,0);
  } finally {db.close();}
});

test('main research APIs and Longbridge coexist without dispatching orders or enabling trading',async t=>{
  const {request,db,broker}=setup(t);
  for(const path of ['/daily-refinement.json','/modular-daily-results.json']){
    const r=await request(path,undefined,{auth:false});
    assert.equal(r.status,200,path);
  }
  assert.equal((await request('/api/v1/longbridge/status',undefined,{auth:false})).status,401);
  assert.equal((await request('/api/v1/longbridge/status')).data.configured,false);
  const r=await request('/api/v1/longbridge/trading');
  assert.equal(r.status,200);assert.equal(Boolean(r.data.control.enabled),false);
  assert.equal(broker.posts().length,0);
  assert.equal(db.get('SELECT COUNT(*) n FROM lb_orders').n,0);
});
