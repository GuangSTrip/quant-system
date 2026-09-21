import {runLabel,runReason} from './run-labels.mjs';
// Read-only aggregation: opening the workspace never starts or cancels a trade.
export function createWorkspaceUI(api,access,go){
 const $=id=>document.getElementById(id);
 const names={CN:'A 股',US:'美股',HK:'港股'},routes={CN:'cn-trade',US:'trade',HK:'longbridge'};
 let generation=0;
 const el=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
 const money=(v,c)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v).toLocaleString('zh-CN',{style:'currency',currency:c}):'暂不可用';
 const when=v=>v?new Date(v).toLocaleString('zh-CN'):'尚无记录';
 function link(label,view,selection,focus){const b=el('button',label);b.onclick=()=>focus?go(view,selection,focus):go(view,selection);return b;}
 function row(parent,label,value){const r=el('div','');r.append(el('span',label),el('strong',value));parent.append(r);}
 function clear(){generation++;for(const id of ['workspace-accounts','workspace-runs'])$(id).replaceChildren(el('p','请先登录，再查看三个共享模拟账户和策略运行状态。','notice'));}
 async function load(view){
  if(!access()){clear();return;}
  const token=++generation,root=$(view==='overview'?'workspace-accounts':'workspace-runs');
  root.replaceChildren(el('p','正在分别读取各市场，单个平台故障不会阻止其他结果显示…','caption'));
  const paths=view==='overview'?['overview','cn/status','longbridge/overview']:['portfolio','automation','longbridge/trading','portfolio/catalog'];
  const results=await Promise.allSettled(paths.map(p=>api(p)));
  if(token!==generation||!access())return;
  const value=i=>results[i].status==='fulfilled'?results[i].value:null;
  root.replaceChildren();
  if(view==='overview'){
   for(const [market,index,currency]of [['CN',1,'CNY'],['US',0,'USD'],['HK',2,'HKD']]){
    const d=value(index),card=el('article','', 'panel account-card');card.append(el('h2',names[market]+' · '+currency));
    if(!d){card.append(el('p',results[index].reason.message,'notice error'));}
    else{
     const account=market==='CN'?d.account?.cash:market==='US'?d.account:d.account?.find(a=>a.currency===currency);
     const issues=Object.values(d.errors||{}).filter(Boolean);
     card.append(el('p',!account?'账户暂不可用':issues.length?'部分信息未读取':'已读取账户',account&&!issues.length?'badge good':'badge'));
     const list=el('div','','detail-list');
     row(list,'账户资产',money(market==='CN'?(account?.nav??account?.total_asset??account?.equity):market==='US'?account?.equity:account?.net_assets,currency));
     row(list,'现金 / 可用资金',money(market==='CN'?(account?.available??account?.available_cash??account?.cash):market==='US'?account?.cash:account?.total_cash,currency));
     row(list,'持仓种类',Array.isArray(d.positions)?String(d.positions.length):'暂不可用');
     row(list,'查询时间',when(d.fetched_at||new Date().toISOString()));card.append(list);
     if(d.stale)card.append(el('p','本次刷新未完成，显示上次成功结果：'+d.refresh_error,'notice'));
     if(issues.length)card.append(el('p',issues.join('；'),'notice error'));
    }
    card.append(link('查看持仓与订单 →',routes[market],null,'orders'));root.append(card);
   }
  }else{
   const portfolio=value(0),catalog=value(3)?.strategies||[];
   const add=(market,title,enabled,reason,budget,currency,time,target,extra='',selection,run=null)=>{
    const card=el('article','','panel run-card');card.append(el('span',names[market], 'badge'),el('h2',title),el('p',run?runLabel(run):'当前无运行',enabled?'badge good':'badge'));
    const list=el('div','','detail-list');row(list,'当前说明',run?.run_id?runReason(reason):'选择策略并确认后才会运行');row(list,'策略预算',run?.run_id?money(budget,currency):'尚未设置');row(list,'最近检查 / 更新',when(time));card.append(list);
    if(extra)card.append(el('p',extra,'caption'));card.append(link('查看详情 / 管理 →',target,selection),link('查看券商订单',routes[market],null,'orders'));root.append(card);
   };
   if(portfolio)for(const market of ['CN','US','HK']){
    const r=portfolio.runs.find(r=>r.market===market),name=catalog.find(e=>e.id===r?.strategy_id)?.name;
    add(market,r?(name||r.strategy_id):'组合策略 · 当前无运行',!!r?.enabled,r?.reason,r?.budget,{CN:'CNY',US:'USD',HK:'HKD'}[market],r?.updated_at,'portfolio',r?'暂停只停止自动执行；进入详情可卖出策略股票，或结束策略并保留股票。':'这不代表没有执行过策略；下方保留历史运行记录。可到“选策略”开始新模拟。',r?.strategy_id||catalog.find(e=>e.market===market&&e.recommended)?.id||catalog.find(e=>e.market===market)?.id,r);
   }else root.append(el('p','组合策略状态读取失败：'+results[0].reason.message,'notice error'));
   const us=value(1),hk=value(2);
   if(us)add('US',us.state.config?.name||'单标的策略（进阶）',!!us.state.enabled,us.state.reason,us.state.budget,'USD',us.state.last_check_at,us.state.config?.type==='enhanced_reversion'?'portfolio':'automation','后台心跳：'+when(us.state.heartbeat_at),us.state.config?.type==='enhanced_reversion'?'US:own-enhanced':undefined,us.state);
   else root.append(el('p','美股单标的状态读取失败：'+results[1].reason.message,'notice error'));
   if(hk)add('HK','定期买入（进阶）',!!hk.automation.enabled,hk.automation.reason,hk.automation.config?.budget,'HKD',hk.automation.last_at,'longbridge','后台心跳：'+when(hk.automation.heartbeat_at),undefined,hk.automation);
   else root.append(el('p','港股定投状态读取失败：'+results[2].reason.message,'notice error'));
  }
 }
 for(const [id,view]of [['workspace-refresh','overview'],['runs-refresh','runs']])$(id).onclick=()=>load(view);
 return {load,clear};
}
