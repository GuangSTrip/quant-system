import {digest,requireValue,nowISO} from './engine.mjs';

const COOKIE='__Host-quant_session',LIFETIME=8*60*60,ITERATIONS=100000;
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const decode=text=>Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const anonymous=()=>({id:null,username:null,signed_in:false,operator:false,expires_at:null});
const cookie=(token,age)=>`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;

async function derive(password,salt,iterations){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));
}
export async function makePasswordRecord(password){
  const salt=crypto.getRandomValues(new Uint8Array(32));
  return JSON.stringify({version:1,iterations:ITERATIONS,salt:encode(salt),hash:encode(await derive(password,salt,ITERATIONS))});
}
function configuration(env){
  const username=String(env.AUTH_USERNAME||'').trim(),raw=String(env.AUTH_PASSWORD_RECORD||'');
  let record;try{record=JSON.parse(raw);}catch{}
  requireValue(username&&record?.version===1&&record.iterations===ITERATIONS&&/^[\w-]{43}$/.test(record.salt)&&/^[\w-]{43}$/.test(record.hash),'网站登录尚未配置',503,'AUTH_UNAVAILABLE');
  return {username,record,raw};
}
export async function verifyPassword(password,record){
  const actual=await derive(password,decode(record.salt),record.iterations),expected=decode(record.hash);
  let difference=actual.length^expected.length;
  for(let i=0;i<actual.length;i++)difference|=actual[i]^(expected[i]||0);
  return difference===0;
}
function tokenFrom(request){
  const tokens=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
  if(tokens.length!==1)return null;
  const token=tokens[0].slice(COOKIE.length+1);return /^[\w-]{43}$/.test(token)?token:null;
}
async function credentialTag(config){return digest({username:config.username,record:config.raw});}

export async function identity(request,env,db){
  const token=tokenFrom(request);if(!token)return anonymous();
  const config=configuration(env),hash=await digest(token);
  const row=await db.prepare('SELECT username,credential_tag,expires_at FROM auth_sessions WHERE token_hash=?').bind(hash).first();
  if(!row||row.expires_at<=Date.now()||row.username!==config.username||row.credential_tag!==await credentialTag(config))return anonymous();
  return {id:'local:'+row.username,username:row.username,signed_in:true,operator:true,expires_at:new Date(row.expires_at).toISOString()};
}
async function rateLimit(request,db){
  const now=Date.now(),end=now+60000,ip=await digest(request.headers.get('cf-connecting-ip')||'shared');
  for(const [bucket,limit]of [['global',100],['ip:'+ip,20]]){
    const row=await db.prepare('INSERT INTO auth_limits (bucket,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END RETURNING attempts').bind(bucket,end,now,now,end).first();
    requireValue(row.attempts<=limit,'登录尝试过于频繁，请 1 分钟后重试',429,'LOGIN_RATE_LIMIT');
  }
}
export async function login(request,env,db,input,auditStatement){
  const config=configuration(env);
  requireValue(typeof input.username==='string'&&typeof input.password==='string'&&input.username.length<=100&&input.password.length<=128,'请输入有效的账号和密码');
  await rateLimit(request,db);
  const valid=await verifyPassword(input.password,config.record);
  requireValue(valid&&input.username.trim()===config.username,'账号或密码不正确',401,'INVALID_CREDENTIALS');
  const token=encode(crypto.getRandomValues(new Uint8Array(32))),hash=await digest(token),expires=Date.now()+LIFETIME*1000,old=tokenFrom(request),actor='local:'+config.username;
  const statements=[db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').bind(Date.now()),db.prepare('DELETE FROM auth_limits WHERE expires_at<?').bind(Date.now()-86400000)];
  if(old)statements.push(db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await digest(old)));
  statements.push(db.prepare('INSERT INTO auth_sessions (token_hash,username,credential_tag,created_at,expires_at) VALUES (?,?,?,?,?)').bind(hash,config.username,await credentialTag(config),nowISO(),expires),await auditStatement(db,actor,'auth_login',null,{username:config.username,expires_at:new Date(expires).toISOString()}));
  await db.batch(statements);
  return {body:{ok:true,username:config.username,expires_at:new Date(expires).toISOString()},headers:{'set-cookie':cookie(token,LIFETIME)}};
}
export async function logout(request,env,db,auditStatement){
  const token=tokenFrom(request),user=await identity(request,env,db);
  if(token){const statements=[db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await digest(token))];if(user.operator)statements.push(await auditStatement(db,user.id,'auth_logout',null,{}));await db.batch(statements);}
  return {body:{ok:true},headers:{'set-cookie':cookie('',0)}};
}
