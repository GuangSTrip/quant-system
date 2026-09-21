import {login,request,logout} from './local-client.mjs';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const file=new URL('../.lan/functional-acceptance-20260921.json',import.meta.url);
const state=existsSync(file)?JSON.parse(readFileSync(file)): {started:new Date().toISOString(),orders:[],checks:[]};
const save=()=>writeFileSync(file,JSON.stringify(state,null,2));
const mode=process.argv[2];
await login();
try{
 if(mode==='sync'){
  for(const [path,body] of [['longbridge/orders/inspect',{client_id:'user_10c19271c01149e1bf0ac858e2e2671f'}],['cn/reconcile',{}]]){
   const r=await request(path,body);state.checks.push({at:new Date().toISOString(),path,http:r.status,data:r.data});save();console.log(JSON.stringify({path,http:r.status,ok:r.data.ok,status:r.data.receipt?.status,checks:r.data.checks,unresolved:r.data.unresolved}));
  }
 }else if(mode==='buy'||mode==='cancel'){
  const pf=(await request('portfolio')).data;if(pf.runs.some(r=>['CN','HK'].includes(r.market)))throw Error('Existing portfolio: stop acceptance dispatch');
  for(const market of ['CN','HK']){
   if(state.orders.some(o=>o.market===market&&o.mode===mode)){console.log(market+' '+mode+' already recorded; inspect original only');continue;}
   const client_id='accept_'+crypto.randomUUID().replaceAll('-','');
   const input=market==='CN'?{client_id,symbol:'SHSE.600036',side:'buy',quantity:100,type:'limit',limit_price:mode==='buy'?41.1:40,confirm:'提交A股模拟订单'}:{client_id,symbol:'288.HK',side:'Buy',quantity:500,lot_size:500,price:mode==='buy'?6.69:6.6,confirm:true};
   const prefix=market==='CN'?'cn':'longbridge';
   const preview=await request(prefix+'/orders/preview',input);if(preview.status!==200||!preview.data.ok){console.log(JSON.stringify({market,mode,preview:preview.data}));continue;}
   const row={market,mode,client_id,input,stage:'prepared',at:new Date().toISOString()};state.orders.push(row);save();
   row.stage='sending';save();const response=await request(market==='CN'?'cn/orders':'longbridge/orders/submit',input);row.submit={http:response.status,data:response.data};row.stage='response';save();
   console.log(JSON.stringify({market,mode,http:response.status,ok:response.data.ok,status:response.data.order?.status,error:response.data.error,client_id}));
   if(mode==='cancel'&&response.status===200&&response.data.ok){const r=await request(prefix+'/orders/cancel',{client_id,confirm:true});row.cancel={http:r.status,data:r.data};save();console.log(JSON.stringify({market,mode:'cancel-request',http:r.status,ok:r.data.ok,status:r.data.order?.status,message:r.data.message,error:r.data.error}));}
  }
 }else if(mode==='sell-hk'){
  if(state.orders.some(o=>o.mode===mode))throw Error('Sell already recorded; inspect original only');
  const bought=state.orders.find(o=>o.market==='HK'&&o.mode==='buy');
  const checked=await request('longbridge/orders/inspect',{client_id:bought.client_id});
  if(checked.data.receipt?.status!=='FilledStatus'||Number(checked.data.receipt.executed_quantity)!==500)throw Error('Buy not confirmed');
  const client_id='accept_'+crypto.randomUUID().replaceAll('-','');const input={client_id,symbol:'288.HK',side:'Sell',quantity:500,lot_size:500,price:6.65,confirm:true};
  const row={market:'HK',mode,client_id,input,stage:'prepared'};state.orders.push(row);save();row.stage='sending';save();const r=await request('longbridge/orders/submit',input);row.submit={http:r.status,data:r.data};row.stage='response';save();console.log(JSON.stringify({market:'HK',mode,http:r.status,ok:r.data.ok,error:r.data.error}));
 }else if(mode==='t1'){
  const input={client_id:'preview_'+crypto.randomUUID().replaceAll('-',''),symbol:'SHSE.600036',side:'sell',quantity:100,type:'limit',limit_price:41,confirm:'提交A股模拟订单'};
  const r=await request('cn/orders/preview',input);state.checks.push({at:new Date().toISOString(),test:'A股T+1卖出预览拦截',http:r.status,data:r.data});save();console.log(JSON.stringify({test:'T+1',http:r.status,code:r.data.code,message:r.data.error}));
 }else if(mode==='inspect'){
  await request('cn/reconcile',{});const cn=(await request('cn/status')).data;
  for(const row of state.orders){
   const r=row.market==='CN'?{status:200,data:{order:cn.orders.find(o=>o.client_id===row.client_id),positions:cn.positions}}:await request('longbridge/orders/inspect',{client_id:row.client_id});row.latest={at:new Date().toISOString(),http:r.status,data:r.data};save();
   const o=r.data.order,b=o?.broker||o?.broker_data;console.log(JSON.stringify({market:row.market,mode:row.mode,http:r.status,status:o?.status,filled:b?.filled_volume??b?.executed_quantity,price:b?.filled_vwap??b?.executed_price,checks:r.data.checks,error:r.data.error}));
  }
  console.log(JSON.stringify({cnPositions:cn.positions.map(p=>({symbol:p.symbol,volume:p.volume,available:p.available_now})),cnUnresolved:cn.unresolved}));
 }else throw Error('Specify sync, buy, cancel or inspect');
}finally{save();await logout();}
