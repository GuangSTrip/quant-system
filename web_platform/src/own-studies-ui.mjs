import stockNames from './stock-names.json' with {type:'json'};
export const STUDY_FAMILIES={daily:'日线选股与风险控制',alternatives:'反转与趋势多机制',fundamental:'A股盈利质量与估值'};
const marketNames={CN:'A股',HK:'港股',US:'美股'};
const pct=v=>Number.isFinite(v)?(100*v).toFixed(2)+'%':'未记录';
const num=v=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:4}):'未记录';
export function stockLabel(symbol){
 const normalized=symbol.replace(/^SHSE\.(\d+)$/,'$1.SH').replace(/^SZSE\.(\d+)$/,'$1.SZ');
 return (stockNames.names?.[normalized]||'名称暂缺')+'（'+symbol+'）';
}
export function studyRules(config){
 const selection={quality_momentum:'多周期动量与价格走势质量评分；走势质量不是财务质量。',smooth_breakout:'接近历史高点、动量与走势质量联合评分。',defensive_momentum:'60%多周期动量分位与40%低波动分位评分。',distributed_trend:'优先流动性较高、价格站上200日均线且20日均线高于120日均线的股票。',residual_reversal:'筛选近期相对市场异常走弱的股票，研究短期反转。',recovery_reversal:'从长期落后股票中选择近期上涨且站上120日均线的股票。',mechanism_mix:'固定组合：50%分散趋势、25%短期残差反转、25%长期转强。',fundamental_quality:'按当时已披露的利润/资产、利润/权益、经营现金流/资产进行质量评分。',fundamental_value_quality:'50%财务质量与50%正市盈率对应的盈利收益率评分。'}[config.family]||'具体规则见所选配置与研究协议。';
 return [selection,
  `候选范围按当时成交额前 ${config.liquidity_limit} 名筛选，并检查历史数据、波动率和可成交性；不等于整个市场。`,
  `每 ${config.rebalance} 个观察日检查调仓，收盘后决定，最早下一交易日开盘尝试成交；名单变化不等于已经买卖。`,
  `配置持股数 ${config.holdings}；按策略配权，目标波动率 ${pct(config.target_vol)} 只用于降低仓位，最高股票敞口95%。`,
  config.regime?`启用市场广度控制，广度低于 ${pct(config.breadth_floor)} 时减少或退出股票敞口。`:'本配置未启用市场广度仓位控制。',
  config.portfolio_stop>0?`风险周期净值回落 ${pct(config.portfolio_stop)} 后于下一开盘尝试退出，暂停买入 ${config.portfolio_pause} 个观察日；无法成交会重试，阈值不是实际最大回撤上限。`:'本配置未额外启用账户回撤退出机制。'];
}
export function eligibleStudies(manifest,family,market){return manifest.studies.filter(s=>s.family===family&&s.market===market);}
export function createOwnStudiesUI(root,chart){
 const el=(tag,text='')=>{const e=document.createElement(tag);e.textContent=text;return e;};
 const table=(heads,rows)=>{const wrap=el('div');wrap.className='table-scroll';const t=document.createElement('table'),h=t.createTHead().insertRow();heads.forEach(x=>h.append(el('th',x)));const b=t.createTBody();rows.forEach(row=>{const tr=b.insertRow();row.forEach(x=>tr.append(el('td',x)));});wrap.append(t);return wrap;};
 root.innerHTML=`<article class="panel"><span class="badge good">★ 第2组 · 本组自研</span><h2 id="os-title"></h2><p class="notice">历史研究 · 尚未接入自动交易。下面是真实保存的试验结果，不是今天的买入建议。</p><div class="form-row"><label>市场<select id="os-market"><option value="CN">A股 · CNY</option><option value="HK">港股 · HKD</option><option value="US">美股 · USD</option></select></label><label>研究版本<select id="os-version"></select></label><button id="os-retry">重新加载</button></div><p id="os-status" role="status"></p></article>
 <div id="os-content" hidden><article class="panel"><h2>① 这套策略怎么选股、买卖和控制仓位？</h2><div id="os-rules"></div><p id="os-config" class="caption"></p></article>
 <article class="panel"><h2>② 扣除成本后的历史表现</h2><p id="os-period"></p><div id="os-metrics"></div><div id="os-chart" class="chart"></div><p id="os-limits" class="notice"></p><h3>不同历史阶段</h3><div id="os-segments"></div><h3>费用增加或成交延迟时</h3><div id="os-checks"></div></article>
 <article class="panel"><h2>③ 当时选了什么，之后是否成交？</h2><label>历史决策日期<select id="os-date"></select></label><p id="os-decision"></p><div id="os-stocks"></div><h3>计划执行日的实际回测成交</h3><div id="os-decision-trades"></div><p class="caption">数量为复权分数单位，不是券商可下单的整手股数。历史候选与成交分别记录；未成交不补造。</p></article>
 <article class="panel"><h2>④ 逐笔回测成交</h2><div class="actions"><button id="os-prev">上一页</button><span id="os-page"></span><button id="os-next">下一页</button><button id="os-download">下载完整研究记录</button></div><div id="os-trades"></div></article>
 <article class="panel"><h2>⑤ 怎样选定这个版本？</h2><p id="os-selection"></p><div id="os-trials"></div><details><summary>查看早期研究版本</summary><p>早期版本可能使用不同的数据和账本处理，不参加当前版本的直接排名。</p><div id="os-history"></div></details><details><summary>研究依据与数据核对信息</summary><pre id="os-evidence"></pre></details><p class="notice">下一步：目前可以理解规则、查看历史选股与成交、下载复核。自动模拟还需要实时信号、整手数量与95%仓位规则的专门适配；此页面不会启动订单。</p></article></div>`;
 const $=id=>root.querySelector('#os-'+id);
 let manifest=null,family='daily',data=null,page=0,version=0;const cache=new Map();
 async function json(path){const r=await fetch(path,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('研究报告读取失败（'+r.status+'）');return r.json();}
 function tradesTable(rows){return table(['日期','股票名称 / 代码','买卖','复权单位','回测价格','金额','费用与滑点'],rows.map(t=>[t.date,stockLabel(t.symbol),t.side==='buy'?'买入':'卖出',num(t.units),num(t.price),num(t.notional),num((t.commission||0)+(t.tax_exchange||0)+(t.slippage||0))]));}
 function drawPage(){const total=Math.max(1,Math.ceil(data.trades.length/30));page=Math.max(0,Math.min(page,total-1));$('page').textContent=`第 ${page+1} / ${total} 页 · 共 ${data.trades.length} 笔`;$('prev').disabled=page===0;$('next').disabled=page===total-1;$('trades').replaceChildren(tradesTable(data.trades.slice(page*30,page*30+30)));}
 function decision(){const d=data.decisions[Number($('date').value)];if(!d){$('decision').textContent='未保存决策记录';$('stocks').replaceChildren();$('decision-trades').replaceChildren();return;}
  $('decision').textContent=`${d.date} 收盘决策 → 最早 ${d.execute_on||'下一交易日'} 执行；合格股票 ${d.eligible??'未记录'} 只，目标股票仓位 ${pct(d.exposure)}。${d.portfolio_risk_off?'本次处于账户风险退出期。':''}`;
  $('stocks').replaceChildren(table(['历史选股名单'],(d.selected||[]).map(s=>[stockLabel(s)])));if(!d.selected?.length)$('stocks').append(el('p','本次没有选中股票。'));
  const rows=data.trades.filter(t=>t.date===d.execute_on);$('decision-trades').replaceChildren(rows.length?tradesTable(rows):el('p','该计划执行日没有保存的成交；候选名单不是已成交持仓。'));
 }
 function metricRows(rows){return table(['记录','区间','累计收益','年化收益','最大回撤','累计费用'],rows.map(([label,r])=>[label,r?.start&&r?.end?r.start+' 至 '+r.end:'未记录',pct(r?.total_return),pct(r?.cagr),pct(Math.abs(r?.max_drawdown)),num(r?.total_cost)]));}
 function render(){const s=data.selected,c=s.config,m=s.full;
  $('rules').replaceChildren(...studyRules(c).map((x,i)=>el('p',`${i+1}. ${x}`)));$('config').textContent='所选配置：'+c.name;
  $('period').textContent=`${marketNames[data.market]} · ${m.start} 至 ${m.end} · ${m.sessions} 个观察日 · 初始资金100万 ${data.currency}。收益与费用均基于同一个研究账户。`;
  $('metrics').replaceChildren(metricRows([['所选版本',m]]));
  chart('os-chart',data.equity.map(x=>({t:x.date,equity:x.equity})),[{key:'equity',name:'研究账户净值',color:'#527347'}],num);
  $('limits').textContent='研究目标尚未通过验证。'+(s.data_complete?'':'历史数据、证券身份或可成交性仍有缺口。')+'多轮研究已观察后续年份，不能称独立样本外；港股历史池与复权、A股ST/涨跌停、美股更名与公司行动均存在未解决限制。';
  $('segments').replaceChildren(metricRows([['开发期',s.development],['历史复核段',s.validation],['后续已观察历史',s.retrospective_final]]));
  const labels={double_cost:'双倍成本',extra_day_delay:'再延迟一日成交',zero_recovery_stress:'未解决资产零回收',no_breadth_regime:'移除广度控制',no_liquidity_vol_filter:'移除流动性/波动筛选'};
  $('checks').replaceChildren(Object.keys(data.checks).length?metricRows(Object.entries(data.checks).map(([k,v])=>[labels[k]||k,v.full])):el('p','该版本没有保存独立压力结果。'));
  $('date').replaceChildren(...data.decisions.map((d,i)=>{const o=el('option',d.date+' → '+(d.execute_on||'下一交易日'));o.value=i;return o;}));$('date').value=String(Math.max(0,data.decisions.length-1));decision();page=0;drawPage();
  $('selection').textContent=manifest.selection_rule+' 同轮配置均保留，主候选不是按全时期最高收益挑选。';
  $('trials').replaceChildren(metricRows(data.trials.map(t=>[(t.config.name===c.name?'✓ 主候选 · ':'')+t.config.name,t.full])));
  $('history').replaceChildren(data.history.length?metricRows(data.history.map(t=>[t.version,t.full])):el('p','该研究家族没有更早版本记录。'));
  $('evidence').textContent=JSON.stringify({source:data.source,config:c,source_hashes:data.source_hashes,terminal_unresolved_value:s.terminal_unresolved_value,terminal_fee_reserve:s.terminal_fee_reserve,attribution_error:s.attribution_error},null,2);
  $('content').hidden=false;$('status').textContent=`已加载 ${data.decisions.length} 次决策与 ${data.trades.length} 笔回测成交。`;
 }
 async function loadStudy(){const token=++version;$('content').hidden=true;$('status').textContent='正在读取固定研究报告…';data=null;const study=manifest.studies.find(s=>s.id===$('version').value);if(!study){$('status').textContent='该市场尚无此研究。';return;}
  try{const next=cache.get(study.id)||await json(study.path);cache.set(study.id,next);if(token!==version)return;data=next;render();}catch(e){if(token===version)$('status').textContent=e.message+'，请点击重新加载。';}
 }
 function configure(){const rows=eligibleStudies(manifest,family,$('market').value);$('version').replaceChildren(...rows.map(s=>{const o=el('option',s.version==='risk'?'第四轮 · 账户风控方案':s.version==='base'?'第四轮 · 基础方案':s.version==='v5'?'第五轮 · 多机制试验':'财务质量试验');o.value=s.id;return o;}));if(rows.some(s=>s.version==='risk'))$('version').value=rows.find(s=>s.version==='risk').id;return loadStudy();}
 $('market').onchange=configure;$('version').onchange=loadStudy;$('retry').onclick=()=>manifest?loadStudy():load(family);$('date').onchange=decision;$('prev').onclick=()=>{page--;drawPage();};$('next').onclick=()=>{page++;drawPage();};
 $('download').onclick=()=>{if(!data)return;const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download=data.id+'-完整研究记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 async function load(nextFamily){family=nextFamily;$('title').textContent=STUDY_FAMILIES[family];$('market').disabled=family==='fundamental';if(family==='fundamental')$('market').value='CN';
  try{manifest??=await json('/own-studies.json');await configure();}catch(e){$('status').textContent=e.message+'，请点击重新加载。';}}
 return {load};
}
