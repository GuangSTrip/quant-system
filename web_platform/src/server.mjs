import {AppError,requireValue,nowISO,digest,numeric,symbol,SYMBOLS,strategyConfig,backtest,normalizeOrder,riskCheck,ENGINE_VERSION} from './engine.mjs';
import {PAGE,CSS,CLIENT,FROZEN} from './assets.mjs';

const ROOT='https://paper-api.alpaca.markets',DATA='https://data.alpaca.markets';
const TERMINAL=['filled','canceled','expired','rejected','replaced'];
const UNCERTAIN=['submitting','unknown'];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
function database(env){requireValue(env.DB,'持久化服务未就绪，交易已阻断',503,'STORAGE_UNAVAILABLE');return env.DB.withSession?env.DB.withSession('first-primary'):env.DB;}
async function first(db,sql,...values){return db.prepare(sql).bind(...values).first();}
async function all(db,sql,...values){return (await db.prepare(sql).bind(...values).all()).results;}
async function run(db,sql,...values){return db.prepare(sql).bind(...values).run();}
async function control(db){
  await run(db,'INSERT OR IGNORE INTO control (id,updated_at) VALUES (1,?)',nowISO());
  return first(db,'SELECT * FROM control WHERE id=1');
}
function publicControl(c){return {halted:Boolean(c.halted),reason:c.reason,revision:c.revision,max_order:c.max_order,max_daily:c.max_daily,max_position:c.max_position,max_loss:c.max_loss,updated_at:c.updated_at,busy:Boolean(c.lease_id)};}
async function auditStatement(db,actor,kind,subject,details){
  const event={timestamp:nowISO(),actor,kind,subject:subject||null,details};
  return db.prepare('INSERT INTO events (timestamp,actor,kind,subject,details,digest) VALUES (?,?,?,?,?,?)').bind(event.timestamp,actor,kind,event.subject,JSON.stringify(details),await digest(event));
}
async function audit(db,actor,kind,subject,details){return (await auditStatement(db,actor,kind,subject,details)).run();}
function identity(request,env){
  const id=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email');
  const allowed=email&&id&&String(env.OPERATOR_EMAIL||'').trim().toLowerCase()===email.trim().toLowerCase();
  return {id,email,signed_in:Boolean(id&&email),operator:Boolean(allowed)};
}
async function operator(request,env,db){
  const user=identity(request,env);requireValue(user.signed_in,'请先使用 ChatGPT 登录',401,'SIGN_IN_REQUIRED');
  requireValue(user.operator,'当前账号只有查看权限',403,'FORBIDDEN');
  const c=await control(db);
  if(!c.owner_id)await run(db,'UPDATE control SET owner_id=? WHERE id=1 AND owner_id IS NULL',user.id);
  requireValue((await control(db)).owner_id===user.id,'当前身份与已绑定操作员不一致',403,'FORBIDDEN');
  return user;
}
async function body(request){
  requireValue(request.headers.get('origin')===new URL(request.url).origin,'请求来源校验失败',403,'ORIGIN_MISMATCH');
  requireValue(request.headers.get('x-quant-action')==='1','缺少操作标记',403,'CSRF');
  requireValue(request.headers.get('content-type')?.startsWith('application/json'),'请提交 JSON',415);
  requireValue(Number(request.headers.get('content-length')||0)<=20000,'请求过大',413);
  const text=await request.text();requireValue(text.length<=20000,'请求过大',413);
  try{const obj=JSON.parse(text);requireValue(obj&&typeof obj==='object'&&!Array.isArray(obj),'请求格式无效');return obj;}catch(e){if(e instanceof AppError)throw e;throw new AppError('JSON 格式错误');}
}
async function broker(env,path,{method='GET',payload,data=false,allow404=false}={}){
  requireValue(env.ALPACA_PAPER_API_KEY&&env.ALPACA_PAPER_API_SECRET,'Paper 凭据未配置',503,'CREDENTIALS_MISSING');
  let response;
  try{response=await fetch((data?DATA:ROOT)+path,{method,redirect:'error',signal:AbortSignal.timeout(12000),headers:{'APCA-API-KEY-ID':env.ALPACA_PAPER_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_PAPER_API_SECRET,'accept':'application/json',...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});}
  catch{throw new AppError('Alpaca 请求超时或连接中断',502,'BROKER_UNCERTAIN');}
  if(allow404&&response.status===404)return null;
  if(!response.ok){
    const text=await response.text();let message='';try{message=JSON.parse(text).message||'';}catch{}
    for(const secret of [env.ALPACA_PAPER_API_KEY,env.ALPACA_PAPER_API_SECRET])if(secret)message=String(message).split(secret).join('[redacted]');
    const e=new AppError('Alpaca '+response.status+(message?'：'+String(message).slice(0,220):''),response.status>=500?502:422,response.status>=500?'BROKER_UNCERTAIN':'BROKER_REJECTED');e.brokerStatus=response.status;throw e;
  }
  if(response.status===204)return {accepted:true};
  try{return await response.json();}catch{throw new AppError('Alpaca 返回内容无法解析；需查询订单状态',502,'BROKER_UNCERTAIN');}
}
const pick=(o,keys)=>Object.fromEntries(keys.map(k=>[k,o?.[k]??null]));
function cleanOrder(o){return pick(o,['id','client_order_id','symbol','side','type','time_in_force','qty','filled_qty','filled_avg_price','limit_price','stop_price','status','created_at','submitted_at','updated_at','filled_at','canceled_at']);}
async function accountContext(env){
  const [account,clock,positions,openOrders]=await Promise.all([broker(env,'/v2/account'),broker(env,'/v2/clock'),broker(env,'/v2/positions'),broker(env,'/v2/orders?status=open&limit=500&nested=false')]);
  requireValue(openOrders.length<500,'未完成订单过多，暂时阻断新增订单',409,'TOO_MANY_OPEN');
  return {account,clock,positions,openOrders};
}
async function snapshotQuote(env,sym){
  const s=await broker(env,'/v2/stocks/'+encodeURIComponent(sym)+'/snapshot?feed=iex',{data:true});
  return {...s.latestQuote,reference:Number(s.dailyBar?.c||s.prevDailyBar?.c||s.latestTrade?.p),reference_at:s.dailyBar?.t||s.prevDailyBar?.t||s.latestTrade?.t,trade:s.latestTrade,day:s.dailyBar,previous:s.prevDailyBar};
}
async function contextForOrder(env,db,o){
  const [ctx,quote,c]=await Promise.all([accountContext(env),snapshotQuote(env,o.symbol),control(db)]);
  const day=String(ctx.clock.timestamp).slice(0,10);
  const total=await first(db,"SELECT COALESCE(SUM(estimated_notional),0) total,COUNT(*) count FROM orders WHERE created_at>=? AND status!='rejected'",day+'T00:00:00.000Z');
  requireValue(total.count<50,'达到课程版每日 50 次提交上限',409,'RATE_LIMIT');
  return {...ctx,quote,control:c,dailyNotional:total.total};
}
async function acquire(db){
  const id=crypto.randomUUID(),c=await control(db);
  requireValue(!c.lease_id,'已有交易操作进行中；若长时间未恢复，请执行对账',409,'OPERATION_BUSY');
  const result=await run(db,'UPDATE control SET lease_id=?,lease_until=? WHERE id=1 AND lease_id IS NULL',id,Date.now()+90000);
  requireValue(result.meta.changes===1,'已有操作占用交易通道',409,'OPERATION_BUSY');
  return id;
}
async function release(db,id){await run(db,'UPDATE control SET lease_id=NULL,lease_until=0 WHERE id=1 AND lease_id=?',id);}
async function saveBrokerOrder(db,row,order,actor,kind='order_status'){
  const clean=cleanOrder(order);
  await db.batch([db.prepare('UPDATE orders SET broker_id=?,status=?,broker_data=?,error=NULL,updated_at=? WHERE client_id=?').bind(order.id,order.status,JSON.stringify(clean),nowISO(),row.client_id),await auditStatement(db,actor,kind,row.client_id,{status:order.status,filled_qty:order.filled_qty,broker_id:order.id})]);
  return clean;
}
async function findOrder(env,id){return broker(env,'/v2/orders:by_client_order_id?client_order_id='+encodeURIComponent(id),{allow404:true});}
async function reconcileOne(env,db,row,actor){
  const existing=await findOrder(env,row.client_id);
  if(existing)return saveBrokerOrder(db,row,existing,actor,'reconcile_order');
  return null;
}
async function submitOrder(env,db,user,input,plan=null){
  requireValue(input.confirm===true,'请在网页订单摘要中确认提交');
  requireValue(typeof input.idempotency_key==='string'&&/^[a-f0-9-]{36}$/.test(input.idempotency_key),'缺少有效幂等键');
  const order=normalizeOrder(input),hash=await digest({...order,allow_queued:input.allow_queued===true}),clientId='qs_'+input.idempotency_key.replaceAll('-','');
  const lease=await acquire(db);
  try{
    let row=await first(db,'SELECT * FROM orders WHERE client_id=?',clientId);
    if(row){
      requireValue(row.request_hash===hash,'同一幂等键不能用于不同订单',409,'IDEMPOTENCY_CONFLICT');
      if(!TERMINAL.includes(row.status)){const found=await reconcileOne(env,db,row,user.id);if(found)return {ok:true,reused:true,order:found};}
      return {ok:!UNCERTAIN.includes(row.status),reused:true,order:row.broker_data?JSON.parse(row.broker_data):{client_order_id:row.client_id,status:row.status},message:row.error||'该订单已处理，不会重复提交'};
    }
    if(plan)requireValue(Date.now()<=Date.parse(plan.expires_at),'订单计划已过期，请重新生成',409,'PLAN_EXPIRED');
    const uncertain=await first(db,"SELECT client_id FROM orders WHERE status IN ('submitting','unknown') LIMIT 1");
    requireValue(!uncertain,'存在状态未知的订单，必须先对账',409,'UNRESOLVED_ORDER');
    const ctx=await contextForOrder(env,db,order);
    if(plan)requireValue(Math.abs(Number(ctx.positions.find(p=>p.symbol===order.symbol)?.qty||0)-plan.current_qty)<1e-8,'持仓已变化，请重新生成计划',409,'PLAN_STALE');
    requireValue(ctx.clock.is_open||input.allow_queued===true,'当前休市，请明确勾选允许限价单排队',409,'MARKET_CLOSED');
    let check;
    try{check=riskCheck(order,ctx);}catch(e){
      if(e.code==='DAILY_LOSS')await run(db,'UPDATE control SET halted=1,reason=?,revision=revision+1,updated_at=? WHERE id=1','达到当日亏损限额',nowISO());
      await audit(db,user.id,'risk_rejected',clientId,{code:e.code,message:e.message,symbol:order.symbol});throw e;
    }
    const asset=await broker(env,'/v2/assets/'+encodeURIComponent(order.symbol));
    requireValue(asset.tradable&&asset.status==='active'&&asset.asset_class==='us_equity','标的不可交易或不属于课程证券范围',409,'ASSET_NOT_TRADABLE');
    const timestamp=nowISO();
    await db.batch([
      db.prepare('INSERT INTO orders (client_id,request_hash,payload,status,estimated_notional,actor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(clientId,hash,JSON.stringify(order),'submitting',check.notional,user.id,timestamp,timestamp),
      await auditStatement(db,user.id,'order_intent',clientId,{order,check})
    ]);
    row=await first(db,'SELECT * FROM orders WHERE client_id=?',clientId);
    const latest=await control(db);
    if(latest.halted){await run(db,"UPDATE orders SET status='rejected',error=?,updated_at=? WHERE client_id=?",'暂停发生在发送前',nowISO(),clientId);throw new AppError('服务器已暂停，此订单未发送',409,'HALTED');}
    let placed;
    try{placed=await broker(env,'/v2/orders',{method:'POST',payload:{...order,client_order_id:clientId}});}
    catch(e){
      let found=null;try{found=await findOrder(env,clientId);}catch{}
      if(found)placed=found;
      else {
        const rejected=e.code==='BROKER_REJECTED'&&[400,401,403,404,422,429].includes(e.brokerStatus);
        await db.batch([
          db.prepare('UPDATE orders SET status=?,error=?,updated_at=? WHERE client_id=?').bind(rejected?'rejected':'unknown',e.message,nowISO(),clientId),
          await auditStatement(db,user.id,rejected?'order_rejected':'order_unknown',clientId,{message:e.message}),
          ...(!rejected?[db.prepare('UPDATE control SET halted=1,reason=?,revision=revision+1,updated_at=? WHERE id=1').bind('订单状态未知，请对账后恢复',nowISO())]:[])
        ]);
        return {ok:false,order:{client_order_id:clientId,status:rejected?'rejected':'unknown'},message:rejected?e.message:'提交结果未知，已暂停新增订单。请点击对账；系统不会盲目重发。'};
      }
    }
    const result=await saveBrokerOrder(db,row,placed,user.id,'order_submitted');
    if((await control(db)).halted&&!TERMINAL.includes(placed.status)){
      try{await broker(env,'/v2/orders/'+encodeURIComponent(placed.id),{method:'DELETE'});await audit(db,user.id,'halt_cancel_requested',clientId,{broker_id:placed.id});}catch{await audit(db,user.id,'halt_cancel_uncertain',clientId,{broker_id:placed.id});}
    }
    return {ok:true,order:result,risk:check};
  }finally{await release(db,lease);}
}
async function cancelOrders(env,db,user,clientId){
  const candidates=clientId?[await first(db,'SELECT * FROM orders WHERE client_id=?',clientId)]:await all(db,"SELECT * FROM orders WHERE status NOT IN ('filled','canceled','expired','rejected','replaced') ORDER BY created_at DESC LIMIT 100");
  requireValue(!clientId||candidates[0],'找不到本平台订单',404);
  const results=[];
  for(const row of candidates){
    try{
      const order=await findOrder(env,row.client_id);
      if(!order){results.push({client_id:row.client_id,status:'unknown',message:'券商尚未返回此订单，需继续对账'});continue;}
      if(TERMINAL.includes(order.status)){await saveBrokerOrder(db,row,order,user.id,'cancel_already_terminal');results.push({client_id:row.client_id,status:order.status});continue;}
      await audit(db,user.id,'cancel_requested',row.client_id,{broker_id:order.id});
      await broker(env,'/v2/orders/'+encodeURIComponent(order.id),{method:'DELETE'});
      await run(db,"UPDATE orders SET status='pending_cancel',updated_at=? WHERE client_id=?",nowISO(),row.client_id);
      results.push({client_id:row.client_id,status:'pending_cancel'});
    }catch(e){results.push({client_id:row.client_id,status:'cancel_unconfirmed',message:e.message});await audit(db,user.id,'cancel_unconfirmed',row.client_id,{message:e.message});}
  }
  return {ok:true,results,message:'撤单申请已处理；pending_cancel 需等待券商确认。已成交部分不会被撤回。'};
}
async function reconcile(env,db,user){
  const c=await control(db);
  requireValue(!c.lease_id||c.lease_until<Date.now(),'交易操作仍在进行，请稍后再对账',409,'OPERATION_BUSY');
  const rows=await all(db,"SELECT * FROM orders WHERE status NOT IN ('filled','canceled','expired','rejected','replaced') ORDER BY created_at ASC LIMIT 100");
  const results=[];
  for(const row of rows){try{const order=await reconcileOne(env,db,row,user.id);results.push({client_id:row.client_id,status:order?.status||'unknown'});}catch(e){results.push({client_id:row.client_id,status:'unavailable',message:e.message});}}
  const ctx=await accountContext(env);
  const unresolved=results.filter(x=>['unknown','unavailable'].includes(x.status));
  const accounting=Number(ctx.account.cash)+Number(ctx.account.long_market_value)+Number(ctx.account.short_market_value),difference=Number(ctx.account.equity)-accounting;
  const result={timestamp:nowISO(),orders:results,unresolved:unresolved.length,equity_difference:Number.isFinite(difference)?difference:null,external_open_orders:ctx.openOrders.filter(x=>!String(x.client_order_id).startsWith('qs_')).length,scope:'核对本平台订单与券商状态，以及券商现金＋多空市值与净值；不覆盖外部账户流水。'};
  await audit(db,user.id,'reconciliation',null,result);
  if(c.lease_id)await run(db,'UPDATE control SET lease_id=NULL,lease_until=0 WHERE id=1 AND lease_id=? AND lease_until<?',c.lease_id,Date.now());
  if(unresolved.length||!Number.isFinite(difference)||Math.abs(difference)>1)await run(db,'UPDATE control SET halted=1,reason=?,revision=revision+1,updated_at=? WHERE id=1','对账存在未决项',nowISO());
  return {ok:unresolved.length===0&&Number.isFinite(difference)&&Math.abs(difference)<=1,...result};
}
async function setHalt(env,db,user,input){
  requireValue(typeof input.halted==='boolean','暂停状态无效');
  if(input.halted){
    await db.batch([db.prepare('UPDATE control SET halted=1,reason=?,revision=revision+1,updated_at=? WHERE id=1').bind('操作员暂停',nowISO()),await auditStatement(db,user.id,'halt',null,{cancel_requested:input.cancel===true})]);
    const canceled=input.cancel?await cancelOrders(env,db,user):null;
    return {ok:true,control:publicControl(await control(db)),canceled};
  }
  requireValue(input.confirm==='恢复模拟盘','请输入“恢复模拟盘”');
  const initial=await control(db);
  const result=await reconcile(env,db,user);requireValue(result.ok,'对账未通过，保持暂停',409,'RECONCILIATION_FAILED');
  const ctx=await accountContext(env),c=await control(db);
  requireValue(c.revision===initial.revision,'恢复期间控制状态已变化，请刷新后重试',409,'CONTROL_CHANGED');
  requireValue(!ctx.account.trading_blocked&&!ctx.account.account_blocked&&ctx.account.status==='ACTIVE','券商账户仍不可交易',409);
  requireValue(!(Number(ctx.account.last_equity)>0&&(Number(ctx.account.last_equity)-Number(ctx.account.equity))/Number(ctx.account.last_equity)>=c.max_loss),'当日亏损仍超过限额，暂不能恢复',409,'DAILY_LOSS');
  const changed=await db.batch([db.prepare('UPDATE control SET halted=0,reason=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=? AND lease_id IS NULL').bind('操作员对账后恢复',nowISO(),c.revision),await auditStatement(db,user.id,'resume_attempt',null,{reconciliation:result.timestamp,revision:c.revision})]);
  requireValue(changed[0].meta.changes===1,'控制状态发生变化，请刷新后重试',409);
  return {ok:true,control:publicControl(await control(db))};
}
async function saveArtifact(db,user,kind,name,payload,id=crypto.randomUUID()){
  await db.batch([db.prepare('INSERT INTO artifacts (id,kind,name,payload,actor,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,kind,name,JSON.stringify(payload),user.id,nowISO()),await auditStatement(db,user.id,kind+'_saved',id,{name})]);return id;
}
async function artifact(db,id,kind){const row=await first(db,'SELECT * FROM artifacts WHERE id=? AND kind=?',id,kind);requireValue(row,'记录不存在',404);return {...row,payload:JSON.parse(row.payload)};}
async function history(env,c){
  const clock=await broker(env,'/v2/clock'),end=new Date(String(clock.timestamp).slice(0,10)+'T00:00:00Z'),start=new Date(end.getTime()-c.days*86400000);
  const query=new URLSearchParams({symbols:c.symbol,timeframe:'1Day',start:start.toISOString(),end:new Date(end.getTime()-1).toISOString(),feed:'iex',adjustment:'all',limit:'10000',sort:'asc'});
  const response=await broker(env,'/v2/stocks/bars?'+query,{data:true});
  requireValue(!response.next_page_token,'数据超过单次课程任务上限，请缩短区间',422,'DATA_LIMIT');
  return {source:'Alpaca IEX',adjustment:'all',fetched_at:nowISO(),query:Object.fromEntries(query),bars:response.bars?.[c.symbol]||[]};
}
async function runBacktest(env,db,user,input){
  const c=strategyConfig(input.config),saved=input.snapshot_id?await artifact(db,input.snapshot_id,'dataset'):null;
  requireValue(!saved||saved.payload.query.symbols===c.symbol,'快照标的与策略不一致');
  const data=saved?.payload||await history(env,c),snapshotId=saved?.id||'data_'+(await digest({query:data.query,bars:data.bars})).slice(0,40);
  const result=backtest(data.bars,c),strategyId='strategy_'+(await digest({engine:ENGINE_VERSION,config:c})).slice(0,40);
  await saveArtifact(db,user,'dataset',c.symbol+' '+data.query.start.slice(0,10),data,snapshotId);
  await saveArtifact(db,user,'strategy',c.name,{config:c,engine:ENGINE_VERSION},strategyId);
  const payload={...result,snapshot_id:snapshotId,strategy_id:strategyId,created_at:nowISO()};
  const id=await saveArtifact(db,user,'backtest',c.name,payload);
  return {ok:true,id,...payload};
}
async function buildPlan(env,db,user,input){
  const report=await artifact(db,input.backtest_id,'backtest'),r=report.payload,c=r.config;
  const [ctx,quote]=await Promise.all([accountContext(env),snapshotQuote(env,c.symbol)]);
  requireValue((Date.parse(ctx.clock.timestamp)-Date.parse(r.signal_timestamp))/86400000<=7,'回测信号超过 7 天，请重新拉取历史数据',409,'STALE_SIGNAL');
  const reference=Number(quote.ap)>0&&Number(quote.bp)>0?(Number(quote.ap)+Number(quote.bp))/2:Number(quote.reference);
  requireValue(reference>0&&Number.isFinite(reference),'无法获取计划参考价',503);
  const position=ctx.positions.find(p=>p.symbol===c.symbol),current=Number(position?.qty||0),target=Math.floor(Number(ctx.account.equity)*c.allocation*r.signal/reference),delta=target-current;
  const payload={backtest_id:input.backtest_id,strategy_id:r.strategy_id,snapshot_id:r.snapshot_id,signal_timestamp:r.signal_timestamp,signal:r.signal,symbol:c.symbol,current_qty:current,target_qty:target,delta,reference,created_at:nowISO(),expires_at:new Date(Date.now()+300000).toISOString(),order:Math.abs(delta)>=1?{symbol:c.symbol,side:delta>0?'buy':'sell',qty:Math.floor(Math.abs(delta)),type:'limit',limit_price:reference.toFixed(2),time_in_force:'day'}:null,notes:'计划仅调整所选标的；不会清仓其他持仓。超过限额时请降低策略仓位重新回测。提交时重新校验行情、账户和风控。'};
  const id=await saveArtifact(db,user,'plan',c.name,payload);return {ok:true,id,...payload};
}
async function overview(env,db){
  const c=await control(db);
  const results=await Promise.allSettled([broker(env,'/v2/account'),broker(env,'/v2/clock'),broker(env,'/v2/positions'),broker(env,'/v2/orders?status=all&limit=100&direction=desc&nested=false')]);
  const names=['account','clock','positions','orders'],errors={};let out={};
  results.forEach((r,i)=>{if(r.status==='fulfilled')out[names[i]]=r.value;else errors[names[i]]=r.reason.message;});
  out.account=out.account?pick(out.account,['status','currency','equity','last_equity','cash','buying_power','long_market_value','short_market_value','trading_blocked','account_blocked']):null;
  out.positions=out.positions?.map(p=>pick(p,['symbol','qty','side','avg_entry_price','current_price','market_value','unrealized_pl','unrealized_plpc']))||null;
  out.orders=out.orders?.map(cleanOrder)||null;
  const local=await all(db,'SELECT client_id,status,broker_id,payload,broker_data,error,created_at,updated_at FROM orders ORDER BY created_at DESC LIMIT 100');
  return {ok:Object.keys(errors).length===0,fetched_at:nowISO(),...out,control:publicControl(c),local_orders:local.map(r=>({...r,payload:JSON.parse(r.payload),broker_data:r.broker_data?JSON.parse(r.broker_data):null})),errors,source:'Alpaca Paper / IEX',refresh_seconds:15};
}
async function route(request,env){
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(!path.startsWith('/api/')){
    requireValue(method==='GET'||method==='HEAD','Method not allowed',405);
    const asset={'/':[PAGE,'text/html'],'/index.html':[PAGE,'text/html'],'/styles.css':[CSS,'text/css'],'/app.js':[CLIENT,'text/javascript'],'/research-baseline.json':[FROZEN,'application/json']}[path];
    if(!asset)return new Response('Not found',{status:404});
    return new Response(method==='HEAD'?null:asset[0],{headers:{'content-type':asset[1]+'; charset=utf-8','cache-control':'no-cache','content-security-policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
  }
  requireValue(method==='GET'||method==='POST','Method not allowed',405);
  const db=database(env);
  if(method==='GET'){
    if(path==='/api/v1/session'){const u=identity(request,env),c=await control(db);return json({ok:true,signed_in:u.signed_in,operator:u.operator&&(!c.owner_id||u.id===c.owner_id),email:u.email,sign_in:'/signin-with-chatgpt?return_to=%2F',sign_out:'/signout-with-chatgpt?return_to=%2F'});}
    if(path==='/api/v1/overview'||path==='/api/paper/status')return json(await overview(env,db));
    if(path==='/api/v1/equity'){const period=url.searchParams.get('period')||'1M';requireValue(['1W','1M','3M'].includes(period),'时间范围无效');return json({ok:true,source:'Alpaca Paper',fetched_at:nowISO(),history:await broker(env,'/v2/account/portfolio/history?period='+period+'&timeframe=1D&extended_hours=false')});}
    if(path==='/api/v1/market'){const sym=symbol(url.searchParams.get('symbol'));return json({ok:true,symbol:sym,source:'Alpaca IEX',fetched_at:nowISO(),snapshot:await snapshotQuote(env,sym)});}
    if(path==='/api/v1/catalog')return json({ok:true,symbols:SYMBOLS,engine:ENGINE_VERSION,templates:[{type:'sma',name:'双均线趋势',description:'快均线高于慢均线时持有目标仓位，否则空仓。'},{type:'momentum',name:'绝对动量',description:'慢周期累计收益为正时持有目标仓位，否则空仓。'},{type:'buy_hold',name:'买入持有基准',description:'始终保持首次买入的目标仓位，用于同区间比较。'}]});
    if(path==='/api/v1/artifacts'){const kind=url.searchParams.get('kind')||'backtest';requireValue(['backtest','strategy','dataset','plan'].includes(kind),'类别无效');return json({ok:true,items:await all(db,'SELECT id,kind,name,created_at FROM artifacts WHERE kind=? ORDER BY created_at DESC LIMIT 50',kind)});}
    if(path==='/api/v1/artifact'){return json({ok:true,...await artifact(db,url.searchParams.get('id'),url.searchParams.get('kind'))});}
    if(path==='/api/v1/audit'){
      await operator(request,env,db);const rows=await all(db,'SELECT * FROM events ORDER BY id DESC LIMIT 100');
      const items=await Promise.all(rows.map(async r=>({...r,details:JSON.parse(r.details),valid:(await digest({timestamp:r.timestamp,actor:r.actor,kind:r.kind,subject:r.subject,details:JSON.parse(r.details)}))===r.digest})));
      return json({ok:true,items,integrity:items.every(x=>x.valid)});
    }
    throw new AppError('接口不存在',404,'NOT_FOUND');
  }
  const input=await body(request),user=await operator(request,env,db);
  if(path==='/api/v1/orders/preview'){
    const o=normalizeOrder(input),ctx=await contextForOrder(env,db,o),check=riskCheck(o,ctx);return json({ok:true,order:o,...check});
  }
  if(path==='/api/v1/orders')return json(await submitOrder(env,db,user,input));
  if(path==='/api/v1/orders/cancel'){requireValue(typeof input.client_id==='string'&&/^qs_[a-f0-9]{32}$/.test(input.client_id),'缺少有效的平台订单号');return json(await cancelOrders(env,db,user,input.client_id));}
  if(path==='/api/v1/orders/cancel-all')return json(await cancelOrders(env,db,user));
  if(path==='/api/v1/reconcile')return json(await reconcile(env,db,user));
  if(path==='/api/v1/control')return json(await setHalt(env,db,user,input));
  if(path==='/api/v1/risk'){
    const settings={max_order:numeric(input.max_order,'单笔限额',100,10000),max_daily:numeric(input.max_daily,'单日限额',100,50000),max_position:numeric(input.max_position,'单标的上限',0.01,0.5),max_loss:numeric(input.max_loss,'当日亏损上限',0.005,0.1)};
    requireValue(settings.max_daily>=settings.max_order,'单日限额不得小于单笔限额');
    const lease=await acquire(db);try{await db.batch([db.prepare('UPDATE control SET max_order=?,max_daily=?,max_position=?,max_loss=?,revision=revision+1,updated_at=? WHERE id=1').bind(settings.max_order,settings.max_daily,settings.max_position,settings.max_loss,nowISO()),await auditStatement(db,user.id,'risk_settings',null,settings)]);}finally{await release(db,lease);}
    return json({ok:true,control:publicControl(await control(db))});
  }
  if(path==='/api/v1/backtests')return json(await runBacktest(env,db,user,input));
  if(path==='/api/v1/plans')return json(await buildPlan(env,db,user,input));
  if(path==='/api/v1/plans/submit'){
    const plan=(await artifact(db,input.plan_id,'plan')).payload;requireValue(plan.order&&plan.order.qty>=1,'计划没有可提交订单',409);
    return json(await submitOrder(env,db,user,{...plan.order,idempotency_key:input.plan_id,confirm:input.confirm,allow_queued:input.allow_queued},plan));
  }
  throw new AppError('接口不存在',404,'NOT_FOUND');
}
export default {async fetch(request,env){const requestId=crypto.randomUUID();try{const response=await route(request,env);response.headers.set('x-request-id',requestId);return response;}catch(error){const known=error instanceof AppError;const response=json({ok:false,error:known?error.message:'服务暂时不可用，新增交易已阻断；请稍后重试。',code:known?error.code:'SERVICE_UNAVAILABLE',request_id:requestId},known?error.status:503);response.headers.set('x-request-id',requestId);if(!known)console.error('request_failed',requestId,error?.name||'Error');return response;}}};
