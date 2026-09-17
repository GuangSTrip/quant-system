import {AppError} from './engine.mjs';

export function hkSymbol(value='HK.00700') {
  const s=String(value).trim().toUpperCase();
  const match=s.match(/^HK\.(\d{1,5})$/)||s.match(/^(\d{1,5})(?:\.HK)?$/);
  if(!match||Number(match[1])===0)throw new AppError('请输入有效港股代码，例如 HK.00700',400,'HK_SYMBOL');
  return 'HK.'+match[1].padStart(5,'0');
}

// Separate provider boundary: never route Hong Kong requests through Alpaca.
export async function hkOverview(env,value,fetcher=fetch) {
  const symbol=hkSymbol(value);
  const base={market:'HK',environment:'SIMULATE',source:'Futu OpenAPI',execution_enabled:false,symbol};
  if(!env.FUTU_BRIDGE_URL||!env.FUTU_BRIDGE_TOKEN)return {...base,ok:false,status:'not_configured',message:'尚未配置富途 OpenD 桥接服务。港股下单与自动策略尚未启用。'};
  let url;
  try {url=new URL(env.FUTU_BRIDGE_URL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();}
  catch {throw new AppError('富途桥接地址必须为 HTTPS 根地址',503,'HK_CONFIG');}
  url.pathname='/v1/hk/overview';url.searchParams.set('symbol',symbol);
  try {
    const r=await fetcher(url,{headers:{authorization:'Bearer '+env.FUTU_BRIDGE_TOKEN},redirect:'manual',signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw Error();
    const data=await r.json();
    if(data.market!=='HK'||data.environment!=='SIMULATE'||data.source!=='Futu OpenAPI'||data.execution_enabled!==false||data.symbol!==symbol||typeof data.ok!=='boolean')throw Error();
    return {...data,...base};
  } catch {throw new AppError('富途桥接连接失败，请检查服务、OpenD 登录和模拟账户配置',502,'HK_BRIDGE_UNAVAILABLE');}
}
