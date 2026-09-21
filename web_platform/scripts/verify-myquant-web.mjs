import https from 'node:https';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const origin='https://127.0.0.1:8792';
const credentials=Object.fromEntries(readFileSync(new URL('../.env.local-login',import.meta.url),'utf8').trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const request=(path,body,cookie)=>new Promise((resolve,reject)=>{
 const req=https.request(origin+path,{ca:readFileSync(new URL('../.lan/server-cert.pem',import.meta.url)),method:body?'POST':'GET',timeout:20000,headers:{origin,'content-type':'application/json','x-quant-action':'1',...(cookie?{cookie}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks))}));});
 req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
});
const login=await request('/api/v1/auth/login',{username:credentials.USERNAME,password:credentials.PASSWORD});assert.equal(login.status,200);
const cookie=login.headers['set-cookie'][0].split(';')[0];
try{
 const status=await request('/api/v1/cn/status',null,cookie);
 const result={at:new Date().toISOString(),http:status.status,ok:status.data.ok,connected:status.data.bridge?.connected,halted:status.data.control?.halted,source:status.data.account?.name,verification:status.data.account?.status?.verification,cashReadable:Number.isFinite(Number(status.data.account?.cash?.available)),positionsCount:status.data.positions?.length,ordersSubmitted:0};
 if(status.status!==200){result.error=status.data.error;result.code=status.data.code;}
 const orders=await request('/api/v1/cn/orders',null,cookie);result.ordersHTTP=orders.status;
 const audit=await request('/api/v1/cn/audit',null,cookie);result.auditHTTP=audit.status;
 writeFileSync(new URL('../.lan/myquant-web-check.json',import.meta.url),JSON.stringify(result,null,2));console.log(result);
 assert.equal(result.connected,true);assert.equal(result.halted,true);assert.equal(result.cashReadable,true);
 assert.equal(result.ordersHTTP,200);assert.equal(result.auditHTTP,200);
}finally{await request('/api/v1/auth/logout',{},cookie);}
