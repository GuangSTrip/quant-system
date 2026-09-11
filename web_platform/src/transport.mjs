import {AppError,requireValue} from './engine.mjs';

const PAPER='https://paper-api.alpaca.markets',DATA='https://data.alpaca.markets';
function safeMessage(value,env){
  let message=String(value||'');
  for(const value of [env.ALPACA_PAPER_API_KEY,env.ALPACA_PAPER_API_SECRET]){
    const secret=String(value||'');
    if(secret)message=message.split(secret).join('[redacted]');
    if(secret.trim())message=message.split(secret.trim()).join('[redacted]');
  }
  return message.slice(0,240);
}

export async function broker(env,path,{method='GET',payload,data=false,allow404=false}={}){
  const key=String(env.ALPACA_PAPER_API_KEY||'').trim(),secret=String(env.ALPACA_PAPER_API_SECRET||'').trim();
  requireValue(key&&secret,'Paper 凭据未配置',503,'CREDENTIALS_MISSING');
  const started=Date.now(),target=new URL((data?DATA:PAPER)+path);
  const context={host:target.host,path:target.pathname,method};
  let response;
  try{
    // Workers supports manual/follow. Node's valid redirect:'error' throws
    // before any I/O in Workerd. Keep credentials on the fixed origin by
    // receiving redirects manually and explicitly rejecting every 3xx below.
    response=await fetch(target.href,{method,redirect:'manual',signal:AbortSignal.timeout(12000),headers:{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret,accept:'application/json',...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
  }catch(error){
    const message=safeMessage(error?.message,env),configuration=error?.name==='TypeError'&&/redirect|not a function|Invalid.*header/i.test(message);
    console.error(JSON.stringify({event:'broker_request_failed',...context,elapsed_ms:Date.now()-started,error_name:error?.name||'Error',reason:message}));
    throw new AppError(configuration?'服务端券商请求配置无效，已记录具体原因':'Alpaca 请求超时或连接中断',502,configuration?'BROKER_CLIENT_ERROR':'BROKER_UNCERTAIN');
  }
  console.info(JSON.stringify({event:'broker_http_response',...context,status:response.status,elapsed_ms:Date.now()-started}));
  if(response.status>=300&&response.status<400){
    await response.body?.cancel();
    throw new AppError('Alpaca 返回了非预期重定向，已停止请求；请核对订单状态',502,'BROKER_REDIRECT');
  }
  if(allow404&&response.status===404){await response.body?.cancel();return null;}
  if(!response.ok){
    let message='';try{message=(await response.json()).message||'';}catch{}
    const detail=safeMessage(message,env),error=new AppError('Alpaca '+response.status+(detail?'：'+detail:''),response.status>=500?502:422,response.status>=500?'BROKER_UNCERTAIN':'BROKER_REJECTED');error.brokerStatus=response.status;throw error;
  }
  if(response.status===204)return {accepted:true};
  try{return await response.json();}catch(error){
    console.error(JSON.stringify({event:'broker_response_invalid',...context,status:response.status,reason:safeMessage(error?.message,env)}));
    throw new AppError('Alpaca 返回内容无法解析；需查询订单状态',502,'BROKER_UNCERTAIN');
  }
}
