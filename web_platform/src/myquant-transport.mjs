import {AppError,requireValue} from './engine.mjs';

function bridgeConfig(env){
  const raw=String(env.MYQUANT_BRIDGE_URL||'').trim(),secret=String(env.MYQUANT_BRIDGE_SECRET||'').trim();
  requireValue(raw&&secret,'A股掘金桥接尚未配置；网站保持只读且不会尝试直连本机账户',503,'MYQUANT_BRIDGE_UNAVAILABLE');
  let base;try{base=new URL(raw);}catch{throw new AppError('A股桥接地址格式无效',503,'MYQUANT_BRIDGE_INVALID');}
  requireValue(base.protocol==='https:'&&base.username===''&&base.password===''&&base.search===''&&base.hash===''&&base.pathname==='/', 'A股桥接必须使用无凭据的 HTTPS 地址',503,'MYQUANT_BRIDGE_INVALID');
  return {base,secret};
}

function targetFor(base,path){
  requireValue(/^\/v1\/(?:health|status|orders(?:\/preview|\/cancel)?|reconcile|control|audit)$/.test(path),'A股桥接路径无效',500,'MYQUANT_BRIDGE_PATH');
  const target=new URL(path,base.origin);
  requireValue(target.origin===base.origin,'A股桥接主机不匹配',500,'MYQUANT_BRIDGE_ORIGIN');
  return target;
}

export async function myquantBridge(env,path,{method='GET',payload,actor='web-operator'}={}){
  const {base,secret}=bridgeConfig(env),target=targetFor(base,path);
  let response;
  try{
    response=await fetch(target,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{accept:'application/json','x-myquant-bridge-secret':secret,'x-myquant-actor':String(actor).slice(0,120),...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
  }catch{throw new AppError('A股桥接连接失败；订单状态未知前不会重试，请先检查桥接服务并对账',503,'MYQUANT_BRIDGE_UNCERTAIN');}
  if(response.status>=300&&response.status<400)throw new AppError('A股桥接返回重定向，已停止请求',502,'MYQUANT_BRIDGE_REDIRECT');
  let data;try{data=await response.json();}catch{throw new AppError('A股桥接返回内容无法解析，请查询桥接审计记录',502,'MYQUANT_BRIDGE_INVALID_RESPONSE');}
  if(!response.ok)throw new AppError(String(data?.error||`A股桥接请求失败 (${response.status})`).slice(0,500),response.status>=500?502:response.status,String(data?.code||'MYQUANT_BRIDGE_REJECTED'));
  return data;
}
