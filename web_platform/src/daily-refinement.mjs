const pct=x=>Number.isFinite(x)?x.toFixed(2)+'%':'—';
const names={CN:'A 股',HK:'港股',US:'美股'};
const oldNames={selection:{momentum:'中期动量',near_high:'接近年内高点',low_vol:'低波动',defensive_mix:'防御型多因子'},timing:{monthly:'每月换股',trend:'120 日均线进出',breakout:'55/20 日通道进出'},allocation:{vol08:'8% 波动目标',vol12:'12% 波动目标',inverse_vol:'波动倒数分配',equal:'等权分配'}};
const label=r=>r.label||['selection','timing','allocation'].map(k=>oldNames[k][r[k]]||r[k]).join(' × ');
export function refinementPoints(dates,current,previous,mode){
  let a=current[0],b=previous[0];
  return dates.map((t,i)=>{a=Math.max(a,current[i]);b=Math.max(b,previous[i]);return {t,current:mode==='drawdown'?100*(current[i]/a-1):current[i]/current[0],previous:mode==='drawdown'?100*(previous[i]/b-1):previous[i]/previous[0]};});
}
export function createRefinement(root,chart){
  let data=null,market='CN',pending=null;
  const $=id=>root.querySelector('#'+id);
  root.innerHTML=`<article class="panel dq-result"><div class="panel-head"><div><p class="eyebrow">本轮改进 · 34 组新增实验</p><h2 id="dr-heading">提高 A 股收益 · 降低港美股回撤</h2></div><span class="badge">历史探索结果</span></div>
    <p id="dr-status" class="notice">读取本轮结果…</p>
    <label>展示方案<select id="dr-choice" aria-label="本轮实验方案"></select></label>
    <div class="dq-controls dr-rules"><div><h3>01 选股 · 买谁</h3><p id="dr-selection"></p></div><div><h3>02 买卖 · 何时进出</h3><p id="dr-timing"></p></div><div><h3>03 仓位 · 买多少</h3><p id="dr-allocation"></p></div></div>
    <div class="table-scroll"><table><thead><tr><th>方案 / 区间</th><th>年化收益</th><th>最大回撤</th><th>累计收益</th></tr></thead><tbody id="dr-metrics"></tbody></table></div>
    <p id="dr-reading" class="notice"></p>
    <div class="panel-head"><div><h3>与上次报告方案对比</h3><p id="dr-period" class="caption"></p></div><label>曲线类型<select id="dr-mode"><option value="equity">资金曲线</option><option value="drawdown">回撤曲线</option></select></label></div>
    <div class="dq-legend"><span><i class="dq-swatch" style="background:#527347"></i> 绿色：当前展示方案</span><span><i class="dq-swatch" style="background:#a4832c"></i> 金色：上次报告方案</span></div><div id="dr-chart" class="chart dq-chart"></div>
    <p id="dr-chart-note" class="caption"></p>
    <details class="dq-details"><summary>展开：成本、成交延迟与研究说明</summary><p id="dr-stress"></p><p id="dr-method" class="caption"></p><p class="caption">每个市场独立从 100 万本币起步，2024 年用于指标预热。含基础交易成本；港美股是已取得数据的股票样本。本轮使用已经看过的历史做比较，未获得新的独立验证，曲线改善不等于未来承诺。</p></details>
    </article>`;
  function draw(){
    const s=data?.markets[market];if(!s)return;
    const all=[s.selected,s.previous,...s.experiments];const r=all.find(x=>x.id===$('dr-choice').value)||s.selected;
    $('dr-heading').textContent=names[market]+' · '+(market==='CN'?'提高收益的取舍':'降低回撤的取舍');
    $('dr-status').textContent=market==='CN'?'A 股本轮候选仍未达到年化 8%；收益改善伴随更大回撤。再迟一天成交，年化降至 '+pct(s.delayed_open.full.cagr_pct)+'，改善尚不稳健。':market==='HK'?'港股本轮候选达到全段年化 8% / 回撤 5% 的参考线；成本加倍后，2026 年单段年化为 '+pct(s.double_cost.review.cagr_pct)+'。不是实盘保证。':'美股保留已有的通道突破组合；新增降风险方案未能同时保住年化 8%。候选成本加倍后全段年化降至 '+pct(s.double_cost.full.cagr_pct)+'。';
    const selection={earnings_value:'历史盈利为正，按盈利 / 股价排序，选前 30 只。',dividend_defensive:'综合股息率（60%）和低波动（40%）排名，选前 30 只。',balanced_value:'盈利收益率、半年动量和低波动排名等权综合，选前 30 只。',smooth_momentum:'半年涨幅 / 波动率，与近 120 日上涨天数比例各占一半，选前 30 只。',near_high:'按收盘价接近过去 252 日高点的程度排序，选前 20 只。',momentum:'按过去约一年涨幅排名、跳过最近一月，选前 20 只。'};
    $('dr-selection').textContent=selection[r.selection]||oldNames.selection[r.selection];
    $('dr-timing').textContent={monthly:'每 21 个交易日重新排名；落选卖出、新入选买入，期间持有。',trend:'每 21 日重选；入选且高于 120 日均线才持有，跌破或落选卖出。',breakout:'入选且突破此前 55 日高点买入；跌破此前 20 日低点或落选卖出。'}[r.timing]+' 收盘判断，下一交易日开盘模拟成交。';
    $('dr-allocation').textContent=r.risk_policy==='cushion07'?'每天按净值距历史高点 93% 参考底线的余额调仓：风险资金为余额的 6 倍，最多 80% 股票。下跌后减仓，可能长期留在现金；7% 不是保证止损线。':r.risk_policy==='risk06'?'低波动股票分得更多，每 5 日把组合预计年化波动限制在 6% 附近，最多 80% 股票，其余现金。6% 是波动目标，不是回撤上限。':r.risk_policy==='risk08'||r.allocation==='vol08'?'低波动股票分得更多，每 5 日按 8% 年化波动目标减仓，最多 80% 股票，其余现金。8% 不是收益或回撤保证。':r.allocation==='vol12'?'低波动股票分得更多，每 5 日按 12% 年化波动目标调整，最多 80% 股票；通常比 8% 目标承担更多风险。':'按波动倒数分配：波动小的多分，最多 80% 股票、单股目标最多 10%；未触发买入的仓位留现金。';
    $('dr-metrics').replaceChildren(...[['上次方案 · 全段',s.previous.full],['当前方案 · 全段',r.full],['当前方案 · 2025 年',r.development],['当前方案 · 2026 年',r.review]].map(([title,m])=>{const tr=document.createElement('tr');for(const v of [title,pct(m.cagr_pct),pct(-m.max_drawdown_pct),pct(m.total_return_pct)]){const td=document.createElement('td');td.textContent=v;tr.append(td);}return tr;}));
    const change=r.full.cagr_pct-s.previous.full.cagr_pct,dd=-r.full.max_drawdown_pct+s.previous.full.max_drawdown_pct;
    $('dr-reading').textContent=`相比上次，全段年化收益${change>=0?'增加':'减少'} ${Math.abs(change).toFixed(2)} 个百分点，最大回撤${dd>=0?'增加':'减少'} ${Math.abs(dd).toFixed(2)} 个百分点。当前方案平均股票仓位 ${pct(r.average_exposure_pct)}。2026 年单段年化 ${pct(r.review.cagr_pct)}，请同时看逐年表现。`;
    $('dr-period').textContent=`${s.dates[0]} 至 ${s.dates.at(-1)}；上次方案：${label(s.previous)}。`;
    const mode=$('dr-mode').value;
    chart('dr-chart',refinementPoints(s.dates,r.equity,s.previous.equity,mode),[{key:'previous',name:'上次报告方案',color:'#a4832c'},{key:'current',name:'当前展示方案',color:'#527347'}],mode==='drawdown'?pct:v=>v.toFixed(2));
    $('dr-chart-note').textContent=mode==='drawdown'?'越接近 0% 越稳，负数表示距此前最高资金水平的跌幅。收紧仓位通常会让下跌变浅，也会削弱上涨。':'两条线都从 1.00 开始，1.10 表示累计赚 10%，不是年化收益。绿色更高表示累计收益更多；是否更稳请切换回撤曲线。';
    $('dr-stress').textContent=`以下压力检查只对应“本轮候选”：${s.selected.label}。交易成本加倍：全段年化 ${pct(s.double_cost.full.cagr_pct)} / 回撤 ${pct(-s.double_cost.full.max_drawdown_pct)}；成交再延迟一天：年化 ${pct(s.delayed_open.full.cagr_pct)} / 回撤 ${pct(-s.delayed_open.full.max_drawdown_pct)}。`;
    $('dr-method').textContent=s.definitions.details+' 选择口径：A 股在全段回撤 ≤10%、2026 年收益非负中选全段年化较高者；港股在全段回撤 ≤5%、全段及 2026 年年化 ≥8% 中选全段收益较高者；美股在全段年化 ≥8%、2026 年收益非负中选回撤较低者。均为事后探索选择。';
  }
  function show(){
    const s=data?.markets[market];if(!s)return;
    const seen=new Set();const rows=[[s.selected,'本轮候选：'],[s.previous,'上次方案：'],...s.experiments.map(r=>[r,'实验：'])].filter(([r])=>!seen.has(r.id)&&seen.add(r.id));
    $('dr-choice').replaceChildren(...rows.map(([r,prefix])=>{const o=document.createElement('option');o.value=r.id;o.textContent=prefix+label(r);return o;}));draw();
  }
  $('dr-choice').onchange=draw;$('dr-mode').onchange=draw;
  return {async open(code){market=code;try{if(!data){pending??=fetch('/daily-refinement.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('结果暂不可用');return r.json();});data=await pending;}show();}catch(e){pending=null;$('dr-status').textContent='本轮研究加载失败：'+e.message;}}};
}
