import {login,request,logout} from './local-client.mjs';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
await login();const results=[];
const call=async(path,body)=>{const r=await request(path,body);assert.equal(r.status,200,JSON.stringify({path,...r.data}));return r.data;};
try{
 const catalog=(await call('portfolio/catalog')).strategies,state=await call('portfolio');
 assert.equal(state.runs.length,0,'Existing strategies must not be disturbed by acceptance');
 assert.equal(state.signals.length,178,'All registered strategies must have signals');
 await call('control',{halted:false,confirm:'恢复模拟盘'});
 await call('longbridge/control',{enabled:true,confirm:'确认长桥模拟账户',max_order:10000,max_daily:100000});
 await call('cn/control',{halted:false,confirm:'恢复A股模拟盘'});
 for(const market of ['US','HK','CN']){
  const e=catalog.find(e=>e.market===market&&e.recommended)||catalog.find(e=>e.market===market);
  await call('portfolio/start',{strategy_id:e.id,budget:10000,confirm:'启动组合自动模拟交易'});
  const tick=await call('portfolio/tick',{market});
  assert.equal(tick.outcome,'waiting_session',JSON.stringify({market,...tick}));
  await call('portfolio/pause',{market});
  await call('portfolio/resume',{market,confirm:'启动组合自动模拟交易'});
  await call('portfolio/pause',{market});
  await call('portfolio/release',{market});
  results.push({market,strategy:e.id,start:true,tick:tick.outcome,pause:true,resume:true,release:true});
  console.log(JSON.stringify(results.at(-1)));
 }
 const final=await call('portfolio');assert.equal(final.runs.length,0);
 writeFileSync(new URL('../.lan/portfolio-lifecycle.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),signals:178,ordersSubmitted:0,results},null,2));
}finally{await logout();}
