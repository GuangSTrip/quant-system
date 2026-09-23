import {buildPortfolioCatalog, strategyId} from './portfolio-contract.mjs';
import {describeStrategy} from './portfolio-explain.mjs';
import {createReplayUI} from './replay-ui.mjs';
import {portfolioReplay} from './replay-model.mjs';
import {runMinuteResearch,LIBRARY_MARKETS,LIBRARY_STRATEGIES} from './minute-library.mjs';
import {minuteValidation} from './minute-validation.mjs';
import cnMinute from '../demo-data/CN-1Min-snapshot.json' with {type:'json'};
import hkMinute from '../demo-data/HK-1Min-snapshot.json' with {type:'json'};
import usMinute from '../demo-data/SPY-1Min-snapshot.json' with {type:'json'};

export const dimensions=['selection','timing','allocation','risk_policy'];
export function courseFrequency(config){
  return config.timing!=='monthly'||config.risk_policy==='cushion07'?'daily':'longer';
}
export const COURSE_MINUTE_SNAPSHOTS={CN:cnMinute,HK:hkMinute,US:usMinute};
export const COURSE_MINUTE_INSTRUMENTS={CN:'浦发银行',HK:'腾讯控股',US:'标普 500 指数 ETF'};
export function runCourseMinuteStudy(market){
  const snapshot=COURSE_MINUTE_SNAPSHOTS[market];if(!snapshot)throw Error('分钟数据暂不支持该市场');
  const params={market,symbol:snapshot.symbol,budget:market==='US'?2000:100000,cost_bps:LIBRARY_MARKETS[market].costBps};
  const strategies=LIBRARY_STRATEGIES.map(strategy=>{
    const result=runMinuteResearch(snapshot.bars,{...params,type:strategy.id});
    const validation=minuteValidation(snapshot,{...params,type:strategy.id});
    const stressed=runMinuteResearch(snapshot.bars,{...params,type:strategy.id,costMultiplier:2});
    return {strategy,result,validation,stressed};
  });
  return {market,snapshot,params,strategies};
}
export function rankMinuteStudies(rows,criterion='return'){
  const score=row=>{const ret=row.result.net/row.result.initialCapital*100,dd=Math.abs(row.result.maxDrawdown)*100;
    return criterion==='drawdown'?-dd:criterion==='balanced'&&ret>0?ret/Math.max(dd,1):criterion==='balanced'?-Infinity:ret;};
  return [...rows].sort((a,b)=>score(b)-score(a)||a.strategy.id.localeCompare(b.strategy.id));
}
export function matchingEntries(entries, filters){
  return entries.filter(e=>(!filters.market||e.market===filters.market)&&
    (!filters.frequency||courseFrequency(e.config)===filters.frequency)&&
    dimensions.every(k=>!filters[k]||(e.config[k]||'base')===filters[k]));
}
export function reportEvidence(entry){
  const r=entry.report,capital=1_000_000,cost=Number.isFinite(r.cost)?r.cost:null;
  return {capital,cost,costPct:cost===null?null:cost/capital*100,
    turnover:Number.isFinite(r.traded_notional)?r.traded_notional/capital:null,
    complete:!!r.decisions?.length&&!!r.trades?.length};
}
export function balancedScore(entry){
  const m=entry.report.full;
  return Number.isFinite(m.cagr_pct)&&Number.isFinite(m.max_drawdown_pct)&&m.cagr_pct>0
    ?m.cagr_pct/Math.max(1,Math.abs(m.max_drawdown_pct)):-Infinity;
}
export function rankedEntries(entries,market,frequency,criterion){
  const rows=matchingEntries(entries,{market,frequency});
  const first=rows[0]?.report.dates;
  const comparable=rows.filter(e=>e.report.dates.length===first.length&&e.report.dates[0]===first[0]&&e.report.dates.at(-1)===first.at(-1));
  const score=e=>criterion==='drawdown'?-Math.abs(e.report.full.max_drawdown_pct):criterion==='balanced'?balancedScore(e):criterion==='total'?e.report.full.total_return_pct:e.report.full.cagr_pct;
  return comparable.sort((a,b)=>(score(b)-score(a))||b.report.full.cagr_pct-a.report.full.cagr_pct||a.id.localeCompare(b.id));
}
export function intervalMetrics(values,dates){
  if(values.length!==dates.length||values.length<2||values.some(v=>!Number.isFinite(v)||v<=0))return null;
  const years=(Date.parse(dates.at(-1))-Date.parse(dates[0]))/(365.25*86400000);
  if(!(years>0))return null;
  let peak=values[0],drawdown=0;for(const value of values){peak=Math.max(peak,value);drawdown=Math.min(drawdown,value/peak-1);}
  return {total_return_pct:(values.at(-1)/values[0]-1)*100,cagr_pct:((values.at(-1)/values[0])**(1/years)-1)*100,max_drawdown_pct:drawdown*100};
}
export function optionExplanation(key,value,market='CN',rules=null){
  const fixed={
    market:{CN:'沪深 A 股，以人民币计价；本研究不含北交所。交易规则与港美股不同，结果需分市场查看。',HK:'港股，以港币计价；历史股票样本来自交易所清单的可用数据，并非全市场无偏样本。',US:'美股，以美元计价；历史股票样本来自交易所清单的可用数据，并非全市场无偏样本。'},
    frequency:{minute:'分钟级日内研究：使用 1 分钟 OHLCV 回测日内买卖，分钟 K 线不含订单簿、排队和亚分钟成交信息；短样本只适合探索。',daily:'日线策略：每天收盘后按完整日线检查条件，最早下一交易日成交；这不等同于高频交易。',longer:'较长周期策略：通常每 21 个交易日重选和调仓；波动仓位仍可能每 5 日更新，实际成交频率以回测记录为准。'},
    'chart-mode':{equity:'把初始净值设为 1，比较资产如何增长；曲线越高并不代表回撤越小。',drawdown:'显示各曲线相对自身历史最高净值的跌幅；越接近 0，历史回撤越小。'},
    reference:{buyhold:'同市场初始合格股票里流动性最高的 100 只，下一交易日一次性买入目标 80% 股票，其余留现金；之后不换股。不是指数基金。',liquidity:'同市场流动性较高的股票篮子，每 21 个交易日重选；与策略使用相同基础费率，但它也在主动换股。',fund:market==='CN'?'华泰柏瑞沪深300ETF（510300.SH）：Tushare 基金日线与复权因子，完整覆盖本轮 A 股历史；一次买入，目标 80% 基金。':market==='HK'?'恒生指数ETF：盈富基金（2800.HK）跟踪恒生指数。使用 AkShare/Sina 前复权日线，覆盖本轮港股历史；分红再投资口径尚未单独对账，收益是近似值。':'SPY 指数基金：冻结分红复权日线只到 2026-05-29，选择后所有策略曲线一起截到该日。',none:'只看策略组合曲线，不叠加参考基准。'},
    'rank-by':{return:'按扣成本年化收益从高到低排列；同时看回撤和交易成本。',total:'按整个历史区间的扣成本累计收益排列；不同长度区间不能直接比较。',drawdown:'按历史最大回撤绝对值从低到高排列；少交易或长期空仓也可能排在前面。',balanced:'按正年化收益 ÷ max(最大回撤绝对值, 1%) 排列。这是展示取舍的自定义指标，不是盈利概率或独立验证。'}
  };
  if(fixed[key])return fixed[key][value]||'';
  const config={selection:value,timing:value,allocation:value,risk_policy:value==='base'?null:value};
  const description=describeStrategy({config})[key==='risk_policy'?'risk':key];
  const basis=key==='selection'?rules?.selection?.[value]?.basis:'';
  const tradeoff={
    selection:{momentum:'可能追随过热股票，行情反转时回撤会放大。',low_vol:'可能错过高波动领涨股，市场普跌时也会亏损。',near_high:'可能在高位买入，需结合买卖规则控制下跌。',defensive_mix:'多因子降低单一指标依赖，但不同市场使用的因子并不完全相同。',earnings_value:'低估值也可能反映真实经营风险，需要检查盈利质量。',dividend_defensive:'高股息可能来自股价大跌，分红也可能变化。',balanced_value:'因子组合降低单一指标依赖，但权重是本项目设定。',smooth_momentum:'平稳上涨并非未来继续上涨的保证。'},
    timing:{monthly:'换手通常较低，但跌势中可能继续持有到下次换股。',trend:'能减少部分下跌敞口，但震荡行情容易反复进出、增加成本。',breakout:'只追确认突破，可能错过早期涨幅，也可能在假突破后亏损。'},
    allocation:{equal:'简单易解释，但没有按个股波动差异分配风险。',inverse_vol:'历史低波动股票权重更高，但过去波动不保证未来安全。',vol08:'风险目标较低时可能大量持有现金，收益也可能降低；8% 不是回撤上限。',vol12:'比 8% 目标通常允许更多股票敞口，也可能承受更大波动。'},
    risk_policy:{base:'不额外限制组合风险，仍有选股和仓位规则本身的限制。',risk06:'目标波动更低可能压低收益；不能保证最大回撤不超过 6%。',risk08:'仓位随估计风险变化；不能保证最大回撤不超过 8%。',cushion07:'遇到跳空下跌仍可能跌破缓冲线，不能保证最大回撤不超过 7%。'}
  }[key]?.[value]||'';
  return [description,tradeoff,basis?'理论依据：'+basis:''].filter(Boolean).join(' ');
}

export function createCourseResearch(root,chart,onExecute){
  const $=id=>root.querySelector('#cr-'+id);
  const el=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
  const pct=v=>Number.isFinite(v)?v.toFixed(2)+'%':'未记录';
  const amount=v=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:2}):'未记录';
  let original,refined,benchmarks,fund,entries=[],current=null,pending=null,comparison=[];
  root.innerHTML=`<article class="panel"><h2>① 组合一套策略</h2>
    <p>选择怎么选股、怎么买卖和分配资金，查看已有历史实验。展开选项后，把鼠标停在任一条或用键盘聚焦，可查看规则与取舍。更改选项读取已保存结果，不会重新回测或下单。</p>
    <div class="course-controls">
      <label>市场<select id="cr-market"><option value="CN">A 股 · CNY</option><option value="HK">港股 · HKD</option><option value="US">美股 · USD</option></select></label>
      <label>策略频率<select id="cr-frequency"><option value="minute">分钟级日内 · 1 分钟</option><option value="daily">日线策略 · 每日检查</option><option value="longer">较长周期 · 定期调仓</option></select></label>
      <label class="cr-daily-only">选股方法<select id="cr-selection"></select></label>
      <label class="cr-daily-only">买卖规则<select id="cr-timing"></select></label>
      <label class="cr-daily-only">仓位分配<select id="cr-allocation"></select></label>
    </div><details class="cr-daily-only"><summary>额外风险控制</summary><label>仓位限制<select id="cr-risk_policy"></select></label></details>
    <p id="cr-status" role="status">正在读取历史研究…</p>
    <p id="cr-frequency-note" class="caption">分钟、日线与较长周期使用不同频率的数据和策略，结果只在各自类别内比较。</p>
    </article>
    <article class="panel" id="cr-minute-panel" hidden><h2>② 分钟级策略对比</h2><p id="cr-minute-provenance" class="caption"></p>
      <div class="form-row"><label>排名依据<select id="cr-minute-rank"><option value="return">账户累计收益最高</option><option value="drawdown">最大回撤最低</option><option value="balanced">收益 / 回撤较均衡</option></select></label></div>
      <p id="cr-minute-warning" class="notice"></p><div id="cr-minute-ranking" class="table-scroll course-ranking-table"></div>
      <div id="cr-minute-chart" class="chart"></div><div id="cr-minute-legend" class="course-chart-legend" role="list" aria-label="分钟净值曲线图例"></div><p id="cr-minute-benchmark" class="caption"></p><div id="cr-minute-cards" class="course-minute-cards"></div>
    </article>
    <article class="panel" id="cr-result" hidden><h2>② 理由与历史效果</h2><h3 id="cr-title"></h3>
      <p id="cr-summary"></p><p id="cr-period" class="caption"></p>
      <div id="cr-metrics" class="mini-metrics"></div><p id="cr-stages" class="caption"></p><details><summary>为什么这样选、怎么买卖、如何分配资金？</summary><div id="cr-rules" class="course-rules"></div></details>
      <div class="form-row"><label>图表<select id="cr-chart-mode"><option value="equity">净值曲线</option><option value="drawdown">回撤曲线</option></select></label><label>参考对照<select id="cr-reference"><option value="buyhold">固定篮子买入持有</option><option value="liquidity">定期换股流动性篮子</option><option value="fund">同市场指数基金</option><option value="none">不显示参考</option></select></label><button id="cr-compare-add">加入曲线（最多 3 套）</button></div>
      <div id="cr-chart-legend" class="course-chart-legend"></div><div id="cr-chart" class="chart"></div><p id="cr-reference-metrics" class="caption"></p><p id="cr-chart-note" class="caption"></p>
      <details><summary>成本、验证与数据范围</summary><div id="cr-evidence"></div></details>
    </article>
    <article class="panel" id="cr-ranking" hidden><div class="panel-head"><h2>③ 同市场组合排序</h2><label>排序依据<select id="cr-rank-by"><option value="return">年化收益最高</option><option value="total">累计收益最高</option><option value="drawdown">最大回撤最低</option><option value="balanced">收益 / 回撤最均衡</option></select></label></div><p id="cr-ranking-note" class="caption"></p><div id="cr-ranking-table" class="table-scroll course-ranking-table"></div></article>
    <article class="panel" id="cr-history-panel" hidden><h2>④ 历史上为什么选、怎么买卖？</h2>
      <p>这里跟随历史日期查看记录，与今天的选股、账户和模拟订单无关。</p><p id="cr-completeness" class="notice"></p>
      <details id="cr-history"><summary>展开历史日期、选股与成交记录</summary><div id="cr-replay"></div></details>
    </article>
    <article class="panel" id="cr-comparison" hidden><div class="panel-head"><h2>曲线中的组合</h2><button id="cr-compare-clear">清空对比</button></div><p>只对比同市场、同历史来源及区间。优先只改变一个模块，检查其对收益、回撤和成本的影响。</p><div id="cr-compare-table" class="table-scroll"></div></article>
    <article class="panel course-next"><p>完成研究后，可带着同一配置进入独立模拟执行页；在那里再读取当前信号、账户与报价。</p><button id="cr-execute" disabled>使用这套配置进入模拟执行 →</button><details><summary>进阶研究工具</summary><div class="actions"><button data-go="daily">原有日线实验档案</button><button data-go="research">单标的自定义回测</button><button data-go="library">分钟短样本实验</button></div></details></article>`;
  const replay=createReplayUI($('replay'),chart);
  let minuteStudy=null;
  const extras={earnings_value:'盈利收益率',dividend_defensive:'红利低波动',balanced_value:'价值动量低波动',smooth_momentum:'平稳中期动量',base:'无额外控制',risk06:'6% 波动目标',risk08:'8% 波动目标',cushion07:'净值缓冲'};
  function label(key,value){return original?.rules[key]?.[value]?.label||extras[value]||value;}
  const pickers=new Map();
  function syncPicker(key){
    const select=$(key),picker=pickers.get(key);if(!select||!picker)return;
    const selected=select.selectedOptions[0];picker.summary.textContent=(selected?.textContent||'请选择')+' ▾';
    picker.list.replaceChildren(...[...select.options].map(option=>{
      const button=el('button',option.textContent);button.type='button';button.className='course-picker-option';button.setAttribute('aria-current',String(option.value===select.value));button.setAttribute('aria-describedby',picker.preview.id);
      const explain=optionExplanation(key,option.value,$('market').value,original?.rules);
      button.title=explain;
      button.onpointerenter=button.onfocus=()=>{picker.preview.textContent=explain;};
      button.onclick=()=>{select.value=option.value;picker.details.open=false;select.dispatchEvent(new Event('change',{bubbles:true}));};
      return button;
    }));
    picker.preview.textContent=optionExplanation(key,select.value,$('market').value,original?.rules);
  }
  function syncPickers(){for(const key of pickers.keys())syncPicker(key);}
  for(const key of ['market','frequency',...dimensions,'chart-mode','reference','rank-by']){
    const select=$(key),parent=select.parentElement,title=parent.firstChild.textContent.trim(),field=el('div','');
    field.className='course-field';for(const cls of parent.classList)field.classList.add(cls);field.append(el('span',title));
    const details=document.createElement('details'),summary=document.createElement('summary'),popover=el('div',''),list=el('div',''),preview=el('p','');
    details.className='course-picker';popover.className='course-picker-popover';list.className='course-picker-list';preview.className='course-picker-preview';preview.id='cr-'+key+'-help';
    popover.append(list,preview);details.append(summary,popover);field.append(select,details);parent.replaceWith(field);select.hidden=true;
    details.addEventListener('toggle',()=>{if(details.open)for(const [other,p] of pickers)if(other!==key)p.details.open=false;});
    details.addEventListener('keydown',event=>{if(event.key==='Escape'){details.open=false;summary.focus();}});
    pickers.set(key,{details,summary,list,preview});
  }
  document.addEventListener('pointerdown',event=>{if(!root.contains(event.target))return;for(const picker of pickers.values())if(picker.details.open&&!picker.details.contains(event.target))picker.details.open=false;});
  syncPickers();
  function showDailyControls(show){
    for(const field of root.querySelectorAll('.cr-daily-only'))field.closest('.course-field')?.toggleAttribute('hidden',!show)??field.toggleAttribute('hidden',!show);
  }
  function renderMinuteStudy(){
    const market=$('market').value;
    minuteStudy=runCourseMinuteStudy(market);
    const {snapshot,params,strategies}=minuteStudy,spec=LIBRARY_MARKETS[market];
    const dates=[...new Set(snapshot.bars.map(bar=>bar.t.slice(0,10)))];
    const instrument=`${snapshot.symbol}（${COURSE_MINUTE_INSTRUMENTS[market]}）`;
    $('minute-provenance').textContent=`${spec.name} · ${instrument} · 1 分钟 OHLCV · ${dates.length} 个交易日（${dates[0]} 至 ${dates.at(-1)}）· ${snapshot.bars.length.toLocaleString('zh-CN')} 根 · ${snapshot.source} · 抓取于 ${snapshot.fetched_at||'日期未记录'}。每个市场目前只有这一个样本标的，不代表全市场。`;
    $('minute-warning').textContent=`样本状态：${strategies[0].validation.status}。${market==='CN'?'A 股 T+1 已按次日开盘后才允许卖出；':'日内持仓按回测规则收盘前退出。'}当前费用按单边 ${params.cost_bps} 基点估算，并用双倍费用做压力测试；这不是完整券商佣金、印花税、买卖价差和冲击成本。分钟线也不含盘口队列或亚分钟成交信息，结果仅用于课堂探索，不证明长期有效。`;
    const ranked=rankMinuteStudies(strategies,$('minute-rank').value),table=document.createElement('table'),head=table.createTHead().insertRow();
    for(const title of ['名次','策略','账户累计收益（扣成本）','策略预算收益','最大回撤','对照基准收益','成交笔数','累计成本','双倍成本收益'])head.append(el('th',title));
    const body=table.createTBody();for(const [index,row] of ranked.entries()){
      const {strategy,result,stressed}=row,tr=body.insertRow(),metric=[String(index+1),strategy.name,pct(result.net/result.initialCapital*100),pct(result.net/result.budget*100),pct(Math.abs(result.maxDrawdown)*100),pct(result.baselineNet/result.initialCapital*100),String(result.orders.length),amount(result.totalCost)+' '+result.currency,pct(stressed.net/stressed.initialCapital*100)];
      for(const value of metric)tr.append(el('td',value));
    }
    $('minute-ranking').replaceChildren(table);
    const colors=['#527347','#b26d39','#7864a5'];
    const pointsByDay=new Map(),series=strategies.map((row,index)=>({key:`m${index}`,name:row.strategy.name,color:colors[index]}));
    series.push({key:'baseline',name:`同标的每日持有基准（${instrument}）`,color:'#627d9b'});
    for(const [index,row] of strategies.entries())for(const point of row.result.curve){
      const day=point.day||String(point.t).slice(0,10),entry=pointsByDay.get(day)||{t:day};
      entry[`m${index}`]=point.equity/row.result.initialCapital;
      if(index===0)entry.baseline=(point.baseline??point.benchmark)/row.result.initialCapital;
      pointsByDay.set(day,entry);
    }
    chart('cr-minute-chart',[...pointsByDay.values()].sort((a,b)=>a.t.localeCompare(b.t)),series,value=>value.toFixed(4));
    $('minute-legend').replaceChildren(...series.map(s=>{const item=el('span','');item.className='course-legend-item';item.setAttribute('role','listitem');const swatch=el('i','');swatch.style.background=s.color;item.append(swatch,el('span',s.name));return item;}));
    const best=strategies[0].result;$('minute-benchmark').textContent=`基准口径：同标的、相同样本期和同一费用设定下每日持有，并遵守市场交易与结算规则；账户初始净值 100,000 ${best.currency}，策略预算 ${amount(best.budget)} ${best.currency}。图中净值均以账户初始资金归一为 1。三种策略使用预设参数，不做自动寻优；排名只说明这段样本的结果。`;
    const cards=strategies.map(({strategy,result,validation,stressed})=>{
      const card=el('article','');card.className='course-minute-card';card.append(el('h3',strategy.name),el('p',strategy.rule));
      const localStamp=new Intl.DateTimeFormat('zh-CN',{timeZone:spec.zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
      const metrics=el('div','');metrics.className='mini-metrics';for(const [name,value] of [
        ['账户净收益',amount(result.net)+' '+result.currency],['预算收益',pct(result.net/result.budget*100)],['最大回撤',pct(Math.abs(result.maxDrawdown)*100)],['累计成本',amount(result.totalCost)+' '+result.currency],['回测成交',`${result.orders.length} 笔`],['双倍成本收益',pct(stressed.net/result.initialCapital*100)]
      ]){const item=el('div','');item.append(el('span',name),el('strong',value));metrics.append(item);}card.append(metrics);
      const note=el('p',`${validation.status}。开发段 ${validation.development?.days??0} 日，检验段 ${validation.holdout?.days??0} 日；成本倍增后仍可能改变结论。`);note.className='caption';card.append(note);
      const details=document.createElement('details'),summary=el('summary','查看模拟买卖记录（不是券商成交）'),wrap=el('div','');
      const orders=result.orders.slice(0,12),orderTable=document.createElement('table'),orderHead=orderTable.createTHead().insertRow();for(const title of ['时间','方向','数量','价格','费用','触发理由'])orderHead.append(el('th',title));
      const orderBody=orderTable.createTBody();for(const order of orders){const tr=orderBody.insertRow();for(const value of [localStamp.format(new Date(order.t))+' '+spec.zone,order.side==='buy'?'买入':'卖出',String(order.qty),amount(order.price),amount(order.cost),order.reason])tr.append(el('td',value));}
      if(!orders.length)wrap.append(el('p','该策略在当前样本没有成交。'));else wrap.append(orderTable);
      if(result.orders.length>orders.length)wrap.append(el('p',`仅显示前 ${orders.length} 笔，共 ${result.orders.length} 笔。`));details.append(summary,wrap);card.append(details);return card;
    });
    $('minute-cards').replaceChildren(...cards);
  }
  function configure(){
    const isMinute=$('frequency').value==='minute';showDailyControls(!isMinute);
    $('minute-panel').hidden=!isMinute;$('result').hidden=isMinute;$('ranking').hidden=isMinute;$('history-panel').hidden=isMinute;$('comparison').hidden=isMinute;
    $('execute').disabled=isMinute;
    $('frequency-note').textContent=isMinute?'当前为分钟级日内研究。只比较所选市场、单一标的和相同历史区间；日线策略不能直接与分钟策略排名。':'日线与较长周期策略按各自决策节奏回测；“每日检查”不等于每天成交，也不等同于高频交易。';
    if(isMinute){current=null;replay.clear();syncPickers();$('status').textContent='已载入三市场分钟快照；当前排名只覆盖所选市场的一只标的和预设参数。';renderMinuteStudy();return;}
    const fundOption=$('reference').querySelector('option[value="fund"]');
    fundOption.textContent={CN:'510300 · 沪深300ETF',HK:'恒生指数ETF · 盈富基金 2800',US:'SPY · 截至 2026-05'}[$('market').value];
    let rows=matchingEntries(entries,{market:$('market').value,frequency:$('frequency').value});
    for(const key of dimensions){
      const old=$(key).value,values=[...new Set(rows.map(e=>e.config[key]||'base'))];
      $(key).replaceChildren(...values.map(value=>{const o=el('option',label(key,value));o.value=value;return o;}));
      if(values.includes(old))$(key).value=old;
      rows=rows.filter(e=>(e.config[key]||'base')===$(key).value);
    }
    current=rows[0]||null;syncPickers();render();
  }
  function draw(){
    if(!current)return;
    const mode=$('chart-mode').value,reference=$('reference').value;
    const shown=comparison.length>=2?comparison:[current,...comparison.filter(e=>e.id!==current.id)];
    const colors=['#527347','#b26d39','#7864a5'],series=shown.map((e,i)=>({key:'s'+i,name:'组合 '+String.fromCharCode(65+i),color:colors[i]}));
    const candidate=reference==='buyhold'?benchmarks?.markets?.[current.market]:reference==='liquidity'?original.markets[current.market].benchmark:reference==='fund'?fund?.markets?.[current.market]:null;
    const b=candidate&&candidate.equity.length<=current.report.dates.length&&(!candidate.dates||candidate.dates.every((d,i)=>d===current.report.dates[i]))?candidate:null;
    if(b)series.push({key:'reference',name:reference==='buyhold'?'固定买入持有':reference==='fund'?b.symbol+' 基金':'流动性换股',color:'#627d9b'});
    const plotDates=b&&reference==='fund'?b.dates:current.report.dates;
    const curves=shown.map(e=>e.report.equity),peaks=curves.map(()=>1);let refPeak=1;
    const points=plotDates.map((t,i)=>{const row={t};for(let j=0;j<curves.length;j++){const v=curves[j][i];peaks[j]=Math.max(peaks[j],v);row['s'+j]=mode==='equity'?v:v/peaks[j]-1;}if(b){const v=b.equity[i];refPeak=Math.max(refPeak,v);row.reference=mode==='equity'?v:v/refPeak-1;}return row;});
    chart('cr-chart',points,series,mode==='equity'?v=>v.toFixed(2):v=>pct(v*100));
    $('chart-legend').replaceChildren(...series.map((s,i)=>{const item=el('span','');item.className='course-legend-item';const swatch=el('i','');swatch.style.background=s.color;item.append(swatch,el('span',i<shown.length?s.name+' · '+shown[i].name:s.name));return item;}));
    $('reference-metrics').textContent=b?.full?reference==='fund'?`共同区间 ${plotDates[0]} 至 ${plotDates.at(-1)}：${shown.map((e,i)=>{const m=intervalMetrics(e.report.equity.slice(0,plotDates.length),plotDates);return `组合 ${String.fromCharCode(65+i)} 年化 ${pct(m.cagr_pct)} / 回撤 ${pct(Math.abs(m.max_drawdown_pct))}`;}).join('；')}；${b.symbol} 年化 ${pct(b.full.cagr_pct)} / 回撤 ${pct(Math.abs(b.full.max_drawdown_pct))}，买入成本 ${amount(b.cost)} ${current.currency}。`: `参考对照：年化 ${pct(b.full.cagr_pct)} · 最大回撤 ${pct(Math.abs(b.full.max_drawdown_pct))} · 累计成本 ${amount(b.cost)} ${current.currency}`:'';
    $('chart-note').textContent=`${current.market} 市场 · ${plotDates[0]} 至 ${plotDates.at(-1)} · 各曲线净值从 1 开始。${!b&&reference!=='none'?'参考数据日期不一致，已停止叠加。':reference==='buyhold'?'买入持有：初始合格股票中流动性前 100 只，目标 80% 股票、20% 现金；只买一次，不调仓，同费率。':reference==='liquidity'?'流动性篮子：每 21 个交易日重选并调仓；不是买入持有或指数基金。':reference==='fund'?`${b.symbol}：目标 80% 基金、其余现金，次日开盘买入一次并计入 ${b.fee_bps} 基点成本，按前日成交额的 1% 限制买入。来源：${b.source}；${b.adjustment}。${plotDates.length<current.report.dates.length?'基金样本较短，所有策略曲线同步截断；上方总指标仍是完整区间。':''}`:'未选择参考对照。'}`;
  }
  function rankings(){
    const market=$('market').value,frequency=$('frequency').value,criterion=$('rank-by').value;
    const rows=rankedEntries(entries,market,frequency,criterion);
    $('ranking').hidden=!rows.length;
    if(!rows.length)return;
    $('ranking-note').textContent=`${market} 市场 · ${frequency==='daily'?'日级检查':'较长周期'} · ${rows[0].report.dates[0]} 至 ${rows[0].report.dates.at(-1)} · 共 ${rows.length} 套。收益和回撤均为扣成本历史结果；“均衡”=正年化收益 ÷ max(最大回撤绝对值, 1%)，负收益排在末尾。最低回撤可能来自少交易或空仓，请结合成交笔数看。排序用于探索，不能当成独立样本选优证明。`;
    const table=document.createElement('table'),head=table.createTHead().insertRow();
    for(const x of ['名次','组合','累计收益','年化收益','最大回撤','均衡值','成交笔数','累计成本','操作'])head.append(el('th',x));
    const body=table.createTBody();for(let i=0;i<rows.length;i++){
      const e=rows[i],tr=body.insertRow(),m=e.report.full;
      for(const v of [String(i+1),e.name,pct(m.total_return_pct),pct(m.cagr_pct),pct(Math.abs(m.max_drawdown_pct)),Number.isFinite(balancedScore(e))?balancedScore(e).toFixed(2):'—',amount(e.report.trade_count),amount(e.report.cost)+' '+e.currency])tr.append(el('td',v));
      const action=tr.insertCell(),button=el('button','查看');button.type='button';button.onclick=()=>selectEntry(e);action.append(button);
    }
    $('ranking-table').replaceChildren(table);
  }
  function selectEntry(entry){
    $('market').value=entry.market;$('frequency').value=courseFrequency(entry.config);
    configure();for(const key of dimensions){$(key).value=entry.config[key]||'base';configure();}
    $('result').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function render(){
    for(const id of ['result','history-panel'])$(id).hidden=!current;
    $('execute').disabled=!current;
    if(!current){$('status').textContent='这个市场与频率暂无已保存组合；未替换为其他策略或编造回测。';replay.clear();return;}
    const r=current.report,m=r.full,e=reportEvidence(current),rules=describeStrategy(current);
    $('status').textContent='已载入历史实验 · '+(courseFrequency(current.config)==='daily'?'日级检查买卖条件':'定期调仓')+' · 未重新计算';
    $('title').textContent=current.name;
    $('summary').textContent=current.config.timing==='monthly'?'每 21 个交易日重选股票，次日开盘调仓；'+(current.config.risk_policy==='cushion07'?'每日检查净值缓冲。':current.config.allocation.startsWith('vol')||current.config.risk_policy?'每 5 个交易日重算风险仓位。':'其余时间持有。'):'每 21 个交易日选股，每日收盘检查'+(current.config.timing==='trend'?'均线':'通道突破')+'条件，下一交易日开盘执行。';
    const hypothesis={momentum:'假设中期相对强势具有延续性；跳过最近一月，减少短期反转对排名的影响。',low_vol:'优先选择过去波动较小的股票，尝试降低组合风险；低波动不等于不会亏损。',near_high:'用接近历史高点衡量相对强势，再由买卖规则决定是否入场。',defensive_mix:'组合多个特征，避免完全依赖单一排名；不同市场的数据条件导致因子内容不同。'};
    const reason=(hypothesis[current.config.selection]||'结合价格或估值特征形成排名，检验组合后的收益与风险取舍。')+' '+(original.rules.selection[current.config.selection]?.basis||'在经典选股思路上组合价格或估值指标，属于本项目的探索性改写，改进效果仍需独立验证。');
    $('rules').replaceChildren(...[['选什么',rules.selection],['怎么买卖',rules.timing],['买多少',rules.allocation],['为什么这样选',reason],['实际频率',current.config.timing==='monthly'&&courseFrequency(current.config)==='longer'?'每 21 个交易日重选；波动目标或额外波动控制每 5 个交易日更新仓位，其余时间持有。':rules.cadence.split('模拟盘')[0]],['额外控制',current.config.risk_policy?rules.risk:'无额外净值缓冲；仓位控制由所选分配方法决定。']].map(([k,v])=>{const p=el('p','');p.append(el('strong',k+'：'),el('span',v));return p;}));
    $('period').textContent=`历史区间 ${r.dates[0]} 至 ${r.dates.at(-1)} · 初始资金 ${amount(e.capital)} ${current.currency} · 固定研究档案，不是实时数据`;
    $('metrics').replaceChildren(...[['扣成本累计收益',pct(m.total_return_pct)],['年化收益',pct(m.cagr_pct)],['最大回撤',pct(Math.abs(m.max_drawdown_pct))],['累计成本 / '+current.currency,amount(e.cost)],['成交笔数',amount(r.trade_count)],['累计成交额 / 初始资金',e.turnover===null?'未记录':e.turnover.toFixed(2)+' 倍']].map(([k,v])=>{const box=el('div','');box.append(el('span',k),el('strong',v));return box;}));
    $('stages').textContent=r.development&&r.review?`分阶段：2025 年化 ${pct(r.development.cagr_pct)}、最大回撤 ${pct(Math.abs(r.development.max_drawdown_pct))}；2026 至今对应 ${pct(r.review.cagr_pct)}、${pct(Math.abs(r.review.max_drawdown_pct))}。两段数据都已用于本项目探索，不是未见样本检验。`:'分阶段结果未保存，不能补算。';
    const meta=original.markets[current.market].metadata;
    const evidence=[`成本模型：单边 ${ {CN:15,HK:20,US:10}[current.market]} 基点，作为费用与执行摩擦的近似；不是完整逐项券商税费模型。累计成本占初始资金 ${pct(e.costPct)}。`,
      '研究比较主要看收益率和风险百分比；本轮固定初始资金 100 万本币。由于每股成交额 1% 的流动性上限是绝对金额，换用更大本金可能改变实际成交与收益；真实交易还受整手、最低佣金、冲击成本约束，因此不能声称资金规模完全无关。',
      '尚无这套组合完整的零成本重跑对照，不能简单把已付费用加回净收益来冒充无成本回测。',
      `${meta.symbols} 个历史代码；${meta.scope}。实际入选股票随历史日期变化。`,
      '2025 年与 2026 年数据均已参与研究探索，不能视为未见过的独立验证。复权价格与可分割份额不等于真实整手成交；波动目标不保证最大回撤。'];
    const extra=refined.markets[current.market];
    if(strategyId(current.market,extra.selected)===current.id)evidence.push(`此配置已有压力结果：双倍成本年化 ${pct(extra.double_cost.full.cagr_pct)}、回撤 ${pct(Math.abs(extra.double_cost.full.max_drawdown_pct))}；延迟一天年化 ${pct(extra.delayed_open.full.cagr_pct)}。`);
    else evidence.push('当前配置没有单独保存的双倍成本及延迟成交测试，不套用其他候选的结果。');
    $('evidence').replaceChildren(...evidence.map(t=>el('p',t)));
    $('completeness').textContent=e.complete?'报告含历史决策与逐笔成交；展开查看所选日期的实际记录。':'旧研究仅保存净值及部分候选名单，不能完整解释每笔买卖。候选不等于持仓；缺失的成交、指标值和触发理由不会从曲线推测。';
    replay.set(portfolioReplay(current));draw();rankings();
  }
  function comparisons(){
    $('comparison').hidden=!comparison.length;
    const table=document.createElement('table'),head=table.createTHead().insertRow();
    for(const x of ['组合','扣成本收益','最大回撤','累计成本','成交笔数'])head.append(el('th',x));
    const body=table.createTBody();for(const e of comparison){const tr=body.insertRow();for(const v of [e.name,pct(e.report.full.total_return_pct),pct(Math.abs(e.report.full.max_drawdown_pct)),amount(e.report.cost)+' '+e.currency,amount(e.report.trade_count)])tr.append(el('td',v));}
    $('compare-table').replaceChildren(table);
    draw();
  }
  for(const key of ['market','frequency',...dimensions])$(key).onchange=()=>{if(key==='market'){comparison=[];comparisons();}configure();};
  $('chart-mode').onchange=()=>{syncPicker('chart-mode');draw();};$('reference').onchange=()=>{syncPicker('reference');draw();};$('rank-by').onchange=()=>{syncPicker('rank-by');rankings();};$('minute-rank').onchange=()=>{if($('frequency').value==='minute')renderMinuteStudy();};
  $('compare-add').onclick=()=>{if(!current)return;if(comparison.some(e=>e.id===current.id)){$('status').textContent='该组合已在对比中。';return;}if(comparison.length>=3){$('status').textContent='最多比较 3 套，请先清空再选择。';return;}if(comparison.some(e=>e.market!==current.market||e.report.dates.join()!==current.report.dates.join())){$('status').textContent='区间不同，不能加入同一对比。';return;}comparison.push(current);comparisons();$('comparison').scrollIntoView({behavior:'smooth',block:'start'});};
  $('compare-clear').onclick=()=>{comparison=[];comparisons();};
  $('execute').onclick=()=>{if(current)onExecute(current.id);};
  return {async load(){
    if(entries.length){draw();return;}
    try{pending??=Promise.all(['/modular-daily-results.json','/daily-refinement.json','/course-benchmarks.json','/course-fund-benchmarks.json'].map(async path=>{const response=await fetch(path);if(!response.ok)throw Error('历史报告暂不可用');return response.json();}));
      [original,refined,benchmarks,fund]=await pending;entries=[...buildPortfolioCatalog(original,refined).values()];for(const e of entries){const history=refined.markets[e.market]?.selection_history?.[e.config.selection];if(!e.report.selection_history.length&&history)e.report.selection_history=history;}configure();
    }catch(e){pending=null;$('status').textContent='读取失败：'+e.message+'。重新打开策略研究可重试。';}
  }};
}
