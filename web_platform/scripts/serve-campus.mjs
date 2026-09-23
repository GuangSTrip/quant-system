// HTTP mode is confined to this campus gateway. Worker HTTPS auth stays unchanged.
import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {campusIP} from './campus-network.mjs';
import {gatewayRevision,gatewayPolicyVerified} from './gateway-runtime.mjs';
const runtime={ok:true,revision:gatewayRevision(),policyVerified:gatewayPolicyVerified(campusIP),startedAt:new Date().toISOString()};
const ca=readFileSync(new URL('../.lan/server-cert.pem',import.meta.url));
const clients=new Map(),connections=new Map();let inflight=0;
const hosts=new Set(['10.250.27.137:8791','127.0.0.1:8791','localhost:8791']);
setInterval(()=>{const now=Date.now();for(const [ip,v] of clients)if(now-v.start>60000)clients.delete(ip);},30000).unref();
const browserScript=`// HTTP lacks randomUUID; use the browser cryptographic RNG.
if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0'));return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('');}});
document.addEventListener('DOMContentLoaded',()=>{const note=document.createElement('p');note.className='caption';note.textContent='校园网模拟交易平台 · HTTP 连接未加密，仅在可信校园网使用。';document.querySelector('main')?.prepend(note);});`;
function json(res,status,body){if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}
function sessionCookie(header=''){
 const found=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith('quant_lan_session='));
 if(found.length!==1)return '';
 const token=found[0].slice('quant_lan_session='.length);
 return /^[\w-]{43}$/.test(token)?'__Host-quant_session='+token:'';
}
const assets=new Set(['/','/index.html','/styles.css','/app.js','/research-baseline.json','/library-demo.json','/current-daily-plan.json','/historical-daily-results.json','/modular-daily-results.json','/daily-refinement.json','/course-benchmarks.json','/course-fund-benchmarks.json']);
export const server=http.createServer((req,res)=>{
 const ip=req.socket.remoteAddress,host=req.headers.host;
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
 if(!campusIP(ip))return json(res,403,{ok:false,error:'该来源不在已配置校园网范围内。'});
 if(!hosts.has(host))return json(res,403,{ok:false,error:'访问地址不正确。'});
 if(req.url.length>2048)return json(res,414,{ok:false});
 if(!req.url.startsWith('/')||req.url.startsWith('//'))return json(res,400,{ok:false});
 let url;try{url=new URL(req.url,'http://'+host);}catch{return json(res,400,{ok:false});}
 // Loopback-only diagnostic reports the policy actually loaded by this process.
 if(url.pathname==='/_gateway/health'){
  if(ip!=='127.0.0.1'||req.method!=='GET')return json(res,404,{ok:false});
  return json(res,200,runtime);
 }
 if(!['GET','HEAD','POST'].includes(req.method))return json(res,405,{ok:false,error:'不支持的请求方法。'});
 const now=Date.now();let rate=clients.get(ip);
 if(!rate||now-rate.start>60000){if(clients.size>=4096&&!rate)return json(res,503,{ok:false});rate={start:now,count:0};clients.set(ip,rate);}
 if(++rate.count>180){res.setHeader('Retry-After','60');return json(res,429,{ok:false,error:'请求过于频繁，请稍后重试。'});}
 // Check the original browser origin BEFORE translating to the loopback worker.
 if(req.method==='POST'){
  if(req.headers.origin!=='http://'+host||req.headers['x-quant-action']!=='1')return json(res,403,{ok:false,error:'请求来源校验失败',code:'CSRF'});
  if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{ok:false,error:'请提交 JSON'});
 }
 if(url.pathname==='/lan-client.js'&&req.method!=='POST'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(req.method==='HEAD'?'':browserScript);}
 // Never expose Wrangler devtools/scheduled endpoints or local disk files.
 if(!assets.has(url.pathname)&&url.pathname!=='/own-studies.json'&&!/^\/own-study-(CN|HK|US)-(daily|alternatives|fundamental)-(base|risk|v5|v1)\.json$/.test(url.pathname)&&!url.pathname.startsWith('/api/'))return json(res,404,{ok:false,error:'页面不存在'});
 if(inflight>=32)return json(res,503,{ok:false,error:'访问繁忙，请稍后重试。'});
 const limit=url.pathname==='/api/v1/portfolio/backtests'?2000000:url.pathname==='/api/v1/portfolio/signals'?500000:20000;
 if(Number(req.headers['content-length']||0)>limit)return json(res,413,{ok:false,error:'请求过大'});
 inflight++;let released=false,upstream;const release=()=>{if(!released){released=true;inflight--;}};
 res.once('close',()=>{release();upstream?.destroy();});
 const chunks=[];let received=0,aborted=false;
 req.on('error',()=>{aborted=true;release();res.destroy();});
 req.on('data',chunk=>{received+=chunk.length;if(received>limit){if(!aborted){aborted=true;json(res,413,{ok:false,error:'请求过大'});}}else if(!aborted)chunks.push(chunk);});
 req.on('end',()=>{
  if(aborted||res.destroyed)return;
  // Only gateway-generated identity transport headers reach the backend.
  const headers={'cf-connecting-ip':ip};const cookie=sessionCookie(req.headers.cookie);
  if(cookie)headers.cookie=cookie;
  if(req.method==='POST')Object.assign(headers,{'content-type':'application/json','content-length':received,origin:'https://127.0.0.1:8792','x-quant-action':'1'});
  upstream=https.request({hostname:'127.0.0.1',port:8792,path:url.pathname+url.search,method:req.method,headers,ca,timeout:120000},response=>{
   const parts=[];let size=0;
   response.on('error',()=>{if(!res.headersSent)json(res,502,{ok:false,error:'后台响应中断'});else res.destroy();});
   response.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024)upstream.destroy(new Error('response too large'));else parts.push(chunk);});
   response.on('end',()=>{
    if(res.destroyed)return;
    let body=Buffer.concat(parts);const type=response.headers['content-type']||'application/octet-stream';
    if(type.includes('text/html'))body=Buffer.from(body.toString().replace('</head>','<script src="/lan-client.js"></script></head>'));
    const output={'content-type':type,'cache-control':'no-store'};
    for(const key of ['content-security-policy','x-request-id','content-disposition','retry-after'])if(response.headers[key])output[key]=response.headers[key];
    const cookies=(response.headers['set-cookie']||[]).filter(v=>v.startsWith('__Host-quant_session='));
    if(cookies.length)output['set-cookie']=cookies.map(v=>v.replace(/^__Host-quant_session=/,'quant_lan_session=').replace(/;\s*Secure\b/ig,''));
    res.writeHead(response.statusCode,output);res.end(req.method==='HEAD'?undefined:body);
   });
  });
  upstream.on('timeout',()=>upstream.destroy(new Error('timeout')));
  upstream.on('error',()=>{if(!res.headersSent)json(res,503,{ok:false,error:'服务连接中断；涉及交易时请先查询订单状态，勿重复提交。'});else res.destroy();});
  upstream.end(Buffer.concat(chunks));
 });
});
server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=3000;server.maxRequestsPerSocket=100;server.maxConnections=128;
server.on('connection',socket=>{const ip=socket.remoteAddress;const n=(connections.get(ip)||0)+1;if(!campusIP(ip)||n>12){socket.destroy();return;}connections.set(ip,n);socket.setTimeout(130000,()=>socket.destroy());socket.once('close',()=>{const left=(connections.get(ip)||1)-1;if(left)connections.set(ip,left);else connections.delete(ip);});});
server.listen(8791,'0.0.0.0',()=>console.log('Campus full-function HTTP gateway listening on port 8791'));
