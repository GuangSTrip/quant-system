import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceUI} from '../src/workspace-ui.mjs';

class Element{
 constructor(){this.children=[];this.textContent='';}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 text(){return this.textContent+this.children.map(x=>x.text()).join(' ');}
}
function documentFixture(){const elements=new Map();globalThis.document={createElement:()=>new Element(),getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);}};return id=>document.getElementById(id);}
test('account dashboard keeps healthy markets visible when another broker fails; reads only',async()=>{
 const $=documentFixture(),calls=[];
 const api=async(path,payload)=>{assert.equal(payload,undefined);calls.push(path);if(path==='cn/status')throw Error('桥接离线');if(path==='overview')return {account:{equity:123,cash:100},positions:[],errors:{}};return {account:[{currency:'HKD',net_assets:456,total_cash:400}],positions:[],errors:{}};};
 await createWorkspaceUI(api,()=>true,()=>{}).load('overview');
 const text=$('workspace-accounts').text();assert.match(text,/桥接离线/);assert.match(text,/123/);assert.match(text,/456/);assert.equal(calls.length,3);
});
test('logout invalidates in-flight account results',async()=>{
 const $=documentFixture();let release;const waiting=new Promise(r=>release=r);let signedIn=true;
 const ui=createWorkspaceUI(async()=>{await waiting;return {account:{equity:999},positions:[]};},()=>signedIn,()=>{});
 const request=ui.load('overview');signedIn=false;ui.clear();release();await request;
 assert.match($('workspace-accounts').text(),/请先登录/);assert.doesNotMatch($('workspace-accounts').text(),/999/);
});
test('all five strategy slots are shown and a portfolio opens its exact strategy',async()=>{
 const $=documentFixture(),navigation=[];
 const api=async path=>({portfolio:{runs:[{market:'CN',strategy_id:'CN:example',enabled:1,budget:1000}],signals:[]},automation:{state:{enabled:0},scheduler:{}},'longbridge/trading':{automation:{enabled:0}},'portfolio/catalog':{strategies:[{market:'CN',id:'CN:example',name:'示例策略'}]}}[path]);
 await createWorkspaceUI(api,()=>true,(...args)=>navigation.push(args)).load('runs');
 const cards=$('workspace-runs').children;assert.equal(cards.length,5);assert.match(cards[0].text(),/示例策略/);
 cards[0].children.find(c=>c.textContent==='查看详情 / 管理 →').onclick();assert.deepEqual(navigation,[['portfolio','CN:example']]);
});
