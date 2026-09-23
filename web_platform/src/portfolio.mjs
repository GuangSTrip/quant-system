import {createRunHistory,historyStatement,recordRunMark,runPerformance} from './portfolio-history.mjs';
import {requireValue,nowISO,numeric,digest} from './engine.mjs';
import {MARKETS,validateSignal,deltaOrders,instrumentSymbol} from './portfolio-contract.mjs';
import {positionMap,ownedPositions,checkOwnership} from './portfolio-ownership.mjs';
import {describeStrategy,budgetPreview} from './portfolio-explain.mjs';
const get=(db,s,...v)=>db.prepare(s).bind(...v).first();
const rows=async(db,s,...v)=>(await db.prepare(s).bind(...v).all()).results;
const run=(db,s,...v)=>db.prepare(s).bind(...v).run();
export async function portfolioGuard(db,market,execution=null){
 const p=await get(db,'SELECT * FROM portfolio_runs WHERE market=?',market);
 if(execution)requireValue(p?.enabled&&p.run_id===execution.run_id&&p.revision===execution.revision,'组合已暂停或版本已变化',409,'PORTFOLIO_STOPPED');
 else requireValue(!p,'该市场正在由组合策略管理，请先结束并释放策略；原有持仓可以保留',409,'PORTFOLIO_OWNS_ACCOUNT');
}
export function createPortfolio({catalog,adapters,audit}){
 const entry=id=>{const e=catalog.get(id);requireValue(e,'未知组合策略',404);return e;};
 const adapter=market=>{const a=adapters[market];requireValue(a,'此市场尚未配置模拟盘适配器',409,'ADAPTER_UNAVAILABLE');return a;};
 async function baseline(db,s){
  const row=await get(db,"SELECT payload FROM artifacts WHERE id=? AND kind='portfolio_ownership'",'ownership:'+s.run_id);
  // Runs created by older versions required a flat account at inception.
  return row?JSON.parse(row.payload):{positions:{},awaiting_orders:false};
 }
 async function state(db,env){
  const quote_symbols={};
  for(const s of await rows(db,'SELECT * FROM portfolio_runs')){
   const owned={};for(const o of await adapter(s.market).ledger(db,s,env))owned[o.symbol]=(owned[o.symbol]||0)+(o.side==='buy'?1:-1)*o.filled;
   const latest=await get(db,'SELECT payload FROM portfolio_signals WHERE strategy_id=? ORDER BY signal_date DESC LIMIT 1',s.strategy_id);
   quote_symbols[s.market]=[...new Set([...Object.entries(owned).filter(([,q])=>q>0).map(([symbol])=>symbol),...(latest?JSON.parse(latest.payload).targets.map(t=>t.symbol):[])])];
  }
  return {ok:true,quote_symbols,runs:await Promise.all((await rows(db,'SELECT market,run_id,strategy_id,version,budget,enabled,exit_requested,revision,lease_until,last_decision,reason,updated_at FROM portfolio_runs')).map(async s=>({...s,ownership:await baseline(db,s)}))),signals:await rows(db,"SELECT s.strategy_id,s.signal_date,json_extract(s.payload,'$.expires_at') expires_at FROM portfolio_signals s WHERE s.signal_date=(SELECT MAX(p.signal_date) FROM portfolio_signals p WHERE p.strategy_id=s.strategy_id)"),decisions:(await rows(db,'SELECT * FROM portfolio_decisions ORDER BY created_at DESC LIMIT 50')).map(r=>({...r,payload:JSON.parse(r.payload)}))};}
 async function ingest(db,user,input){
  const e=entry(input.strategy_id),signal=validateSignal(input,e),id=await digest(signal);
  const old=await get(db,'SELECT * FROM portfolio_signals WHERE strategy_id=? AND signal_date=?',e.id,signal.signal_date);
  requireValue(!old||old.id===id,'同日信号已冻结，禁止覆盖已使用的输入；修改策略须升级版本',409,'SIGNAL_CONFLICT');
  const previous=await get(db,'SELECT payload FROM portfolio_signals WHERE strategy_id=? ORDER BY signal_date DESC LIMIT 1',e.id);
  if(previous&&!old){const p=JSON.parse(previous.payload);requireValue(p.origin===signal.origin&&signal.rebalance_date>=p.rebalance_date,'预热起点、证券池或调仓相位变化，请升级策略版本',409,'SIGNAL_ORIGIN');if(signal.rebalance_date===p.rebalance_date)requireValue(JSON.stringify(signal.targets)===JSON.stringify(p.targets),'同一调仓日的目标不能改变',409,'SIGNAL_CONFLICT');}
  await run(db,'INSERT OR IGNORE INTO portfolio_signals(id,strategy_id,signal_date,payload,created_at) VALUES(?,?,?,?,?)',id,e.id,signal.signal_date,JSON.stringify(signal),nowISO());
  const saved=await get(db,'SELECT id FROM portfolio_signals WHERE strategy_id=? AND signal_date=?',e.id,signal.signal_date);requireValue(saved.id===id,'并发发布了不同信号',409,'SIGNAL_CONFLICT');
  await audit(db,user.id,'portfolio_signal',id,{strategy_id:e.id,data_digest:signal.data_digest});return {ok:true,id};
 }
 async function quotes(db,user,input){
  requireValue(['HK','CN'].includes(input.market),'报价发布接口仅供港股和A股行情适配器使用');
  const age=Date.now()-Date.parse(input.asof);requireValue(Number.isFinite(age)&&age>=-5000&&age<=120000,'报价已过期',409,'STALE_QUOTE');
  requireValue(typeof input.is_open==='boolean'&&Array.isArray(input.instruments)&&input.instruments.length<=100,'行情快照无效');
  const seen=new Set();const instruments=input.instruments.map(q=>{const symbol=instrumentSymbol(q.symbol,input.market);requireValue(!seen.has(symbol),'重复行情');seen.add(symbol);const lot=numeric(q.lot,'每手股数',1,1000000),price=numeric(q.price,'未复权限价',.001,1000000);requireValue(Number.isSafeInteger(lot)&&typeof q.tradable==='boolean'&&Math.abs(price*1000-Math.round(price*1000))<1e-6,'标的资料无效');const age=Date.now()-Date.parse(q.asof);requireValue(Number.isFinite(age)&&age>=-5000&&age<=120000,'证券报价已过期',409,'STALE_QUOTE');return {symbol,lot,price,tradable:q.tradable,asof:q.asof};});
  const payload={market:input.market,asof:input.asof,is_open:input.is_open,instruments};
  await run(db,'INSERT INTO portfolio_quotes(market,payload,updated_at) VALUES(?,?,?) ON CONFLICT(market) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',input.market,JSON.stringify(payload),nowISO());return {ok:true};
 }
 async function latest(db,e){const s=await get(db,'SELECT * FROM portfolio_signals WHERE strategy_id=? ORDER BY signal_date DESC LIMIT 1',e.id);requireValue(s,'请先运行行情与信号生产器，发布最新完整日线信号',409,'SIGNAL_REQUIRED');return {...s,signal:validateSignal(JSON.parse(s.payload),e)};}
 async function start(env,db,user,input){
  requireValue(input.confirm==='启动组合自动模拟交易','请输入“启动组合自动模拟交易”');
  const e=entry(input.strategy_id),a=adapter(e.market),budget=numeric(input.budget,'组合预算',100,100000000);
  requireValue(env.SCHEDULER_LOCAL_ENABLED==='true'||env.SCHEDULER_NATIVE==='true'||env.SCHEDULER_REPOSITORY_ID,'后台调度尚未配置',503,'NO_SCHEDULER');
  requireValue(!await get(db,'SELECT market FROM portfolio_runs WHERE market=?',e.market),'该市场已有组合，请恢复原运行或平仓释放后更换',409,'PORTFOLIO_EXISTS');
  const initialSignal=await latest(db,e);
  let startedRun;
  // Reuse the broker's order lock so legacy starts/manual submissions cannot race creation.
  await a.exclusive(db,async()=>{
   await a.available(env,db);const ctx=await a.snapshot(env,db,[]);
   const ownership={positions:positionMap(ctx.positions),awaiting_orders:!!ctx.pending};
   requireValue(ctx.cash>=budget,'账户可用本币现金不足',409,'CASH_LIMIT');
   const runId=crypto.randomUUID(),at=nowISO();startedRun=runId;
   await db.batch([
    db.prepare('INSERT INTO portfolio_runs(market,run_id,strategy_id,version,connection_tag,budget,enabled,reason,updated_at) VALUES(?,?,?,?,?,?,1,?,?)').bind(e.market,runId,e.id,e.version,ctx.tag,budget,ctx.pending?'waiting_existing_orders':'等待后台执行',at),
    db.prepare('INSERT INTO artifacts(id,kind,name,payload,actor,created_at) VALUES(?,?,?,?,?,?)').bind('ownership:'+runId,'portfolio_ownership',runId,JSON.stringify(ownership),user.id,at),
    historyStatement(db,{run_id:runId,strategy_id:e.id,market:e.market,currency:e.currency,name:e.name,config:e.config,version:e.version,budget,started_at:at,status:'running',initial_signal:initialSignal.signal},user.id)
   ]);
  });
  await audit(db,user.id,'portfolio_started',startedRun,{budget,market:e.market,strategy_id:e.id});return state(db,env);
 }
 async function pause(db,user,market,reason='操作员暂停；委托仍需核对，管理权保留',env){
  const previous=await get(db,'SELECT run_id FROM portfolio_runs WHERE market=?',market);
  await run(db,'UPDATE portfolio_runs SET enabled=0,revision=revision+1,reason=?,updated_at=? WHERE market=?',reason,nowISO(),market);
  await audit(db,user.id,'portfolio_paused',previous?.run_id||market,{reason,market});return state(db,env);
 }
 async function resume(env,db,user,input){
  requireValue(input.confirm==='启动组合自动模拟交易','请输入“启动组合自动模拟交易”');
  const s=await get(db,'SELECT * FROM portfolio_runs WHERE market=?',input.market);requireValue(s&&!s.enabled,'没有可恢复的组合');
  requireValue(!s.lease_id||s.lease_until<Date.now(),'上一轮仍在执行');
  if(!s.exit_requested)await latest(db,entry(s.strategy_id));const a=adapter(s.market);await a.reconcile(env,db,s);await a.available(env,db);
  const ctx=await a.snapshot(env,db,[]);requireValue(ctx.tag===s.connection_tag,'账户连接变化，禁止恢复',409);
  const r=await run(db,'UPDATE portfolio_runs SET enabled=1,revision=revision+1,lease_id=NULL,lease_until=0,reason=?,updated_at=? WHERE market=? AND run_id=? AND revision=?','等待后台执行',nowISO(),s.market,s.run_id,s.revision);requireValue(r.meta.changes===1,'策略状态已变化，请刷新后重试',409,'PORTFOLIO_CHANGED');
  await audit(db,user.id,'portfolio_resumed',s.run_id,{});return state(db,env);
 }
 async function release(env,db,user,input){
  const s=await get(db,'SELECT * FROM portfolio_runs WHERE market=?',input.market);requireValue(s&&!s.enabled&&!s.lease_id,'先暂停且等待执行结束再释放');
  const a=adapter(s.market);await a.reconcile(env,db,s);const ctx=await a.snapshot(env,db,[]),ledger=await a.ledger(db,s,env),owned=ownedPositions(ledger),base=await baseline(db,s);
  requireValue(ctx.tag===s.connection_tag,'账户连接已改变',409,'CONNECTION_CHANGED');
  const keep=input.keep_positions===true;
  if(keep)requireValue(input.confirm==='结束策略并保留持仓','请确认结束策略并将现有股票转为手动管理',400,'KEEP_POSITIONS_CONFIRM');
  requireValue((keep||!Object.keys(owned).length)&&(!ledger.length||!ctx.pending),'结束前需核对完策略委托；有股票时可选择“结束策略，保留股票”',409,'NEEDS_FLAT');
  if(!base.awaiting_orders)checkOwnership(ctx,base.positions,owned);
  const saved=await get(db,"SELECT payload FROM artifacts WHERE id=? AND kind='portfolio_run_history'",'run-history:'+s.run_id);
  const at=nowISO(),e=entry(s.strategy_id),record={...(saved?JSON.parse(saved.payload):{run_id:s.run_id,strategy_id:s.strategy_id,market:s.market,currency:e.currency,name:e.name,config:e.config,budget:s.budget,started_at:null,legacy:true}),status:keep?'ended_kept':'ended',ended_at:at,kept_positions:keep?owned:{},orders:ledger,final_metrics:runPerformance(ledger,s.budget,{})};
  // Insert/update only while the exact paused revision still exists; archive and release are atomic.
  const archived=db.prepare("INSERT INTO artifacts(id,kind,name,payload,actor,created_at) SELECT ?,'portfolio_run_history',?,?,?,? WHERE EXISTS(SELECT 1 FROM portfolio_runs WHERE market=? AND run_id=? AND revision=? AND enabled=0 AND lease_id IS NULL) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").bind('run-history:'+s.run_id,s.run_id,JSON.stringify(record),user.id,record.started_at||at,s.market,s.run_id,s.revision);
  const results=await db.batch([archived,db.prepare('DELETE FROM portfolio_runs WHERE market=? AND run_id=? AND revision=? AND enabled=0 AND lease_id IS NULL').bind(s.market,s.run_id,s.revision)]);
  requireValue(results[1].meta.changes===1,'策略状态已变化，请刷新后重试',409,'PORTFOLIO_CHANGED');await audit(db,user.id,'portfolio_released',s.run_id,{kept_positions:keep?owned:{},ownership_transfer:keep?'manual':'none'});return state(db,env);
 }
 async function liquidate(env,db,user,input){
  requireValue(input.confirm==='平仓并停止组合','请输入“平仓并停止组合”');
  const s=await get(db,'SELECT * FROM portfolio_runs WHERE market=?',input.market);requireValue(s&&!s.lease_id,'先暂停并等待当前执行结束');
  await adapter(s.market).available(env,db);
  const result=await run(db,'UPDATE portfolio_runs SET exit_requested=?,enabled=1,revision=revision+1,reason=?,updated_at=? WHERE market=? AND run_id=? AND revision=? AND lease_id IS NULL',Date.now(),'等待按实时行情平仓',nowISO(),s.market,s.run_id,s.revision);requireValue(result.meta.changes===1,'策略状态已变化，请刷新后重试',409,'PORTFOLIO_CHANGED');
  await audit(db,user.id,'portfolio_liquidation_requested',s.run_id,{});return state(db,env);
 }
 async function tick(env,db,market){
  const s=await get(db,'SELECT * FROM portfolio_runs WHERE market=?',market);if(!s?.enabled)return {ok:true,outcome:'paused'};
  if(s.lease_id){if(s.lease_until<Date.now())await pause(db,{id:'scheduler'},market,'执行中断，请核对后恢复',env);return {ok:true,outcome:'busy'};}
  const lease=crypto.randomUUID();const claimed=await run(db,'UPDATE portfolio_runs SET lease_id=?,lease_until=? WHERE market=? AND revision=? AND enabled=1 AND lease_id IS NULL',lease,Date.now()+600000,market,s.revision);if(!claimed.meta.changes)return {ok:true,outcome:'busy'};
  let releaseLease=true,orderPrepared=false;
  const finish=async(outcome,details={})=>{await run(db,'UPDATE portfolio_runs SET reason=?,updated_at=? WHERE market=? AND run_id=?',outcome,nowISO(),market,s.run_id);return {ok:true,outcome,...details};};
  try{
   const a=adapter(market),e=entry(s.strategy_id);requireValue(e.version===s.version,'策略版本变化，请停止旧运行',409,'SIGNAL_VERSION');
   await a.available(env,db);await a.reconcile(env,db,s);
   const ledger=await a.ledger(db,s,env),owned=ownedPositions(ledger);
   const spent=ledger.reduce((n,o)=>n+(o.side==='buy'?1:-1)*o.filled*o.price+o.filled*o.price*.002,0);
   const base=await baseline(db,s);
   if(base.awaiting_orders){
    requireValue(!ledger.length,'隔离记账尚未完成却已有策略委托，请核对',409,'POSITION_DRIFT');
    const initial=await a.snapshot(env,db,[]);
    requireValue(initial.tag===s.connection_tag,'账户连接已改变',409,'CONNECTION_CHANGED');
    if(initial.pending)return finish('waiting_existing_orders');
    base.positions=positionMap(initial.positions);base.awaiting_orders=false;
    await run(db,"UPDATE artifacts SET payload=? WHERE id=? AND kind='portfolio_ownership'",JSON.stringify(base),'ownership:'+s.run_id);
   }
   const {signal,id:signalId}=s.exit_requested?{signal:{targets:[],liquidity_caps:Object.fromEntries(Object.keys(owned).map(k=>[k,1e15])),rebalance_date:'liquidation-'+s.exit_requested,execute_after:new Date(0).toISOString(),expires_at:new Date(Date.now()+86400000).toISOString()},id:'operator-liquidation'}:await latest(db,e),symbols=[...new Set([...signal.targets.map(t=>t.symbol),...Object.keys(owned)])];
   const ctx=await a.snapshot(env,db,s.last_decision===s.run_id+':'+signal.rebalance_date?[]:symbols);requireValue(ctx.tag===s.connection_tag,'账户连接已改变',409,'CONNECTION_CHANGED');
   checkOwnership(ctx,base.positions,owned);
   // Monitoring is observational; a missing mark cannot change execution permissions.
   try{let markQuotes=ctx.quotes;if(market==='US'&&!Object.keys(markQuotes).length&&Object.keys(owned).length){const last=await get(db,"SELECT created_at FROM artifacts WHERE kind='portfolio_run_mark' AND name=? ORDER BY created_at DESC LIMIT 1",s.run_id);if(!last||Date.now()-Date.parse(last.created_at)>60000)markQuotes=(await a.snapshot(env,db,Object.keys(owned))).quotes;}await recordRunMark(db,s,ledger,markQuotes);}catch{console.warn('portfolio_monitor_unavailable',market);}
   // A-share T+1: never borrow sellable old shares to sell today's strategy buys.
   if(market==='CN')for(const [symbol,q] of Object.entries(ctx.quotes))q.available=Math.max(0,(q.available||0)-(base.positions[symbol]||0));
   if(ctx.pending)return finish('pending_orders');
   if(!ctx.is_open||Date.now()<Date.parse(signal.execute_after))return finish('waiting_session');
   requireValue(Date.now()<Date.parse(signal.expires_at),'信号执行窗口已结束',409,'SIGNAL_EXPIRED');
   const decision=s.run_id+':'+signal.rebalance_date;
   if(s.last_decision===decision)return finish('already_evaluated');
   const cash=Math.max(0,s.budget-spent),equity=cash+Object.entries(owned).reduce((sum,[symbol,qty])=>sum+qty*(ctx.quotes[symbol]?.price||0),0);
   const previousSell=await get(db,'SELECT * FROM portfolio_decisions WHERE id=?',decision+':sell');
   const sellsComplete=previousSell?.phase==='sell_sent';
   if(sellsComplete){
    const intended=JSON.parse(previousSell.payload).orders;
    requireValue(intended.every(o=>ledger.some(fill=>fill.key===o.key.replaceAll('-','')&&fill.filled===o.qty)),'卖单已结束但未全部成交，请核对；同一决策不盲目追卖',409,'SELL_INCOMPLETE');
   }
   // Completed sell quantities are frozen. Fees/quotes can move fractional targets between phases.
   const planned=deltaOrders(signal,owned,ctx.quotes,equity,Math.min(cash,ctx.cash),market,sellsComplete);
   // Persist a whole phase before sending any order. After a crash its deterministic keys are reused.
   const phase=planned.some(o=>o.side==='sell')?'sell':'buy',phaseId=decision+':'+phase;
   let record=await get(db,'SELECT * FROM portfolio_decisions WHERE id=?',phaseId);
   if(!record){
    const orders=[];for(const order of planned){const hash=await digest(phaseId+':'+order.symbol);orders.push({...order,key:hash.slice(0,8)+'-'+hash.slice(8,12)+'-'+hash.slice(12,16)+'-'+hash.slice(16,20)+'-'+hash.slice(20,32)});}
    await run(db,'INSERT INTO portfolio_decisions(id,run_id,signal_id,phase,payload,created_at) VALUES(?,?,?,?,?,?)',phaseId,s.run_id,signalId,phase,JSON.stringify({orders,equity,cash,signal}),nowISO());record=await get(db,'SELECT * FROM portfolio_decisions WHERE id=?',phaseId);
   }
   const payload=JSON.parse(record.payload);
   // Once the deterministic intent exists, any later uncertainty must pause and
   // reconcile instead of being treated as a harmless read failure.
   orderPrepared=true;
   requireValue(Date.now()<Date.parse(payload.signal.expires_at),'已保存的委托计划过期，禁止跨交易日重发',409,'DECISION_EXPIRED');
   for(const order of payload.orders){await portfolioGuard(db,market,s);const result=await a.submit(env,db,s,order);requireValue(result.ok,'委托未确认接收，暂停并等待对账',409,'ORDER_UNRESOLVED');}
   // A completed sell phase is never resent; partially filled/canceled sells leave cash for conservative buys.
   if(phase==='buy')await run(db,'UPDATE portfolio_runs SET last_decision=? WHERE market=? AND run_id=?',decision,market,s.run_id);
   else if(record){
    // Once the sell phase has terminal receipts, next pass builds only the buy side.
    await run(db,'UPDATE portfolio_decisions SET phase=? WHERE id=?','sell_sent',phaseId);
   }
   if(s.exit_requested&&phase==='buy')await pause(db,{id:'portfolio:'+s.run_id},market,'组合已平仓，可释放管理权',env);
   await audit(db,'portfolio:'+s.run_id,'portfolio_cycle',phaseId,{orders:payload.orders.length,signal_id:signalId});return finish(payload.orders.length?'submitted':'no_order');
  }catch(error){
   if(['SIGNAL_REQUIRED','SIGNAL_EXPIRED','STALE_QUOTE','CN_T1'].includes(error.code))return finish('waiting_data',{message:error.message});
   if(!orderPrepared&&(error?.retryableRead===true||['BROKER_UNCERTAIN','LB_UNKNOWN','MYQUANT_BRIDGE_UNCERTAIN'].includes(error?.code)))return finish('waiting_connection',{message:'券商连接波动，后台将在下一轮自动重试；未提交订单',code:error.code||'BROKER_UNCERTAIN'});
   try{await pause(db,{id:'portfolio:'+s.run_id},market,error.message||'组合执行异常',env);}catch(storage){releaseLease=false;throw storage;}
   return {ok:false,outcome:'fault',code:error.code||'SERVICE_UNAVAILABLE',message:error.message};
  }finally{if(releaseLease)await run(db,'UPDATE portfolio_runs SET lease_id=NULL,lease_until=0 WHERE market=? AND lease_id=?',market,lease);}
 }
 async function explanation(db,id){
  const e=entry(id),row=await get(db,'SELECT payload FROM portfolio_signals WHERE strategy_id=? ORDER BY signal_date DESC LIMIT 1',id);
  const s=row?JSON.parse(row.payload):null;
  // Research output only: no connection identifiers, tokens or account state.
  const signal=s?{signal_date:s.signal_date,rebalance_date:s.rebalance_date,data_asof:s.data_asof,execute_after:s.execute_after,expires_at:s.expires_at,targets:s.targets,cash_weight:s.cash_weight}:null;
  return {ok:true,strategy_id:id,market:e.market,currency:e.currency,rules:describeStrategy(e),signal,universe:s?Object.keys(s.liquidity_caps||{}):[],fetched_at:nowISO()};
 }
 async function preview(env,db,id,budget){
  const info=await explanation(db,id),amount=numeric(budget,'模拟预算',100,100000000),issues=[];let context=null;
  if(info.signal)try{context=await adapter(info.market).snapshot(env,db,info.signal.targets.map(t=>t.symbol),{partial:true});}catch(e){issues.push(e.message||'账户或行情暂不可用');}
  const owner=await get(db,'SELECT * FROM portfolio_runs WHERE market=?',info.market);
  let protectedPositions=context?.positions||[];
  if(context){
   let owned={};
   if(owner?.strategy_id===id){const a=adapter(info.market);const base=await baseline(db,owner);owned=ownedPositions(await a.ledger(db,owner,env));if(!base.awaiting_orders)checkOwnership(context,base.positions,owned);protectedPositions=Object.entries(base.positions).map(([symbol,qty])=>({symbol,qty}));}
   context={...context,positions:Object.entries(owned).map(([symbol,qty])=>({symbol,qty}))};
  }
  const result=budgetPreview(info.signal,amount,context);
  if(owner)issues.push('该市场已有组合管理账户；此处仅按输入预算演示，不能重复启动或据此直接下单。');
  return {ok:true,strategy_id:id,budget:amount,currency:info.currency,...result,protected_positions:protectedPositions,blockers:[...issues,...result.blockers],fetched_at:nowISO()};
 }
 return {state,ingest,quotes,start,pause,resume,release,liquidate,tick,explanation,preview,history:createRunHistory({catalog,adapters})};
}
