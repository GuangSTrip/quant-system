import {rankedCatalog} from './portfolio-ranking.mjs';
import {cnPortfolioAdapter,cnExclusive} from './myquant-portfolio.mjs';
import {replayDetails} from './portfolio-replay.mjs';
import {createPortfolio,portfolioGuard} from './portfolio.mjs';
import {buildPortfolioCatalog,instrumentSymbol} from './portfolio-contract.mjs';
import {tradingState,setTrading,previewHK,submitHK,inspectHK,cancelHK,recoverHK,startHKAuto,pauseHKAuto,resumeHKAuto,tickHK,changeHKConnection,hkPortfolioAdapter} from './longbridge-trading.mjs';
import {connectionStatus,saveConnection,removeConnection,connectionOverview} from './longbridge.mjs';
import {hkOverview} from './hk.mjs';
import {AppError,requireValue,nowISO,digest,numeric,symbol,SYMBOLS,INTRADAY_SYMBOLS,strategyConfig,isIntraday,backtest,normalizeOrder,riskCheck,ENGINE_VERSION} from './engine.mjs';
import {PAGE,CSS,CLIENT,FROZEN,LIBRARY_DEMO,CURRENT_DAILY_PLAN,HISTORICAL_DAILY_RESULTS,MODULAR_DAILY_RESULTS,DAILY_REFINEMENT} from './assets.mjs';
import {broker} from './transport.mjs';
import {myquantBridge} from './myquant-transport.mjs';
import {identity,login,logout} from './auth.mjs';
import {createAutomation,autoGuard} from './automation.mjs';
import {verifyScheduler} from './scheduler-auth.mjs';

const TERMINAL=['filled','canceled','expired','rejected','replaced'];
const UNCERTAIN=['submitting','unknown'];
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff',...headers}});
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
async function operator(request,env,db){
  const user=await identity(request,env,db);requireValue(user.signed_in,'请先使用网站账号和密码登录',401,'SIGN_IN_REQUIRED');
  requireValue(user.operator,'当前账号只有查看权限',403,'FORBIDDEN');
  return user;
}
async function myquantAction(env,db,user,path,input,kind){
  const result=await myquantBridge(env,path,{method:'POST',payload:input,actor:user.id});
  await audit(db,user.id,'myquant_'+kind,input?.client_id||null,{
    source:'myquant_sim_bridge',
    order_status:result.order?.status||null,
    bridge_connected:result.bridge?.connected??null,
  });
  return result;
}
async function body(request){
  const path=new URL(request.url).pathname;const limit=path==='/api/v1/portfolio/backtests'?2000000:path==='/api/v1/portfolio/signals'?500000:20000;
  requireValue(request.headers.get('origin')===new URL(request.url).origin,'请求来源校验失败',403,'ORIGIN_MISMATCH');
  requireValue(request.headers.get('x-quant-action')==='1','缺少操作标记',403,'CSRF');
  requireValue(request.headers.get('content-type')?.startsWith('application/json'),'请提交 JSON',415);
  requireValue(Number(request.headers.get('content-length')||0)<=limit,'请求过大',413);
  const text=await request.text();requireValue(text.length<=limit,'请求过大',413);
  try{const obj=JSON.parse(text);requireValue(obj&&typeof obj==='object'&&!Array.isArray(obj),'请求格式无效');return obj;}catch(e){if(e instanceof AppError)throw e;throw new AppError('JSON 格式错误');}
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
async function requireCourseAsset(env,sym){
  const asset=await broker(env,'/v2/assets/'+encodeURIComponent(sym),{allow404:true});
  requireValue(asset,`${sym}：券商未找到该证券，请检查交易代码`,409,'ASSET_NOT_FOUND');
  // Raw Trading API JSON uses "class"; "asset_class" is the Python SDK model name.
  requireValue(typeof asset.class==='string'&&typeof asset.status==='string'&&typeof asset.tradable==='boolean',`${sym}：券商证券资料不完整，暂时无法确认可交易性，请稍后重试`,502,'ASSET_DATA_UNAVAILABLE');
  requireValue(asset.class==='us_equity',`${sym}：当前课程平台仅支持美股和美股 ETF，不支持该证券类别`,409,'ASSET_CLASS_UNSUPPORTED');
  requireValue(asset.status==='active',`${sym}：券商将该证券标记为非活跃状态，暂不能提交订单`,409,'ASSET_INACTIVE');
  requireValue(asset.tradable===true,`${sym}：券商当前不允许交易该证券，请选择其他课程标的`,409,'ASSET_NOT_TRADABLE');
  return asset;
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
async function saveBrokerOrder(env,db,row,order,actor,kind='order_status'){
  const requested=JSON.parse(row.payload);
  requireValue(order.client_order_id===row.client_id&&order.symbol===requested.symbol&&order.side===requested.side&&Number(order.qty)===Number(requested.qty)&&Number.isFinite(Number(order.filled_qty))&&Number(order.filled_qty)>=0&&Number(order.filled_qty)<=Number(requested.qty),'券商回报与委托不一致',409,'RECEIPT_MISMATCH');
  const clean=cleanOrder(order);
  await db.batch([db.prepare('UPDATE orders SET broker_id=?,status=?,broker_data=?,error=NULL,updated_at=? WHERE client_id=?').bind(order.id,order.status,JSON.stringify(clean),nowISO(),row.client_id),await auditStatement(db,actor,kind,row.client_id,{status:order.status,filled_qty:order.filled_qty,broker_id:order.id})]);
  console.info(JSON.stringify({event:'paper_order_receipt',observed_at:nowISO(),action:kind,environment:env.DEMO_MODE==='local-fixture'?'Local broker fixture':'Alpaca Paper',client_order_id:row.client_id,broker_order_id:clean.id,symbol:clean.symbol,side:clean.side,status:clean.status,filled_qty:clean.filled_qty,filled_avg_price:clean.filled_avg_price,filled_at:clean.filled_at}));
  return clean;
}
async function findOrder(env,id){return broker(env,'/v2/orders:by_client_order_id?client_order_id='+encodeURIComponent(id),{allow404:true});}
async function reconcileOne(env,db,row,actor){
  const existing=await findOrder(env,row.client_id);
  if(existing)return saveBrokerOrder(env,db,row,existing,actor,'reconcile_order');
  return null;
}
async function submitOrder(env,db,user,input,plan=null,automation=null){
  requireValue(input.confirm===true,'请在网页订单摘要中确认提交');
  requireValue(typeof input.idempotency_key==='string'&&/^[a-f0-9-]{36}$/.test(input.idempotency_key),'缺少有效幂等键');
  const portfolio=automation?.portfolio===true;
  const order=normalizeOrder(input,portfolio?instrumentSymbol(input.symbol,'US'):null),hash=await digest({...order,allow_queued:input.allow_queued===true}),clientId='qs_'+input.idempotency_key.replaceAll('-','');
  const lease=await acquire(db);
  try{
    await portfolioGuard(db,'US',portfolio?automation:null);
    let row=await first(db,'SELECT * FROM orders WHERE client_id=?',clientId);
    if(row){
      requireValue(row.request_hash===hash,'同一幂等键不能用于不同订单',409,'IDEMPOTENCY_CONFLICT');
      if(!TERMINAL.includes(row.status)){const found=await reconcileOne(env,db,row,user.id);if(found)return {ok:found.status!=='rejected',reused:true,order:found};}
      return {ok:!UNCERTAIN.includes(row.status)&&row.status!=='rejected',reused:true,order:row.broker_data?JSON.parse(row.broker_data):{client_order_id:row.client_id,status:row.status},message:row.error||'该订单已处理，不会重复提交'};
    }
    await portfolioGuard(db,'US',portfolio?automation:null);
    await autoGuard(db,order,portfolio?null:automation);
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
    await requireCourseAsset(env,order.symbol);
    const timestamp=nowISO();
    await db.batch([
      db.prepare('INSERT INTO orders (client_id,request_hash,payload,status,estimated_notional,actor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(clientId,hash,JSON.stringify(order),'submitting',check.notional,user.id,timestamp,timestamp),
      await auditStatement(db,user.id,'order_intent',clientId,{order,check})
    ]);
    row=await first(db,'SELECT * FROM orders WHERE client_id=?',clientId);
    const latest=await control(db);
    if(latest.halted){await run(db,"UPDATE orders SET status='rejected',error=?,updated_at=? WHERE client_id=?",'暂停发生在发送前',nowISO(),clientId);throw new AppError('服务器已暂停，此订单未发送',409,'HALTED');}
    try{await portfolioGuard(db,'US',portfolio?automation:null);
    await autoGuard(db,order,portfolio?null:automation);}catch(e){await run(db,"UPDATE orders SET status='rejected',error=?,updated_at=? WHERE client_id=?",e.message,nowISO(),clientId);throw e;}
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
    const result=await saveBrokerOrder(env,db,row,placed,user.id,'order_submitted');
    const stopped=(await control(db)).halted || Boolean(automation && await (portfolio?portfolioGuard(db,'US',automation):autoGuard(db,order,automation)).then(()=>false,()=>true));
    if(stopped&&!TERMINAL.includes(placed.status)){
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
      if(TERMINAL.includes(order.status)){await saveBrokerOrder(env,db,row,order,user.id,'cancel_already_terminal');results.push({client_id:row.client_id,status:order.status});continue;}
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
    await auto.pause(db,user,'全局交易已暂停');
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
  const clock=await broker(env,'/v2/clock'),minute=isIntraday(c.type),end=minute?new Date(Math.floor((Date.parse(clock.timestamp)-60000)/60000)*60000):new Date(String(clock.timestamp).slice(0,10)+'T00:00:00Z'),start=new Date(end.getTime()-c.days*86400000);
  const query=new URLSearchParams({symbols:c.symbol,timeframe:minute?'1Min':'1Day',start:start.toISOString(),end:minute?end.toISOString():new Date(end.getTime()-1).toISOString(),feed:'iex',adjustment:minute?'raw':'all',limit:'10000',sort:'asc'});
  const bars=[],seen=new Set();let pageToken=null,pageCount=0;
  do{
    const pageQuery=new URLSearchParams(query);if(pageToken)pageQuery.set('page_token',pageToken);
    const response=await broker(env,'/v2/stocks/bars?'+pageQuery,{data:true});
    bars.push(...(response.bars?.[c.symbol]||[]));pageCount++;
    pageToken=response.next_page_token||null;
    requireValue(!pageToken||(!seen.has(pageToken)&&pageCount<4),'历史分钟数据分页过多或重复，请缩短区间',422,'DATA_LIMIT');
    if(pageToken)seen.add(pageToken);
  }while(pageToken);
  return {source:env.DEMO_DATA_SOURCE||'Alpaca IEX',adjustment:minute?'raw':'all',fetched_at:env.DEMO_DATA_FETCHED_AT||nowISO(),query:Object.fromEntries(query),page_count:pageCount,bars};
}
async function runBacktest(env,db,user,input){
  const c=strategyConfig(input.config),saved=input.snapshot_id?await artifact(db,input.snapshot_id,'dataset'):null;
  requireValue(!saved||saved.payload.query.symbols===c.symbol,'快照标的与策略不一致');
  requireValue(!saved||saved.payload.query.timeframe===(isIntraday(c.type)?'1Min':'1Day'),'快照频率与策略不一致');
  const data=saved?.payload||await history(env,c),snapshotId=saved?.id||'data_'+(await digest({query:data.query,bars:data.bars})).slice(0,40);
  const result=backtest(data.bars,c),strategyId='strategy_'+(await digest({engine:ENGINE_VERSION,config:c})).slice(0,40);
  await saveArtifact(db,user,'dataset',c.symbol+' '+data.query.start.slice(0,10),data,snapshotId);
  await saveArtifact(db,user,'strategy',c.name,{config:c,engine:ENGINE_VERSION},strategyId);
  const payload={...result,data_source:data.source,data_fetched_at:data.fetched_at,snapshot_id:snapshotId,strategy_id:strategyId,created_at:nowISO()};
  const id=await saveArtifact(db,user,'backtest',c.name,payload);
  return {ok:true,id,...payload};
}
async function buildPlan(env,db,user,input){
  const report=await artifact(db,input.backtest_id,'backtest'),r=report.payload,c=r.config;
  const [ctx,quote]=await Promise.all([accountContext(env),snapshotQuote(env,c.symbol)]);
  const age=Date.parse(ctx.clock.timestamp)-Date.parse(r.signal_timestamp);
  requireValue(age>=0&&age<=(isIntraday(c.type)?5*60000:7*86400000),isIntraday(c.type)?'分钟信号超过 5 分钟，请重新拉取行情':'回测信号超过 7 天，请重新拉取历史数据',409,'STALE_SIGNAL');
  if(isIntraday(c.type))requireValue(ctx.clock.is_open,'分钟策略仅在开市时生成模拟订单',409,'MARKET_CLOSED');
  const reference=Number(quote.ap)>0&&Number(quote.bp)>0?(Number(quote.ap)+Number(quote.bp))/2:Number(quote.reference);
  requireValue(reference>0&&Number.isFinite(reference),'无法获取计划参考价',503);
  const position=ctx.positions.find(p=>p.symbol===c.symbol),current=Number(position?.qty||0),target=Math.floor((isIntraday(c.type)?c.budget:Number(ctx.account.equity)*c.allocation)*r.signal/reference),delta=target-current;
  const payload={backtest_id:input.backtest_id,strategy_id:r.strategy_id,snapshot_id:r.snapshot_id,signal_timestamp:r.signal_timestamp,signal:r.signal,symbol:c.symbol,current_qty:current,target_qty:target,delta,reference,created_at:nowISO(),expires_at:new Date(Date.now()+300000).toISOString(),order:Math.abs(delta)>=1?{symbol:c.symbol,side:delta>0?'buy':'sell',qty:Math.floor(Math.abs(delta)),type:'limit',limit_price:reference.toFixed(2),time_in_force:'day'}:null,notes:'计划仅调整所选标的；不会清仓其他持仓。超过限额时请降低策略仓位重新回测。提交时重新校验行情、账户和风控。'};
  const id=await saveArtifact(db,user,'plan',c.name,payload);return {ok:true,id,...payload};
}
async function prepareAcceptance(env,db,user,input){
  const sym=symbol(input.symbol||'SPY'),ctx=await accountContext(env),quote=await snapshotQuote(env,sym);
  const reference=Number(quote.reference);requireValue(reference>0&&Number.isFinite(reference),'验收缺少参考价格',503);
  const latestAge=(Date.parse(ctx.clock.timestamp)-Date.parse(quote.t))/1000;
  const price=ctx.clock.is_open&&latestAge>=-5&&latestAge<=120&&Number(quote.ap)>0?Number(quote.ap):reference;
  const report=await runBacktest(env,db,user,{config:{name:sym+' 课堂验收回测',symbol:sym,type:'buy_hold',allocation:.01,days:90,fast:5,slow:20,cost_bps:10}});
  const dataset=await artifact(db,report.snapshot_id,'dataset'),replay=backtest(dataset.payload.bars,report.config);
  const reproducible=await digest({metrics:report.metrics,curve:report.curve})===await digest({metrics:replay.metrics,curve:replay.curve});
  const reconciliation=await reconcile(env,db,user);
  const order=normalizeOrder({symbol:sym,side:'buy',type:'limit',qty:1,limit_price:(price*1.005).toFixed(2),time_in_force:'day'});
  let check=null,riskError=null;try{check=riskCheck(order,await contextForOrder(env,db,order));}catch(error){riskError={code:error.code,message:error.message};}
  const id=crypto.randomUUID(),cancelKey=crypto.randomUUID();
  const payload={id,created_at:nowISO(),environment:'Alpaca Paper',symbol:sym,current_qty:Number(ctx.positions.find(p=>p.symbol===sym)?.qty||0),initial_cash:Number(ctx.account.cash),clock:ctx.clock,expires_at:new Date(Date.now()+300000).toISOString(),order,cancel_key:cancelKey,cancel_order:normalizeOrder({...order,limit_price:(price*.5).toFixed(2)}),backtest_id:report.id,snapshot_id:report.snapshot_id,check,risk_error:riskError,checks:[{name:'账户／市场时钟／持仓／订单接口',status:'passed',evidence:'实际 Alpaca Paper 响应，账户 '+ctx.account.status},{name:'IEX 行情与历史日线',status:'passed',evidence:dataset.payload.bars.length+' 根历史日线；行情时间 '+(quote.t||quote.reference_at)},{name:'同快照回测重跑',status:reproducible?'passed':'failed',evidence:'指标和完整曲线 SHA-256 对比'},{name:'交易前对账',status:reconciliation.ok?'passed':'failed',evidence:'净值差额 '+reconciliation.equity_difference+' USD；未决 '+reconciliation.unresolved}],notes:'本流程通过本平台订单引擎分别创建一笔 1 股买入限价单和一笔 1 股撤单测试单。买入限价为准备时参考价上浮 0.5%；撤单测试价为参考价的 50%。每笔均需确认并重新风控。不会自动卖出测试持仓；休市排队不算成交。'};
  await saveArtifact(db,user,'acceptance',sym+' 模拟盘验收',payload,id);return {ok:true,run:payload};
}
async function acceptanceReport(db,id){
  const run=(await artifact(db,id,'acceptance')).payload;
  const row=await first(db,"SELECT payload FROM artifacts WHERE kind='acceptance_result' AND name=? ORDER BY created_at DESC LIMIT 1",id);
  return {ok:true,run,latest:row?JSON.parse(row.payload):null};
}
async function inspectAcceptance(env,db,user,id){
  const saved=(await artifact(db,id,'acceptance')).payload;
  async function receipt(key){
    const clientId='qs_'+key.replaceAll('-',''),local=await first(db,'SELECT * FROM orders WHERE client_id=?',clientId);
    if(!local)return null;
    const found=await findOrder(env,clientId);
    if(found)return saveBrokerOrder(env,db,local,found,user.id,'acceptance_order_observed');
    return {client_order_id:clientId,status:'unknown',filled_qty:null,filled_avg_price:null};
  }
  const fill=await receipt(id),cancel=await receipt(saved.cancel_key),reconciliation=await reconcile(env,db,user),ctx=await accountContext(env);
  const currentQty=Number(ctx.positions.find(p=>p.symbol===saved.symbol)?.qty||0),delta=currentQty-saved.current_qty;
  const filled=fill?.status==='filled'&&Number(fill.filled_qty)===1&&Number(fill.filled_avg_price)>0&&Number.isFinite(Date.parse(fill.filled_at));
  const canceled=cancel?.status==='canceled'&&Number(cancel.filled_qty)===0;
  const expected=Number(fill?.filled_qty||0)+Number(cancel?.filled_qty||0),positionOK=filled&&Math.abs(delta-expected)<1e-8;
  const checks=[...saved.checks,
    {name:'买入委托被券商接收',status:fill?.id&&fill.status!=='rejected'?'passed':fill?.status==='rejected'?'failed':'pending',evidence:fill?fill.client_order_id+' · '+fill.status:'尚未提交'},
    {name:'1 股实际模拟成交',status:filled?'passed':fill&&['rejected','canceled','expired'].includes(fill.status)?'failed':'pending',evidence:filled?'券商 '+fill.id+'；成交价 '+fill.filled_avg_price+'；成交时间 '+fill.filled_at:ctx.clock.is_open?'等待券商成交回报':'市场休市；下次开市 '+ctx.clock.next_open},
    {name:'独立撤单委托已撤销',status:canceled?'passed':Number(cancel?.filled_qty)>0?'failed':'pending',evidence:cancel?cancel.client_order_id+' · '+cancel.status+(Number(cancel.filled_qty)>0?'；已有成交不能撤回':''):'尚未运行撤单验证'},
    {name:'持仓变化与本次成交相符',status:positionOK?'passed':'pending',evidence:'准备时 '+saved.current_qty+' 股，当前 '+currentQty+' 股，本次两笔委托合计成交 '+expected+' 股；其他同标的操作会影响差额'},
    {name:'成交后账户与订单对账',status:!reconciliation.ok?'failed':filled?'passed':'pending',evidence:'净值差额 '+reconciliation.equity_difference+' USD；未决 '+reconciliation.unresolved+(filled?'':'；仍需等待实际成交')}
  ];
  const result={run_id:id,checked_at:nowISO(),environment:'Alpaca Paper',complete:checks.every(c=>c.status==='passed'),checks,receipts:{fill,cancel},positions:{initial:saved.current_qty,current:currentQty,delta,expected},reconciliation,clock:ctx.clock};
  await saveArtifact(db,user,'acceptance_result',id,result);
  console.info(JSON.stringify({event:'paper_acceptance_result',run_id:id,checked_at:result.checked_at,complete:result.complete,checks:checks.map(c=>({name:c.name,status:c.status})),fill_order_id:fill?.id||null,cancel_order_id:cancel?.id||null,position_delta:delta,expected_position_delta:expected,equity_difference:reconciliation.equity_difference,unresolved:reconciliation.unresolved}));
  return {ok:true,run:saved,latest:result};
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
  return {ok:Object.keys(errors).length===0,fetched_at:nowISO(),...out,control:publicControl(c),local_orders:local.map(r=>({...r,payload:JSON.parse(r.payload),broker_data:r.broker_data?JSON.parse(r.broker_data):null})),errors,source:env.DEMO_MODE==='local-fixture'?'本地券商替身 / 历史行情快照':'Alpaca Paper / IEX',demo_mode:env.DEMO_MODE==='local-fixture',refresh_seconds:15};
}
const portfolioCatalog=buildPortfolioCatalog(JSON.parse(MODULAR_DAILY_RESULTS),JSON.parse(DAILY_REFINEMENT));
const portfolio=createPortfolio({catalog:portfolioCatalog,audit,adapters:{
 US:{
  async exclusive(db,fn){const lease=await acquire(db);try{return await fn();}finally{await release(db,lease);}},
  async available(env,db){requireValue(!await first(db,"SELECT client_id FROM orders WHERE status IN ('unknown','submitting') LIMIT 1"),'存在未知订单，请先对账',409,'UNRESOLVED_ORDER');const c=await control(db);requireValue(!c.halted,'请先对账并恢复美股交易',409,'HALTED');const old=await first(db,'SELECT enabled FROM auto_strategy WHERE id=1');requireValue(!old?.enabled,'请先暂停原单标的自动策略',409);},
  async snapshot(env,db,symbols){
   const ctx=await accountContext(env);requireValue(ctx.account.currency==='USD','账户必须以 USD 计价',409);requireValue(ctx.account.status==='ACTIVE'&&!ctx.account.trading_blocked&&!ctx.account.account_blocked,'模拟账户当前不可交易',409,'ACCOUNT_BLOCKED');
   const quotes={};if(ctx.clock.is_open)for(const symbol of symbols){await requireCourseAsset(env,symbol);const q=await snapshotQuote(env,symbol),age=Date.now()-Date.parse(q.t);requireValue(age>=-5000&&age<=120000&&Number(q.ap)>0&&Number(q.bp)>0&&Number(q.ap)>=Number(q.bp),'实时报价过期：'+symbol,409,'STALE_QUOTE');quotes[symbol]={price:(Number(q.ap)+Number(q.bp))/2,lot:1,tradable:true};}
   return {tag:await digest('alpaca:'+env.ALPACA_PAPER_API_KEY),cash:Number(ctx.account.cash),is_open:ctx.clock.is_open,pending:ctx.openOrders.length>0,positions:ctx.positions.map(p=>({symbol:p.symbol,qty:Number(p.qty)})),quotes};
  },
  async reconcile(env,db){requireValue((await reconcile(env,db,{id:'portfolio'})).ok,'账户对账失败',409,'RECONCILIATION_FAILED');},
  async ledger(db,s){return (await all(db,'SELECT * FROM orders WHERE actor=?','portfolio:'+s.run_id)).map(o=>{const b=o.broker_data?JSON.parse(o.broker_data):null,p=JSON.parse(o.payload);return {key:o.client_id.replace(/^qs_/,''),id:o.client_id,broker_id:o.broker_id,status:o.status,qty:Number(p.qty),submitted_at:o.created_at,updated_at:o.updated_at,filled_at:b?.filled_at||null,symbol:p.symbol,side:p.side,filled:Number(b?.filled_qty||0),price:Number(b?.filled_avg_price||0)};});},
  async submit(env,db,s,o){return submitOrder(env,db,{id:'portfolio:'+s.run_id},{symbol:o.symbol,side:o.side,qty:o.qty,type:'limit',limit_price:o.price,time_in_force:'day',confirm:true,idempotency_key:o.key},null,{portfolio:true,run_id:s.run_id,revision:s.revision});}
 },HK:hkPortfolioAdapter,CN:cnPortfolioAdapter
}});
async function route(request,env){
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(!path.startsWith('/api/')){
    requireValue(method==='GET'||method==='HEAD','Method not allowed',405);
    const asset={'/':[PAGE,'text/html'],'/index.html':[PAGE,'text/html'],'/styles.css':[CSS,'text/css'],'/app.js':[CLIENT,'text/javascript'],'/research-baseline.json':[FROZEN,'application/json'],'/library-demo.json':[LIBRARY_DEMO,'application/json'],'/current-daily-plan.json':[CURRENT_DAILY_PLAN,'application/json'],'/historical-daily-results.json':[HISTORICAL_DAILY_RESULTS,'application/json'],'/modular-daily-results.json':[MODULAR_DAILY_RESULTS,'application/json'],'/daily-refinement.json':[DAILY_REFINEMENT,'application/json']}[path];
    if(!asset)return new Response('Not found',{status:404});
    return new Response(method==='HEAD'?null:asset[0],{headers:{'content-type':asset[1]+'; charset=utf-8','cache-control':'no-cache','content-security-policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
  }
  requireValue(method==='GET'||method==='POST','Method not allowed',405);
  const db=database(env);
  if(path==='/api/v1/scheduler/tick'){requireValue(method==='POST','Method not allowed',405);const identity=await verifyScheduler(request,env);const result=await scheduledTick(env,db,identity.source);console.info(JSON.stringify({event:'scheduler_tick',source:identity.source,at:nowISO(),ok:result.ok,outcome:result.outcome}));return json(result);}
  if(method==='GET'){
    if(path==='/api/v1/portfolio/catalog')return json(await rankedCatalog(db,portfolioCatalog,url.searchParams.get('source')==='reference'?'reference':'latest'));
    if(path==='/api/v1/portfolio/history'){await operator(request,env,db);return json(await portfolio.history.list(db,{offset:url.searchParams.get('offset'),market:url.searchParams.get('market')}));}
    if(path==='/api/v1/portfolio/history/detail'){await operator(request,env,db);return json(await portfolio.history.detail(env,db,url.searchParams.get('id')));}
    if(path==='/api/v1/portfolio/explanation')return json(await portfolio.explanation(db,url.searchParams.get('id')));
    if(path==='/api/v1/portfolio/preview'){await operator(request,env,db);return json(await portfolio.preview(env,db,url.searchParams.get('id'),Number(url.searchParams.get('budget'))));}
    if(path==='/api/v1/portfolio/report'){const e=portfolioCatalog.get(url.searchParams.get('id'));requireValue(e,'策略不存在',404);if(url.searchParams.get('source')==='latest'){const r=await first(db,"SELECT payload FROM artifacts WHERE kind='portfolio_backtest' AND name=? ORDER BY created_at DESC LIMIT 1",e.id);requireValue(r,'尚未导入该策略的重放回测',404);return json({ok:true,...e,...JSON.parse(r.payload)});}return json({ok:true,...e});}
    if(path==='/api/v1/portfolio'){await operator(request,env,db);return json(await portfolio.state(db,env));}
    if(path==='/api/v1/longbridge/trading'){await operator(request,env,db);return json(await tradingState(env,db));}
    if(path==='/api/v1/longbridge/status'){await operator(request,env,db);return json(await connectionStatus(env,db));}
    if(path==='/api/v1/longbridge/overview'){await operator(request,env,db);return json(await connectionOverview(env,db));}
    if(path==='/api/v1/hk/overview'){await operator(request,env,db);return json(await hkOverview(env,url.searchParams.get('symbol')||'HK.00700'));}
    if(path==='/api/v1/automation'){await operator(request,env,db);return json(await auto.status(db,env));}
    if(path==='/api/v1/session'){const u=await identity(request,env,db);return json({ok:true,signed_in:u.signed_in,operator:u.operator,username:u.username,expires_at:u.expires_at,auth_mode:'password',login_enabled:Boolean(env.AUTH_USERNAME&&env.AUTH_PASSWORD_RECORD)});}
    if(path==='/api/v1/cn/status'){const user=await operator(request,env,db);return json(await myquantBridge(env,'/v1/status',{actor:user.id}));}
    if(path==='/api/v1/cn/orders'){const user=await operator(request,env,db);return json(await myquantBridge(env,'/v1/orders',{actor:user.id}));}
    if(path==='/api/v1/cn/audit'){const user=await operator(request,env,db);return json(await myquantBridge(env,'/v1/audit',{actor:user.id}));}
    if(path==='/api/v1/overview'||path==='/api/paper/status'){await operator(request,env,db);return json(await overview(env,db));}
    if(path==='/api/v1/equity'){await operator(request,env,db);const period=url.searchParams.get('period')||'1M';requireValue(['1W','1M','3M'].includes(period),'时间范围无效');return json({ok:true,source:'Alpaca Paper',fetched_at:nowISO(),history:await broker(env,'/v2/account/portfolio/history?period='+period+'&timeframe=1D&extended_hours=false')});}
    if(path==='/api/v1/market'){const sym=symbol(url.searchParams.get('symbol'));return json({ok:true,symbol:sym,source:'Alpaca IEX',fetched_at:nowISO(),snapshot:await snapshotQuote(env,sym)});}
    if(path==='/api/v1/catalog')return json({ok:true,symbols:SYMBOLS,intraday_symbols:INTRADAY_SYMBOLS,engine:ENGINE_VERSION,templates:[{type:'adaptive_momentum',name:'波动率自适应动量',timeframe:'1Min',description:'历史动量超过波动阈值且成交量确认时买入；负动量或收盘前 15 分钟退出。'},{type:'opening_range_breakout',name:'开盘区间突破',timeframe:'1Min',description:'美股开盘观察区间结束后，收盘价突破区间上沿买入；跌破区间中点或 15:45 后卖出。'},{type:'vwap_reversion',name:'VWAP 均值回归',timeframe:'1Min',description:'当日价格低于 VWAP 指定幅度买入；回到 VWAP 或 15:45 后卖出。'},{type:'sma',name:'双均线趋势',timeframe:'1Day',description:'快均线高于慢均线时持有目标仓位，否则空仓。'},{type:'momentum',name:'绝对动量',timeframe:'1Day',description:'慢周期累计收益为正时持有目标仓位，否则空仓。'},{type:'buy_hold',name:'买入持有基准',timeframe:'1Day',description:'始终保持首次买入的目标仓位，用于同区间比较。'}]});
    if(path==='/api/v1/artifacts'){const kind=url.searchParams.get('kind')||'backtest';requireValue(['backtest','strategy','dataset','plan','acceptance'].includes(kind),'类别无效');return json({ok:true,items:await all(db,'SELECT id,kind,name,created_at FROM artifacts WHERE kind=? ORDER BY created_at DESC LIMIT 50',kind)});}
    if(path==='/api/v1/acceptance/report')return json(await acceptanceReport(db,url.searchParams.get('id')));
    if(path==='/api/v1/artifact'){return json({ok:true,...await artifact(db,url.searchParams.get('id'),url.searchParams.get('kind'))});}
    if(path==='/api/v1/audit'){
      await operator(request,env,db);const rows=await all(db,'SELECT * FROM events ORDER BY id DESC LIMIT 100');
      const items=await Promise.all(rows.map(async r=>({...r,details:JSON.parse(r.details),valid:(await digest({timestamp:r.timestamp,actor:r.actor,kind:r.kind,subject:r.subject,details:JSON.parse(r.details)}))===r.digest})));
      return json({ok:true,items,integrity:items.every(x=>x.valid)});
    }
    throw new AppError('接口不存在',404,'NOT_FOUND');
  }
  const input=await body(request);
  if(path==='/api/v1/auth/login'){const result=await login(request,env,db,input,auditStatement);return json(result.body,200,result.headers);}
  if(path==='/api/v1/auth/logout'){const result=await logout(request,env,db,auditStatement);return json(result.body,200,result.headers);}
  const user=await operator(request,env,db);
  if(path==='/api/v1/cn/orders/preview')return json(await myquantAction(env,db,user,'/v1/orders/preview',input,'order_preview'));
  if(path==='/api/v1/cn/orders')return json(await cnExclusive(db,async()=>{await portfolioGuard(db,'CN');return myquantAction(env,db,user,'/v1/orders',input,'order_submit');}));
  if(path==='/api/v1/cn/orders/cancel')return json(await myquantAction(env,db,user,'/v1/orders/cancel',input,'order_cancel'));
  if(path==='/api/v1/cn/reconcile')return json(await myquantAction(env,db,user,'/v1/reconcile',input,'reconcile'));
  if(path==='/api/v1/cn/control')return json(await myquantAction(env,db,user,'/v1/control',input,'control'));
  if(path==='/api/v1/portfolio/backtests'){
   const e=portfolioCatalog.get(input.signal?.strategy_id),r=input.backtest,dates=input.dates;
   requireValue(e&&input.signal.strategy_version===e.version,'策略版本无效');
   requireValue(['selection','timing','allocation','risk_policy'].every(k=>(input.config?.[k]||null)===(e.config[k]||null)),'回测配置与注册策略不一致');
   requireValue(Array.isArray(dates)&&dates.length>1&&dates.length<=10000&&dates.every((d,i)=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&(!i||d>dates[i-1])),'回测日期无效');
   requireValue(r&&Array.isArray(r.equity)&&r.equity.length===dates.length&&r.equity.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)&&['cagr_pct','max_drawdown_pct','total_return_pct'].every(k=>typeof r.full?.[k]==='number'&&Number.isFinite(r.full[k])),'回测曲线或指标无效');
   const payload={comparison:JSON.stringify([input.signal.origin,Object.keys(input.signal.liquidity_caps||{}).sort(),String(input.note||'').slice(0,300),[...new Set((r.trades||[]).map(t=>Number((t.cost/(t.qty*t.price)).toFixed(6))))].sort()]),report:{equity:r.equity,dates,full:r.full,...replayDetails(r,dates)},source:'导入的同规则重放回测 · 数据摘要 '+String(input.signal.data_digest).slice(0,16)+' · '+String(input.note||'').slice(0,300)};
   return json({ok:true,id:await saveArtifact(db,user,'portfolio_backtest',e.id,payload)});
  }
  if(path==='/api/v1/portfolio/signals')return json(await portfolio.ingest(db,user,input));
  if(path==='/api/v1/portfolio/quotes')return json(await portfolio.quotes(db,user,input));
  if(path==='/api/v1/portfolio/start')return json(await portfolio.start(env,db,user,input));
  if(path==='/api/v1/portfolio/pause')return json(await portfolio.pause(db,user,input.market,undefined,env));
  if(path==='/api/v1/portfolio/resume')return json(await portfolio.resume(env,db,user,input));
  if(path==='/api/v1/portfolio/liquidate')return json(await portfolio.liquidate(env,db,user,input));
  if(path==='/api/v1/portfolio/release')return json(await portfolio.release(env,db,user,input));
  if(path==='/api/v1/portfolio/tick')return json(await portfolio.tick(env,db,input.market));
  if(path==='/api/v1/longbridge/connect')return json(await changeHKConnection(db,()=>saveConnection(env,db,user,input,auditStatement)));
  if(path==='/api/v1/longbridge/disconnect'){requireValue(input.confirm===true,'请确认移除长桥连接');return json(await changeHKConnection(db,()=>removeConnection(db,user,auditStatement)));}
  if(path==='/api/v1/longbridge/control')return json(await setTrading(env,db,user,input));
  if(path==='/api/v1/longbridge/orders/preview')return json(await previewHK(env,db,input));
  if(path==='/api/v1/longbridge/orders/submit')return json(await submitHK(env,db,user,input));
  if(path==='/api/v1/longbridge/orders/inspect')return json(await inspectHK(env,db,input.client_id));
  if(path==='/api/v1/longbridge/orders/cancel')return json(await cancelHK(env,db,user,input));
  if(path==='/api/v1/longbridge/recover')return json(await recoverHK(env,db,user));
  if(path==='/api/v1/longbridge/auto/start')return json(await startHKAuto(env,db,user,input));
  if(path==='/api/v1/longbridge/auto/resume')return json(await resumeHKAuto(env,db,user,input));
  if(path==='/api/v1/longbridge/auto/pause')return json(await pauseHKAuto(env,db,user));
  if(path==='/api/v1/longbridge/auto/tick')return json(await tickHK(env,db,'manual'));
  if(path==='/api/v1/automation/start')return json(await auto.configure(env,db,user,input));
  if(path==='/api/v1/automation/resume')return json(await auto.resume(env,db,user,input));
  if(path==='/api/v1/automation/pause'){if(input.cancel)return json(await auto.cancelRun(env,db,user));await auto.pause(db,user);return json(await auto.status(db,env));}
  if(path==='/api/v1/automation/tick')return json(await auto.tick(env,db,'manual'));
  if(path==='/api/v1/acceptance/prepare')return json(await prepareAcceptance(env,db,user,input));
  if(path==='/api/v1/acceptance/inspect')return json(await inspectAcceptance(env,db,user,input.id));
  if(path==='/api/v1/acceptance/submit'){
    const run=(await artifact(db,input.id,'acceptance')).payload;
    return json(await submitOrder(env,db,user,{...run.order,idempotency_key:input.id,confirm:input.confirm,allow_queued:input.allow_queued},run));
  }
  if(path==='/api/v1/acceptance/cancel-check'){
    const run=(await artifact(db,input.id,'acceptance')).payload;
    requireValue(input.confirm===true,'请在网页摘要中确认撤单验证');
    const clientId='qs_'+run.cancel_key.replaceAll('-','');
    // Recovery must query/cancel the original order even when the market has
    // opened and the user no longer needs the queue-consent checkbox.
    if(await first(db,'SELECT client_id FROM orders WHERE client_id=?',clientId))return json(await cancelOrders(env,db,user,clientId));
    const submitted=await submitOrder(env,db,user,{...run.cancel_order,idempotency_key:run.cancel_key,confirm:input.confirm,allow_queued:input.allow_queued});
    requireValue(submitted.ok,'撤单验证订单未确认接收，请先对账',409,'UNRESOLVED_ORDER');
    const canceled=await cancelOrders(env,db,user,clientId);
    return json({...canceled,order:submitted.order});
  }
  if(path==='/api/v1/orders/preview'){
    const o=normalizeOrder(input),ctx=await contextForOrder(env,db,o),check=riskCheck(o,ctx);
    await autoGuard(db,o,null);
    await requireCourseAsset(env,o.symbol);
    return json({ok:true,order:o,...check});
  }
  if(path==='/api/v1/orders')return json(await submitOrder(env,db,user,input));
  if(path==='/api/v1/orders/cancel'){requireValue(typeof input.client_id==='string'&&/^qs_[a-f0-9]{32}$/.test(input.client_id),'缺少有效的平台订单号');return json(await cancelOrders(env,db,user,input.client_id));}
  if(path==='/api/v1/orders/cancel-all')return json(await cancelOrders(env,db,user));
  if(path==='/api/v1/reconcile')return json(await reconcile(env,db,user));
  if(path==='/api/v1/control')return json(await setHalt(env,db,user,input));
  if(path==='/api/v1/risk'){
    const settings={max_order:numeric(input.max_order,'单笔限额',100,Number.MAX_SAFE_INTEGER/100),max_daily:numeric(input.max_daily,'单日限额',100,Number.MAX_SAFE_INTEGER/100),max_position:numeric(input.max_position,'单标的上限',0.01,0.5),max_loss:numeric(input.max_loss,'当日亏损上限',0.005,0.1)};
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
const auto=createAutomation({accountContext,history,snapshotQuote,requireCourseAsset,submitOrder,reconcile,audit,auditStatement,artifact,control,cancelOrders,acquire,release,saveArtifact});
async function scheduledTick(env,db,source){const results=await Promise.allSettled([auto.tick(env,db,source),tickHK(env,db,source),portfolio.tick(env,db,'US'),portfolio.tick(env,db,'HK'),portfolio.tick(env,db,'CN')]);if(results[0].status==='rejected')throw results[0].reason;const result=results[0].value;result.longbridge=results[1].status==='fulfilled'?results[1].value:{ok:false,outcome:'fault',message:'长桥调度异常，请核对后恢复'};result.portfolios=results.slice(2).map(r=>r.status==='fulfilled'?r.value:{ok:false,outcome:'fault'});result.ok=result.ok!==false&&result.longbridge.ok!==false&&result.portfolios.every(r=>r.ok!==false);return result;}
export default {async scheduled(event,env){requireValue(env.SCHEDULER_NATIVE==='true','原生调度未启用',503);const db=database(env);return scheduledTick(env,db,'cloudflare');},async fetch(request,env){const requestId=crypto.randomUUID();try{const response=await route(request,env);response.headers.set('x-request-id',requestId);return response;}catch(error){const known=error instanceof AppError;const response=json({ok:false,error:known?error.message:'服务暂时不可用，新增交易已阻断；请稍后重试。',code:known?error.code:'SERVICE_UNAVAILABLE',request_id:requestId},known?error.status:503);response.headers.set('x-request-id',requestId);if(!known)console.error('request_failed',requestId,error?.name||'Error');return response;}}};
