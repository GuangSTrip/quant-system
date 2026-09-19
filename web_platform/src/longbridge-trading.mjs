import {AppError,requireValue,nowISO,numeric,digest} from './engine.mjs';
import {signedHeaders,unseal} from './longbridge.mjs';
const first=(db,s,...v)=>db.prepare(s).bind(...v).first();
const rows=async(db,s,...v)=>(await db.prepare(s).bind(...v).all()).results;
const run=(db,s,...v)=>db.prepare(s).bind(...v).run();
const done=new Set(['FilledStatus','CanceledStatus','RejectedStatus','ExpiredStatus','PartialWithdrawal','rejected']);
const pick=(o,keys)=>Object.fromEntries(keys.map(k=>[k,o?.[k]??null]));
const clean=o=>pick(o,['order_id','symbol','side','status','quantity','executed_quantity','executed_price','price','submitted_at','updated_at','remark']);
const safeError=e=>e instanceof AppError?e.message:'长桥服务暂不可用，请核对订单，不要重复提交';
const allow=new Set(['GET /v1/asset/account','GET /v1/asset/stock','GET /v1/trade/order','GET /v1/trade/order/today','GET /v1/trade/order/history','GET /v1/trade/execution/today','GET /v1/trade/estimate/buy_limit','POST /v1/trade/order','DELETE /v1/trade/order']);
export async function tradeRequest(credentials,method,path,params={},payload,fetcher=fetch){
 requireValue(allow.has(method+' '+path),'不支持的长桥交易接口',400,'LB_ENDPOINT');
 const query=new URLSearchParams(params).toString(),body=payload===undefined?undefined:JSON.stringify(payload);
 const headers=await signedHeaders(credentials,path,query,String(Math.floor(Date.now()/1000)),method,body);
 let response,data;
 try{response=await fetcher('https://openapi.longbridge.com'+path+(query?'?'+query:''),{method,headers,redirect:'manual',signal:AbortSignal.timeout(12000),...(body===undefined?{}:{body})});data=await response.json();}
 catch{throw new AppError('长桥请求超时或返回异常；交易结果待核对，禁止重复提交',502,'LB_UNKNOWN');}
 requireValue(response.status<300||response.status>=400,'长桥重定向已阻止；请核对订单',502,'LB_UNKNOWN');
 if(!response.ok||data?.code!==0){const definite=response.status>=400&&response.status<500&&response.status!==408||response.ok&&Number.isSafeInteger(data?.code)&&data.code!==0;throw new AppError('长桥请求未成功（错误码 '+(Number.isSafeInteger(data?.code)?data.code:response.status)+'）',502,definite?'LB_REJECTED':'LB_UNKNOWN');}
 requireValue(data.data&&typeof data.data==='object','长桥返回不完整，请核对订单',502,'LB_UNKNOWN');return data.data;
}
export function normalizeHK(input){
 const s=String(input.symbol||'').trim().toUpperCase().replace(/^HK\./,'').replace(/\.HK$/,'');
 requireValue(/^\d{1,5}$/.test(s)&&Number(s)>0,'请输入港股数字代码，例如 700.HK',400,'LB_SYMBOL');
 const quantity=numeric(input.quantity,'股数',1,1000000),lot=numeric(input.lot_size,'每手股数',1,1000000),price=numeric(input.price,'限价',0.001,1000000);
 requireValue(Number.isSafeInteger(quantity)&&Number.isSafeInteger(lot)&&quantity%lot===0,'股数必须是每手股数的整数倍',400,'LB_LOT');
 requireValue(['Buy','Sell'].includes(input.side),'买卖方向无效');
 requireValue(Math.abs(price*1000-Math.round(price*1000))<1e-6,'限价最多三位小数');
 return {symbol:Number(s)+'.HK',side:input.side,quantity,lot_size:lot,price,order_type:'LO',time_in_force:'Day'};
}
export function hkWindow(time=Date.now()){
 const d=new Date(time+8*3600000),minute=d.getUTCHours()*60+d.getUTCMinutes();
 return d.getUTCDay()>=1&&d.getUTCDay()<=5&&(minute>=570&&minute<720||minute>=780&&minute<960);
}
async function init(db){await run(db,'INSERT OR IGNORE INTO lb_control(id,updated_at) VALUES(1,?)',nowISO());await run(db,'INSERT OR IGNORE INTO lb_auto(id,updated_at) VALUES(1,?)',nowISO());}
async function connection(env,db){const row=await first(db,'SELECT * FROM longbridge_connection WHERE id=1');requireValue(row,'请先连接长桥模拟账户',409,'LB_NOT_CONFIGURED');return {credentials:await unseal(env,row.ciphertext),tag:await digest(row.ciphertext)};}
async function control(db){await init(db);return first(db,'SELECT * FROM lb_control WHERE id=1');}
async function audit(db,actor,kind,subject,details){const timestamp=nowISO();await run(db,'INSERT INTO events(timestamp,actor,kind,subject,details,digest) VALUES(?,?,?,?,?,?)',timestamp,actor,kind,subject,JSON.stringify(details),await digest({timestamp,actor,kind,subject,details}));}
async function lock(db,fn){await init(db);const id=crypto.randomUUID();const r=await run(db,'UPDATE lb_control SET lease_id=?,lease_until=? WHERE id=1 AND lease_id IS NULL',id,Date.now()+180000);requireValue(r.meta.changes===1,'长桥执行通道忙或上一轮中断，请稍后核对并恢复通道',409,'LB_BUSY');try{return await fn();}finally{await run(db,'UPDATE lb_control SET lease_id=NULL,lease_until=0 WHERE id=1 AND lease_id=?',id);}}
async function authorized(env,db){const c=await control(db),conn=await connection(env,db);requireValue(c.enabled&&c.connection_tag===conn.tag,'请先确认模拟账户并启用长桥交易；更换凭证会使授权失效',409,'LB_DISABLED');return {...conn,control:c};}
const publicOrder=r=>({...r,payload:JSON.parse(r.payload),broker_data:r.broker_data?JSON.parse(r.broker_data):null,connection_tag:undefined,request_hash:undefined});
export async function tradingState(env,db){const c=await control(db),a=await first(db,'SELECT * FROM lb_auto WHERE id=1'),row=await first(db,'SELECT ciphertext FROM longbridge_connection WHERE id=1'),tag=row?await digest(row.ciphertext):null;
 return {ok:true,control:{enabled:Boolean(c.enabled&&tag===c.connection_tag),max_order:c.max_order,max_daily:c.max_daily,busy:!!c.lease_id,lease_until:c.lease_until,environment_basis:'操作员确认模拟 Token；接口未独立证明账户环境'},automation:{...a,config:a.config?JSON.parse(a.config):null},scheduler:{configured:env.SCHEDULER_NATIVE==='true'||Boolean(env.SCHEDULER_REPOSITORY_ID),healthy:!!a.heartbeat_at&&Date.now()-Date.parse(a.heartbeat_at)<75*60000},orders:(await rows(db,'SELECT * FROM lb_orders WHERE connection_tag=? ORDER BY created_at DESC LIMIT 100',tag||'')).map(publicOrder)};
}
export async function setTrading(env,db,user,input){
 await init(db);
 if(input.enabled===false){await db.batch([db.prepare('UPDATE lb_control SET enabled=0,updated_at=? WHERE id=1').bind(nowISO()),db.prepare("UPDATE lb_auto SET enabled=0,reason='长桥交易已暂停',updated_at=? WHERE id=1").bind(nowISO())]);await audit(db,user.id,'lb_disabled',null,{});return tradingState(env,db);}
 requireValue(input.confirm==='确认长桥模拟账户','请输入“确认长桥模拟账户”');
 const maxOrder=numeric(input.max_order,'单笔上限',1,100000000),maxDaily=numeric(input.max_daily,'单日上限',maxOrder,100000000);
 return lock(db,async()=>{const {tag}=await connection(env,db);await run(db,'UPDATE lb_control SET enabled=1,connection_tag=?,max_order=?,max_daily=?,updated_at=? WHERE id=1',tag,maxOrder,maxDaily,nowISO());await audit(db,user.id,'lb_paper_attested',null,{maxOrder,maxDaily,basis:'operator_attestation'});return tradingState(env,db);});
}
async function holdings(credentials){const d=await tradeRequest(credentials,'GET','/v1/asset/stock');requireValue(Array.isArray(d.list),'持仓格式异常',502);return d.list.flatMap(x=>{requireValue(Array.isArray(x.stock_info),'持仓格式异常',502);return x.stock_info;}).filter(x=>x.market==='HK');}
async function brokerOrders(credentials){const d=await tradeRequest(credentials,'GET','/v1/trade/order/today',{market:'HK'});requireValue(Array.isArray(d.orders),'订单列表格式异常',502);return d.orders;}
async function validateRisk(env,db,o,autoRun){
 const ctx=await authorized(env,db),{credentials,tag,control:c}=ctx;
 const a=await first(db,'SELECT * FROM lb_auto WHERE id=1');
 requireValue(autoRun? a.enabled&&a.run_id===autoRun:!a.enabled,'自动策略已暂停或正在管理账户，请先暂停再手动下单',409,'LB_AUTO_OWNS');
 const unresolved=await first(db,"SELECT client_id FROM lb_orders WHERE connection_tag=? AND status IN ('unknown','submitting','cancel_unknown') LIMIT 1",tag);requireValue(!unresolved,'存在待核对交易，禁止新增订单',409,'LB_UNRESOLVED');
 const notional=o.quantity*o.price;requireValue(notional<=c.max_order,'订单金额超过长桥单笔限额',409,'LB_ORDER_LIMIT');
 const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10),since=new Date(Date.parse(day+'T00:00:00+08:00')).toISOString();
 const spent=await first(db,"SELECT COALESCE(SUM(notional),0) total,COUNT(*) n FROM lb_orders WHERE connection_tag=? AND created_at>=? AND status!='rejected'",tag,since);
 requireValue(Number(spent.total)+notional<=c.max_daily,'订单金额超过长桥当日提交限额（撤单不返还）',409,'LB_DAILY_LIMIT');requireValue(spent.n<100,'课程账户当日委托次数已达 100 次',409,'LB_DAILY_COUNT');
 const [p,open]=await Promise.all([holdings(credentials),brokerOrders(credentials)]);
 requireValue(!open.some(x=>x.symbol===o.symbol&&!done.has(x.status)),'该标的已有未完成委托，请先处理',409,'LB_PENDING');
 const owned=p.find(x=>x.symbol===o.symbol),initialQty=Number(owned?.quantity||0);requireValue(Number.isFinite(initialQty),'持仓数量无效',502);
 if(o.side==='Sell')requireValue(Number(owned?.available_quantity||0)>=o.quantity,'可卖股数不足；不允许做空',409,'LB_POSITION');
 else {
 const funds=await tradeRequest(credentials,'GET','/v1/asset/account',{currency:'HKD'});requireValue(Array.isArray(funds.list),'账户资金返回异常',502);
 const cash=funds.list.flatMap(x=>Array.isArray(x.cash_infos)?x.cash_infos:[]).filter(x=>x.currency==='HKD').reduce((n,x)=>n+Number(x.available_cash||0),0);
 requireValue(Number.isFinite(cash)&&cash>=notional*1.01,'可用港币现金不足（预留 1% 费用，不使用融资）',409,'LB_CASH');
 }
 return {...ctx,initialQty,notional};
}
export async function previewHK(env,db,input){const o=normalizeHK(input),ctx=await validateRisk(env,db,o,null);return {ok:true,order:o,notional:ctx.notional,initial_qty:ctx.initialQty,queued:!hkWindow(),message:'仅预览；港股每手股数和价位由券商最终校验。休市提交可能排队，未成交不算通过验收。'};}
async function submitLocked(env,db,user,input,autoRun=null){
 const o=normalizeHK(input);requireValue(input.confirm===true,'请确认限价模拟订单');requireValue(hkWindow()||input.allow_queued===true,'当前不在港股常规时段；请确认允许排队',409,'LB_CLOSED');
 const id=String(input.client_id||'');requireValue(/^[a-zA-Z0-9_-]{16,64}$/.test(id),'缺少有效的唯一请求编号');const hash=await digest(o),conn=await connection(env,db);
 const old=await first(db,'SELECT * FROM lb_orders WHERE client_id=?',id);
 if(old){requireValue(old.request_hash===hash&&old.connection_tag===conn.tag,'相同请求编号不能用于不同订单或账户',409,'LB_ID_CONFLICT');return {ok:!['unknown','submitting'].includes(old.status),reused:true,order:publicOrder(old)};}
 const ctx=await validateRisk(env,db,o,autoRun),payload={symbol:o.symbol,side:o.side,order_type:'LO',submitted_quantity:String(o.quantity),submitted_price:String(o.price),time_in_force:'Day',remark:'qs:'+id,client_request_id:id};
 await run(db,'INSERT INTO lb_orders(client_id,connection_tag,payload,request_hash,status,notional,initial_qty,actor,run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,ctx.tag,JSON.stringify(o),hash,'submitting',ctx.notional,ctx.initialQty,user.id,autoRun,nowISO(),nowISO());
 await audit(db,user.id,'lb_submit_intent',id,{order:o,notional:ctx.notional});
 // Recheck the pause switch after asynchronous risk checks and before dispatch.
 try{await authorized(env,db);if(autoRun){const a=await first(db,'SELECT enabled,run_id FROM lb_auto WHERE id=1');requireValue(a.enabled&&a.run_id===autoRun,'策略已暂停',409,'LB_AUTO_STOPPED');}}catch(e){await run(db,"UPDATE lb_orders SET status='rejected',error=?,updated_at=? WHERE client_id=?",safeError(e),nowISO(),id);throw e;}
 try{
 const result=await tradeRequest(ctx.credentials,'POST','/v1/trade/order',{},payload);requireValue(typeof result.order_id==='string'&&result.order_id.length>0,'缺少券商订单号，请核对结果',502,'LB_UNKNOWN');
 await run(db,"UPDATE lb_orders SET broker_id=?,status='submitted',updated_at=? WHERE client_id=?",result.order_id,nowISO(),id);
 await audit(db,user.id,'lb_submitted',id,{broker_id:result.order_id});
 }catch(e){await run(db,'UPDATE lb_orders SET status=?,error=?,updated_at=? WHERE client_id=?',e.code==='LB_REJECTED'?'rejected':'unknown',safeError(e),nowISO(),id);}
 const r=await first(db,'SELECT * FROM lb_orders WHERE client_id=?',id);return {ok:r.status==='submitted',order:publicOrder(r)};
}
export async function submitHK(env,db,user,input){return lock(db,()=>submitLocked(env,db,user,input));}
async function updateReceipt(db,row,d){
 const o=JSON.parse(row.payload);
 requireValue(d.symbol===o.symbol&&d.side===o.side&&Number(d.quantity)===o.quantity&&typeof d.status==='string'&&Number.isFinite(Number(d.executed_quantity))&&Number(d.executed_quantity)>=0&&Number(d.executed_quantity)<=o.quantity,'券商订单与本地记录不一致',409,'LB_RECEIPT_MISMATCH');
 requireValue(!row.broker_id||row.broker_id===d.order_id,'券商订单编号不一致',409,'LB_RECEIPT_MISMATCH');
 await run(db,'UPDATE lb_orders SET broker_id=?,status=?,broker_data=?,error=NULL,updated_at=? WHERE client_id=?',d.order_id,d.status,JSON.stringify(clean(d)),nowISO(),row.client_id);return clean(d);
}
async function inspectLocked(env,db,id){
 const conn=await connection(env,db),row=await first(db,'SELECT * FROM lb_orders WHERE client_id=?',id);requireValue(row&&row.connection_tag===conn.tag,'订单不属于当前连接',404,'LB_ORDER_NOT_FOUND');
 let d;
 if(row.broker_id)d=await tradeRequest(conn.credentials,'GET','/v1/trade/order',{order_id:row.broker_id});
 else{
 let list=await brokerOrders(conn.credentials),matches=list.filter(x=>x.remark==='qs:'+id);if(!matches.length){const history=await tradeRequest(conn.credentials,'GET','/v1/trade/order/history',{market:'HK',start_at:String(Math.floor(Date.parse(row.created_at)/1000)-60),end_at:String(Math.floor(Date.now()/1000))});requireValue(Array.isArray(history.orders),'历史订单返回不完整',502);matches=history.orders.filter(x=>x.remark==='qs:'+id);}requireValue(matches.length===1,'尚未查到唯一对应委托，保持未知状态，禁止自动重发；请在长桥核对',409,'LB_UNRESOLVED');d=await tradeRequest(conn.credentials,'GET','/v1/trade/order',{order_id:matches[0].order_id});
 }
 const receipt=await updateReceipt(db,row,d),o=JSON.parse(row.payload),p=await holdings(conn.credentials),current=Number(p.find(x=>x.symbol===o.symbol)?.quantity||0),filled=Number(receipt.executed_quantity);
 const ledger=await rows(db,'SELECT * FROM lb_orders WHERE connection_tag=? AND created_at>=? ORDER BY created_at',conn.tag,row.created_at);
 const same=ledger.filter(x=>JSON.parse(x.payload).symbol===o.symbol),unverified=same.filter(x=>x.client_id!==id&&!x.broker_data&&x.status!=='rejected');
 const change=same.reduce((n,x)=>{const b=x.client_id===id?receipt:x.broker_data?JSON.parse(x.broker_data):null;return n+(b?(b.side==='Buy'?1:-1)*Number(b.executed_quantity):0);},0),expected=row.initial_qty+change;
 let executions=[],execution_error=null;try{const e=await tradeRequest(conn.credentials,'GET','/v1/trade/execution/today',{order_id:receipt.order_id});requireValue(Array.isArray(e.trades),'成交返回格式异常',502);executions=e.trades.filter(x=>x.order_id===receipt.order_id).map(x=>pick(x,['trade_id','order_id','symbol','price','quantity','trade_done_at']));}catch(e){execution_error=safeError(e);}
 const quantity=executions.reduce((n,x)=>n+Number(x.quantity),0),checks={broker_order:true,filled:filled>0,execution_details:filled>0&&quantity===filled,position_matches:unverified.length===0&&Number.isFinite(current)&&Math.abs(expected-current)<1e-8,cancelled:['CanceledStatus','PartialWithdrawal'].includes(receipt.status)};
 return {ok:true,order:publicOrder(await first(db,'SELECT * FROM lb_orders WHERE client_id=?',id)),receipt,executions,execution_error,checks,position:{before:row.initial_qty,current,expected},message:'成交明细接口仅含当日记录；历史订单以订单详情累计成交核对。外部交易可能造成持仓差异。'};
}
export async function inspectHK(env,db,id){return lock(db,()=>inspectLocked(env,db,id));}
export async function cancelHK(env,db,user,input){requireValue(input.confirm===true,'请确认撤单');return lock(db,async()=>{
 const conn=await connection(env,db),row=await first(db,'SELECT * FROM lb_orders WHERE client_id=?',input.client_id);requireValue(row&&row.connection_tag===conn.tag&&row.broker_id,'未找到当前账户可撤销的平台委托，请先核对',409);
 const d=await tradeRequest(conn.credentials,'GET','/v1/trade/order',{order_id:row.broker_id});await updateReceipt(db,row,d);
 if(done.has(d.status))return {ok:true,message:'订单已结束；已成交部分无法撤回',receipt:clean(d)};
 await audit(db,user.id,'lb_cancel_intent',row.client_id,{broker_id:row.broker_id});
 try{await tradeRequest(conn.credentials,'DELETE','/v1/trade/order',{order_id:row.broker_id});await run(db,"UPDATE lb_orders SET status='cancel_pending',updated_at=? WHERE client_id=?",nowISO(),row.client_id);}
 catch(e){await run(db,"UPDATE lb_orders SET status='cancel_unknown',error=?,updated_at=? WHERE client_id=?",safeError(e),nowISO(),row.client_id);return {ok:false,message:'撤单结果未知，请点击核对；不要认为已撤销'};}
 return {ok:true,message:'撤单申请已提交，尚不代表撤单成功。请点击核对查看最终回报。'};
 });}
export async function recoverHK(env,db,user){const c=await control(db);requireValue(c.lease_id&&Date.now()>c.lease_until+180000,'执行通道尚未超时，不能恢复',409);await run(db,"UPDATE lb_auto SET enabled=0,reason='执行中断后已暂停',updated_at=? WHERE id=1",nowISO());await run(db,'UPDATE lb_control SET enabled=0,lease_id=NULL,lease_until=0 WHERE id=1 AND lease_id=?',c.lease_id);await audit(db,user.id,'lb_recover',null,{});return tradingState(env,db);}
export async function startHKAuto(env,db,user,input){
 requireValue(input.confirm==='启动长桥自动模拟交易','请输入“启动长桥自动模拟交易”');
 const o=normalizeHK({...input,side:'Buy'}),budget=numeric(input.budget,'总预算',o.price*o.quantity,100000000),interval=numeric(input.interval_minutes,'间隔分钟',5,10080);
 requireValue(Number.isInteger(interval),'间隔必须是整数分钟');
 requireValue(env.SCHEDULER_NATIVE==='true'||env.SCHEDULER_REPOSITORY_ID,'后台调度尚未配置，不能启动无人值守策略',503,'LB_NO_SCHEDULER');
 return lock(db,async()=>{const old=await first(db,'SELECT * FROM lb_auto WHERE id=1');requireValue(!old.enabled,'请先暂停已有策略');await validateRisk(env,db,o,null);const conn=await connection(env,db);const p=await holdings(conn.credentials);requireValue(!p.some(x=>x.symbol===o.symbol&&Number(x.quantity)!==0),'新策略需从该标的空仓开始',409);
 const config={...o,budget,interval_minutes:interval,connection_tag:conn.tag},id=crypto.randomUUID();await run(db,"UPDATE lb_auto SET enabled=1,run_id=?,config=?,sequence=0,next_at=?,last_at=NULL,outcome=NULL,reason='等待后台调度',updated_at=? WHERE id=1",id,JSON.stringify(config),Date.now(),nowISO());await audit(db,user.id,'lb_auto_started',id,{...config,connection_tag:undefined});return tradingState(env,db);});
}
export async function pauseHKAuto(env,db,user){await init(db);await run(db,"UPDATE lb_auto SET enabled=0,reason='操作员暂停；已有委托需单独撤销',updated_at=? WHERE id=1",nowISO());await audit(db,user.id,'lb_auto_paused',null,{});return tradingState(env,db);}
async function outcome(db,name,reason){await run(db,'UPDATE lb_auto SET last_at=?,outcome=?,reason=?,updated_at=? WHERE id=1',nowISO(),name,reason,nowISO());return {ok:name!=='fault',outcome:name,message:reason};}
export async function tickHK(env,db,source='manual'){
 await init(db);if(source!=='manual')await run(db,'UPDATE lb_auto SET heartbeat_at=? WHERE id=1',nowISO());
 let a=await first(db,'SELECT * FROM lb_auto WHERE id=1');if(!a.enabled)return {ok:true,outcome:'paused'};
 try{return await lock(db,async()=>{
 a=await first(db,'SELECT * FROM lb_auto WHERE id=1');if(!a.enabled)return {ok:true,outcome:'paused'};
 const c=JSON.parse(a.config),ctx=await authorized(env,db);requireValue(c.connection_tag===ctx.tag,'连接已更换，策略停止',409);
 const own=await rows(db,'SELECT * FROM lb_orders WHERE run_id=? ORDER BY created_at',a.run_id);
 for(const o of own.filter(o=>!done.has(o.status)).slice(0,10))await inspectLocked(env,db,o.client_id);
 const fresh=await rows(db,'SELECT * FROM lb_orders WHERE run_id=? ORDER BY created_at',a.run_id);
 requireValue(!fresh.some(x=>['unknown','submitting','cancel_unknown'].includes(x.status)),'订单结果未知，策略停止',409);
 if(fresh.some(x=>!done.has(x.status)))return outcome(db,'pending','等待已有委托结束，本轮不新增订单');
 const owned=fresh.reduce((n,x)=>n+(x.broker_data?Number(JSON.parse(x.broker_data).executed_quantity):0),0),p=await holdings(ctx.credentials),current=Number(p.find(x=>x.symbol===c.symbol)?.quantity||0);requireValue(current===owned,'持仓与策略成交不一致，请人工核对',409,'LB_POSITION_DRIFT');
 if(!hkWindow())return outcome(db,'market_closed','港股常规时段外，等待下一轮；交易所假期以券商接受情况为准');
 if(Date.now()<a.next_at)return outcome(db,'waiting','尚未到达下一次定投时间');
 const reserved=fresh.reduce((n,x)=>n+x.notional,0);if(reserved+c.price*c.quantity>c.budget){await run(db,'UPDATE lb_auto SET enabled=0 WHERE id=1');return outcome(db,'completed','总预算已用尽，策略自动结束；撤单不返还本轮预算');}
 const id='lba_'+a.run_id.replaceAll('-','')+'_'+a.sequence;
 const result=await submitLocked(env,db,{id:'lb-auto:'+a.run_id},{...c,client_id:id,confirm:true},a.run_id);
 requireValue(result.ok,'委托未确认接收，策略暂停，请核对',409);
 await run(db,'UPDATE lb_auto SET sequence=sequence+1,next_at=? WHERE id=1 AND run_id=?',Date.now()+c.interval_minutes*60000,a.run_id);
 await audit(db,'lb-auto:'+a.run_id,'lb_auto_cycle',id,{source,notional:c.price*c.quantity});return outcome(db,'submitted','已提交限价委托，等待券商成交；关闭网页不影响后台调度');
 });}catch(e){if(e.code==='LB_BUSY')return {ok:true,outcome:'busy',message:e.message};await run(db,'UPDATE lb_auto SET enabled=0 WHERE id=1');return outcome(db,'fault',safeError(e));}
}
export async function changeHKConnection(db,fn){return lock(db,async()=>{
 const active=await rows(db,"SELECT status FROM lb_orders WHERE status NOT IN ('FilledStatus','CanceledStatus','RejectedStatus','ExpiredStatus','PartialWithdrawal','rejected') LIMIT 1");
 requireValue(!active.length,'仍有未完成或未知的长桥委托，请核对并处理后再更换连接',409,'LB_PENDING');
 const a=await first(db,'SELECT enabled FROM lb_auto WHERE id=1');requireValue(!a.enabled,'请先暂停长桥自动策略',409);
 const result=await fn();await run(db,'UPDATE lb_control SET enabled=0,connection_tag=NULL,updated_at=? WHERE id=1',nowISO());return result;
});}
export async function resumeHKAuto(env,db,user,input){
 requireValue(input.confirm==='启动长桥自动模拟交易','请确认恢复长桥自动模拟交易');
 return lock(db,async()=>{const a=await first(db,'SELECT * FROM lb_auto WHERE id=1');requireValue(a.run_id&&a.config&&!a.enabled,'没有可恢复的已暂停策略',409);const ctx=await authorized(env,db),c=JSON.parse(a.config);requireValue(c.connection_tag===ctx.tag,'连接已变化，不能恢复旧策略',409);
 const ledger=await rows(db,'SELECT * FROM lb_orders WHERE run_id=? ORDER BY created_at',a.run_id);
 for(const o of ledger.filter(o=>!done.has(o.status)).slice(0,10))await inspectLocked(env,db,o.client_id);
 requireValue(!(await first(db,"SELECT client_id FROM lb_orders WHERE connection_tag=? AND status IN ('unknown','submitting','cancel_unknown') LIMIT 1",ctx.tag)),'存在未决委托，请先核对',409);
 const updated=await rows(db,'SELECT * FROM lb_orders WHERE run_id=?',a.run_id),owned=updated.reduce((n,o)=>n+(o.broker_data?Number(JSON.parse(o.broker_data).executed_quantity):0),0),p=await holdings(ctx.credentials);requireValue(Number(p.find(x=>x.symbol===c.symbol)?.quantity||0)===owned,'持仓与策略成交不一致，不能恢复',409);
 await run(db,"UPDATE lb_auto SET enabled=1,reason='恢复原策略，保留累计预算与执行序号',updated_at=? WHERE id=1",nowISO());await audit(db,user.id,'lb_auto_resumed',a.run_id,{});return tradingState(env,db);
 });
}
