import https from 'node:https';
import {readFileSync} from 'node:fs';
const base=new URL('../',import.meta.url),origin='https://127.0.0.1:8792';
const ca=readFileSync(new URL('.lan/server-cert.pem',base));
let cookie='';
export async function request(path,body){return new Promise((resolve,reject)=>{const req=https.request(origin+'/api/v1/'+path,{ca,method:body?'POST':'GET',timeout:60000,headers:{origin,cookie,'content-type':'application/json','x-quant-action':'1'}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(data)});}catch{reject(Error('Invalid JSON'));}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('timeout')));req.end(body?JSON.stringify(body):undefined);});}
export async function login(){const credentials=Object.fromEntries(readFileSync(new URL('.env.local-login',base),'utf8').trim().split(/\r?\n/).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));const r=await request('auth/login',{username:credentials.USERNAME,password:credentials.PASSWORD});if(r.status!==200)throw Error('Login failed');cookie=r.headers['set-cookie'][0].split(';')[0];}
export async function logout(){await request('auth/logout',{});cookie='';}
