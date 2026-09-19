import {backtest,strategyConfig,signalAt,ENGINE_VERSION} from './engine.mjs';

const TITLES={sma:'双均线趋势',momentum:'绝对动量',buy_hold:'买入持有'};
const percent=v=>(v*100).toFixed(2)+'%';
const dollars=v=>'$'+Number(v).toLocaleString('en-US',{maximumFractionDigits:2});
export function teachingBars(){
  const bars=[];let day=new Date('2023-01-02T00:00:00Z');
  while(bars.length<320){if(day.getUTCDay()!==0&&day.getUTCDay()!==6){const i=bars.length,c=100+i*.055+12*Math.sin(i/26)+3*Math.sin(i/7),o=(bars.at(-1)?.c||c)+.35*Math.sin(i);bars.push({t:day.toISOString(),o,h:Math.max(o,c)+1,l:Math.min(o,c)-1,c,v:100000});}day=new Date(day.getTime()+86400000);}return bars;
}
export function inspectSignal(bars,c,i){
  const price=bars[i].c,ready=c.type==='buy_hold'||i>=c.slow-1;
  const avg=n=>i>=n-1?bars.slice(i-n+1,i+1).reduce((s,b)=>s+b.c,0)/n:null;
  return {price,ready,fast:c.type==='sma'?avg(c.fast):null,slow:c.type==='sma'?avg(c.slow):null,reference:c.type==='momentum'&&ready?bars[i-c.slow+1].c:null,signal:signalAt(bars,i,c)};
}
export function createStrategyLab({api,chart,onSaved,onAuto}){
  const $=id=>document.getElementById(id),form=$('lab-form');
  let bars=teachingBars(),snapshot=null,sourceSymbol=null,sourceName='教学生成数据',experimentName=null,saved=null,report=null,config=null,loading=false,sequence=0,timer;
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const set=(id,t)=>{$(id).textContent=t;};
  const signature=c=>JSON.stringify(c);
  function readConfig(){const f=form.elements;return strategyConfig({name:experimentName||f.symbol.value+' '+TITLES[f.type.value]+' 图解实验',symbol:f.symbol.value,type:f.type.value,fast:Number(f.fast.value),slow:Number(f.slow.value),allocation:Number(f.allocation.value)/100,days:Number(f.days.value),cost_bps:Number(f.cost_bps.value)});}
  function fill(c){for(const k of ['symbol','type','fast','slow','days','cost_bps'])form.elements[k].value=c[k];form.elements.allocation.value=c.allocation*100;}
  function available(id,yes){const b=$(id);b.dataset.unavailable=yes?'0':'1';b.disabled=!yes||document.getElementById('sign-out').hidden;}
  function savedMatches(){return !!(report&&snapshot&&sourceSymbol===config.symbol&&saved&&signature(saved.config)===signature(config));}
  function access(){available('lab-save',!loading&&!!report&&!!snapshot&&sourceSymbol===config?.symbol);available('lab-auto',!loading&&savedMatches());$('lab-example').disabled=loading;$('lab-load').disabled=loading;$('lab-reports').disabled=loading;}
  function message(t,bad=false){set('lab-message',t);$('lab-message').classList.toggle('negative',bad);}
  function rule(c){if(c.type==='sma')return `比较最近 ${c.fast} 个交易日与 ${c.slow} 个交易日的平均收盘价：短均线更高，就持有；短均线小于或等于长均线，就空仓。`;
    if(c.type==='momentum')return `把最新完整日线收盘价与最近 ${c.slow} 根日线中第一根的收盘价比较：上涨就持有，未上涨就空仓。这个窗口跨 ${c.slow-1} 个交易日间隔。`;
    return '持续给出持有信号。按设定仓位买入后继续持有，不主动发出退出信号；它用作对照基准。';}
  function recompute(){
    try{config=readConfig();if(snapshot&&sourceSymbol!==config.symbol)throw Error('当前快照属于 '+sourceSymbol+'，请获取 '+config.symbol+' 的真实行情后继续。');report=backtest(bars,config);set('lab-rule-title',TITLES[config.type]);set('lab-rule',rule(config));
      set('lab-source-badge',snapshot?'真实历史快照 · 参数可预览':'教学示例 · 非市场数据');
      set('lab-data-label',`${sourceName}${snapshot?' · '+sourceSymbol:''} · ${bars.length} 根日线 · ${bars[0].t.slice(0,10)} — ${bars.at(-1).t.slice(0,10)}。${snapshot?'调整历史天数不会改变已载入快照，需重新获取行情。':'此价格序列为固定教学数据，不代表 SPY 或任何证券的历史表现。'}`);
      set('lab-legend-fast',config.type==='momentum'?'绿色：窗口起点收盘价':'绿色：'+config.fast+' 日均线');
      $('lab-legend-fast').hidden=config.type==='buy_hold';$('lab-legend-slow').hidden=config.type!=='sma';set('lab-legend-slow','金色：'+config.slow+' 日均线');
      const slider=$('lab-day');slider.max=bars.length-1;if(!slider.dataset.ready){slider.value=bars.length-1;slider.dataset.ready='1';}slider.value=Math.min(Number(slider.value),bars.length-1);
      drawPrice();drawDay();renderResults();message(snapshot&&sourceSymbol!==config.symbol?'当前快照属于 '+sourceSymbol+'，尚未切换为 '+config.symbol+'；请获取新标的真实行情。':(config.type!=='sma'?'当前模板不使用快周期。快周期仍需小于慢周期以符合统一参数校验。':''));
    }catch(e){report=null;message(e.message,true);set('lab-result-state','参数无效 · 请修改');for(const id of ['lab-price','lab-metrics','lab-equity','lab-drawdown','lab-script','lab-explain'])$(id).replaceChildren();set('lab-reading','当前输入未产生有效结果。');set('lab-signal','—');set('lab-handoff','请修正参数后继续。');}
    access();
  }
  function drawPrice(){
    const ns='http://www.w3.org/2000/svg',W=900,H=320,L=68,R=18,T=20,B=58;
    const make=(tag,attrs={},text)=>{const n=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;};
    const svg=make('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':'收盘价、策略指标、回测成交与持仓信号。使用下方日期滑块查看具体数值。'});
    const values=bars.flatMap(b=>[b.o,b.c]),low=Math.min(...values)*.96,high=Math.max(...values)*1.04;
    const x=i=>L+i/(bars.length-1)*(W-L-R),y=v=>T+(high-v)/(high-low)*(H-T-B);
    for(let i=0;i<4;i++){const v=low+(high-low)*i/3;svg.append(make('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),stroke:'#e4e5db'}),make('text',{x:L-8,y:y(v)+5,fill:'#6e7266','text-anchor':'end','font-size':14},v.toFixed(0)));}
    const observations=bars.map((b,i)=>inspectSignal(bars,config,i));
    const line=(values,color)=>{let active=false;const path=values.map((v,i)=>{if(v===null){active=false;return '';}const p=(active?'L':'M')+x(i).toFixed(2)+','+y(v).toFixed(2);active=true;return p;}).join(' ');svg.append(make('path',{d:path,fill:'none',stroke:color,'stroke-width':2.2}));};
    line(bars.map(b=>b.c),'#292d25');if(config.type==='sma'){line(observations.map(o=>o.fast),'#527347');line(observations.map(o=>o.slow),'#99771d');}if(config.type==='momentum')line(observations.map(o=>o.reference),'#527347');
    observations.forEach((o,i)=>svg.append(make('rect',{x:x(i),y:H-39,width:(W-L-R)/(bars.length-1)+.2,height:9,fill:!o.ready?'#ffffff':o.signal?'#527347':'#d5d9cc'})));
    const indices=new Map(bars.map((b,i)=>[b.t,i]));for(const trade of report.trades){const i=indices.get(trade.t),xx=x(i),yy=y(trade.price),buy=trade.side==='buy';svg.append(make('path',{d:buy?`M ${xx} ${yy-7} l -5 10 h 10 Z`:`M ${xx} ${yy+7} l -5 -10 h 10 Z`,fill:buy?'#527347':'#b44b45',stroke:'#f8f7f1','stroke-width':1}));}
    for(const i of [0,Math.floor(bars.length/2),bars.length-1])svg.append(make('text',{x:x(i),y:H-8,fill:'#6e7266','font-size':14,'text-anchor':i===0?'start':i===bars.length-1?'end':'middle'},bars[i].t.slice(0,10)));
    svg.append(make('line',{id:'lab-cursor',x1:x(Number($('lab-day').value)),x2:x(Number($('lab-day').value)),y1:T,y2:H-27,stroke:'#68745c','stroke-dasharray':'4 4'}));
    svg.addEventListener('pointerdown',e=>{const box=svg.getBoundingClientRect(),pos=(e.clientX-box.left)/box.width*W;$('lab-day').value=Math.max(0,Math.min(bars.length-1,Math.round((pos-L)/(W-L-R)*(bars.length-1))));drawDay();});
    $('lab-price').replaceChildren(svg);
  }
  function drawDay(){if(!report)return;const i=Number($('lab-day').value),o=inspectSignal(bars,config,i),stamp=bars[i].t.slice(0,10);
    set('lab-day-label',stamp+' · 第 '+(i+1)+' 根日线');set('lab-signal',!o.ready?'历史长度不足':o.signal?'持有信号':'空仓信号');$('lab-signal').className='badge '+(o.ready&&o.signal?'good':'');
    const cursor=$('lab-cursor');if(cursor){const x=68+i/(bars.length-1)*814;cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);}
    let why=!o.ready?`需要至少 ${config.slow} 根完整日线，目前只有 ${i+1} 根，暂不产生持有信号。`:config.type==='sma'?`短均线 ${dollars(o.fast)} ${o.signal?'>':'≤'} 长均线 ${dollars(o.slow)}，因此规则选择${o.signal?'持有':'空仓'}。`:config.type==='momentum'?`收盘价 ${dollars(o.price)} ${o.signal?'>':'≤'} 窗口起点价格 ${dollars(o.reference)}，因此规则选择${o.signal?'持有':'空仓'}。`:'买入持有始终给出持有信号，不使用均线，也没有自动退出规则。';
    const trade=report.trades.find(t=>t.signal_t===bars[i].t),next=bars[i+1];
    const action=trade?`回测下一交易日 ${trade.t.slice(0,10)}：${trade.side==='buy'?'买入':'卖出'} ${trade.qty} 股，开盘价 ${dollars(trade.price)}，成本 ${dollars(trade.cost)}。`:!next?'这是最后一根日线，没有下一日数据验证成交。自动模拟盘仍需开市、仓位和风控检查。':!o.ready?'等待数据积累。':'下一日没有回测成交：可能仓位无需变化、尚在预热阶段或预算不足一股。持有信号不等于每天买入。';
    $('lab-explain').replaceChildren(el('p','',stamp+' 收盘价 '+dollars(o.price)),el('p','',why),el('p','',action));$('lab-prev').disabled=i===0;$('lab-next').disabled=i===bars.length-1;
  }
  function renderResults(){const m=report.metrics,last=report.curve.at(-1),bench=last.benchmark/100000-1,delta=m.total_return-bench;
    const cards=[['策略总收益',percent(m.total_return)],['同仓位持有',percent(bench)],['最大回撤',percent(m.max_drawdown)],['买卖成交笔数',String(m.trade_count)]];
    $('lab-metrics').replaceChildren(...cards.map(([label,v])=>{const n=el('div');n.append(el('span','',label),el('strong','',v));return n;}));
    chart('lab-equity',report.curve,[{key:'equity',name:'策略',color:'#527347'},{key:'benchmark',name:'同仓位持有',color:'#627d9b'}]);chart('lab-drawdown',report.curve,[{key:'drawdown',name:'回撤',color:'#b44b45'}],percent);
    set('lab-result-state',snapshot?(savedMatches()?'已保存真实回测':'真实快照 · 未保存参数预览'):'教学数据计算结果');
    set('lab-reading',`在 ${report.curve[0].t.slice(0,10)} 至 ${last.t.slice(0,10)} 的回测区间，策略收益${delta>=0?'高于':'低于'}同仓位持有 ${Math.abs(delta*100).toFixed(2)} 个百分点，累计模拟成本 ${dollars(m.total_cost)}。${snapshot?'这是该段历史上的结果。':'这些数值只说明规则如何计算，不用于评价实际盈利能力。'}调整慢周期会改变预热长度及可回测区间。`);
    const paragraphs=[`我们研究的是单标的、日频、只做多的 ${TITLES[config.type]} 策略。${rule(config)}`,`本次展示使用${snapshot?sourceName+' 的 '+sourceSymbol+' 历史快照':'固定生成的教学数据，并非真实市场'}，共 ${bars.length} 根日线。回测仓位为 ${percent(config.allocation)}，单边成本为 ${config.cost_bps} 基点。信号只使用已完成日线，回测在下一交易日开盘执行。`,`本次计算总收益为 ${percent(m.total_return)}，同仓位买入持有为 ${percent(bench)}，最大回撤为 ${percent(m.max_drawdown)}，发生 ${m.trade_count} 笔买卖。${snapshot?'这些是历史回测结果，不是模拟账户实际收益。':'教学数值不能作为策略有效的市场证据。'}`,`策略的局限是${config.type==='sma'?'均线反应滞后，横盘时可能反复买卖并累积成本':config.type==='momentum'?'历史涨跌不保证延续，趋势反转时可能退出较晚':'下跌时仍持续持有，缺少策略退出机制'}。调参后的历史表现不等于样本外有效，更不证明未来盈利。`,`真实回测保存后，可以把同一规则带入自动策略页，单独设置预算并授权启动。后台会计算信号、执行风控、提交模拟委托并对账；是否成交以券商回报为准。`];
    $('lab-script').replaceChildren(...paragraphs.map(p=>el('p','',p)));
    set('lab-handoff',!snapshot?'教学数据不能用于启动模拟交易。先获取真实行情，或载入一份真实回测。':sourceSymbol!==config.symbol?'所选标的与快照不同，请先获取该标的真实行情。':savedMatches()?'当前参数已保存。可带入自动策略页；不会自动启动，也不会修改正在运行的策略。':'当前参数有未保存修改。先保存真实快照上的回测，再带入自动策略页。');
  }
  async function operation(fn){if(loading)return;loading=true;form.querySelectorAll('input,select').forEach(n=>n.disabled=true);$('lab-fetch').dataset.busy='1';$('lab-fetch').disabled=true;access();try{await fn();}catch(e){message(e.message,true);}finally{loading=false;form.querySelectorAll('input,select').forEach(n=>n.disabled=false);delete $('lab-fetch').dataset.busy;$('lab-fetch').disabled=$('sign-out').hidden;access();}}
  async function loadReport(r){
    if(r.engine!==ENGINE_VERSION||!r.snapshot_id)throw Error('这份报告不属于当前网页引擎，请重新获取真实行情回测。');
    const data=await api('artifact?kind=dataset&id='+encodeURIComponent(r.snapshot_id));
    if(data.payload.query.symbols!==r.config.symbol)throw Error('报告与数据快照的标的不一致。');
    bars=data.payload.bars;snapshot=r.snapshot_id;sourceSymbol=r.config.symbol;sourceName=data.payload.source||'Alpaca IEX';experimentName=r.config.name;saved=r;fill(r.config);$('lab-day').dataset.ready='';recompute();
  }
  form.addEventListener('input',()=>{clearTimeout(timer);available('lab-auto',false);timer=setTimeout(recompute,120);});
  form.addEventListener('submit',e=>{e.preventDefault();operation(async()=>{clearTimeout(timer);const c=readConfig();message('正在获取真实历史数据并保存回测…');const r=await api('backtests',{config:c});await loadReport(r);await onSaved();message('真实回测已保存。可以逐日讲解，或带入自动策略页。');});});
  $('lab-save').addEventListener('click',()=>operation(async()=>{clearTimeout(timer);const c=readConfig();if(!snapshot||sourceSymbol!==c.symbol)throw Error('请先载入同标的真实数据。');const r=await api('backtests',{config:c,snapshot_id:snapshot});await loadReport(r);await onSaved();message('新参数已保存为独立报告；已有策略运行配置不会改变。');}));
  $('lab-auto').addEventListener('click',()=>operation(async()=>{clearTimeout(timer);recompute();if(!savedMatches())throw Error('请先保存当前参数的真实回测。');await onAuto(saved.id);}));
  $('lab-example').addEventListener('click',()=>{sequence++;bars=teachingBars();snapshot=null;saved=null;sourceSymbol=null;sourceName='教学生成数据';$('lab-day').dataset.ready='';recompute();});
  $('lab-list').addEventListener('click',async()=>{const seq=++sequence;try{const r=await api('artifacts?kind=backtest');if(seq!==sequence)return;const options=r.items.map(r=>{const n=el('option','',r.name+' · '+r.created_at.slice(0,10));n.value=r.id;return n;});$('lab-reports').replaceChildren(...options);message(options.length?'选择报告并点击载入，恢复当时的参数和真实快照。':'尚无已保存回测，请登录后获取真实行情。');}catch(e){message(e.message,true);}});
  $('lab-load').addEventListener('click',()=>operation(async()=>{const id=$('lab-reports').value;if(!id)throw Error('请先选择已保存回测。');const r=await api('artifact?kind=backtest&id='+encodeURIComponent(id));await loadReport({id:r.id,...r.payload});message('已载入真实快照。调参只改变本页预览，保存后才产生新报告。');}));
  $('lab-day').addEventListener('input',drawDay);for(const [id,d]of [['lab-prev',-1],['lab-next',1]])$(id).addEventListener('click',()=>{$('lab-day').value=Number($('lab-day').value)+d;drawDay();});
  $('lab-export').addEventListener('click',()=>{if(!report)return;const text='# 策略课程汇报\n\n'+$('lab-data-label').textContent+'\n\n'+Array.from($('lab-script').children).map(n=>n.textContent).join('\n\n')+'\n\n参数：\n```json\n'+JSON.stringify(config,null,2)+'\n```\n\n数据快照：'+(snapshot||'无，教学生成数据')+'\n报告：'+(savedMatches()?saved.id:'未保存参数预览')+'\n引擎：'+ENGINE_VERSION+'\n';const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'})),a=el('a');a.href=url;a.download='strategy-presentation.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  recompute();return {loadReport};
}
