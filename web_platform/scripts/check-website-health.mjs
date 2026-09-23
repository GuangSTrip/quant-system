import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {gatewayRevision,gatewayRuntimeMatches} from './gateway-runtime.mjs';
const ca=readFileSync(new URL('../.lan/server-cert.pem',import.meta.url));
async function check(url,valid=body=>body.ok===true){return new Promise(resolve=>{
 const u=new URL(url),client=u.protocol==='https:'?https:http;
 let req,finished=false;
 const done=value=>{if(finished)return;finished=true;clearTimeout(timer);resolve(value);};
 const timer=setTimeout(()=>{req?.destroy();done(false);},8000);
 req=client.get(u,{ca},res=>{let body='';res.on('data',c=>{body+=c;if(body.length>65536){req.destroy();done(false);}});res.on('error',()=>done(false));res.on('end',()=>{try{done(res.statusCode===200&&valid(JSON.parse(body)));}catch{done(false);}});});
 req.on('error',()=>done(false));
});}
const expectedRevision=gatewayRevision();
const [backend,gatewayHttp,gatewayRuntime]=await Promise.all([
 check('https://127.0.0.1:8792/api/v1/session'),
 check('http://127.0.0.1:8791/api/v1/session'),
 check('http://127.0.0.1:8791/_gateway/health',body=>gatewayRuntimeMatches(body,expectedRevision))
]);
console.log(JSON.stringify({at:new Date().toISOString(),backend,gateway:gatewayHttp&&gatewayRuntime,gatewayHttp,gatewayRuntime}));
