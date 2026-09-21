import {login,request,logout} from './local-client.mjs';
import {writeFileSync} from 'node:fs';
await login();
try{
 const results={at:new Date().toISOString()};
 for(const path of ['cn/status','longbridge/trading','longbridge/overview','portfolio','automation']){
  const r=await request(path);results[path]=r.data;
  const d=r.data;console.log(JSON.stringify({path,http:r.status,ok:d.ok,errors:d.errors,runs:d.runs,control:d.control,positions:d.positions?.map(p=>({symbol:p.symbol,qty:p.quantity??p.volume,available:p.available_quantity??p.available_now})),orders:d.orders?.map(o=>({id:o.client_id||o.order_id,status:o.status,symbol:o.request?.symbol||o.payload?.symbol||o.symbol,filled:o.broker?.filled_volume||o.broker_data?.executed_quantity||o.executed_quantity})),signals:d.signals?.length,scheduler:d.scheduler}));
 }
 writeFileSync(new URL('../.lan/acceptance-before-20260921.json',import.meta.url),JSON.stringify(results,null,2));
}finally{await logout();}
