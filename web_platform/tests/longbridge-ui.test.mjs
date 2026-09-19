import test from 'node:test';
import assert from 'node:assert/strict';
import {createLongbridgePanel} from '../src/longbridge-ui.mjs';
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.textContent='';this.events={};}
  append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
  addEventListener(name,fn){this.events[name]=fn;} reset(){this.resetCalled=true;}
  createTHead(){const e=new Element('thead');this.append(e);return e;}
  createTBody(){const e=new Element('tbody');this.append(e);return e;}
  insertRow(){const e=new Element('tr');this.append(e);return e;}
  insertCell(){const e=new Element('td');this.append(e);return e;}
}
function setup(t,api){const nodes=new Map();const old=globalThis.document;globalThis.document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement:tag=>new Element(tag)};t.after(()=>{globalThis.document=old;});return {panel:createLongbridgePanel(api),get:id=>globalThis.document.getElementById(id)};}
const text=e=>[e.textContent,...e.children.map(text)].join(' ');
const status={configured:true,storage_ready:true};
const overview={ok:true,fetched_at:'2026-09-18T12:00:00Z',account:[{currency:'HKD',net_assets:'1000'}],positions:[{symbol:'700.HK',quantity:'100'}],orders:[{order_id:'test-order',symbol:'700.HK',executed_quantity:'100',executed_price:'500'}],errors:{}};
test('UI renders nonempty broker records as text and labels partial failures',async t=>{
 const r={...overview,ok:false,errors:{positions:'持仓查询超时'},orders:[{...overview.orders[0],symbol:'<img src=x onerror=alert(1)>'}]};
 const {panel,get}=setup(t,async p=>p.endsWith('status')?status:r);await panel.refresh();
 assert.match(text(get('lb-results')),/test-order/);assert.match(text(get('lb-results')),/持仓查询超时/);assert.match(text(get('lb-results')),/<img src=x/);assert.match(get('lb-status').textContent,/部分查询失败/);assert.equal(get('lb-refresh').disabled,false);
});
test('double refresh is coalesced and late response after logout cannot restore account data',async t=>{
 let resolve,calls=0;const pending=new Promise(r=>resolve=r);
 const {panel,get}=setup(t,async p=>{calls++;return p.endsWith('status')?status:pending;});
 const first=panel.refresh();await Promise.resolve();await Promise.resolve();await panel.refresh();assert.equal(calls,2);
 panel.clear();resolve(overview);await first;assert.equal(get('lb-results').children.length,0);assert.equal(get('lb-settings').hidden,true);assert.equal(get('lb-refresh').disabled,false);
});
test('status auth failure clears old account records and does not call overview',async t=>{
 let fail=false,reads=0;const {panel,get}=setup(t,async p=>{if(fail)throw Error('请登录');if(p.endsWith('status'))return status;reads++;return overview;});
 await panel.refresh();assert.ok(get('lb-results').children.length);fail=true;await panel.refresh();assert.equal(reads,1);assert.equal(get('lb-results').children.length,0);assert.equal(get('lb-settings').hidden,true);
});
test('rate-limit or network failure removes stale results and permits a subsequent successful refresh',async t=>{
 let fail=false;const {panel,get}=setup(t,async p=>{if(p.endsWith('status'))return status;if(fail)throw Error('请间隔 5 秒后再次连接或刷新');return overview;});
 await panel.refresh();fail=true;await panel.refresh();assert.equal(get('lb-results').children.length,0);assert.match(get('lb-status').textContent,/5 秒/);assert.equal(get('lb-refresh').disabled,false);fail=false;await panel.refresh();assert.match(text(get('lb-results')),/700.HK/);
});
