import stockNames from './stock-names.json';
import {runReason} from './run-labels.mjs';
const labels={running:'运行中',paused:'已暂停',exiting:'正在平仓退出',ended:'已结束',ended_kept:'已结束 · 保留股票',legacy:'旧记录 · 结束状态待核实'};
const statuses={filled:'全部成交',FilledStatus:'全部成交',partially_filled:'部分成交',PartialFilledStatus:'部分成交',canceled:'已撤销',CanceledStatus:'已撤销',rejected:'已拒绝',RejectedStatus:'已拒绝',new:'已接收',NewStatus:'已接收',queued:'待提交',unknown:'回报待核实',pending_new:'待接收',submitting:'提交中',ExpiredStatus:'已过期',expired:'已过期',PartialWithdrawal:'部分成交后撤单'};
export function createRunHistoryUI(root,api,access,chart){
 const el=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
 const when=v=>v?new Date(v).toLocaleString('zh-CN'):'未记录';
 const num=(v,s='')=>v==null||!Number.isFinite(Number(v))?'未能核实':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2})+s;
 const name=s=>(stockNames.names[s]||'名称暂缺')+'（'+s+'）';
 const table=(headers,rows)=>{const t=document.createElement('table'),h=t.createTHead().insertRow(),body=t.createTBody();for(const x of headers)h.append(el('th',x));for(const values of rows){const tr=body.insertRow();for(const v of values){const td=el('td','');if(v instanceof Node)td.append(v);else td.textContent=String(v??'—');tr.append(td);}}const wrap=el('div','','table-scroll');wrap.append(t);return wrap;};
 root.innerHTML='<div class="panel-head"><h2>组合策略运行记录</h2><button id="history-refresh">刷新记录</button></div><p>每次启动是一份独立记录。已结束的策略仍可查看当时选股、模拟委托及成交结果。进阶单标的与港股定投的检查记录，可在上方对应任务详情中查看。</p><div class="run-history-toolbar"><label>市场<select id="history-market"><option value="">全部市场</option><option value="CN">A 股</option><option value="HK">港股</option><option value="US">美股</option></select></label><button id="history-prev">上一页</button><button id="history-next">下一页</button><span id="history-page"></span></div><div id="history-list"></div><article id="history-detail" class="run-history-detail"></article>';
 const $=id=>root.querySelector('#'+id);let offset=0,listVersion=0,detailVersion=0,selected=null;
 function clear(){listVersion++;detailVersion++;selected=null;$('history-list').replaceChildren(el('p','请登录后查看运行记录。','notice'));$('history-detail').replaceChildren();}
 async function detail(id,scroll=false){
  if(!access()){clear();return;}selected=id;const version=++detailVersion,target=$('history-detail');target.replaceChildren(el('p','正在读取这次运行的选股和成交…'));
  try{const d=await api('portfolio/history/detail?id='+encodeURIComponent(id));if(version!==detailVersion||!access())return;const r=d.run,m=d.metrics;target.replaceChildren(el('h2',r.name+' · '+(labels[r.status]||r.status)),el('p',`运行编号 ${r.run_id}`,'caption'),el('p',`开始 ${when(r.started_at)}${r.start_time_exact?'':'（最早可追溯时间）'} · 结束 ${when(r.ended_at)} · 预算 ${num(r.budget)} ${r.currency||''}`));
   if(r.reason)target.append(el('p',runReason(r.reason),'notice'));
   for(const note of d.notes)target.append(el('p',note,'caption'));
   if(d.truncated)target.append(el('p','这份长期运行的部分明细超出本页上限；下方数据不是完整导出。','notice'));
   target.append(el('h3','本次模拟运行收益（不是历史回测收益）'));
   if(d.order_error)target.append(el('p',d.order_error,'notice error'));
   if(m){target.append(table(['已实现盈亏','持仓浮动盈亏','合计盈亏','相对策略预算'],[[num(m.realized),num(m.unrealized),num(m.total),num(m.return_pct,'%')]]),el('p',`${r.currency||''} · ${m.fee_note}。按委托累计成交均价进行移动平均成本估算。`,'caption'));if(!m.complete)target.append(el('p',m.errors.join('；'),'notice error'));}
   else target.append(el('p','缺少足够的成交或结束估值记录，暂不能计算收益。','notice'));
   if(m?.positions?.length){target.append(el('h3',r.status==='ended_kept'?'结束时转为手动管理的股票':'本策略持仓'),table(['股票','数量','平均买入成本','有效估值价','浮动盈亏'],m.positions.map(p=>[name(p.symbol),num(p.qty),num(p.average_cost),num(p.price),num(p.unrealized)])));}
   const marks=d.marks||[];target.append(el('h3','上线后记录的策略盈亏曲线'));const graph=el('div','','chart');graph.id='run-history-chart';target.append(graph);
   if(marks.length>1)chart(graph.id,marks.map(p=>({t:p.at,equity:p.total})),[{key:'equity',color:'#527347',name:'策略未扣费盈亏'}]);else graph.append(el('p','尚无足够的监控估值点；不会根据历史回测拼接本次运行曲线。','caption'));
   const sig=r.initial_signal;target.append(el('h3','启动时的选股目标'));
   if(sig?.targets)target.append(el('p',`信号日期 ${sig.signal_date||'未记录'}；下表是目标，不代表全部实际买入。`),table(['股票','目标资金比例'],sig.targets.map(t=>[name(t.symbol),num(t.weight*100,'%')])));else target.append(el('p','旧记录未保存启动时的选股快照。'));
   target.append(el('h3','实际委托与成交'),el('p','委托接收不等于成交。成交时间缺失时，明确显示回报更新时间。','caption'));
   if(d.orders.length)target.append(table(['股票','方向','下单时间','成交时间 / 回报更新时间','委托 / 成交数量','成交均价','状态'],d.orders.map(o=>[name(o.symbol),o.side==='buy'?'买入':'卖出',when(o.submitted_at),o.filled_at?when(o.filled_at):'回报更新 '+when(o.updated_at),num(o.qty)+' / '+num(o.filled),Number(o.filled)>0?num(o.price):'尚未成交',statuses[o.status]||o.status||'旧回报（状态未记录）'])));else target.append(el('p',d.order_error?'回报暂不可用':'尚无本策略委托；可能仍在等待开市、行情或执行条件。'));
   target.append(el('h3','每次调仓决策'));
   for(const decision of d.decisions){target.append(el('h4',when(decision.at)+' · '+(decision.phase==='sell_sent'?'卖出阶段':decision.phase==='buy'?'买入阶段':'卖出计划')));const ts=decision.signal?.targets||[];target.append(el('p',ts.length?'本轮目标：'+ts.map(t=>name(t.symbol)+' '+num(t.weight*100,'%')).join('、'):'本轮目标：持有现金 / 平仓'));if(decision.orders?.length)target.append(table(['股票','计划方向','计划数量','委托限价'],decision.orders.map(o=>[name(o.symbol),o.side==='buy'?'买入':'卖出',num(o.qty),num(o.price)])));else target.append(el('p','本轮没有需要提交的委托。'));}
   if(!d.decisions.length)target.append(el('p','未形成调仓决策记录。'));
   target.append(el('h3','运行事件'));
   const eventNames={portfolio_started:'启动',portfolio_paused:'暂停',portfolio_resumed:'恢复',portfolio_released:'结束并释放',portfolio_liquidation_requested:'授权平仓',portfolio_cycle:'执行检查',lb_submit_intent:'准备提交港股委托',lb_submitted:'港股券商已接收委托'};
   target.append(table(['时间','事件','说明'],d.events.map(e=>[when(e.timestamp),eventNames[e.kind]||e.kind,e.details.reason||e.details.message||(e.kind==='portfolio_cycle'?'本轮 '+(e.details.orders??0)+' 笔委托意图':e.kind==='portfolio_released'?(Object.keys(e.details.kept_positions||{}).length?'股票转为手动管理':'已结束'):'已记录')])));
   if(scroll)target.scrollIntoView({block:'start',behavior:'smooth'});
  }catch(e){if(version===detailVersion&&access())target.replaceChildren(el('p',e.message,'notice error'));}
 }
 async function load(){if(!access()){clear();return;}const version=++listVersion;try{const d=await api('portfolio/history?offset='+offset+'&market='+$('history-market').value);if(version!==listVersion||!access())return;$('history-prev').disabled=offset===0;$('history-next').disabled=offset+d.runs.length>=d.total;$('history-page').textContent=`共 ${d.total} 次运行 · 第 ${Math.floor(offset/20)+1} 页`;
  $('history-list').replaceChildren(d.runs.length?table(['策略 / 市场','开始时间','预算','状态','详情'],d.runs.map(r=>{const b=el('button','查看选股、成交与收益');b.onclick=()=>detail(r.run_id,true);return [r.name+' · '+({CN:'A 股',HK:'港股',US:'美股'}[r.market]||'待核实'),when(r.started_at),num(r.budget)+' '+(r.currency||''),labels[r.status],b];})):el('p','该范围内尚无可追溯运行记录。'));
  if(d.runs.length)await detail(d.runs.some(r=>r.run_id===selected)?selected:d.runs[0].run_id);else{detailVersion++;$('history-detail').replaceChildren();}
 }catch(e){if(version===listVersion&&access())$('history-list').replaceChildren(el('p',e.message,'notice error'));}}
 $('history-refresh').onclick=load;$('history-market').onchange=()=>{offset=0;load();};$('history-prev').onclick=()=>{offset=Math.max(0,offset-20);load();};$('history-next').onclick=()=>{offset+=20;load();};return {load,clear};
}
