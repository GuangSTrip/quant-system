import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
const ca=readFileSync(new URL('../.lan/server-cert.pem',import.meta.url));
async function check(url){return new Promise(resolve=>{const u=new URL(url),client=u.protocol==='https:'?https:http;const req=client.get(u,{ca,timeout:8000},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(res.statusCode===200&&JSON.parse(body).ok===true);}catch{resolve(false);}});});req.on('error',()=>resolve(false));req.on('timeout',()=>{req.destroy();resolve(false);});});}
const [backend,gateway]=await Promise.all([check('https://127.0.0.1:8792/api/v1/session'),check('http://127.0.0.1:8791/api/v1/session')]);
console.log(JSON.stringify({at:new Date().toISOString(),backend,gateway}));
