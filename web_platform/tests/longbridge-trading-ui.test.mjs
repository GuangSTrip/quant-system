import test from 'node:test';
import assert from 'node:assert/strict';
import {createHKTradingUI} from '../src/longbridge-trading-ui.mjs';
class Node{constructor(){this.children=[];this.events={};this.textContent='';this.hidden=false;this.disabled=false;}append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}addEventListener(k,fn){this.events[k]=fn;}reset(){}}
const collect=n=>[n.textContent,...n.children.map(collect)].join(' ');
function fixture(t,api){const prev=globalThis.document,nodes=new Map();globalThis.document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},createElement:()=>new Node()};t.after(()=>globalThis.document=prev);const ui=createHKTradingUI(api);return {ui,get:id=>nodes.get(id)};}
const data={control:{enabled:false,max_order:2000,max_daily:5000},automation:{enabled:0},scheduler:{configured:true},orders:[{client_id:'test-client',broker_id:'123',payload:{symbol:'2800.HK',side:'Buy',quantity:500,price:20},status:'FilledStatus',broker_data:{executed_quantity:'500',executed_price:'20'}}]};
test('trading screen displays broker order ids and fills; terminal orders cannot be cancelled',async t=>{
 const {ui,get}=fixture(t,async()=>data);await ui.status();assert.match(collect(get('lb-ledger')),/券商订单号 123/);assert.match(collect(get('lb-ledger')),/累计成交 500/);const buttons=get('lb-ledger').children[0].children.filter(n=>n.events.click);assert.equal(buttons[1].disabled,true);assert.equal(get('lb-execution').hidden,false);
});
test('logout invalidates in-flight status and clears all transaction results',async t=>{
 let resolve;const {ui,get}=fixture(t,()=>new Promise(r=>resolve=r));const reading=ui.status();ui.clear();resolve(data);await reading;assert.equal(get('lb-execution').hidden,true);assert.equal(get('lb-ledger').children.length,0);
});
test('failed trading state hides previous records instead of presenting stale permission',async t=>{
 let fail=false;const {ui,get}=fixture(t,async()=>{if(fail)throw Error('请重新登录');return data;});await ui.status();fail=true;await ui.status();assert.equal(get('lb-execution').hidden,true);assert.equal(get('lb-ledger').children.length,0);assert.equal(get('lb-trade-message').textContent,'请重新登录');
});
