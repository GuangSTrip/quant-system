import {createStrategyLab} from './strategy-lab.mjs';
import {createDailyWorkbench} from './daily-workbench.mjs';
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dailyWorkbench=createDailyWorkbench($('daily-workbench'),chart);
  const state = {session:null,overview:null,quote:null,report:null,plan:null,audit:[],orders:[],pending:null,confirmation:null,refreshing:false,riskDirty:false,chartMode:'equity',acceptance:null,checkingAcceptance:false};
  const names = {showcase:'成果演示',library:'分钟旧研究',daily:'日线策略研究',overview:'账户总览',strategy:'策略讲解',research:'策略与回测',trade:'模拟交易',risk:'风控与对账',audit:'操作审计',acceptance:'交付验收',automation:'自动策略'};
  const statusNames = {new:'券商已接收',accepted:'已接收待处理',pending_new:'待接收',partially_filled:'部分成交',filled:'全部成交',done_for_day:'当日结束',canceled:'已撤销',expired:'已过期',rejected:'已拒绝',pending_cancel:'撤单待确认',pending_replace:'修改待确认',replaced:'已替换',stopped:'已停止',suspended:'已挂起',calculated:'结算处理中',submitting:'提交待确认',unknown:'状态未知'};
  const terminal = ['filled','canceled','expired','rejected','replaced'];
  const types = {limit:'限价',market:'市价',stop:'止损市价',stop_limit:'止损限价'};
  const symbolNames={SPY:'标普 500 ETF',QQQ:'纳斯达克 100 ETF',IWM:'美国小盘股 ETF',EFA:'发达市场 ETF',EEM:'新兴市场 ETF',TLT:'长期美债 ETF',IEF:'中期美债 ETF',GLD:'黄金 ETF',DBC:'商品 ETF',SHY:'短期美债 ETF',AAPL:'苹果公司',MSFT:'微软公司'};
  const minuteSymbols=new Set(['SPY','QQQ','AAPL','MSFT']);
  const money = v => v!==null&&v!==undefined&&Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}) : '—';
  const num = (v,d=2) => v!==null&&v!==undefined&&Number.isFinite(Number(v)) ? Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d}) : '—';
  const pct = v => v!==null&&v!==undefined&&Number.isFinite(Number(v)) ? (Number(v)*100).toFixed(2)+'%' : '—';
  const date = v => v&&Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-CN',{hour12:false,timeZoneName:'short'}) : '—';
  function node(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;}
  function text(id,value){$(id).textContent=value;}
  function message(id,value,error=false){const e=$(id);e.textContent=value;e.hidden=!value;e.classList.toggle('error',error);}
  function emptyTable(id,cols,label){const tr=node('tr'),td=node('td','empty',label);td.colSpan=cols;tr.append(td);$(id).replaceChildren(tr);}
  function details(rows){const e=node('div','detail-list');rows.forEach(([k,v])=>{const r=node('div');r.append(node('span','',k),node('strong','',v));e.append(r);});return e;}
  function toast(value){text('toast',value);$('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('show'),6000);}
  function syncAccess(){document.querySelectorAll('[data-operator]').forEach(e=>{e.disabled=!state.session?.operator||e.dataset.busy==='1'||e.dataset.unavailable==='1';});}
  async function busy(button,fn){if(button?.dataset.busy==='1')return;if(button){button.dataset.busy='1';button.disabled=true;}try{return await fn();}finally{if(button){delete button.dataset.busy;button.disabled=button.hasAttribute('data-operator')?!state.session?.operator||button.dataset.unavailable==='1':false;}}}
  async function api(path,payload){
    let response;try{response=await fetch('/api/v1/'+path,{method:payload===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:payload===undefined?{}:{'content-type':'application/json','x-quant-action':'1'},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(payload===undefined?20000:120000)});}catch{throw new Error(payload===undefined?'连接中断，请稍后刷新。':'请求结果尚未确认。请查询同一笔订单或执行对账，不要重复创建新订单。');}
    let data;try{data=await response.json();}catch{throw new Error('服务器返回了无法识别的结果，请刷新后查看订单状态。');}
    if(!response.ok){if(response.status===401&&path!=='session'&&path!=='auth/login')await loadSession();const e=new Error(data.error||'请求失败');e.code=data.code;throw e;}return data;
  }
  function showView(view){
    if(view==='automation')loadAutomation();
    if(!names[view])view='showcase';
    document.body.dataset.currentView=view;
    document.querySelectorAll('.view').forEach(e=>{e.hidden=e.id!=='view-'+view;});
    document.querySelectorAll('[data-view]').forEach(e=>{e.classList.toggle('active',e.dataset.view===view);e.setAttribute('aria-current',e.dataset.view===view?'page':'false');});
    text('view-title',names[view]);if(location.hash!=='#'+view)history.replaceState(null,'','#'+view);
    if(view==='audit'&&state.session?.operator)loadAudit();
    if(view==='acceptance')loadAcceptanceHistory();
    if(view==='showcase'&&state.session)loadShowcase();
    if(view==='library')loadLibrary();
    if(view==='daily'){dailyWorkbench.load();loadCurrentDailyPlan();}
  }
  async function loadSession(){
    try{state.session=await api('session');text('identity-label',state.session.operator?state.session.username+' · 操作员已登录':'公开访客 · 查看权限');$('sign-in').hidden=state.session.signed_in;$('sign-out').hidden=!state.session.signed_in;$('operator-notice').hidden=state.session.operator;}
    catch(e){state.session=null;text('identity-label','身份服务暂不可用');message('global-error',e.message,true);$('operator-notice').hidden=false;}
    syncAccess();
  }
  function chart(id,points,series,format=money,markers=[]){
    const box=$(id);box.replaceChildren();const valid=points.filter(p=>series.some(s=>Number.isFinite(p[s.key])));
    if(!valid.length){box.append(node('p','caption','当前区间暂无可绘制数据。'));return;}
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),W=900,H=260,left=83,right=18,top=17,bottom=39;
    const make=(tag,attrs,textValue)=>{const e=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs||{}))e.setAttribute(k,String(v));if(textValue!==undefined)e.textContent=textValue;return e;};
    svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('role','img');svg.setAttribute('aria-label',series.map(s=>s.name).join(' 与 ')+'；'+valid.length+' 个观测点');
    const values=valid.flatMap(p=>series.map(s=>p[s.key]).filter(Number.isFinite));let min=Math.min(...values),max=Math.max(...values);if(max===min){min-=Math.max(1,Math.abs(min)*.005);max+=Math.max(1,Math.abs(max)*.005);}const range=max-min;min-=range*.08;max+=range*.08;
    const x=i=>left+i/Math.max(1,valid.length-1)*(W-left-right),y=v=>top+(max-v)/(max-min)*(H-top-bottom);
    for(let i=0;i<4;i++){const v=min+(max-min)*i/3,yy=y(v);svg.append(make('line',{x1:left,x2:W-right,y1:yy,y2:yy,stroke:'#24384a'}),make('text',{x:left-10,y:yy+4,fill:'#95acc2','font-size':12,'text-anchor':'end'},format(v)));}
    for(const s of series){const path=valid.map((p,i)=>Number.isFinite(p[s.key])?(i?'L':'M')+x(i).toFixed(2)+','+y(p[s.key]).toFixed(2):'').join(' ');svg.append(make('path',{d:path,fill:'none',stroke:s.color,'stroke-width':2.3,'stroke-linejoin':'round'}));}
    for(const marker of markers){const i=valid.findIndex(p=>p.t===marker.t);if(i<0||!Number.isFinite(marker.price))continue;const dot=make('circle',{cx:x(i),cy:y(marker.price),r:4.2,fill:marker.side==='buy'?'#63e0c7':'#ff8694',stroke:'#10202d','stroke-width':1.5});dot.append(make('title',{},(marker.side==='buy'?'买入 ':'卖出 ')+format(marker.price)+' · '+String(marker.t).replace('T',' ').slice(0,16)));svg.append(dot);}
    const minuteResolution=valid.length>1&&String(valid[0].t).slice(0,10)===String(valid[1].t).slice(0,10),label=p=>String(p.t||'').replace('T',' ').slice(0,minuteResolution?16:10);svg.append(make('text',{x:left,y:H-8,fill:'#95acc2','font-size':12},label(valid[0])),make('text',{x:W-right,y:H-8,fill:'#95acc2','font-size':12,'text-anchor':'end'},label(valid.at(-1))));
    const marker=make('line',{x1:left,x2:left,y1:top,y2:H-bottom,stroke:'#94b6c8','stroke-dasharray':'4 4',visibility:'hidden'}),tip=make('text',{x:left+10,y:top+15,fill:'#e1ecf8','font-size':12,visibility:'hidden'});
    svg.append(marker,tip);svg.addEventListener('pointermove',e=>{const bounds=svg.getBoundingClientRect(),sx=(e.clientX-bounds.left)/bounds.width*W,i=Math.max(0,Math.min(valid.length-1,Math.round((sx-left)/(W-left-right)*(valid.length-1))));marker.setAttribute('x1',x(i));marker.setAttribute('x2',x(i));marker.setAttribute('visibility','visible');tip.setAttribute('visibility','visible');tip.textContent=label(valid[i])+' · '+series.map(s=>s.name+' '+format(valid[i][s.key])).join(' / ');});svg.addEventListener('pointerleave',()=>{marker.setAttribute('visibility','hidden');tip.setAttribute('visibility','hidden');});
    box.append(svg);
  }
  function renderBudgetLimit(c){
    if(!c||!Number.isFinite(Number(c.max_order)))return;
    $('auto-budget').max=String(c.max_order);
    text('auto-budget-limit','当前允许预算：100 至 '+money(c.max_order)+'。按已保存的单笔限额生效；需要提高时，请到“风控与对账”修改并保存。');
  }
  function renderControl(c){
    if(!c)return;
    renderBudgetLimit(c);
    text('control-state',c.halted?'新增订单已暂停':'模拟交易可提交');$('control-state').className='badge '+(c.halted?'bad':'good');
    text('risk-state',(c.halted?'已暂停':'已启用')+' · '+c.reason+' · 更新于 '+date(c.updated_at));
    $('execution-state').replaceChildren(details([['服务端开关',c.halted?'暂停':'已启用'],['通道',c.busy?'有操作进行中':'空闲'],['单笔上限',money(c.max_order)],['当日提交上限',money(c.max_daily)],['单标的上限',pct(c.max_position)],['当日亏损上限',pct(c.max_loss)]]));
    if(!state.riskDirty){const f=$('risk-form').elements;f.max_order.value=c.max_order;f.max_daily.value=c.max_daily;f.max_position.value=Number((c.max_position*100).toFixed(3));f.max_loss.value=Number((c.max_loss*100).toFixed(3));}
  }
  function renderPositions(positions){
    text('positions-count',positions?positions.length+' 个标的':'读取失败');
    if(!positions?.length){emptyTable('positions-body',7,positions?'当前没有持仓。下单后以券商实际成交为准。':'持仓读取失败，请刷新。');return;}
    $('positions-body').replaceChildren(...positions.map(p=>{const tr=node('tr');[p.symbol,num(p.qty,6),money(p.avg_entry_price),money(p.current_price),money(p.market_value),money(p.unrealized_pl),pct(p.unrealized_plpc)].forEach((v,i)=>tr.append(node('td',i>=5?(Number(p.unrealized_pl)>=0?'positive':'negative'):'',v)));return tr;}));
  }
  function collectOrders(data){
    const local=new Map((data.local_orders||[]).map(o=>[o.client_id,o])),broker=new Map((data.orders||[]).map(o=>[o.client_order_id,o]));
    const ids=new Set([...broker.keys(),...local.keys()]);
    state.orders=[...ids].map(id=>{const l=local.get(id),b=broker.get(id);return {...l?.payload,...l?.broker_data,...b,client_order_id:id,created_at:b?.created_at||l?.created_at,status:b?.status||l?.status,local:Boolean(l),error:l?.error,brokerFresh:Boolean(b)};}).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    const pendingId=state.pending?.client_id;if(pendingId&&broker.has(pendingId)){clearPending();toast('已查到上一笔提交：'+(statusNames[broker.get(pendingId).status]||broker.get(pendingId).status));}
  }
  function filteredOrders(){const filter=$('order-filter').value;return state.orders.filter(o=>filter==='all'||filter==='platform'&&o.local||filter==='open'&&!terminal.includes(o.status)||filter==='filled'&&Number(o.filled_qty)>0);}
  function renderOrders(){
    const rows=filteredOrders();if(!rows.length){emptyTable('orders-body',8,state.overview?.orders?'当前筛选条件下没有订单。':'券商订单暂不可用；请刷新或执行对账。');return;}
    $('orders-body').replaceChildren(...rows.map(o=>{const tr=node('tr'),time=node('td','',date(o.created_at)),sym=node('td','',o.symbol||'—');sym.append(node('small','',o.client_order_id));const side=node('td',o.side==='buy'?'positive':'',o.side==='buy'?'买入':'卖出');side.append(node('small','',(types[o.type]||o.type||'')+' · '+(o.time_in_force||'').toUpperCase()));
      const status=node('td','',statusNames[o.status]||o.status||'—');status.append(node('small','',o.local?'本平台':'外部订单'));if(!o.brokerFresh)status.append(node('small','',o.error||'本地记录，尚需券商核实'));
      const action=node('td');if(o.local&&!terminal.includes(o.status)){const btn=node('button','',o.status==='pending_cancel'?'查询撤单':'申请撤单');btn.setAttribute('data-operator','');btn.addEventListener('click',()=>askAction('撤销模拟订单',o.symbol+' · '+o.client_order_id+'。撤单申请可能与成交并发；以券商最终状态为准。',()=>api('orders/cancel',{client_id:o.client_order_id})));action.append(btn);}else action.textContent='—';
      tr.append(time,sym,side,node('td','',num(o.qty,6)),node('td','',num(o.filled_qty,6)),node('td','',money(o.filled_avg_price)),status,action);return tr;}));syncAccess();
  }
  async function refresh(){
    if(state.refreshing)return;state.refreshing=true;$('refresh').disabled=true;
    try{const d=await api('overview');state.overview=d;const a=d.account,c=d.clock;
      text('equity',money(a?.equity));text('cash',money(a?.cash));text('buying-power',money(a?.buying_power));text('account-status',a?'账户 '+a.status+(a.trading_blocked?' · 交易被阻断':''):'账户读取失败');
      const change=a&&Number(a.last_equity)>0?Number(a.equity)-Number(a.last_equity):null;text('daily-pnl',change===null?'上日净值不可用':'较上日 '+money(change)+' / '+pct(change/Number(a.last_equity)));$('daily-pnl').className=change===null?'':change>=0?'positive':'negative';
      text('market-state',c?(c.is_open?'常规交易时段':'当前休市'):'未知');text('market-next',c?(c.is_open?'下次收市 ':'下次开市 ')+date(c.is_open?c.next_close:c.next_open):'市场时钟读取失败');
      text('freshness','读取于 '+date(d.fetched_at)+' · 可见时每 15 秒更新');text('connection',d.demo_mode?'本地演示 · 券商替身':d.ok?'Paper 已连接':'部分数据不可用');$('connection').className='badge '+(d.ok?'good':'bad');text('broker-label',d.demo_mode?'LOCAL DEMO · 模拟成交':'ALPACA PAPER');
      message('global-error',Object.entries(d.errors||{}).map(([k,v])=>k+'：'+v).join('；'),true);renderControl(d.control);renderPositions(d.positions);collectOrders(d);renderOrders();
    }catch(e){text('connection','连接异常');$('connection').className='badge bad';text('freshness',state.overview?'当前保留旧数据，最后成功读取于 '+date(state.overview.fetched_at):'尚未读取成功');message('global-error',e.message,true);}
    finally{state.refreshing=false;$('refresh').disabled=false;}
  }
  async function loadEquity(){
    text('equity-chart','读取中…');try{const d=await api('equity?period='+$('equity-period').value),h=d.history;const points=(h.timestamp||[]).map((t,i)=>({t:new Date(t*1000).toISOString(),equity:h.equity[i]===null?NaN:Number(h.equity[i])}));chart('equity-chart',points,[{key:'equity',color:'#63e0c7',name:'模拟账户净值'}]);text('equity-caption','Alpaca 账户历史 · 日频 · 读取于 '+date(d.fetched_at)+'；移动到图线上查看数值。');}catch(e){text('equity-chart','账户历史暂不可用');text('equity-caption',e.message);}
  }
  async function loadQuote(){
    return busy($('quote-form').querySelector('button'),async()=>{try{const d=await api('market?symbol='+$('quote-symbol').value);state.quote=d;const s=d.snapshot,p=Number(s.trade?.p)||Number(s.reference);text('quote-price',d.symbol+' '+money(p));$('quote-details').replaceChildren(details([['最新成交时间',date(s.trade?.t||s.reference_at)],['买价 / 卖价',money(s.bp)+' / '+money(s.ap)],['报价时间',date(s.t)],['最近日线收盘',money(s.reference)],['数据读取时间',date(d.fetched_at)]]));}catch(e){state.quote=null;text('quote-price','读取失败');text('quote-details',e.message);}});
  }
  async function loadResearch(){
    try{const d=await api('artifacts?kind=backtest');$('research-history').replaceChildren(...d.items.map(r=>{const e=node('div','record');e.append(node('strong','',r.name),node('small','',date(r.created_at)),node('small','',r.id));const b=node('button','','打开报告与参数');b.addEventListener('click',()=>busy(b,async()=>{try{const row=await api('artifact?kind=backtest&id='+encodeURIComponent(r.id));showReport({id:row.id,...row.payload},true);}catch(e){toast(e.message);}}));e.append(b);return e;}));if(!d.items.length)$('research-history').append(node('p','caption','还没有实验。填写左侧参数并运行一次真实行情回测。'));}catch(e){text('research-history',e.message);}
  }
  function renderReportChart(){if(!state.report)return;const drawdown=state.chartMode==='drawdown',matched=Number.isFinite(state.report.metrics.benchmark_return);$('chart-equity').classList.toggle('selected',!drawdown);$('chart-drawdown').classList.toggle('selected',drawdown);chart('report-chart',state.report.curve,drawdown?[{key:'drawdown',name:'回撤',color:'#ff8694'}]:[{key:'equity',name:'策略',color:'#63e0c7'},{key:'benchmark',name:matched?'同预算日内基准':'买入持有基准',color:'#799dc5'}],drawdown?pct:money);}
  function showReport(r,fillForm=false){
    state.report=r;state.plan=null;$('backtest-result').hidden=false;$('plan-panel').hidden=true;state.chartMode='equity';text('report-name',r.config.name+(r.baseline?' · 冻结基线':''));
    const m=r.metrics,metrics=[['总收益',pct(m.total_return)],['年化收益',pct(m.cagr)],['夏普（无风险利率 0）',num(m.sharpe)],['最大回撤',pct(m.max_drawdown)],['年化波动',pct(m.volatility)],['日收益 VaR 95%',pct(m.var95)],['交易次数',num(m.trade_count,0)],['累计成本',money(m.total_cost)]];
    $('report-metrics').replaceChildren(...metrics.map(([k,v])=>{const e=node('div');e.append(node('span','',k),node('strong','',v));return e;}));
    const minute=['opening_range_breakout','vwap_reversion'].includes(r.config.type),rule=minute?(r.config.type==='opening_range_breakout'?'开盘区间突破：突破上沿买入，跌破区间中点卖出':'VWAP 均值回归：跌破 VWAP 阈值买入，回到 VWAP 卖出'):'日线策略';
    text('report-provenance','数据来源 '+(r.data_source||'旧版冻结基线')+' · '+rule+' · 标的 '+(r.config.symbol||'多资产')+' · '+(minute?'1 分钟':'日线')+' · '+(minute?'预算 '+money(r.config.budget)+' · 阈值 '+r.config.threshold_bps+' 基点 · 15:45 后平仓 · ':'')+'引擎 '+r.engine+' · 数据 '+r.quality.rows+' 根，'+String(r.quality.from)+' 至 '+String(r.quality.to)+' · 快照 '+(r.snapshot_id||'旧版研究基线')+' · 最新信号 '+(r.signal===1?'持有目标仓位':r.signal===0?'空仓':'不适用')+(r.signal_reason?'（'+r.signal_reason+'）':'')+'。青色为策略，蓝色为'+(Number.isFinite(r.metrics.benchmark_return)?'同预算、同成本的日内基准。':'买入持有基准（不计成本）。'));
    text('report-limits',r.limitations.join(' '));
    if(r.trades?.length){$('backtest-trades').replaceChildren(...r.trades.slice(-300).map(t=>{const tr=node('tr');[date(t.t),date(t.signal_t),t.side==='buy'?'买入':'卖出',num(t.qty,6),money(t.price),money(t.cost)].forEach(v=>tr.append(node('td','',v)));return tr;}));}else emptyTable('backtest-trades',6,r.baseline?'冻结基线仅保留汇总；逐笔记录见原项目报告。':'当前参数没有触发交易。');
    $('generate-plan').dataset.unavailable=r.baseline?'1':'0';syncAccess();renderReportChart();
    if(fillForm&&!r.baseline){const f=$('research-form').elements;for(const k of ['name','symbol','type','days','cost_bps'])f[k].value=r.config[k];updateResearchFields();for(const k of minute?['budget','opening_minutes','threshold_bps']:['fast','slow'])f[k].value=r.config[k];if(!minute)f.allocation.value=r.config.allocation*100;}
    $('backtest-result').scrollIntoView({block:'start',behavior:'auto'});
  }
  async function loadShowcase(){
    const fill=(id,...parts)=>$(id).replaceChildren(...parts.map((value,i)=>node(i?'p':'strong','',value)));
    try{
      const records=await api('artifacts?kind=backtest');
      if(!records.items.length){fill('showcase-data','尚无历史行情快照');fill('showcase-rule','请先运行策略回测');fill('showcase-backtest','尚无回测结果');fill('showcase-orders','尚无模拟订单');return;}
      let auto=null;if(state.session?.operator)try{auto=await api('automation');}catch{}
      const candidate=auto?.state?.backtest_id||records.items[0].id;
      const row=await api('artifact?kind=backtest&id='+encodeURIComponent(candidate)),r=row.payload,c=r.config;
      const minute=['opening_range_breakout','vwap_reversion'].includes(c.type);
      const sessions=minute?new Set(r.curve.map(point=>String(point.t).slice(0,10))).size:null;
      fill('showcase-data',c.symbol+' · '+(symbolNames[c.symbol]||'美股标的'),c.symbol==='SPY'?'买卖的是 SPY ETF 份额，不是分别买入 500 只成分股。':'本次仅买卖这个代码，不自动扫描全部股票。',(r.data_source||'旧版历史快照')+' · '+(minute?'1 分钟':'日线')+' · '+r.quality.rows+' 根',String(r.quality.from)+' 至 '+String(r.quality.to),'覆盖 '+(sessions??'—')+' 个交易日；分钟策略固定范围：SPY、QQQ、AAPL、MSFT。');
      const rule=c.type==='opening_range_breakout'?'开盘 '+c.opening_minutes+' 分钟形成区间；收盘价突破上沿 '+c.threshold_bps+' 基点买入，跌破区间中点卖出。':c.type==='vwap_reversion'?'低于当日 VWAP '+c.threshold_bps+' 基点买入，回到 VWAP 卖出。':'按照已保存的日线规则产生信号。';
      fill('showcase-rule','只交易 '+c.symbol+' · '+(symbolNames[c.symbol]||'美股标的'),rule,minute?'单策略预算 '+money(c.budget)+'；15:45 美东时间后发出平仓信号。':'目标仓位 '+pct(c.allocation));
      const net=r.metrics.total_return*100000,gross=net+r.metrics.total_cost;
      fill('showcase-backtest','净盈亏 '+money(net),'交易盈亏（扣成本前）'+money(gross)+'；交易成本 '+money(r.metrics.total_cost),minute?'相当于策略预算的 '+pct(net/c.budget)+'；账户收益率 '+pct(r.metrics.total_return):'账户收益率 '+pct(r.metrics.total_return),minute&&Number.isFinite(r.metrics.benchmark_return)?'同预算日内基准净盈亏 '+money(r.metrics.benchmark_return*100000)+'（含成本）':'基准数据见回测曲线','历史买卖 '+num(r.metrics.trade_count,0)+' 笔 · 最大回撤 '+pct(r.metrics.max_drawdown),c.threshold_bps===0?'触发阈值为 0，微小突破也会交易；频繁买卖放大成本。':'成本与价格波动都会影响净收益。','样本仅 '+(sessions??'—')+' 个交易日，结果不能证明策略长期有效。');
      const box=$('showcase-orders');box.replaceChildren();
      if(!state.session?.operator){box.append(node('p','','登录课程操作员后显示模拟订单和券商回报。'));return;}
      const cycles=(auto?.cycles||[]).filter(x=>['submitted','filled'].includes(x.outcome)).slice(0,4);
      if(!cycles.length){box.append(node('p','','尚无自动模拟订单；可在“自动策略”授权并检查一轮。'));return;}
      for(const cycle of cycles){const d=cycle.details,e=node('div','showcase-order');e.append(node('b','',cycle.outcome==='filled'?'已成交':d.broker_status==='partially_filled'?'部分成交':'已提交，待成交'),node('p','',d.message||''),node('p','','历史信号 '+date(d.signal_timestamp)+' · 回放记录 '+date(cycle.created_at)),node('p','','订单 '+(d.client_order_id||'—')));box.append(e);}
    }catch(error){fill('showcase-data','读取失败：'+error.message);fill('showcase-rule','请刷新或登录后重试');fill('showcase-backtest','—');fill('showcase-orders','—');}
  }
  $('showcase-refresh').addEventListener('click',loadShowcase);
  let libraryReports=null;
  async function loadLibrary(){
    try{
      if(!libraryReports){const response=await fetch('/library-demo.json',{cache:'no-cache'});if(!response.ok)throw Error('三市场报告不可用');libraryReports=(await response.json()).reports;}
      const market=$('library-market').value,type=$('library-strategy').value,symbols=[...new Set(libraryReports.filter(x=>x.market===market).map(x=>x.symbol))];
      const selected=symbols.includes($('library-symbol').value)?$('library-symbol').value:symbols[0];
      $('library-symbol').replaceChildren(...symbols.map(symbol=>{const option=node('option','',symbol);option.value=symbol;return option;}));$('library-symbol').value=selected;
      const r=libraryReports.find(x=>x.market===market&&x.symbol===selected&&x.type===type);
      if(!r)throw Error('缺少该市场策略报告');
      const currency=value=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:r.currency,maximumFractionDigits:2}).format(value);
      const fill=(id,...parts)=>$(id).replaceChildren(...parts.map((x,i)=>node(i?'p':'strong','',x)));
      text('library-warning',r.sampleKind==='historical'?'真实历史分钟样本：覆盖 '+r.days+' 个交易日；仍需核对数据质量并做样本外验证。':'固定种子伪随机合成样本：仅验证代码、市场交易限制和展示流程；盈亏不能作为投资结论。');
      fill('library-data',r.symbol+' · '+({US:'美股',HK:'港股',CN:'A股普通股票'}[market]),'来源：'+r.source,'样本：'+r.days+' 个交易日 / '+r.rows+' 根分钟线',r.from+' 至 '+r.to,r.dataFetchedAt?'抓取于 '+r.dataFetchedAt:'合成演示，无抓取时间');
      fill('library-rule',r.strategyName+' · '+r.level,r.rule,'预算 '+currency(r.budget)+'；单边成本 '+r.costBps+' 基点；交易单位 '+r.lot+' 股。',r.tplus?'A股普通股票 T+1：当日买入不得当日卖出；剩余持仓 '+r.openQty+' 股。':'日内可买卖；样本日收盘前平仓。');
      fill('library-result',(r.sampleKind==='synthetic'?'合成样本账面变动 ':'策略净盈亏 ')+currency(r.net),(r.sampleKind==='synthetic'?'合成样本基准变动 ':'同预算基准净盈亏 ')+currency(r.baselineNet),'策略交易成本 '+currency(r.totalCost)+'；买卖 '+r.orders.length+' 笔',r.note);
      $('library-compare').replaceChildren(...libraryReports.filter(x=>x.market===market&&x.symbol===selected).map(item=>{const tr=node('tr');for(const value of [item.strategyName,currency(item.net),currency(item.baselineNet),currency(item.totalCost),num(item.orders.length,0),pct(item.maxDrawdown)])tr.append(node('td','',value));const action=node('td'),button=node('button','','查看');button.addEventListener('click',()=>{$('library-strategy').value=item.type;loadLibrary();$('library-detail-select').scrollIntoView({behavior:'smooth',block:'start'});});action.append(button);tr.append(action);return tr;}));
      chart('library-equity',r.equityCurve,[{key:'equity',name:'策略',color:'#63e0c7'},{key:'benchmark',name:'同预算基准',color:'#799dc5'}],currency);
      chart('library-drawdown',r.equityCurve,[{key:'drawdown',name:'回撤',color:'#ff8694'}],pct);
      chart('library-price',r.equityCurve,[{key:'price',name:r.symbol+' 价格',color:'#799dc5'}],currency,r.orders);
      text('library-chart-caption',(r.sampleKind==='synthetic'?'合成价格生成的曲线仅用于验证绘图流程；':'真实历史曲线仅反映所示 '+r.days+' 个交易日；')+'最大盘中回撤 '+pct(r.maxDrawdown)+'。回撤反映从此前资金高点跌落的幅度。');
      text('library-orders-caption','显示前 '+Math.min(20,r.orders.length)+' / '+r.orders.length+' 笔回测成交；没有券商订单号或真实成交回报。');
      $('library-orders').replaceChildren(...r.orders.slice(0,20).map(o=>{const tr=node('tr');for(const value of [date(o.t),o.side==='buy'?'买入':'卖出',num(o.qty,0),currency(o.price),currency(o.cost),o.reason])tr.append(node('td','',value));return tr;}));
      if(!r.orders.length)emptyTable('library-orders',6,'该短样本没有触发交易。');
    }catch(error){text('library-warning','报告读取失败：'+error.message);}
  }
  $('library-market').addEventListener('change',loadLibrary);$('library-symbol').addEventListener('change',loadLibrary);$('library-strategy').addEventListener('change',loadLibrary);
  let currentDailyPlan=null;
  let historicalDaily=null;
  async function loadHistoricalDaily(){
    try{
      if(!historicalDaily){const response=await fetch('/historical-daily-results.json',{cache:'no-cache'});if(!response.ok)throw Error('历史报告不可用');historicalDaily=await response.json();}
      const market=$('historical-market').value,labels={CN:'A 股',HK:'港股',US:'美股'};
      text('historical-status',labels[market]+'：'+historicalDaily.markets[market]);
      const rows=market==='CN'?historicalDaily.rows:[];
      $('historical-results').replaceChildren(...rows.map(row=>{const tr=node('tr');const fmt=m=>Number(m.cagr_pct).toFixed(2)+'% / '+Math.abs(Number(m.max_drawdown_pct)).toFixed(2)+'%';for(const value of [row.strategy,row.variant,fmt(row.development),fmt(row.holdout),row.meets_goal_both_periods?'两段均达标':'未同时达标'])tr.append(node('td','',value));return tr;}));
      if(!rows.length)emptyTable('historical-results',5,'没有可验证的历史结果。');
      text('historical-note',market==='CN'?'658 个交易日、'+historicalDaily.data.symbols_in_list+' 只上市及退市股票；100 万元起始资金，费用已计入。历史规则没有同时达到 8% 年化与 5% 回撤。涨跌停、历史 ST 状态及退市价格仍需完善，结果可能偏乐观。':'该市场的全市场历史行情尚未取得；不使用旧固定名单冒充动态选股回测。');
    }catch(error){text('historical-status','历史结果读取失败：'+error.message);}
  }
  $('historical-market').addEventListener('change',loadHistoricalDaily);
  async function loadCurrentDailyPlan(){
    try{
      if(!currentDailyPlan){const response=await fetch('/current-daily-plan.json',{cache:'no-cache'});if(!response.ok)throw Error('今日策略计划不可用');currentDailyPlan=await response.json();}
      const labels={CN:'A 股',HK:'港股',US:'美股'},states={expired_daily_open_signal:'昨日信号已过期，今天禁止补单',research_signal_ready:'研究信号待下一开盘核价',data_incomplete:'历史数据未就绪，禁止下单'};
      const market=$('daily-market').value,plan=currentDailyPlan.markets[market];
      $('current-market-status').replaceChildren(...['CN','HK','US'].map(code=>{const item=currentDailyPlan.markets[code],tr=node('tr');for(const value of [labels[code],String(item.universe?.listed||item.listed||item.listed_returned||'—'),item.signal_date||'—',states[item.status]||item.status])tr.append(node('td','',value));return tr;}));
      text('daily-warning',labels[market]+' · '+(states[plan.status]||plan.status)+'。目标：年化至少 8%，最大回撤不超过 5%；新动态股票池尚未完成历史验证。');
      text('current-plan-rule',plan.rule||plan.reason||'当前无法形成可信的全市场信号。');
      $('current-selection').replaceChildren(...(plan.selected||[]).map(p=>{const tr=node('tr');for(const value of [p.name+' '+p.symbol,p.target_weight_pct.toFixed(2)+'%',num(p.reference_close,2),num(p.indicative_shares_at_reference_close,0)+' 股',p.indicative_position_weight_pct.toFixed(2)+'%'])tr.append(node('td','',value));return tr;}));
      if(!plan.selected?.length)emptyTable('current-selection',5,'数据不完整，暂无选股结果。');
      text('current-plan-cash',plan.initial_cash?'100 万元人民币空仓；理论股票仓位 '+plan.total_stock_weight_pct.toFixed(2)+'%，按 100 股取整后约 '+plan.indicative_stock_weight_pct.toFixed(2)+'%，参考剩余现金 '+num(plan.indicative_cash_after_fees,2)+' 元。':'独立 100 万本币空仓；等待完整行情后计算目标仓位。');
      text('current-order-warning',plan.status==='expired_daily_open_signal'?'信号形成于 '+plan.signal_date+' 收盘，'+plan.next_open_date+' 开盘已经过去。今天不产生有效买单；需今日收盘后重算。':plan.status==='data_incomplete'?plan.reason:'仅为 '+(plan.next_open_date||'下一交易日')+' 开盘的模拟订单意向，尚未下单。');
      $('current-orders').replaceChildren(...(plan.order_intentions||[]).map(order=>{const tr=node('tr');for(const value of [order.symbol,order.side==='BUY'?'买入':'卖出',num(order.reference_shares,0)+' 股',order.execution])tr.append(node('td','',value));return tr;}));
      if(!plan.order_intentions?.length)emptyTable('current-orders',4,'当前无有效买卖订单。');
    }catch(error){text('daily-warning','策略计划读取失败：'+error.message);}
  }
  $('daily-market').addEventListener('change',loadCurrentDailyPlan);  function updateResearchFields(){const f=$('research-form').elements,minute=['opening_range_breakout','vwap_reversion'].includes(f.type.value);for(const kind of ['daily','minute'])for(const label of document.querySelectorAll('[data-research-'+kind+']')){const active=(kind==='minute')===minute;label.hidden=!active;label.querySelector('input').disabled=!active;label.querySelector('input').required=active;}for(const option of f.symbol.options)option.disabled=minute&&!minuteSymbols.has(option.value);if(f.symbol.selectedOptions[0]?.disabled)f.symbol.value='SPY';f.days.min=minute?'2':'90';f.days.max=minute?'30':'1095';if(Number(f.days.value)<Number(f.days.min)||Number(f.days.value)>Number(f.days.max))f.days.value=minute?'5':'365';text('research-message',minute?'分钟策略固定范围：SPY、QQQ、AAPL、MSFT；一次仅交易所选 1 个标的。Alpaca IEX 可拉取 2—30 个日历日；本机公开演示快照仅有最近 5 个交易日。':'日线：前一根完整日线产生信号，下一根开盘价模拟成交。');}
  $('research-form').elements.type.addEventListener('change',updateResearchFields);updateResearchFields();
  async function runResearch(e){e.preventDefault();return busy(e.submitter,async()=>{try{const f=new FormData(e.target),config=Object.fromEntries(f);config.allocation=Number(config.allocation)/100;const reuse=$('reuse-snapshot').checked;if(reuse&&!state.report?.snapshot_id)throw new Error('请先打开一份真实回测报告再选择快照重跑。');message('research-message','正在读取历史数据并计算，请稍候…');const r=await api('backtests',{config,...(reuse?{snapshot_id:state.report.snapshot_id}:{})});showReport(r);message('research-message','回测已持久化。'+(reuse?'本次使用所选报告的原有数据区间，历史天数输入不改变该快照。':''));await loadResearch();}catch(err){message('research-message',err.message,true);}});}
  async function loadBaseline(){return busy($('load-baseline'),async()=>{try{const response=await fetch('/research-baseline.json',{cache:'no-cache'});if(!response.ok)throw new Error('基线文件不可用');const d=await response.json(),m=d.metrics;showReport({baseline:true,config:{name:'原有多资产研究'},engine:'原项目 Python 回测',quality:{rows:d.report.rows,from:d.report.data_start,to:d.report.data_end},metrics:{...m,sharpe:m.sharpe_ratio,volatility:m.annual_volatility,var95:m.value_at_risk_95,total_cost:(m.total_commission||0)+(m.estimated_impact_cost||0)},curve:d.curve.map(x=>({...x,t:x.timestamp})),trades:[],limitations:['冻结研究基线，无法据此生成当前订单。此图采用原项目的多资产基准，数据与当前 Alpaca 账户无关。']});}catch(e){toast(e.message);}});}
  async function generatePlan(){return busy($('generate-plan'),async()=>{try{if(!state.report?.id)throw new Error('请先完成真实回测。');const p=await api('plans',{backtest_id:state.report.id});state.plan=p;$('plan-panel').hidden=false;$('plan-details').replaceChildren(details([['标的',p.symbol],['当前 / 目标股数',num(p.current_qty,6)+' → '+num(p.target_qty,6)],['计划',p.order?(p.order.side==='buy'?'买入 ':'卖出 ')+p.order.qty+' 股，限价 '+money(p.order.limit_price):'无需交易'],['有效至',date(p.expires_at)]]),node('p','caption',p.notes));if(p.order){const label=node('label','check');const checkbox=node('input');checkbox.type='checkbox';checkbox.id='plan-allow-queued';label.append(checkbox,document.createTextNode('休市时允许此限价单排队'));$('plan-details').append(label);}$('plan-to-ticket').dataset.unavailable=p.order?'0':'1';syncAccess();$('plan-panel').scrollIntoView({block:'center',behavior:'auto'});}catch(e){toast(e.message);}});}
  function updateOrderFields(){const type=$('order-type').value,f=$('order-form').elements,limit=type.includes('limit'),stop=type.startsWith('stop');$('limit-field').hidden=!limit;$('stop-field').hidden=!stop;f.limit_price.required=limit;f.stop_price.required=stop;}
  function orderInput(){const form=$('order-form');return {...Object.fromEntries(new FormData(form)),allow_queued:$('allow-queued').checked};}
  function showConfirmation(value){
    state.confirmation=value;message('confirm-error','');text('confirm-title',value.recovery?'查询上次提交结果':'确认模拟订单');
    const o=value.order;const rows=[['环境','Alpaca Paper · 模拟资金'],['标的 / 方向',o.symbol+' / '+(o.side==='buy'?'买入':'卖出')],['类型 / 有效期',(types[o.type]||o.type)+' / '+o.time_in_force.toUpperCase()],['股数',o.qty]];
    if(o.limit_price)rows.push(['限价',money(o.limit_price)]);if(o.stop_price)rows.push(['触发价',money(o.stop_price)]);if(value.check)rows.push(['风控估算金额',money(value.check.notional)],['预检',value.check.checks.join(' · ')]);
    rows.push(['休市排队',value.payload.allow_queued?'已明确允许':'未允许'],['本次订单号',value.client_id]);
    $('confirm-details').replaceChildren(details(rows),node('p','notice',value.recovery?'将使用原来的订单号查询／提交；服务器会识别已处理记录，防止重复创建。':'提交前服务器会重新校验。券商已接收不等于已成交，市价单成交价可能不同于参考价。'));
    text('confirm-submit',value.recovery?'查询同一笔订单结果':'确认提交到 Alpaca Paper');$('confirm-submit').disabled=!state.session?.operator;if(!$('confirm-dialog').open)$('confirm-dialog').showModal();$('confirm-title').focus();
  }
  async function preview(order,planId=null){
    if(state.pending){showConfirmation({...state.pending,recovery:true});return;}
    const check=await api('orders/preview',order);if(check.queued&&!order.allow_queued)throw new Error('当前休市，请勾选允许限价单排队后重新预览。');
    const key=planId||crypto.randomUUID(),payload=planId?{plan_id:planId,confirm:true,allow_queued:order.allow_queued===true}:{...check.order,confirm:true,allow_queued:order.allow_queued===true,idempotency_key:key};
    showConfirmation({path:planId?'plans/submit':'orders',payload,order:check.order,check,client_id:'qs_'+key.replaceAll('-','')});
  }
  function savePending(p){state.pending=p;try{sessionStorage.setItem('quant.pending.v1',JSON.stringify(p));}catch{}renderPending();}
  function clearPending(){state.pending=null;try{sessionStorage.removeItem('quant.pending.v1');}catch{}renderPending();}
  function renderPending(){const e=$('last-order');if(!state.pending){e.hidden=true;return;}e.hidden=false;e.replaceChildren(node('p','','上一笔提交待核实：'+state.pending.client_id));const b=node('button','','查询上次提交');b.addEventListener('click',()=>showConfirmation({...state.pending,recovery:true}));e.append(b);}
  async function confirmOrder(){return busy($('confirm-submit'),async()=>{
    const c=state.confirmation;if(!c)return;savePending(c);message('confirm-error','');
    try{const result=await api(c.path,c.payload);const status=result.order?.status;
      if(status==='unknown'||status==='submitting'){message('confirm-error',result.message||'状态未知，已暂停新增订单，请对账。',true);text('confirm-submit','查询同一笔订单结果');}
      else{clearPending();$('confirm-dialog').close();showView('trade');message('order-message',(result.reused?'查到已有订单：':'券商结果：')+(statusNames[status]||status||'请对账确认')+' · '+(result.order?.client_order_id||c.client_id)+(result.message?' · '+result.message:''),!result.ok);toast(result.ok?'订单结果已更新，请查看订单列表。':'券商未接受此订单。');}
      await refresh();
      if(c.path==='acceptance/submit'){showView('acceptance');await inspectAcceptance();}
    }catch(e){if(e.code&&!['SERVICE_UNAVAILABLE','BROKER_UNCERTAIN','OPERATION_BUSY'].includes(e.code))clearPending();message('confirm-error',e.message+(state.pending?' 保留了同一订单号，可以继续查询。':' 请返回修改，或处理风控提示后再提交。'),true);text('confirm-submit',state.pending?'查询同一笔订单结果':'再次检查并提交');}
  });}
  let action=null;
  function askAction(title,description,fn,requireText=false){action=fn;text('action-title',title);text('action-description',description);$('action-text-label').hidden=!requireText;$('action-text').value='';$('action-text').required=requireText;message('action-error','');$('action-dialog').showModal();(requireText?$('action-text'):$('action-submit')).focus();}
  function reconciliationText(d){return '对账时间：'+date(d.timestamp)+'\n结果：'+(d.ok?'通过':'存在未决项，保持暂停')+'\n未知／不可用订单：'+d.unresolved+'\n净值核算差额：'+money(d.equity_difference)+'\n外部未完成订单：'+d.external_open_orders+'\n'+d.scope+'\n\n'+d.orders.map(o=>o.client_id+' · '+(statusNames[o.status]||o.status)+(o.message?' · '+o.message:'')).join('\n');}
  async function doReconcile(){return busy($('reconcile'),async()=>{try{const d=await api('reconcile',{});text('reconcile-result',reconciliationText(d));toast(d.ok?'对账通过。':'对账有未决项，请查看详情。');await refresh();}catch(e){text('reconcile-result',e.message);}});}
  async function loadAudit(){
    if(!state.session?.operator)return;try{const d=await api('audit');state.audit=d.items;text('audit-integrity',(d.integrity?'所有已加载事件摘要校验通过':'发现事件摘要不一致')+' · 最近 '+d.items.length+' 条。摘要用于检测意外变更，不代表外部公证。');$('audit-list').replaceChildren(...d.items.map(x=>{const e=node('details','record');e.append(node('summary','',x.kind+' · '+date(x.timestamp)),node('small','',x.subject||'平台控制'),node('pre','',JSON.stringify(x.details,null,2)),node('small','',x.digest+' · '+(x.valid?'校验通过':'不一致')));return e;}));if(!d.items.length)$('audit-list').append(node('p','caption','尚无操作记录。'));}catch(e){text('audit-integrity',e.message);}
  }
  function download(name,value,type='application/json'){const blob=new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportOrders(){const cols=['client_order_id','symbol','side','type','qty','filled_qty','filled_avg_price','status','created_at'];const cell=v=>{let s=String(v??'');if(typeof v==='string'&&/^[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};download('paper-orders.csv','\ufeff'+[cols,...filteredOrders().map(o=>cols.map(k=>o[k]))].map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');}
  const verdict={passed:'通过',pending:'待完成',failed:'未通过'};
  const acceptanceChecks=d=>d.latest?.checks||[...d.run.checks,...['买入委托被券商接收','1 股实际模拟成交','独立撤单委托已撤销','持仓变化与本次成交相符','成交后账户与订单对账'].map(name=>({name,status:'pending',evidence:'尚未完成交易验证，请按步骤操作后查询券商结果。'}))];
  function renderAcceptance(data){
    state.acceptance=data;const r=data.run,v=data.latest;$('acceptance-report').hidden=false;text('acceptance-title',r.symbol+' 模拟盘验收');text('acceptance-status',v?.complete?'全部验收通过':'尚有未完成项目');$('acceptance-status').className='badge '+(v?.complete?'good':'bad');text('acceptance-time','准备于 '+date(r.created_at)+' · 最新检查 '+date(v?.checked_at)+' · 验收号 '+r.id);
    $('acceptance-details').replaceChildren(details([['成交验证单','买入 1 股 '+r.symbol+'，限价 '+money(r.order.limit_price)],['撤单测试单','买入 1 股 '+r.symbol+'，限价 '+money(r.cancel_order.limit_price)+'，接收后立即申请撤销'],['主委托有效准备期',date(r.expires_at)],['券商成交回报',v?.receipts.fill?(statusNames[v.receipts.fill.status]||v.receipts.fill.status)+' · '+v.receipts.fill.id:'尚无'],['实际成交价 / 股数',v?.receipts.fill?money(v.receipts.fill.filled_avg_price)+' / '+num(v.receipts.fill.filled_qty,6):'尚无']]));
    $('acceptance-checks').replaceChildren(...acceptanceChecks(data).map(c=>{const e=node('div','record');e.append(node('strong',c.status==='passed'?'positive':c.status==='failed'?'negative':'',(verdict[c.status]||c.status)+' · '+c.name),node('p','caption',c.evidence));return e;}));text('acceptance-notes',r.notes+(r.risk_error?' 准备时风控提示：'+r.risk_error.message+'；处理后可再次预览，提交前会重新检查。':''));
    text('acceptance-submit',v?.receipts.fill?'2. 查询已提交的成交验证单':'2. 预览 1 股成交验证单');syncAccess();
  }
  async function loadAcceptanceHistory(){try{const d=await api('artifacts?kind=acceptance'),select=$('acceptance-history');const option=node('option','','选择验收记录');option.value='';select.replaceChildren(option,...d.items.map(r=>{const o=node('option','',date(r.created_at)+' · '+r.name);o.value=r.id;return o;}));if(state.acceptance)select.value=state.acceptance.run.id;}catch(e){message('acceptance-message',e.message,true);}}
  async function inspectAcceptance(){if(!state.acceptance||state.checkingAcceptance)return;state.checkingAcceptance=true;try{const d=await api('acceptance/inspect',{id:state.acceptance.run.id});renderAcceptance(d);message('acceptance-message',d.latest.complete?'全部验收通过，报告已保存，可导出汇报。':'检查结果已保存。尚未成交或撤单完成的项目仍显示待完成。');}catch(e){message('acceptance-message',e.message,true);}finally{state.checkingAcceptance=false;}}
  async function previewAcceptance(){
    if(state.pending){showConfirmation({...state.pending,recovery:true});return;}
    const r=state.acceptance?.run;if(!r)return;if(state.acceptance.latest?.receipts.fill){await inspectAcceptance();return;}
    const allow=$('acceptance-queued').checked,check=await api('orders/preview',r.order);if(check.queued&&!allow)throw new Error('当前休市，请先明确勾选允许限价委托排队。');showConfirmation({path:'acceptance/submit',payload:{id:r.id,confirm:true,allow_queued:allow},order:r.order,check,client_id:'qs_'+r.id.replaceAll('-','')});
  }
  function exportAcceptance(){const d=state.acceptance;if(!d)return;const r=d.run,v=d.latest,cell=s=>String(s??'').replaceAll('|','／').replaceAll('\n',' ');const lines=['# Alpaca Paper 课程实际操作验收报告','','验收号：'+r.id,'','准备时间：'+date(r.created_at),'','最新检查：'+date(v?.checked_at),'','结论：'+(v?.complete?'全部验收通过':'尚有未完成项目，不能作为完整成交验收通过的证明'),'','| 验收项 | 结果 | 实际证据 |','| --- | --- | --- |',...acceptanceChecks(d).map(c=>'| '+cell(c.name)+' | '+cell(verdict[c.status])+' | '+cell(c.evidence)+' |'),'','## 券商回报','','```json',JSON.stringify(v?.receipts||{fill:null,cancel:null},null,2),'```','','## 范围与说明','',r.notes,'','回测报告：'+r.backtest_id,'','行情快照：'+r.snapshot_id,'','平台：'+location.origin];download('paper-acceptance-'+r.id+'.md',lines.join('\n'),'text/markdown;charset=utf-8');}
  document.querySelectorAll('[data-view],[data-go]').forEach(e=>e.addEventListener('click',()=>showView(e.dataset.view||e.dataset.go)));
  window.addEventListener('hashchange',()=>showView(location.hash.slice(1)));
  document.querySelectorAll('[data-close]').forEach(e=>e.addEventListener('click',()=>$(e.dataset.close).close()));
  $('sign-in').addEventListener('click',()=>{message('login-error','');$('login-dialog').showModal();$('login-username').focus();});
  $('login-dialog').addEventListener('close',()=>{$('login-password').value='';});
  $('login-form').addEventListener('submit',e=>{e.preventDefault();busy($('login-submit'),async()=>{try{message('login-error','');await api('auth/login',{username:$('login-username').value.trim(),password:$('login-password').value});$('login-dialog').close();await loadSession();await refresh();if(location.hash==='#audit')await loadAudit();if(location.hash==='#showcase')await loadShowcase();toast('登录成功，可以操作课程模拟账户。');}catch(error){message('login-error',error.message,true);}finally{$('login-password').value='';}});});
  $('sign-out').addEventListener('click',()=>busy($('sign-out'),async()=>{try{await api('auth/logout',{});state.audit=[];$('audit-list').replaceChildren();$('confirm-dialog').close();$('action-dialog').close();await loadSession();toast('已退出登录，现在为访客查看模式。');}catch(error){toast(error.message);}}));
  $('open-help').addEventListener('click',()=>{$('help-dialog').showModal();$('help-title').focus();});
  $('refresh').addEventListener('click',refresh);$('equity-period').addEventListener('change',loadEquity);$('quote-form').addEventListener('submit',e=>{e.preventDefault();loadQuote();});
  $('quote-to-trade').addEventListener('click',()=>{const sym=$('quote-symbol').value;$('order-symbol').value=sym;if(state.quote?.symbol===sym){const s=state.quote.snapshot,p=Number(s.trade?.p)||Number(s.reference);if(p>0)$('order-form').elements.limit_price.value=p.toFixed(2);}showView('trade');});
  $('research-form').addEventListener('submit',runResearch);$('reload-research').addEventListener('click',loadResearch);$('load-baseline').addEventListener('click',loadBaseline);
  $('chart-equity').addEventListener('click',()=>{state.chartMode='equity';renderReportChart();});$('chart-drawdown').addEventListener('click',()=>{state.chartMode='drawdown';renderReportChart();});
  $('download-report').addEventListener('click',()=>{if(state.report)download('quant-backtest-'+(state.report.id||'baseline')+'.json',state.report);});$('generate-plan').addEventListener('click',generatePlan);
  $('plan-to-ticket').addEventListener('click',()=>busy($('plan-to-ticket'),async()=>{try{if(!state.plan?.order)throw new Error('没有可提交的计划');await preview({...state.plan.order,allow_queued:$('plan-allow-queued').checked},state.plan.id);}catch(e){toast(e.message);}}));
  $('order-type').addEventListener('change',updateOrderFields);$('order-form').addEventListener('submit',e=>{e.preventDefault();busy(e.submitter,async()=>{try{message('order-message','正在检查账户、行情与限额…');await preview(orderInput());message('order-message','请在弹窗中核对并确认。');}catch(err){message('order-message',err.message,true);}});});$('confirm-submit').addEventListener('click',confirmOrder);
  $('order-filter').addEventListener('change',renderOrders);$('download-orders').addEventListener('click',exportOrders);
  $('cancel-all').addEventListener('click',()=>askAction('撤销本平台未完成订单','只申请撤销本平台创建的未完成 Paper 订单。已成交部分不能撤回。',()=>api('orders/cancel-all',{})));
  $('halt').addEventListener('click',()=>askAction('暂停新增订单','立即保存服务器暂停状态，已被券商接收的订单不受此按钮撤销。',()=>api('control',{halted:true})));
  $('kill').addEventListener('click',()=>askAction('暂停并撤单','立即暂停新增订单，并逐笔申请撤销本平台未完成订单。请在订单列表和对账中核对最终结果。',()=>api('control',{halted:true,cancel:true})));
  $('resume').addEventListener('click',()=>askAction('对账后恢复模拟交易','服务器将先对账并检查账户与亏损限额。请输入“恢复模拟盘”继续。',()=>api('control',{halted:false,confirm:$('action-text').value}),true));
  $('action-form').addEventListener('submit',e=>{e.preventDefault();busy($('action-submit'),async()=>{try{const result=await action();$('action-dialog').close();if(result.results||result.canceled)text('reconcile-result',JSON.stringify(result.canceled||result,null,2));toast(result.message||'操作已保存。');await refresh();if(location.hash==='#acceptance')await inspectAcceptance();}catch(err){message('action-error',err.message,true);}});});
  $('risk-form').addEventListener('input',()=>{state.riskDirty=true;});$('risk-form').addEventListener('submit',e=>{e.preventDefault();busy(e.submitter,async()=>{try{const settings=Object.fromEntries(new FormData(e.target));settings.max_position=Number(settings.max_position)/100;settings.max_loss=Number(settings.max_loss)/100;const d=await api('risk',settings);state.riskDirty=false;renderControl(d.control);toast('风控规则已保存并记录审计。');}catch(err){toast(err.message);}});});
  $('reconcile').addEventListener('click',doReconcile);$('reload-audit').addEventListener('click',loadAudit);$('download-audit').addEventListener('click',()=>download('quant-audit.json',state.audit));
  $('acceptance-prepare').addEventListener('click',()=>busy($('acceptance-prepare'),async()=>{try{message('acceptance-message','正在读取实际账户和行情，运行回测重现与对账…');const d=await api('acceptance/prepare',{symbol:$('acceptance-symbol').value});renderAcceptance(d);await loadAcceptanceHistory();message('acceptance-message','验收记录已保存，尚未创建任何订单。处理风控提示后预览第 2 步。');}catch(e){message('acceptance-message',e.message,true);}}));
  $('acceptance-history-refresh').addEventListener('click',loadAcceptanceHistory);$('acceptance-history').addEventListener('change',async e=>{if(!e.target.value)return;try{renderAcceptance(await api('acceptance/report?id='+encodeURIComponent(e.target.value)));}catch(err){message('acceptance-message',err.message,true);}});
  $('acceptance-submit').addEventListener('click',()=>busy($('acceptance-submit'),async()=>{try{await previewAcceptance();}catch(e){message('acceptance-message',e.message,true);}}));
  $('acceptance-cancel').addEventListener('click',()=>{const r=state.acceptance?.run;if(!r)return;if(state.pending){showConfirmation({...state.pending,recovery:true});return;}const allow=$('acceptance-queued').checked;if(!state.overview?.clock?.is_open&&!allow){message('acceptance-message','休市时请先勾选允许本次限价委托排队。',true);return;}askAction('确认独立撤单验证','将以 '+money(r.cancel_order.limit_price)+' 买入 1 股 '+r.symbol+'，随后立即申请撤销。这会实际向 Alpaca Paper 提交额外一笔订单；如果已成交，成交部分不能撤回。重复此步骤只查询／撤销同一个订单号。',()=>api('acceptance/cancel-check',{id:r.id,confirm:true,allow_queued:allow}));});
  $('acceptance-inspect').addEventListener('click',()=>busy($('acceptance-inspect'),inspectAcceptance));$('acceptance-export').addEventListener('click',exportAcceptance);$('acceptance-export-json').addEventListener('click',()=>{if(state.acceptance)download('paper-acceptance-'+state.acceptance.run.id+'.json',state.acceptance);});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadSession();refresh();}});
  let autoData=null;
  const autoNames={paused:'已暂停',busy:'执行中',market_closed:'等待开市',pending_order:'跟踪挂单',waiting_data:'等待新分钟线',already_evaluated:'本根行情已处理',no_order:'保持仓位',submitted:'已提交',filled:'已成交',fault:'异常暂停',halted:'全局暂停'};
  async function autoReports(){try{const d=await api('artifacts?kind=backtest');$('auto-report').replaceChildren(...d.items.map(r=>{const o=node('option','',r.name+' · '+date(r.created_at));o.value=r.id;return o;}));await syncAutoBudget();}catch(e){message('auto-message',e.message,true);}}
  async function syncAutoBudget(){const id=$('auto-report').value;if(!id)return;try{const r=await api('artifact?kind=backtest&id='+encodeURIComponent(id)),c=r.payload.config;if(['opening_range_breakout','vwap_reversion'].includes(c.type)){$('auto-budget').value=String(c.budget);message('auto-message','所选分钟策略：'+c.symbol+' / '+c.type+'。预算已同步为回测值 '+money(c.budget)+'；启动时会验证一致。');}}catch(e){message('auto-message',e.message,true);}}
  $('auto-report').addEventListener('change',syncAutoBudget);
  async function loadAutomation(){if(!state.session?.operator)return;try{const d=await api('automation');autoData=d;renderBudgetLimit(d.limits);const s=d.state;$('auto-status').replaceChildren(details([['策略状态',({paused:'已暂停',awaiting_execution:'已授权 · 等待首次执行',manual_checked:'已手动检查 · 等待后续执行',scheduled_checked:'后台已执行 · 继续监测',awaiting_scheduler:'等待后台恢复'})[s.execution_state]||'状态待确认'],['策略 / 标的',s.config?s.config.name+' / '+s.config.symbol:'尚未部署'],['预算',money(s.budget)],['后台连接',d.scheduler.healthy?'已收到心跳':'未收到近期心跳'],['最近后台心跳',date(s.heartbeat_at)],['最近执行',date(s.last_check_at)],['执行来源',({manual:'网页手动检查',github:'后台定时任务',cloudflare:'云端定时任务'})[s.last_execution_source]||'尚未执行'],['运行说明',s.reason]]));message('auto-scheduler-note',d.scheduler.healthy?'':(d.scheduler.configured?'后台近期未响应，持续自动执行暂不可靠。可以保存启动授权，再点击“立即检查一轮”执行；后台恢复后也会继续执行已授权策略。':'尚未配置后台调度。可以授权后手动检查一轮，关闭网页不会因此获得持续执行能力。'));$('auto-tick').dataset.unavailable=s.enabled?'0':'1';syncAccess();if(!d.cycles.length)emptyTable('auto-cycles',4,'暂无运行记录，后台心跳不会自行启动策略。');else $('auto-cycles').replaceChildren(...d.cycles.map(r=>{const tr=node('tr');for(const v of [date(r.created_at),{github:'后台定时',cloudflare:'云端定时',manual:'立即检查'}[r.source]||r.source,autoNames[r.outcome]||r.outcome,(r.details.message||'')+(r.details.client_order_id?' · '+r.details.client_order_id:'')])tr.append(node('td','',v));return tr;}));if(!$('auto-report').options.length)await autoReports();}catch(e){message('auto-message',e.message,true);}}
  async function autoAction(path,body,button){return busy(button,async()=>{try{message('auto-message','正在处理…');const r=await api('automation/'+path,body);message('auto-message',r.message||(['start','resume'].includes(path)?'启动授权已保存。可点击“立即检查一轮”；后台任务到达时也会执行，不必重复启动。':'已完成，请查看最新状态与执行记录。'),r.ok===false);await loadAutomation();await refresh();}catch(e){message('auto-message',e.message,true);}});}
  $('auto-form').addEventListener('submit',e=>{e.preventDefault();autoAction('start',{backtest_id:$('auto-report').value,budget:Number($('auto-budget').value),confirm:$('auto-confirm').value},e.submitter);});
  $('auto-resume').addEventListener('click',e=>autoAction('resume',{confirm:$('auto-confirm').value},e.currentTarget));
  $('auto-pause').addEventListener('click',e=>autoAction('pause',{},e.currentTarget));
  $('auto-cancel').addEventListener('click',e=>autoAction('pause',{cancel:true},e.currentTarget));
  $('auto-tick').addEventListener('click',e=>autoAction('tick',{},e.currentTarget));
  $('auto-refresh').addEventListener('click',loadAutomation);$('auto-reports-reload').addEventListener('click',autoReports);
  $('auto-export').addEventListener('click',()=>{if(autoData)download('quant-auto-run-'+(autoData.state.run_id||'status')+'.json',autoData);});
  setInterval(()=>{if(!$('view-automation').hidden)loadAutomation();},15000);
  async function init(){
    createStrategyLab({api,chart,onSaved:async()=>{await loadResearch();},onAuto:async id=>{await autoReports();$('auto-report').value=id;showView('automation');}});
    syncAccess();updateOrderFields();showView(location.hash.slice(1));
    try{const pending=JSON.parse(sessionStorage.getItem('quant.pending.v1')||'null');if(pending?.client_id&&['orders','plans/submit','acceptance/submit'].includes(pending.path)&&pending.payload&&pending.order)state.pending=pending;}catch{}renderPending();
    const symbols=['SPY','QQQ','IWM','EFA','EEM','TLT','IEF','GLD','DBC','SHY','AAPL','MSFT'];for(const id of ['quote-symbol','research-symbol','order-symbol','acceptance-symbol'])$(id).replaceChildren(...symbols.map(s=>{const o=node('option','',s+' · '+symbolNames[s]);o.value=s;return o;}));updateResearchFields();
    await loadSession();await Promise.allSettled([refresh(),loadEquity(),loadQuote(),loadResearch(),loadShowcase()]);if(location.hash==='#audit'&&state.session?.operator)loadAudit();setInterval(()=>{if(!document.hidden)refresh();},15000);
    setInterval(()=>{if(!document.hidden&&location.hash==='#acceptance'&&state.session?.operator&&state.acceptance?.latest?.receipts.fill&&!state.acceptance.latest.complete)inspectAcceptance();},30000);
  }
  init();
})();
