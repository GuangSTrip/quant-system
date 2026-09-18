import {AppError,requireValue,nowISO,digest} from './engine.mjs';

const encoder=new TextEncoder(),decoder=new TextDecoder();
const ORIGIN='https://openapi.longbridge.com';
const PATHS=new Set(['/v1/asset/account','/v1/asset/stock','/v1/trade/order/today']);
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const sha1=async text=>hex(await crypto.subtle.digest('SHA-1',encoder.encode(text)));
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const pick=(row,fields)=>Object.fromEntries(fields.map(k=>[k,row?.[k]??null]));

// Legacy API-key signing follows the official Rust httpclient signature.rs.
// This transport deliberately supports GET on three fixed account endpoints only.
export async function signedHeaders(credentials,path,query='',timestamp=String(Math.floor(Date.now()/1000)),method='GET',body) {
  const signed='authorization;x-api-key;x-timestamp';
  const values=`authorization:${credentials.access_token}\nx-api-key:${credentials.app_key}\nx-timestamp:${timestamp}\n`;
  const canonical=`${method}|${path}|${query}|${values}|${signed}|`+(body===undefined?'':await sha1(body));
  const key=await crypto.subtle.importKey('raw',encoder.encode(credentials.app_secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=hex(await crypto.subtle.sign('HMAC',key,encoder.encode('HMAC-SHA256|'+await sha1(canonical))));
  return {'Authorization':credentials.access_token,'X-Api-Key':credentials.app_key,'X-Timestamp':timestamp,
    'X-Api-Signature':`HMAC-SHA256 SignedHeaders=${signed}, Signature=${signature}`,'Content-Type':'application/json; charset=utf-8'};
}

export async function longbridgeRead(credentials,path,params={},fetcher=fetch) {
  requireValue(PATHS.has(path),'长桥接口不在只读范围内',400,'LB_READ_ONLY');
  const query=new URLSearchParams(params).toString();
  const headers=await signedHeaders(credentials,path,query);
  try {
    const response=await fetcher(ORIGIN+path+(query?'?'+query:''),{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(12000)});
    if(response.status>=300&&response.status<400)throw new AppError('长桥接口返回重定向，连接已停止',502,'LB_REDIRECT');
    if(response.status===429)throw new AppError('长桥请求过于频繁，请稍后重试',429,'LB_RATE_LIMIT');
    let data;try{data=await response.json();}catch{throw new AppError('长桥返回格式异常，请稍后重试',502,'LB_RESPONSE');}
    if(!response.ok||data.code!==0){
      const code=Number.isSafeInteger(data.code)?String(data.code):String(response.status);
      throw new AppError(`长桥连接验证失败（错误码 ${code}）。请检查三项凭证是否来自同一应用及模拟账户、Token 是否过期。`,502,'LB_AUTH_OR_PERMISSION');
    }
    requireValue(data.data&&typeof data.data==='object','长桥返回数据不完整',502,'LB_RESPONSE');
    return data.data;
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('长桥连接超时或中断，请稍后重试',502,'LB_UNAVAILABLE');}
}

async function encryptionKey(env){
  requireValue(typeof env.BROKER_CREDENTIAL_KEY==='string','凭证保存服务尚未就绪，请联系维护者',503,'LB_STORAGE_KEY');
  try {const raw=unb64(env.BROKER_CREDENTIAL_KEY);if(raw.length!==32)throw Error();return await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);}
  catch {throw new AppError('凭证保存服务配置异常',503,'LB_STORAGE_KEY');}
}
const aad=encoder.encode('quant-system:longbridge:credentials:v1');
export async function seal(env,credentials){
  const key=await encryptionKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,encoder.encode(JSON.stringify(credentials)));
  return JSON.stringify({v:1,iv:b64(iv),data:b64(data)});
}
export async function unseal(env,ciphertext){
  const key=await encryptionKey(env);
  try{const box=JSON.parse(ciphertext);if(box.v!==1)throw Error();return JSON.parse(decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(box.iv),additionalData:aad},key,unb64(box.data))));}
  catch {throw new AppError('无法读取已保存的凭证，请重新配置',503,'LB_CREDENTIAL_UNAVAILABLE');}
}
function validateInput(input){
  requireValue(input.paper_confirm===true,'请确认凭证来自长桥模拟账户',400,'LB_PAPER_CONFIRM');
  const result={};
  for(const name of ['app_key','app_secret','access_token']){
    requireValue(typeof input[name]==='string','请完整填写三项凭证',400,'LB_CREDENTIAL_FORMAT');
    const value=input[name].trim();
    requireValue(value.length>=8&&value.length<=(name==='access_token'?8192:512)&&/^[\x21-\x7e]+$/.test(value),'凭证格式不正确，请复制完整内容，避免空格或换行',400,'LB_CREDENTIAL_FORMAT');
    result[name]=value;
  }
  return result;
}
function accounts(data){
  requireValue(Array.isArray(data.list)&&data.list.length>0&&data.list.every(r=>typeof r.currency==='string'&&r.net_assets!=null&&Number.isFinite(Number(r.net_assets))),'长桥未返回有效账户资金；未保存新凭证',502,'LB_ACCOUNT_RESPONSE');
  return data.list.map(r=>({...pick(r,['currency','net_assets','total_cash','buy_power']),cash_infos:(r.cash_infos||[]).map(c=>pick(c,['currency','available_cash','frozen_cash','settling_cash']))}));
}
export async function connectionStatus(env,db){
  const row=await db.prepare('SELECT ciphertext,updated_at FROM longbridge_connection WHERE id=1').first();
  const c=await db.prepare('SELECT enabled,connection_tag FROM lb_control WHERE id=1').first();
  return {ok:true,configured:Boolean(row),storage_ready:Boolean(env.BROKER_CREDENTIAL_KEY),updated_at:row?.updated_at||null,execution_enabled:Boolean(row&&c?.enabled&&c.connection_tag===await digest(row.ciphertext)),environment_verified:false};
}
async function rateLimit(db){
  const time=Date.now();
  const r=await db.prepare("INSERT INTO auth_limits (bucket,attempts,expires_at) VALUES ('longbridge-read',1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=1,expires_at=excluded.expires_at WHERE auth_limits.expires_at<=?").bind(time+5000,time).run();
  requireValue(r.meta.changes===1,'请间隔 5 秒后再次连接或刷新',429,'LB_RATE_LIMIT');
}
export async function saveConnection(env,db,user,input,auditStatement){
  const credentials=validateInput(input);
  const encrypted=await seal(env,credentials); // Check durable secret availability before external I/O.
  await rateLimit(db);
  const account=accounts(await longbridgeRead(credentials,'/v1/asset/account',{currency:'HKD'}));
  const timestamp=nowISO();
  await db.batch([
    db.prepare('INSERT INTO longbridge_connection (id,ciphertext,updated_at,actor) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at,actor=excluded.actor').bind(encrypted,timestamp,user.id),
    await auditStatement(db,user.id,'longbridge_connected','longbridge',{read_verified:true,environment_verified:false,execution_enabled:false})
  ]);
  return {ok:true,configured:true,updated_at:timestamp,execution_enabled:false,environment_verified:false,account,message:'凭证已加密保存，账户资金查询成功。请与长桥模拟账户核对；交易需在网页另行确认启用。'};
}
export async function removeConnection(db,user,auditStatement){
  await db.batch([db.prepare('DELETE FROM longbridge_connection WHERE id=1'),await auditStatement(db,user.id,'longbridge_disconnected','longbridge',{})]);
  return {ok:true,configured:false,execution_enabled:false};
}
export async function connectionOverview(env,db){
  const row=await db.prepare('SELECT ciphertext FROM longbridge_connection WHERE id=1').first();
  requireValue(row,'请先配置长桥模拟账户凭证',409,'LB_NOT_CONFIGURED');
  const credentials=await unseal(env,row.ciphertext);await rateLimit(db);
  const results=await Promise.allSettled([
    longbridgeRead(credentials,'/v1/asset/account',{currency:'HKD'}).then(accounts),
    longbridgeRead(credentials,'/v1/asset/stock').then(d=>{requireValue(Array.isArray(d.list),'持仓返回不完整',502,'LB_RESPONSE');return d.list.flatMap(c=>{requireValue(Array.isArray(c.stock_info),'持仓列表不完整',502,'LB_RESPONSE');return c.stock_info;}).filter(p=>p.market==='HK').map(p=>pick(p,['symbol','symbol_name','currency','quantity','available_quantity','cost_price']));}),
    longbridgeRead(credentials,'/v1/trade/order/today',{market:'HK'}).then(d=>{requireValue(Array.isArray(d.orders),'订单返回不完整',502,'LB_RESPONSE');return d.orders.filter(o=>String(o.symbol).endsWith('.HK')).map(o=>pick(o,['order_id','symbol','status','side','quantity','price','executed_quantity','executed_price','submitted_at']));})
  ]);
  const out={ok:true,source:'Longbridge OpenAPI',environment:'用户声明模拟账户（待核验）',environment_verified:false,execution_enabled:(await connectionStatus(env,db)).execution_enabled,fetched_at:nowISO(),errors:{}};
  ['account','positions','orders'].forEach((name,i)=>{const r=results[i];out[name]=r.status==='fulfilled'?r.value:null;if(r.status==='rejected'){out.ok=false;out.errors[name]=r.reason instanceof AppError?r.reason.message:'查询失败，请稍后重试';}});
  return out;
}
