import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
const ca=readFileSync(new URL('../.lan/server-cert.pem',import.meta.url));
const clients=new Map(),connections=new Map();let inflight=0;
setInterval(()=>{const now=Date.now();for(const [ip,v] of clients)if(now-v.start>60000)clients.delete(ip);},30000).unref();
const campusIP=ip=>ip==='127.0.0.1'||/^10\.250\.\d{1,3}\.\d{1,3}$/.test(ip);
const assets=new Set(['/','/index.html','/styles.css','/app.js','/research-baseline.json','/library-demo.json','/current-daily-plan.json','/historical-daily-results.json','/modular-daily-results.json','/daily-refinement.json','/api/v1/portfolio/catalog','/api/v1/portfolio/report']);
const notice='内网研究入口：可浏览历史策略与报告，不提供登录或交易操作。';
const script=`document.addEventListener('DOMContentLoaded',()=>{if(!location.hash)location.hash='#daily';const banner=document.createElement('div');banner.setAttribute('role','status');banner.textContent=${JSON.stringify(notice)};document.querySelector('main').prepend(banner);banner.className='panel';document.addEventListener('click',e=>{if(e.target.closest('#sign-in,#sign-out')){e.preventDefault();e.stopImmediatePropagation();alert(${JSON.stringify(notice)});}},true);});`;
const css='\n#sign-in,#sign-out,.nav-group:has([data-view="overview"]),.nav-group:has([data-view="risk"]){display:none!important}\n';
function json(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}
export const server=http.createServer((req,res)=>{
 const ip=req.socket.remoteAddress;
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
 if(!campusIP(ip))return json(res,403,{ok:false,error:'该来源不在已配置校园网范围内。'});
 if(!/^(10\.250\.27\.137|127\.0\.0\.1|localhost):8791$/.test(req.headers.host||''))return json(res,403,{ok:false,error:'访问地址不正确。'});
 if(req.url.length>2048)return json(res,414,{ok:false});
 const now=Date.now();let rate=clients.get(ip);
 if(!rate||now-rate.start>60000){if(clients.size>=4096&&!rate)return json(res,503,{ok:false});rate={start:now,count:0};clients.set(ip,rate);}
 if(++rate.count>180){res.setHeader('Retry-After','60');return json(res,429,{ok:false,error:'请求过于频繁，请稍后重试。'});}
 let url;try{url=new URL(req.url,'http://localhost');}catch{return json(res,400,{ok:false});}
 if(!['GET','HEAD'].includes(req.method))return json(res,403,{ok:false,error:notice,code:'READ_ONLY'});
 if(url.pathname==='/readonly.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(req.method==='HEAD'?'':script);}
 if(url.pathname==='/api/v1/session')return json(res,200,{ok:true,signed_in:false,operator:false,username:null,login_enabled:false,auth_mode:'read-only'});
 if(!assets.has(url.pathname)||url.searchParams.has('source'))return json(res,403,{ok:false,error:notice,code:'READ_ONLY'});
 if(inflight>=32)return json(res,503,{ok:false,error:'访问繁忙，请稍后重试。'});
 inflight++;let released=false;const release=()=>{if(!released){released=true;inflight--;}};
 res.once('close',release);
 // Only frozen public reports and assets; no user cookies, authorization or arbitrary destinations.
 const upstream=https.get({hostname:'127.0.0.1',port:8792,path:url.pathname+url.search,ca,timeout:15000},response=>{
  const chunks=[];let size=0;response.on('error',()=>{if(!res.headersSent)json(res,502,{ok:false});else res.destroy();});response.on('data',c=>{size+=c.length;if(size>32*1024*1024)upstream.destroy(new Error('response too large'));else chunks.push(c);});response.on('end',()=>{
   let body=Buffer.concat(chunks);const type=response.headers['content-type']||'application/octet-stream';
   if(type.includes('text/html'))body=Buffer.from(body.toString().replace('</head>','<script src="/readonly.js"></script></head>'));
   if(url.pathname==='/styles.css')body=Buffer.concat([body,Buffer.from(css)]);
   const headers={'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
   if(response.headers['content-security-policy'])headers['content-security-policy']=response.headers['content-security-policy'];
   res.writeHead(response.statusCode,headers);res.end(req.method==='HEAD'?undefined:body);
  });
 });
 upstream.on('timeout',()=>upstream.destroy(new Error('timeout')));
 res.once('close',()=>{release();upstream.destroy();});
 upstream.on('error',()=>{if(!res.headersSent)json(res,503,{ok:false,error:'研究服务暂时不可用，请稍后重试。'});else res.end();});
});
server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=3000;server.maxRequestsPerSocket=100;server.maxConnections=128;
server.on('connection',socket=>{const ip=socket.remoteAddress;const n=(connections.get(ip)||0)+1;if(!campusIP(ip)||n>12){socket.destroy();return;}connections.set(ip,n);socket.setTimeout(20000,()=>socket.destroy());socket.once('close',()=>{const left=(connections.get(ip)||1)-1;if(left)connections.set(ip,left);else connections.delete(ip);});});
server.listen(8791,'0.0.0.0',()=>console.log('Campus read-only research HTTP listening on port 8791'));
