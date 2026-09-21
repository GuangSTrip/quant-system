import https from 'node:https';
import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const vars=Object.fromEntries(readFileSync(new URL('.dev.vars',root),'utf8').split(/\r?\n/).filter(s=>/^[A-Z_]+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).replace(/^['"]|['"]$/g,'')];}));
if(vars.SCHEDULER_LOCAL_ENABLED!=='true'||!vars.SCHEDULER_LOCAL_SECRET)throw Error('Local scheduler not configured');
const ca=readFileSync(new URL('.lan/server-cert.pem',root));
async function tick(){
 const result=await new Promise((resolve,reject)=>{
  const req=https.request('https://127.0.0.1:8792/api/v1/scheduler/tick',{method:'POST',ca,timeout:180000,headers:{'x-local-scheduler-secret':vars.SCHEDULER_LOCAL_SECRET}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{const data=JSON.parse(body);resolve({at:new Date().toISOString(),http:res.statusCode,ok:data.ok,outcome:data.outcome,code:data.code,longbridge:data.longbridge,portfolios:data.portfolios});}catch{reject(Error('Invalid response'));}});});
  req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Scheduler timeout')));req.end();
 });
 writeFileSync(new URL('.lan/scheduler-status.json',root),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
do{try{await tick();}catch(error){console.error(JSON.stringify({at:new Date().toISOString(),ok:false,error:error.code||error.message}));}if(process.argv.includes('--once'))break;await new Promise(r=>setTimeout(r,60000));}while(true);
