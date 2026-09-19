import {createRefinement} from './daily-refinement.mjs';
const LABELS={CN:'A 股',HK:'港股',US:'美股'};
const pct=x=>Number.isFinite(x)?x.toFixed(2)+'%':'—';
const integer=x=>Number(x).toLocaleString('zh-CN',{maximumFractionDigits:0});
export function drawdownSeries(values){let peak=values[0];return values.map(v=>{peak=Math.max(peak,v);return v/peak-1;});}
export function periodSlice(dates,period){
  const selected=dates.map((date,i)=>({date,i})).filter(x=>period==='full'||(period==='development'?x.date<'2026-01-01':x.date>='2026-01-01'));
  if(!selected.length)return {start:0,end:0,anchor:0};
  const start=selected[0].i,end=selected.at(-1).i+1;
  return {start,end,anchor:Math.max(0,start-1)};
}
export function curveStory(dates,values){
  let peak=values[0],peakAt=0,depth=0,trough=0,from=0;
  values.forEach((v,i)=>{if(v>peak){peak=v;peakAt=i;}const d=v/peak-1;if(d<depth){depth=d;trough=i;from=peakAt;}});
  const recovery=values.findIndex((v,i)=>i>trough&&v>=values[from]);
  return {depth,from:dates[from],trough:dates[trough],recovery:depth<0&&recovery>=0?dates[recovery]:null};
}

export function createDailyWorkbench(root,chart){
  let data=null,market='CN',page=0,visible={strategy:true,control:true,benchmark:true};
  const el=(tag,cls,text)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=text;return x;};
  const $=id=>root.querySelector('#'+id);
  root.innerHTML=`
    <article class="panel dq-intro"><div><p class="eyebrow">DAILY STRATEGY LAB</p><h2>选谁 · 何时买卖 · 买多少</h2><p class="caption">把三个决定拆开，比较它们怎样改变收益和回撤。三市场各从 100 万本币开始。</p></div><span class="badge">历史回测 · 组合研究</span></article>
    <div id="dq-markets" class="dq-market-tabs" role="group" aria-label="研究市场"></div>
    <p id="dq-status" class="caption" role="status">读取回测结果…</p>
    <div id="daily-refinement"></div>
    <details id="dq-original" class="panel dq-details"><summary>展开：原有 48 种组合自由搭配与对照</summary>
    <div class="dq-controls">
      ${[['selection','01','选股','买谁'],['timing','02','买卖','何时进出'],['allocation','03','仓位','买多少']].map(([key,no,label,prompt])=>`<article class="panel dq-control"><div class="dq-step"><span>${no} / ${label}</span><span class="dq-help-wrap"><button type="button" class="dq-help" id="dq-help-${key}" aria-label="解释${label}" aria-describedby="dq-tip-${key}" aria-expanded="false">?</button><span role="tooltip" class="dq-tooltip" id="dq-tip-${key}"></span></span></div><label for="dq-${key}">${prompt}</label><select id="dq-${key}"></select><p class="caption" id="dq-desc-${key}"></p></article>`).join('')}
    </div>
    <article class="panel dq-result"><div class="panel-head"><div><p class="eyebrow">当前组合</p><h2 id="dq-title">—</h2></div><button id="dq-reset" type="button">查看按 2025 年选出的候选</button></div>
      <div class="form-row dq-options"><label>观察区间<select id="dq-period"><option value="review">2026 年 · 后段复核</option><option value="development">2025 年 · 开发比较</option><option value="full">全部回测期间</option></select></label><label>参考目标<select id="dq-goal"><option value="8,10">年化 ≥8% / 回撤 ≤10%</option><option value="8,5">原目标：年化 ≥8% / 回撤 ≤5%</option><option value="6,10">年化 ≥6% / 回撤 ≤10%</option></select></label></div>
      <p id="dq-verdict" class="notice"></p>
      <div class="mini-metrics dq-metrics"><div><span>年化收益 <span class="dq-term" tabindex="0" title="把本段实际累计收益按时间折算为一年的增长率；不足一年的年化值不等于已经赚到这么多。">ⓘ</span></span><strong id="dq-cagr">—</strong></div><div><span>最大回撤 <span class="dq-term" tabindex="0" title="净值从此前最高点到随后低点的最大跌幅；此处展示当前观察区间内的回撤。">ⓘ</span></span><strong id="dq-dd">—</strong></div><div><span>实际累计收益</span><strong id="dq-total">—</strong></div><div><span>平均股票仓位 <span class="dq-term" tabindex="0" title="每天股票市值占总资产的比例再取平均。比如 35% 约表示平均每 100 万资产中有 35 万持有股票，余下持有现金。">ⓘ</span></span><strong id="dq-exposure">—</strong></div></div>
      <div class="panel-head"><div><h3 id="dq-plot-title">资金曲线</h3><p id="dq-plot-caption" class="caption"></p></div><label>曲线类型<select id="dq-mode"><option value="equity">资金曲线 · 看赚赔</option><option value="drawdown">回撤曲线 · 看下跌</option><option value="exposure">仓位曲线 · 看资金分配</option></select></label></div>
      <div id="dq-legend" class="dq-legend" role="group" aria-label="显示或隐藏对照曲线"></div>
      <div id="dq-chart" class="chart dq-chart"></div><p class="caption">点图例可隐藏或显示曲线；鼠标移动到图上可查看日期和数值。</p>
      <div class="dq-reading"><h3>这张图说明什么</h3><div id="dq-analysis" aria-live="polite"></div></div>
    </article>
    <details class="panel dq-details"><summary>展开：各组合比较与逐年表现</summary><p class="caption">每个市场 48 个组合。默认按 2025 年风险收益比排序；候选的选择只使用 2025 年，后段用于复核。两段均已用于这次探索，仍需新的历史区间验证。</p><div class="form-row"><label>排序依据<select id="dq-sort"><option value="dev">2025 年风险收益比</option><option value="return">当前区间年化收益</option><option value="drawdown">当前区间回撤从小到大</option></select></label><label>选股筛选<select id="dq-filter"><option value="all">全部选股方式</option></select></label></div><div class="table-scroll dq-table"><table><thead><tr><th>选股</th><th>买卖</th><th>仓位</th><th>2025 年化 / 回撤</th><th>2026 年化 / 回撤</th><th>操作</th></tr></thead><tbody id="dq-combos"></tbody></table></div><div class="dq-pagination"><button id="dq-prev" type="button">上一页</button><span id="dq-page"></span><button id="dq-next" type="button">下一页</button></div></details>
    <details class="panel dq-details"><summary>展开：规则依据、市场区别与数据范围</summary><p id="dq-coverage" class="caption"></p><p id="dq-market-explanation"></p><p id="dq-basis" class="caption"></p><p>这些方向有主流研究基础，但本项目的窗口、持股数、现金仓位及市场限制是具体实现，需要单独验证。没有使用历史财务数据的策略不会标成“质量选股”。</p><ul class="dq-sources"><li><a href="https://www.aqr.com/Insights/Research/Journal-Article/Understanding-Style-Premia" target="_blank" rel="noopener">AQR：动量、价值、防御等风格的研究依据</a></li><li><a href="https://pages.stern.nyu.edu/~jwurgler/papers/wurgler_bradley_baker.pdf" target="_blank" rel="noopener">Baker 等：低波动研究</a></li><li><a href="https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.2004.00695.x" target="_blank" rel="noopener">George–Hwang：52 周高点与动量</a></li><li><a href="https://www.robeco.com/docm/docu-202302-guide-to-conservative-investing.pdf" target="_blank" rel="noopener">Robeco：低风险、动量与派息的组合思路</a></li></ul><p class="caption">模型：收盘信号、下一交易日开盘，单边成本 A 股 0.15%、港股 0.20%、美股 0.10%；按前一日成交额限制模拟成交。采用复权价格与可分割的组合份额，公司行动由供应商复权近似处理，现金不计利息。整手股数、精确税费、真实开盘成交及历史 ST 仍未完整建模。A 股另有保守的 ±4.8% 开盘缺口限制和退市归零处理；它不能替代真实涨跌停检查。美港股包含存续、下载成功及价格质量筛选偏差；单日异常变动超过 65% 的序列被排除，也可能剔除真实大涨大跌。</p><p id="dq-stress" class="caption"></p></details></details>`;

  const refinement=createRefinement($('daily-refinement'),chart);
  function source(){return data?.markets[market];}
  function combo(){const s=source();return s?.combinations.find(x=>x.selection===$('dq-selection').value&&x.timing===$('dq-timing').value&&x.allocation===$('dq-allocation').value);}
  function options(select,records){select.replaceChildren(...Object.entries(records).map(([key,r])=>{const o=el('option','',r.label);o.value=key;return o;}));}
  function choose(id){const r=source().combinations.find(x=>x.id===id);if(!r)return;for(const k of ['selection','timing','allocation'])$('dq-'+k).value=r[k];render();}
  function openMarket(code){
    market=code;page=0;for(const b of $('dq-markets').children){b.classList.toggle('selected',b.dataset.market===market);b.setAttribute('aria-pressed',String(b.dataset.market===market));}
    for(const key of ['selection','timing','allocation'])options($('dq-'+key),data.rules[key]);
    $('dq-filter').replaceChildren(el('option','','全部选股方式'));$('dq-filter').firstChild.value='all';
    for(const [key,r]of Object.entries(data.rules.selection)){const o=el('option','',r.label);o.value=key;$('dq-filter').append(o);}
    choose(source().development_choice.id);
    refinement.open(code);
  }
  function render(){
    const s=source(),r=combo();if(!s||!r)return;
    const period=$('dq-period').value,m=r[period],range=periodSlice(s.dates,period),currency={CN:'元人民币',HK:'港元',US:'美元'}[market];
    const goals=$('dq-goal').value.split(',').map(Number),pass=m.cagr_pct>=goals[0]&&-m.max_drawdown_pct<=goals[1];
    const choice=s.development_choice;
    $('dq-title').textContent=[data.rules.selection[r.selection].label,data.rules.timing[r.timing].label,data.rules.allocation[r.allocation].label].join(' × ');
    $('dq-status').textContent=LABELS[market]+' · '+s.metadata.symbols.toLocaleString('zh-CN')+' 个证券代码 · '+s.metadata.from+' 至 '+s.metadata.to+' · 48 个组合已回测。'+(market==='CN'?'全市场日线与月度估值、股息快照。':'已取得历史数据；来自 '+s.metadata.listed_candidates+' 个清单候选中自动抽样的 '+s.metadata.requested+' 只，不是全市场。');
    for(const key of ['selection','timing','allocation']){
      const rule=data.rules[key][r[key]];
      $('dq-tip-'+key).textContent=rule.description;
      const brief=key==='selection'?(market==='CN'&&r.selection==='defensive_mix'?'低波动中综合股息、估值、动量选股。':r.selection==='defensive_mix'?'低波动加动量；本市场采用价格因子版。':'每次重选排名前 20 只，名单随历史日期变化。'):key==='timing'?(r.timing==='monthly'?'每 21 个交易日换股，期间持续持有。':r.timing==='trend'?'站上均线持有，跌破均线退出。':'突破过去高点才进场，跌破短期低点退出。'):'仓位 = 股票市值 ÷ 总资产。点问号查看资金分配示例。';
      $('dq-desc-'+key).textContent=brief;
    }
    $('dq-verdict').textContent=(pass?'当前区间达到所选参考线。':'当前区间未同时达到所选参考线。')+'区间 '+m.from+' 至 '+m.to+'。'+(r.id===choice.id?(choice.qualified?'此候选在 2025 年达到 8%／10%，随后结果见当前区间。':'2025 年没有组合达到 8%／10%；当前展示当年风险收益比较好的探索候选。'):'当前为手动比较组合。')+'历史结果不代表未来承诺。';
    $('dq-verdict').classList.toggle('dq-pass',pass);
    $('dq-cagr').textContent=pct(m.cagr_pct);$('dq-cagr').className=m.cagr_pct>=0?'positive':'negative';
    $('dq-dd').textContent=pct(-m.max_drawdown_pct);$('dq-total').textContent=pct(m.total_return_pct);
    const exposure=r.exposure.slice(range.start,range.end);const avg=exposure.reduce((a,b)=>a+b,0)/exposure.length;
    $('dq-exposure').textContent=pct(avg*100);
    const control=s.combinations.find(x=>x.selection===r.selection&&x.timing==='monthly'&&x.allocation==='equal');
    const series=[{key:'strategy',name:'当前组合',color:'#527347',result:r},{key:'control',name:'同选股 · 每月等权80%',color:'#627d9b',result:control},{key:'benchmark',name:'流动性对照 · 80%股票',color:'#a4832c',result:s.benchmark}];
    const mode=$('dq-mode').value,dates=s.dates.slice(range.anchor,range.end);
    const points=dates.map(t=>({t}));
    for(const entry of series){const v=entry.result.equity.slice(range.anchor,range.end);const vals=mode==='exposure'?entry.result.exposure.slice(range.anchor,range.end):mode==='drawdown'?drawdownSeries(v):v.map(x=>x/v[0]);vals.forEach((v,i)=>{points[i][entry.key]=v;});}
    $('dq-legend').replaceChildren(...series.map(entry=>{const b=el('button','dq-legend-item');b.type='button';b.setAttribute('aria-pressed',String(visible[entry.key]));const swatch=el('span','dq-swatch');swatch.style.background=entry.color;b.append(swatch,el('span','',entry.name));b.classList.toggle('muted',!visible[entry.key]);b.onclick=()=>{if(visible[entry.key]&&Object.values(visible).filter(Boolean).length===1)return;visible[entry.key]=!visible[entry.key];render();};return b;}));
    const titles={equity:'资金曲线 · 同一起点 1.00',drawdown:'回撤曲线 · 离此前高点有多远',exposure:'仓位曲线 · 有多少资金在股票里'};
    $('dq-plot-title').textContent=titles[mode];
    $('dq-plot-caption').textContent=mode==='equity'?'1.10 表示本段累计上涨 10%。蓝色帮助分辨买卖与仓位的作用，金色是同市场流动性股票对照。':mode==='drawdown'?'0% 表示处在本段新高；−10% 表示从此前高点回落 10%。位置越靠近 0 越稳。':'80% 表示每 100 万本币中约 80 万持有股票；未投入的部分是现金。目标仓位与价格变动后的实际仓位可能不同。';
    // Draw the current strategy last so coincident control lines cannot cover it.
    chart('dq-chart',points,series.filter(x=>visible[x.key]).reverse(),mode==='equity'?(v=>v.toFixed(2)):(v=>pct(v*100)));
    const story=curveStory(dates,r.equity.slice(range.anchor,range.end)),b=s.benchmark[period],c=control[period];
    const lines=[`本段实际累计收益 ${pct(m.total_return_pct)}：若本段起点为 100 万${currency}，终点约 ${integer(1_000_000*(1+m.total_return_pct/100))}${currency}。年化 ${pct(m.cagr_pct)} 是按本段长度折算。`,
      story.depth<0?`最深回撤 ${pct(-story.depth*100)}，从 ${story.from} 的高点到 ${story.trough} 的低点；${story.recovery?'于 '+story.recovery+' 回到该高点。':'到本段结束尚未回到该高点。'}`:'本段净值没有从此前高点下跌；若曲线水平，说明主要保持现金或未触发交易。',
      r.id===control.id?'当前组合与蓝色“同选股对照”完全相同，两条线重合，绿色显示在上层。':`相同选股改用“每月换股、等权80%”后，本段累计收益 ${pct(c.total_return_pct)}、回撤 ${pct(-c.max_drawdown_pct)}；当前买卖与仓位组合改变累计收益 ${(m.total_return_pct-c.total_return_pct).toFixed(2)} 个百分点。`,
      `流动性对照每月选择最多 100 只流动性股票，等权投入 80%、费用相同。本段累计收益 ${pct(b.total_return_pct)}，当前组合相差 ${(m.total_return_pct-b.total_return_pct).toFixed(2)} 个百分点；平均股票仓位 ${pct(avg*100)}，其余现金不计利息。`];
    $('dq-analysis').replaceChildren(...lines.map(t=>el('p','',t)));
    $('dq-coverage').textContent=`${s.metadata.from} 至 ${s.metadata.to}，${s.metadata.sessions} 个交易日，${s.metadata.symbols} 个代码。${s.metadata.scope}。2024 年主要用于指标预热；此页只展示已完成的历史计算。`;
    $('dq-market-explanation').textContent=market==='CN'?'A 股使用历史全市场日线，先按当时的上市时长、成交额筛选，再选最多 20 只。防御型多因子使用历史月末估值和股息快照，滞后到下一交易日才能生效。':market==='HK'?'港股候选来自港元普通股票清单；先过滤流动性，再做低波动、动量等排名。因缺少完整历史财务快照，本次防御多因子只组合价格信号，费用按港股单独设置。':'美股候选来自 Nasdaq 提供的交易所证券清单，剔除 ETF、优先股、权证等，再自动抽样获取历史价格；按美元流动性门槛、独立交易日历及费用回测。';
    $('dq-basis').textContent=data.rules.selection[r.selection].basis;
    const stress=s.cost_stress[period];$('dq-stress').textContent='按 2025 年选出的候选，单边成本加倍后：当前区间年化 '+pct(stress.cagr_pct)+'，最大回撤 '+pct(-stress.max_drawdown_pct)+'。此检查对应默认候选，手动切换其他组合不会改变它。';
    renderTable();
  }
  function renderTable(){
    const s=source(),period=$('dq-period').value,sort=$('dq-sort').value,filter=$('dq-filter').value;
    let rows=s.combinations.filter(r=>filter==='all'||r.selection===filter);
    rows.sort((a,b)=>sort==='dev'?b.development.sharpe-a.development.sharpe:sort==='return'?b[period].cagr_pct-a[period].cagr_pct:b[period].max_drawdown_pct-a[period].max_drawdown_pct);
    const pages=Math.ceil(rows.length/8);page=Math.min(page,Math.max(0,pages-1));
    $('dq-combos').replaceChildren(...rows.slice(page*8,page*8+8).map(r=>{const tr=el('tr');for(const v of [data.rules.selection[r.selection].label,data.rules.timing[r.timing].label,data.rules.allocation[r.allocation].label,pct(r.development.cagr_pct)+' / '+pct(-r.development.max_drawdown_pct),pct(r.review.cagr_pct)+' / '+pct(-r.review.max_drawdown_pct)])tr.append(el('td','',v));const td=el('td'),button=el('button','','展示');button.type='button';button.onclick=()=>{choose(r.id);$('dq-title').scrollIntoView({behavior:'smooth',block:'start'});};td.append(button);tr.append(td);return tr;}));
    $('dq-page').textContent=`${page+1} / ${pages} 页 · ${rows.length} 个组合`;$('dq-prev').disabled=page===0;$('dq-next').disabled=page>=pages-1;
  }
  for(const k of ['selection','timing','allocation']){$('dq-'+k).onchange=render;$('dq-help-'+k).onclick=e=>{const b=e.currentTarget;const expanded=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(expanded));b.parentElement.classList.toggle('open',expanded);};}
  for(const k of ['period','goal','mode'])$('dq-'+k).onchange=render;
  for(const k of ['sort','filter'])$('dq-'+k).onchange=()=>{page=0;renderTable();};
  $('dq-reset').onclick=()=>choose(source().development_choice.id);
  $('dq-prev').onclick=()=>{page--;renderTable();};$('dq-next').onclick=()=>{page++;renderTable();};
  return {async load(){
    if(data){render();return;}
    try{const response=await fetch('/modular-daily-results.json',{cache:'no-cache'});if(!response.ok)throw Error('回测报告暂不可用');data=await response.json();
      $('dq-markets').replaceChildren(...Object.entries(LABELS).filter(([code])=>data.markets[code]).map(([code,label])=>{const b=el('button','dq-market-tab');b.type='button';b.dataset.market=code;b.append(el('strong','',label),el('span','',data.markets[code].metadata.symbols.toLocaleString('zh-CN')+' 个代码 · 48 个组合'));b.onclick=()=>openMarket(code);return b;}));openMarket(market);
    }catch(error){$('dq-status').textContent='历史研究加载失败：'+error.message;}
  }};
}
