import https from 'node:https';
import {readFileSync,writeFileSync} from 'node:fs';
const base=new URL('../',import.meta.url),origin='https://127.0.0.1:8792';
const credentials=Object.fromEntries(readFileSync(new URL('.env.local-login',base),'utf8').trim().split(/\r?\n/).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));
let cookie='';
async function request(path,body){return new Promise((resolve,reject)=>{const req=https.request(origin+'/api/v1/'+path,{ca:readFileSync(new URL('.lan/server-cert.pem',base)),method:body?'POST':'GET',timeout:60000,headers:{origin,cookie,'content-type':'application/json','x-quant-action':'1'}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(data)}));});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));req.end(body?JSON.stringify(body):undefined);});}
const login=await request('auth/login',{username:credentials.USERNAME,password:credentials.PASSWORD});
if(login.status!==200)throw new Error('Login failed '+login.status);
cookie=login.headers['set-cookie'][0].split(';')[0];
try{
 const results={};
 for(const path of ['overview','automation','longbridge/status','longbridge/trading','longbridge/overview','cn/status','portfolio']){
  const r=await request(path);results[path]={status:r.status,data:r.data};
  const d=r.data;
  console.log(JSON.stringify({path,http:r.status,ok:d.ok,error:d.error,configured:d.configured,connected:d.bridge?.connected,halted:d.control?.halted,enabled:d.control?.enabled,scheduler:d.scheduler,accountStatus:d.account?.status,positions:d.positions?.length,keys:Object.keys(d)}));
 }
 writeFileSync(new URL('.lan/platform-check.json',base),JSON.stringify(results,null,2));
}finally{await request('auth/logout',{});}
