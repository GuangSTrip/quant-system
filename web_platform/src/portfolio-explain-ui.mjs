import stockNames from './stock-names.json';
import {budgetPreview} from './portfolio-explain.mjs';
export function createExplanationUI(root,api,access,budget,onReadiness=()=>{},launch=root,rulesRoot=root){
 let info=null,version=0;
 const el=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
 const money=v=>Number(v).toLocaleString('zh-CN',{style:'currency',currency:info?.currency||'USD'});
 const percent=v=>(v*100).toFixed(2)+'%';
 const stamp=v=>new Date(v).toLocaleString('zh-CN',{hour12:false});
 const rules=document.createElement('div'),signal=document.createElement('div'),preview=document.createElement('div'),feedback=el('p','');
 const refresh=el('button','读取账户，更新股数预览');refresh.type='button';
 const budgetRow=document.createElement('div');budgetRow.className='form-row';budgetRow.append(budget.closest('label'),refresh);
 const rulesHeading=el('h3','这套策略怎么买卖');rulesHeading.className='daily-strategy-rules';rules.className='daily-strategy-rules';rulesRoot.append(rulesHeading,rules);
 const planHeading=el('h2','① 模拟计划 · 等待信号');
 root.append(planHeading,el('p','这是策略按最新数据选出的目标股票。沿用同一套规则，历史回测与后续模拟交易才有可比性；股票由策略决定，不必自行挑选。'),signal);
 const planning=document.createElement('div');planning.append(budgetRow,feedback,preview);
 launch.querySelector('h2').after(planning);
 function render(result){
  onReadiness((result.blockers.length?'当前需注意：'+result.blockers.join('；'):'已取得账户与报价预览。')+' 启动时仍会校验持仓、委托和交易限额。');
  preview.replaceChildren();
  if(!info?.signal){preview.append(el('p','没有可展示的最新目标，不使用历史选股名单代替。'));return;}
  const table=document.createElement('table'),head=table.createTHead().insertRow();
  for(const t of ['股票代码','股票名称','目标比例','目标金额','本策略股数','参考价格','目标股数','预计操作'])head.append(el('th',t));
  const body=table.createTBody();
  for(const r of result.rows){const tr=body.insertRow();for(const v of [r.symbol,stockNames.names[r.symbol]||'名称暂缺',percent(r.weight),money(r.amount),r.held??'待读取',r.price===null?'待有效报价':money(r.price),r.target_qty??'待报价',r.action+(r.delta?` ${Math.abs(r.delta)} 股`:'')])tr.append(el('td',String(v)));}
  const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);preview.append(wrap);
  if(!result.rows.length)preview.append(el('p','本信号没有目标股票：保持现金；若本策略已有持仓，读取账户后查看预计卖出项；原有股票不参与。'));
  if(result.protected_positions?.some(p=>p.qty>0))preview.append(el('p','原有持仓（不参与本策略买卖）：'+result.protected_positions.filter(p=>p.qty>0).map(p=>(stockNames.names[p.symbol]||p.symbol)+' '+p.qty+' 股').join('、')));
  preview.append(el('p','目标保留现金：'+money(result.cash_amount)+'。未满足买入条件、整手取整和费用会影响最终剩余现金。'));
  for(const text of result.blockers){const p=el('p',text);p.className='notice';preview.append(p);}preview.append(el('p',result.note||''));
 }
 function local(){if(!info)return;version++;const n=Number(budget.value);if(!Number.isFinite(n)||n<100){preview.replaceChildren();feedback.textContent='请输入至少 100 的有效模拟预算。';onReadiness(feedback.textContent);return;}render(budgetPreview(info.signal,n));feedback.textContent='修改预算只更新预览，不会启动交易。';}
 budget.addEventListener('input',local);
 async function readAccount(){
  if(!info)return;if(!access()){feedback.textContent='请先登录；不登录也能查看股票目标与金额。';return;}
  const n=Number(budget.value);if(!Number.isFinite(n)||n<100){feedback.textContent='请输入至少 100 的有效模拟预算。';onReadiness(feedback.textContent);return;}
  const token=++version,id=info.strategy_id;refresh.disabled=true;feedback.textContent='正在只读查询账户和报价，不会下单…';
  try{const r=await api('portfolio/preview?id='+encodeURIComponent(id)+'&budget='+n);if(token!==version||!access())return;render(r);feedback.textContent='预览更新时间：'+stamp(r.fetched_at)+' · 数量仅供估算，尚未下单。';}catch(e){if(token===version)feedback.textContent=e.message;}finally{refresh.disabled=false;}
 }
 refresh.onclick=readAccount;
 return {clearAccount(){if(info)local();},async load(id){
  const token=++version;info=null;onReadiness('正在读取所选策略的最新信号和账户条件…');rules.replaceChildren();signal.replaceChildren(el('p','读取最新信号…'));preview.replaceChildren();feedback.textContent='';
  try{const data=await api('portfolio/explanation?id='+encodeURIComponent(id));if(token!==version)return;info=data;
   for(const [key,title]of [['selection','选什么股票'],['timing','何时买入 / 卖出'],['allocation','每只分多少钱'],['risk','额外仓位控制'],['cadence','什么时候更新']]){const p=el('p','');p.append(el('strong',title+'：'),el('span',data.rules[key]));rules.append(p);}
   signal.replaceChildren();
   if(data.signal){const s=data.signal;planHeading.textContent=Date.now()>=Date.parse(s.expires_at)?'① 历史计划已过期 · '+s.signal_date:'① 模拟计划 · 依据 '+s.signal_date+' 收盘数据';signal.append(el('p',`信号日期 ${s.signal_date} · 目标最近调整 ${s.rebalance_date} · 可执行窗口 ${stamp(s.execute_after)} 至 ${stamp(s.expires_at)}`));signal.append(el('p',`当前信号股票池共 ${data.universe.length} 只，目标持有 ${s.targets.length} 只；并非全市场扫描。以下是策略目标，不是已经成交的持仓。`));if(Date.now()>=Date.parse(s.expires_at))signal.append(el('p','此信号已过期，以下仅作展示；后台更新后才会用于模拟交易。'));const table=document.createElement('table'),head=table.createTHead().insertRow();for(const title of ['股票代码','股票名称','目标资金比例'])head.append(el('th',title));for(const t of s.targets){const row=table.createTBody().insertRow();for(const value of [t.symbol,stockNames.names[t.symbol]||'名称暂缺',percent(t.weight)])row.append(el('td',value));}const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);signal.append(wrap,el('p',s.targets.length?'另保留 '+percent(s.cash_weight)+' 现金；下一步按预算计算股数。':'当前没有股票满足条件，策略选择持有现金。'));signal.append(el('p','策略从这些股票中筛选：'+data.universe.map(s=>(stockNames.names[s]||'名称暂缺')+'（'+s+'）').join('、')));}
   else {planHeading.textContent='① 模拟计划 · 尚无信号';signal.append(el('p','后台尚未生成此策略的最新信号，请等待数据更新。'));}
   render(budgetPreview(data.signal,Number(budget.value)));if(access())await readAccount();
  }catch(e){if(token===version){signal.replaceChildren(el('p','最新选股读取失败：'+e.message));onReadiness('暂时不能确认启动条件：'+e.message);}}
 }};
}
