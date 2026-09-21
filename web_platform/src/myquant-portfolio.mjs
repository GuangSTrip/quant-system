import {requireValue,digest} from './engine.mjs';
import {myquantBridge} from './myquant-transport.mjs';
import {portfolioGuard} from './portfolio.mjs';
const first=(db,s,...v)=>db.prepare(s).bind(...v).first();
const run=(db,s,...v)=>db.prepare(s).bind(...v).run();
export function cnNative(symbol){requireValue(/^\d{6}\.(SH|SZ)$/.test(symbol),'A股自动执行只支持沪深股票',422,'CN_SYMBOL');const [code,exchange]=symbol.split('.');return (exchange==='SH'?'SHSE.':'SZSE.')+code;}
export function cnSymbol(symbol){requireValue(/^(SHSE|SZSE)\.\d{6}$/.test(symbol),'非沪深持仓需人工核对',409,'CN_SYMBOL');const [exchange,code]=symbol.split('.');return code+(exchange==='SHSE'?'.SH':'.SZ');}
export async function cnExclusive(db,fn){
 const lease=crypto.randomUUID();await run(db,"INSERT OR IGNORE INTO broker_locks(market) VALUES('CN')");
 const r=await run(db,"UPDATE broker_locks SET lease_id=?,lease_until=? WHERE market='CN' AND (lease_id IS NULL OR lease_until<?)",lease,Date.now()+120000,Date.now());
 requireValue(r.meta.changes===1,'A股账户正在执行其他操作',409,'CN_BUSY');
 try{return await fn();}finally{await run(db,"UPDATE broker_locks SET lease_id=NULL,lease_until=0 WHERE market='CN' AND lease_id=?",lease);}
}
export const cnPortfolioAdapter={
 exclusive:cnExclusive,
 async available(env){const s=await myquantBridge(env,'/v1/status');requireValue(s.bridge.connected&&Date.now()-Date.parse(s.bridge.updated_at)<30000,'A股账户快照已过期',503,'CN_OFFLINE');requireValue(!s.control.halted,'请先对账并恢复A股模拟交易',409,'HALTED');requireValue(s.account?.status?.environment==='paper','A股仿真环境未确认',409,'PAPER_ENVIRONMENT_UNVERIFIED');},
 async snapshot(env,db,symbols,options={}){
  const s=await myquantBridge(env,'/v1/status');requireValue(s.bridge.connected&&Date.now()-Date.parse(s.bridge.updated_at)<30000,'A股账户快照已过期',503,'CN_OFFLINE');
  requireValue(s.account.binding,'A股桥接需升级以绑定策略账户',503,'CN_BINDING');
  const cash=Number(s.account.cash?.available);requireValue(Number.isFinite(cash)&&cash>=0,'A股资金无效',503);
  const positions=s.positions.map(p=>({symbol:cnSymbol(p.symbol),qty:Number(p.volume),available:Number(p.available_now??p.available??0)}));
  requireValue(positions.every(p=>Number.isSafeInteger(p.qty)&&p.qty>=0&&Number.isSafeInteger(p.available)&&p.available>=0),'A股持仓无效',503);
  const row=await first(db,"SELECT payload FROM portfolio_quotes WHERE market='CN'"),feed=row?JSON.parse(row.payload):null,quotes={};
  if(symbols.length){requireValue(feed&&Date.now()-Date.parse(feed.asof)>=-5000&&Date.now()-Date.parse(feed.asof)<=120000,'A股行情服务未发布两分钟内的交易时段快照',409,'STALE_QUOTE');
   if(feed.is_open)for(const symbol of symbols){cnNative(symbol);const q=feed.instruments.find(q=>q.symbol===symbol);if(options.partial&&(!q||Date.now()-Date.parse(q.asof)>120000))continue;requireValue(q&&Date.now()-Date.parse(q.asof)<=120000,'A股报价过期：'+symbol,409,'STALE_QUOTE');quotes[symbol]={...q,available:positions.find(p=>p.symbol===symbol)?.available||0};}}
  return {tag:await digest('myquant:'+s.account.binding),cash,positions,pending:s.open_orders.length>0||s.unresolved>0,is_open:feed?.is_open===true,quotes};
 },
 async reconcile(env){const r=await myquantBridge(env,'/v1/reconcile',{method:'POST',payload:{},actor:'portfolio'});requireValue(r.ok,'A股委托状态未确认，请对账',409,'CN_UNRESOLVED');},
 async ledger(db,s,env){const r=await myquantBridge(env,'/v1/ledger',{actor:'portfolio:'+s.run_id});return r.orders.map(o=>({key:o.client_id.replaceAll('-',''),symbol:cnSymbol(o.request.symbol),side:o.request.side,filled:Number(o.broker?.filled_volume||0),price:Number(o.broker?.filled_vwap||0)}));},
 async submit(env,db,s,o){return cnExclusive(db,async()=>{await portfolioGuard(db,'CN',s);const result=await myquantBridge(env,'/v1/orders',{method:'POST',actor:'portfolio:'+s.run_id,payload:{client_id:o.key,symbol:cnNative(o.symbol),side:o.side,quantity:o.qty,type:'limit',limit_price:o.price,confirm:'提交A股模拟订单'}});requireValue(['queued','pending_new','new','partially_filled','filled'].includes(result.order?.status),'A股委托未确认接收',409,'CN_ORDER_UNRESOLVED');return result;});}
};
