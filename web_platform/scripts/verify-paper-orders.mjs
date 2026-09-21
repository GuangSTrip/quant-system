import {login,request,logout} from './local-client.mjs';
import {writeFileSync} from 'node:fs';
const result={at:new Date().toISOString(),tests:[]},file=new URL('../.lan/paper-orders-'+Date.now()+'.json',import.meta.url);
const save=()=>writeFileSync(file,JSON.stringify(result,null,2));
await login();
try{
 const state=(await request('portfolio')).data;if(state.runs?.length)throw Error('Do not interfere with a portfolio');
 const overview=(await request('overview')).data;if(overview.clock?.is_open!==false)throw Error('This test is only for a closed market');
 const q=(await request('market?symbol=SPY')).data.snapshot;
 const usPrice=Math.floor(Number(q.reference)*.95*100)/100;if(!Number.isFinite(usPrice)||usPrice<=0)throw Error('Missing reference');
 const tests=[
  {market:'US',path:'orders',cancel:'orders/cancel',body:{symbol:'SPY',side:'buy',type:'limit',qty:1,limit_price:usPrice,time_in_force:'day',idempotency_key:crypto.randomUUID(),confirm:true,allow_queued:true}},
  {market:'HK',path:'longbridge/orders/submit',cancel:'longbridge/orders/cancel',body:{symbol:'288.HK',side:'Buy',quantity:500,lot_size:500,price:6.3,client_id:'verify_'+crypto.randomUUID().replaceAll('-',''),confirm:true,allow_queued:true}},
  {market:'CN',path:'cn/orders',cancel:'cn/orders/cancel',body:{symbol:'SHSE.600000',side:'buy',quantity:100,type:'limit',limit_price:8.8,client_id:'verify_'+crypto.randomUUID().replaceAll('-',''),confirm:'提交A股模拟订单'}}
 ];
 for(const test of tests){
  const id=test.market==='US'?'qs_'+test.body.idempotency_key.replaceAll('-',''):test.body.client_id;
  const record={market:test.market,client_id:id,intent:test.body,state:'prepared'};result.tests.push(record);save();
  try{
   record.state='sending';save();const r=await request(test.path,test.body);record.submit={http:r.status,...r.data};record.state='submitted_response';save();
   console.log(JSON.stringify({market:test.market,stage:'submit',http:r.status,ok:r.data.ok,code:r.data.code,status:r.data.order?.status,message:r.data.error||r.data.message}));
   if(r.data.order&&r.data.order.status!=='rejected'){
    const canceled=await request(test.cancel,{client_id:id,confirm:true});record.cancel={http:canceled.status,...canceled.data};save();
    console.log(JSON.stringify({market:test.market,stage:'cancel',http:canceled.status,ok:canceled.data.ok,status:canceled.data.order?.status,code:canceled.data.code,message:canceled.data.error}));
   }
  }catch(error){record.state='uncertain';record.error=error.code||error.message;save();console.log(JSON.stringify({market:test.market,state:'uncertain'}));}
 }
 await new Promise(r=>setTimeout(r,3000));
 for(const t of result.tests){
  const path=t.market==='US'?'reconcile':t.market==='HK'?'longbridge/orders/inspect':'cn/reconcile';
  const r=await request(path,t.market==='HK'?{client_id:t.client_id}:{});t.reconciliation={http:r.status,...r.data};save();
  console.log(JSON.stringify({market:t.market,stage:'reconcile',http:r.status,ok:r.data.ok,code:r.data.code}));
 }
}finally{save();await logout();}
