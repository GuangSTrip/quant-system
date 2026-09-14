import {requireValue,nowISO,numeric,strategyConfig,validateBars,signalAt,normalizeOrder,digest,ENGINE_VERSION} from './engine.mjs';
const get=(db,sql,...v)=>db.prepare(sql).bind(...v).first();
const rows=async(db,sql,...v)=>(await db.prepare(sql).bind(...v).all()).results;
const run=(db,sql,...v)=>db.prepare(sql).bind(...v).run();
export async function autoState(db){await run(db,'INSERT OR IGNORE INTO auto_strategy (id,updated_at) VALUES (1,?)',nowISO());return get(db,'SELECT * FROM auto_strategy WHERE id=1');}
export async function autoGuard(db,order,automation){
  const state=await autoState(db);
  if(automation)requireValue(state.enabled&&state.run_id===automation.run_id&&state.revision===automation.revision,'策略已暂停或版本已变化',409,'STRATEGY_STOPPED');
  else requireValue(!state.enabled||JSON.parse(state.config).symbol!==order.symbol,'该标的正由自动策略管理，请先暂停策略再手动交易',409,'STRATEGY_OWNS_SYMBOL');
}
export function createAutomation(services){
  const {accountContext,history,snapshotQuote,requireCourseAsset,submitOrder,reconcile,audit,artifact,control,cancelOrders}=services;
  async function status(db,env){const s=await autoState(db),healthy=Boolean(s.heartbeat_at&&Date.now()-Date.parse(s.heartbeat_at)>=0&&Date.now()-Date.parse(s.heartbeat_at)<75*60000),last=s.last_check_at?await get(db,'SELECT source FROM auto_cycles WHERE run_id IS ? AND created_at=? ORDER BY id DESC LIMIT 1',s.run_id,s.last_check_at):null;const execution_state=!s.enabled?'paused':!s.last_check_at?'awaiting_execution':last?.source==='manual'?'manual_checked':healthy?'scheduled_checked':'awaiting_scheduler';return {ok:true,state:{...s,execution_state,last_execution_source:last?.source||null,config:s.config?JSON.parse(s.config):null,lease_id:undefined},scheduler:{configured:Boolean(env.SCHEDULER_NATIVE==='true'||env.SCHEDULER_REPOSITORY_ID),kind:env.SCHEDULER_NATIVE==='true'?'cloudflare':'github',healthy},cycles:(await rows(db,'SELECT * FROM auto_cycles ORDER BY id DESC LIMIT 60')).map(r=>({...r,details:JSON.parse(r.details)})),orders:(await rows(db,'SELECT client_id,status,broker_data,error FROM orders WHERE actor=? ORDER BY created_at DESC LIMIT 100','auto:'+s.run_id)).map(r=>({...r,broker_data:r.broker_data?JSON.parse(r.broker_data):null})),decisions:(await rows(db,'SELECT * FROM auto_decisions WHERE run_id=? ORDER BY created_at DESC LIMIT 30',s.run_id||'')).map(r=>({...r,payload:JSON.parse(r.payload)}))};}
  async function pause(db,user,reason='操作员暂停'){await autoState(db);await db.batch([db.prepare('UPDATE auto_strategy SET enabled=0,revision=revision+1,reason=?,updated_at=? WHERE id=1').bind(reason,nowISO()),await services.auditStatement(db,user.id,'strategy_paused',null,{reason})]);}
  async function configure(env,db,user,input){
    requireValue(input.confirm==='启动自动模拟交易','请输入“启动自动模拟交易”');
    const old=await autoState(db);requireValue(!old.enabled,'请先暂停当前策略');requireValue(!old.lease_id||old.lease_until<Date.now(),'上一轮仍在执行，请稍后再启动');
    const lease=await services.acquire(db);
    try{
      const c=await control(db);requireValue(!c.halted,'请先在风控页对账并恢复模拟交易',409,'HALTED');
      const report=await artifact(db,input.backtest_id,'backtest');requireValue(report.payload.engine===ENGINE_VERSION,'回测版本已变化，请重新回测');
      const config=strategyConfig(report.payload.config),budget=numeric(input.budget,'策略预算',100,Math.min(10000,c.max_order));
      await requireCourseAsset(env,config.symbol);
      const ctx=await accountContext(env);requireValue(!ctx.positions.some(p=>p.symbol===config.symbol&&Number(p.qty)!==0)&&!ctx.openOrders.some(o=>o.symbol===config.symbol),'启动新策略前，该标的必须没有持仓和未完成委托；请先处理现有仓位',409,'STRATEGY_NEEDS_FLAT');
      requireValue(!(await get(db,"SELECT client_id FROM orders WHERE status IN ('unknown','submitting') LIMIT 1")),'存在未知订单，请先对账',409,'UNRESOLVED_ORDER');
      const runId=crypto.randomUUID(),stamp=nowISO();
      const current=await autoState(db);requireValue(current.revision===old.revision&&!current.enabled,'策略状态已变化，请刷新');
      await db.batch([db.prepare('UPDATE auto_strategy SET run_id=?,enabled=1,revision=revision+1,config=?,backtest_id=?,budget=?,actor=?,reason=?,started_at=?,updated_at=?,lease_id=NULL,lease_until=0,last_check_at=NULL,last_outcome=NULL WHERE id=1 AND revision=?').bind(runId,JSON.stringify(config),input.backtest_id,budget,user.id,'等待后台检查',stamp,stamp,old.revision),await services.auditStatement(db,user.id,'strategy_started',runId,{config,budget,backtest_id:input.backtest_id})]);
      return status(db,env);
    }finally{await services.release(db,lease);}
  }
  async function resume(env,db,user,input){
    requireValue(input.confirm==='启动自动模拟交易','请输入“启动自动模拟交易”');const s=await autoState(db);requireValue(s.run_id&&!s.enabled,'请先创建或暂停策略');
    requireValue(!s.lease_id||s.lease_until<Date.now(),'上一轮仍在执行，请稍后重试');
    requireValue((await reconcile(env,db,user)).ok,'对账未通过',409,'RECONCILIATION_FAILED');requireValue(!(await control(db)).halted,'请先恢复全局交易',409,'HALTED');
    const changed=await db.batch([db.prepare('UPDATE auto_strategy SET enabled=1,revision=revision+1,reason=?,updated_at=?,lease_id=NULL,lease_until=0,last_check_at=NULL,last_outcome=NULL WHERE id=1 AND revision=? AND enabled=0').bind('等待后台检查',nowISO(),s.revision),await services.auditStatement(db,user.id,'strategy_resumed',s.run_id,{})]);requireValue(changed[0].meta.changes===1,'状态已变化，请刷新');return status(db,env);
  }
  async function record(db,s,source,outcome,details){const stamp=nowISO();await db.batch([db.prepare('INSERT INTO auto_cycles (run_id,source,outcome,details,created_at) VALUES (?,?,?,?,?)').bind(s.run_id,source,outcome,JSON.stringify(details),stamp),db.prepare('UPDATE auto_strategy SET last_check_at=?,last_outcome=?,reason=CASE WHEN enabled=1 THEN ? ELSE reason END,updated_at=? WHERE id=1 AND run_id IS ?').bind(stamp,outcome,details.message||outcome,stamp,s.run_id),db.prepare('DELETE FROM auto_cycles WHERE id NOT IN (SELECT id FROM auto_cycles ORDER BY id DESC LIMIT 1000)')]);return {ok:true,outcome,...details};}
  async function tick(env,db,source='manual'){
    let s=await autoState(db);
    if(source!=='manual'){await run(db,'UPDATE auto_strategy SET heartbeat_at=?,heartbeat_source=? WHERE id=1',nowISO(),source);}
    if(!s.enabled)return {ok:true,outcome:'paused',message:source==='manual'?'策略已暂停，请先授权启动或恢复':'策略未启动；调度心跳已接收'};
    if(s.lease_id){
      if(s.lease_until<Date.now())await pause(db,{id:'scheduler'},'上一轮中断，请对账后人工恢复');
      return {ok:true,outcome:'busy',message:'上一轮尚未结束'};
    }
    const lease=crypto.randomUUID();const claimed=await run(db,'UPDATE auto_strategy SET lease_id=?,lease_until=? WHERE id=1 AND enabled=1 AND revision=? AND lease_id IS NULL',lease,Date.now()+180000,s.revision);if(!claimed.meta.changes)return {ok:true,outcome:'busy'};
    const user={id:'auto:'+s.run_id};
    let releaseLease=true;
    try{
      if((await control(db)).halted){await pause(db,user,'全局交易已暂停，请分别恢复交易和策略');return record(db,s,source,'halted',{message:'全局交易已暂停'});}
      requireValue((await reconcile(env,db,user)).ok,'自动对账未通过',409,'RECONCILIATION_FAILED');
      const ctx=await accountContext(env),config=JSON.parse(s.config);
      requireValue(ctx.account.status==='ACTIVE'&&!ctx.account.trading_blocked&&!ctx.account.account_blocked,'券商账户不可交易',409,'ACCOUNT_BLOCKED');
      const c=await control(db);const equity=Number(ctx.account.equity),last=Number(ctx.account.last_equity);
      if(last>0&&(last-equity)/last>=c.max_loss){await run(db,'UPDATE control SET halted=1,reason=?,revision=revision+1,updated_at=? WHERE id=1','自动监控触发日亏损限额',nowISO());requireValue(false,'日亏损限额已触发',409,'DAILY_LOSS');}
      if(!ctx.clock.is_open)return record(db,s,source,'market_closed',{message:'市场休市，等待常规交易时段',next_open:ctx.clock.next_open});
      const tracked=await rows(db,'SELECT broker_data,status FROM orders WHERE actor=?',user.id);
      requireValue(!tracked.some(o=>['unknown','submitting'].includes(o.status)),'存在未知订单',409,'UNRESOLVED_ORDER');
      const owned=tracked.reduce((n,o)=>{const b=o.broker_data?JSON.parse(o.broker_data):null;return n+(b?(b.side==='buy'?1:-1)*Number(b.filled_qty||0):0);},0);
      const current=Number(ctx.positions.find(p=>p.symbol===config.symbol)?.qty||0);
      requireValue(Number.isFinite(owned)&&Math.abs(current-owned)<1e-8,'持仓与策略成交账本不一致，可能存在手动或外部交易，请人工对账',409,'STRATEGY_POSITION_DRIFT');
      if(ctx.openOrders.some(o=>o.symbol===config.symbol))return record(db,s,source,'pending_order',{message:'已有未完成委托，跟踪结果，暂不增加订单'});
      const data=await history(env,config),bars=validateBars(data.bars);requireValue(bars.length>=config.slow,'历史日线不足',422,'INSUFFICIENT_DATA');
      const bar=bars.at(-1),age=(Date.parse(ctx.clock.timestamp)-Date.parse(bar.t))/86400000;requireValue(age>=0&&age<=7,'信号日线已过期',409,'STALE_SIGNAL');
      const id=s.run_id+':'+bar.t,existing=await get(db,'SELECT * FROM auto_decisions WHERE id=?',id);
      if(existing)return record(db,s,source,'already_evaluated',{message:'当前完整日线已处理，本轮不重复下单',decision_id:id});
      const signal=signalAt(bars,bars.length-1,config),quote=await snapshotQuote(env,config.symbol);
      const side=signal?'buy':'sell',price=signal?Number(quote.ap)*1.001:Number(quote.bp)*.999;
      requireValue(price>0&&Number.isFinite(price),'报价不可用',409,'STALE_QUOTE');
      const target=signal?(owned>0?owned:Math.floor(s.budget/price)):0,delta=target-owned;
      const order=Math.abs(delta)>=1?normalizeOrder({symbol:config.symbol,side:delta>0?'buy':'sell',qty:Math.floor(Math.abs(delta)),type:'limit',limit_price:price.toFixed(2),time_in_force:'day'}):null;
      const datasetId='data_'+(await digest({query:data.query,bars:data.bars})).slice(0,40);
      await services.saveArtifact(db,user,'dataset',config.symbol+' 自动策略决策数据',data,datasetId);
      const key=crypto.randomUUID(),details={snapshot_id:datasetId,config,signal,signal_timestamp:bar.t,owned_qty:owned,target_qty:target,order,source:data.source,data_digest:await digest(bars),engine:ENGINE_VERSION,message:order?'信号产生限价委托':'保持当前仓位，无需下单'};
      await autoGuard(db,{symbol:config.symbol},{run_id:s.run_id,revision:s.revision});
      await db.batch([db.prepare('INSERT INTO auto_decisions (id,run_id,bar_time,signal,payload,client_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,s.run_id,bar.t,signal,JSON.stringify(details),order?key:null,order?'prepared':'no_order',nowISO(),nowISO()),await services.auditStatement(db,user.id,'auto_decision',id,details)]);
      if(!order)return record(db,s,source,'no_order',details);
      const result=await submitOrder(env,db,user,{...order,confirm:true,idempotency_key:key},null,{run_id:s.run_id,revision:s.revision});
      await run(db,'UPDATE auto_decisions SET status=?,updated_at=? WHERE id=?',result.ok?'submitted':'unknown',nowISO(),id);
      requireValue(result.ok,'订单状态未确认，请对账后恢复',409,'UNRESOLVED_ORDER');
      return record(db,s,source,'submitted',{...details,client_order_id:result.order.client_order_id,broker_status:result.order.status});
    }catch(e){
      // If storage cannot persist the fault pause, keep the lease as a durable
      // recovery barrier. A later tick must not silently resume this run.
      try{await pause(db,user,e.message||'执行异常');}catch(storageError){releaseLease=false;throw storageError;}
      await record(db,s,source,'fault',{message:e.message||'执行异常',code:e.code||'SERVICE_UNAVAILABLE'});return {ok:false,outcome:'fault',code:e.code||'SERVICE_UNAVAILABLE',message:e.message||'执行异常'};
    }finally{if(releaseLease)await run(db,'UPDATE auto_strategy SET lease_id=NULL,lease_until=0 WHERE id=1 AND lease_id=?',lease);}
  }
  async function cancelRun(env,db,user){const s=await autoState(db);await pause(db,user,'操作员暂停并撤销策略委托');const pending=await rows(db,"SELECT client_id FROM orders WHERE actor=? AND status NOT IN ('filled','canceled','expired','rejected','replaced')",'auto:'+s.run_id);const results=[];for(const p of pending)results.push(await cancelOrders(env,db,user,p.client_id));return {ok:true,results};}
  return {status,configure,resume,pause,tick,cancelRun};
}
