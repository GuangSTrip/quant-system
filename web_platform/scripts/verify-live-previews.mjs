import {login,request,logout} from './local-client.mjs';
import {writeFileSync} from 'node:fs';
await login();const results=[];
async function check(path,body){const r=await request(path,body);const item={path,http:r.status,ok:r.data.ok,code:r.data.code,error:r.data.error,queued:r.data.queued};results.push(item);console.log(JSON.stringify(item));return r;}
try{
 await check('reconcile',{});await check('control',{halted:false,confirm:'恢复模拟盘'});
 await check('longbridge/control',{enabled:true,confirm:'确认长桥模拟账户',max_order:10000,max_daily:100000});
 await check('cn/reconcile',{});await check('cn/control',{halted:false,confirm:'恢复A股模拟盘'});
 const quote=await request('market?symbol=SPY'),price=Number(quote.data.snapshot?.reference);
 if(Number.isFinite(price))await check('orders/preview',{symbol:'SPY',side:'buy',type:'limit',qty:1,limit_price:Number(price.toFixed(2)),time_in_force:'day',idempotency_key:crypto.randomUUID()});
 await check('longbridge/orders/preview',{symbol:'288.HK',side:'Buy',quantity:500,lot_size:500,price:6.60});
 await check('cn/orders/preview',{client_id:crypto.randomUUID(),symbol:'SHSE.600000',side:'buy',quantity:100,type:'limit',limit_price:9.07});
}finally{
 await check('control',{halted:true});await check('longbridge/control',{enabled:false});await check('cn/control',{halted:true});
 writeFileSync(new URL('../.lan/live-previews.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),ordersSubmitted:0,results},null,2));await logout();
}
