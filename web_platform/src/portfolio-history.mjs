import {nowISO,requireValue} from './engine.mjs';
const rows=async(db,s,...v)=>(await db.prepare(s).bind(...v).all()).results;
const first=(db,s,...v)=>db.prepare(s).bind(...v).first();
const parse=v=>v?JSON.parse(v):null;
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));

// Use only this run's confirmed fills. Missing prices never become zero-value holdings.
export function runPerformance(orders,budget,quotes={},now=Date.now()){
 const lots={},errors=[];let realized=0,turnover=0,filledOrders=0;
 const ordered=[...orders].sort((a,b)=>String(a.filled_at||a.submitted_at||'').localeCompare(String(b.filled_at||b.submitted_at||'')));
 for(const o of ordered){
  if(!finite(o.filled)||Number(o.filled)<0){errors.push('成交数量不完整');continue;}
  const qty=Number(o.filled);if(!qty)continue;
  if(!finite(o.price)||Number(o.price)<=0||!['buy','sell'].includes(o.side)){errors.push('成交价格或方向不完整');continue;}
  const price=Number(o.price),p=lots[o.symbol]||{qty:0,cost:0};filledOrders++;turnover+=qty*price;
  if(o.side==='buy'){p.qty+=qty;p.cost+=qty*price;}
  else if(qty>p.qty+1e-8)errors.push('卖出超过可追溯的策略买入数量');
  else{const cost=p.qty?p.cost/p.qty:0;realized+=qty*(price-cost);p.qty-=qty;p.cost-=qty*cost;}
  lots[o.symbol]=p;
 }
 let unrealized=0,valued=true;
 const positions=Object.entries(lots).filter(([,p])=>p.qty>1e-8).map(([symbol,p])=>{
  const q=quotes[symbol],age=now-Date.parse(q?.asof),valid=finite(q?.price)&&Number(q.price)>0&&age>=-5000&&age<=120000;
  const pnl=valid?p.qty*Number(q.price)-p.cost:null;if(!valid)valued=false;else unrealized+=pnl;
  return {symbol,qty:p.qty,average_cost:p.cost/p.qty,price:valid?Number(q.price):null,quote_at:q?.asof||null,unrealized:pnl};
 });
 const complete=errors.length===0,total=complete&&valued?realized+unrealized:null;
 return {realized:complete?realized:null,unrealized:complete&&valued?unrealized:null,total,return_pct:total!==null&&finite(budget)&&Number(budget)>0?total/Number(budget)*100:null,positions,filled_orders:filledOrders,turnover,complete,errors,net:null,fee_note:'未扣税费盈亏；券商费用尚未完整核实，不作为净收益',valuation_at:nowISO()};
}

export function historyStatement(db,record,actor='system'){
 return db.prepare("INSERT INTO artifacts(id,kind,name,payload,actor,created_at) VALUES(?,'portfolio_run_history',?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
  .bind('run-history:'+record.run_id,record.run_id,JSON.stringify(record),actor,record.started_at||nowISO());
}

export async function recordRunMark(db,s,ledger,quotes){
 if(!Object.keys(quotes).length){const feed=await first(db,'SELECT payload FROM portfolio_quotes WHERE market=?',s.market||'');quotes=Object.fromEntries((parse(feed?.payload)?.instruments||[]).map(q=>[q.symbol,q]));}
 const stamped=Object.fromEntries(Object.entries(quotes).map(([k,q])=>[k,{...q,asof:q.asof||nowISO()}]));
 const metrics=runPerformance(ledger,s.budget,stamped);
 if(metrics.total===null)return;
 const at=nowISO(),bucket=Math.floor(Date.now()/300000),id='run-mark:'+s.run_id+':'+bucket;
 await db.prepare("INSERT INTO artifacts(id,kind,name,payload,actor,created_at) VALUES(?,'portfolio_run_mark',?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at")
  .bind(id,s.run_id,JSON.stringify({at,total:metrics.total,return_pct:metrics.return_pct,equity:Number(s.budget)+metrics.total,quotes:stamped}), 'portfolio:'+s.run_id,at).run();
}

export function createRunHistory({catalog,adapters}){
 async function readRun(db,id){
  const current=await first(db,'SELECT * FROM portfolio_runs WHERE run_id=?',id);
  const archived=await first(db,"SELECT payload,created_at FROM artifacts WHERE id=? AND kind='portfolio_run_history'",'run-history:'+id);
  const ownership=await first(db,"SELECT created_at FROM artifacts WHERE id=? AND kind='portfolio_ownership'",'ownership:'+id);
  const decisions=await rows(db,'SELECT * FROM portfolio_decisions WHERE run_id=? ORDER BY created_at,id LIMIT 1001',id);
  const oldOrders=await first(db,'SELECT created_at FROM lb_orders WHERE run_id=? UNION ALL SELECT created_at FROM orders WHERE actor=? LIMIT 1',id,'portfolio:'+id);
  requireValue(current||archived||ownership||decisions.length||oldOrders,'运行记录不存在',404);
  const stored=parse(archived?.payload),initial=decisions.map(d=>parse(d.payload)?.signal).find(s=>s?.strategy_id),strategy_id=stored?.strategy_id||current?.strategy_id||initial?.strategy_id||null;
  const e=catalog.get(strategy_id),released=await first(db,"SELECT timestamp,details FROM events WHERE kind='portfolio_released' AND subject=? ORDER BY timestamp DESC LIMIT 1",id);
  const kept=parse(released?.details)?.kept_positions||stored?.kept_positions||{};
  const state=current?(current.exit_requested?'exiting':current.enabled?'running':'paused'):stored?.ended_at?stored.status:released?(Object.keys(kept).length?'ended_kept':'ended'):'legacy';
  return {record:{run_id:id,strategy_id,market:stored?.market||current?.market||e?.market||initial?.market||null,name:stored?.name||e?.name||'旧运行（策略信息不完整）',currency:stored?.currency||e?.currency||null,budget:stored?.budget??current?.budget??null,started_at:stored?.started_at||ownership?.created_at||decisions[0]?.created_at||oldOrders?.created_at||null,start_time_exact:!!stored?.started_at||!!ownership,status:state,ended_at:stored?.ended_at||released?.timestamp||null,reason:current?.reason||stored?.reason||null,legacy:!stored||!!stored.legacy,kept_positions:kept,initial_signal:stored?.initial_signal||initial||null,config:stored?.config||e?.config||null},stored,current,decisions};
 }
 async function list(db,{offset=0,market=''}={}){
  const start=Math.max(0,Math.min(100000,Math.floor(Number(offset)||0)));
  const candidates=await rows(db,`SELECT run_id,MIN(at) at FROM (
   SELECT run_id,updated_at at FROM portfolio_runs UNION ALL
   SELECT name run_id,created_at at FROM artifacts WHERE kind IN ('portfolio_run_history','portfolio_ownership') UNION ALL
   SELECT run_id,created_at at FROM portfolio_decisions UNION ALL
   SELECT substr(actor,11) run_id,created_at at FROM orders WHERE actor LIKE 'portfolio:%' UNION ALL
   SELECT run_id,created_at at FROM lb_orders WHERE actor LIKE 'portfolio:%' AND run_id IS NOT NULL
  ) GROUP BY run_id ORDER BY at DESC,run_id DESC`);
  const records=[];
  for(const c of candidates){const {record}=await readRun(db,c.run_id);if(!market||record.market===market)records.push(record);}
  return {ok:true,total:records.length,offset:start,limit:20,runs:records.slice(start,start+20)};
 }
 async function detail(env,db,id){
  requireValue(typeof id==='string'&&id.length<=100,'运行编号无效');
  const {record,stored,current,decisions}=await readRun(db,id);let orders=stored?.orders||[],orderError=null;
  if(!stored?.ended_at&&record.market&&adapters[record.market]){
   try{orders=await adapters[record.market].ledger(db,{run_id:id},env);}catch{orderError='券商历史成交暂不可读取；不能把缺失回报当作零成交或零盈亏';orders=null;}
  }else if(!stored?.ended_at&&!record.market){orders=null;orderError='旧记录缺少市场信息，无法可靠关联成交';}
  const feed=record.market?await first(db,'SELECT payload FROM portfolio_quotes WHERE market=?',record.market):null;
  const quotes=Object.fromEntries((parse(feed?.payload)?.instruments||[]).map(q=>[q.symbol,q]));
  if(record.market==='US'&&current){const mark=await first(db,"SELECT payload FROM artifacts WHERE kind='portfolio_run_mark' AND name=? ORDER BY created_at DESC LIMIT 1",id);Object.assign(quotes,parse(mark?.payload)?.quotes||{});}
  let metrics=orders?runPerformance(orders,record.budget,quotes):null;
  if(stored?.ended_at)metrics=stored.final_metrics||null;
  // Old released runs with retained stock have no end-of-run valuation; do not apply today's quote.
  if(!stored&&record.ended_at&&Object.keys(record.kept_positions).length&&metrics)metrics={...metrics,unrealized:null,total:null,return_pct:null,valuation_at:null};
  const marks=await rows(db,"SELECT payload FROM artifacts WHERE kind='portfolio_run_mark' AND name=? ORDER BY created_at LIMIT 2001",id);
  const events=await rows(db,"SELECT timestamp,kind,details FROM events WHERE subject=? OR actor=? OR subject LIKE ? ORDER BY timestamp LIMIT 501",id,'portfolio:'+id,id+':%');
  return {ok:true,run:record,orders:orders||[],order_error:orderError,metrics,decisions:decisions.slice(0,1000).map(d=>({id:d.id,at:d.created_at,phase:d.phase,...parse(d.payload)})),events:events.slice(0,500).map(e=>({...e,details:parse(e.details)})),marks:marks.slice(0,2000).map(m=>{const p=parse(m.payload);return {at:p.at,total:p.total,return_pct:p.return_pct,equity:p.equity};}),truncated:decisions.length>1000||marks.length>2000||events.length>500,notes:[record.legacy?'旧记录由已有决策和订单恢复，缺失内容未补造。':'本次运行有独立档案，结束后仍可查看。','曲线仅记录监控功能上线后取得的有效估值，每五分钟保留最近一个点；不是连续净值或券商结算收益。',current?'委托状态使用最近已同步的券商回报；本页只读，不提交、撤销或重发订单。':'结束后保留股票的后续涨跌不计入已结束策略。']};
 }
 return {list,detail};
}
