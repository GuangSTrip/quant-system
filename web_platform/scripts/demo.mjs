// Local-only classroom fixture. Never connects to Alpaca or sends a real Paper order.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import worker from '../worker/index.js';
import {setup} from '../tests/helpers.mjs';

const h=setup({after(){}});
// Expose the broker substitute to the UI and API so its receipts cannot be mistaken for Alpaca Paper.
h.env.DEMO_MODE='local-fixture';
const snapshot=JSON.parse(await readFile(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url),'utf8'));
h.env.DEMO_DATA_SOURCE=snapshot.source+' · 公开历史快照';h.env.DEMO_DATA_FETCHED_AT=snapshot.fetched_at;
const allBars=snapshot.bars;h.broker.historical=allBars;
let cash=100000,owned=0;
h.broker.onPost=payload=>{
  const qty=Number(payload.qty),price=Number(payload.limit_price),delta=payload.side==='buy'?qty:-qty;
  owned+=delta;cash-=delta*price;
  h.broker.positions=owned?[{symbol:'SPY',qty:String(owned),market_value:String(owned*price),avg_entry_price:String(price),current_price:String(price),unrealized_pl:'0',unrealized_plpc:'0'}]:[];
  h.broker.account.cash=String(cash);h.broker.account.long_market_value=String(owned*price);h.broker.account.equity=String(cash+owned*price);
  return Response.json(h.broker.put(payload,{status:'filled',filled_qty:payload.qty,filled_avg_price:String(price),filled_at:new Date().toISOString()}));
};
function setReplayBar(signalTime){
  const index=allBars.findIndex(b=>b.t===signalTime),bar=allBars[index];
  if(index<0)throw Error('Replay bar missing: '+signalTime);
  h.broker.historical=allBars.slice(0,index+1);
  h.broker.clock.timestamp=new Date(Date.parse(bar.t)+2*60000).toISOString();
  h.broker.quote.latestQuote={t:h.broker.clock.timestamp,ap:bar.c+.01,bp:bar.c-.01};
  h.broker.quote.latestTrade={t:h.broker.clock.timestamp,p:bar.c};
  h.broker.quote.dailyBar={t:bar.t,c:bar.c};
}
await h.resume();
const report=await h.request('/api/v1/backtests',{config:{name:'SPY 开盘区间突破 · 真实历史分钟线',symbol:'SPY',type:'opening_range_breakout',days:5,budget:2000,opening_minutes:15,threshold_bps:0,cost_bps:10}});
if(!report.data.ok)throw Error(JSON.stringify(report.data));
const comparison=await h.request('/api/v1/backtests',{config:{name:'SPY VWAP 均值回归 · 同一真实数据',symbol:'SPY',type:'vwap_reversion',days:5,budget:2000,opening_minutes:15,threshold_bps:20,cost_bps:10}});
if(!comparison.data.ok)throw Error(JSON.stringify(comparison.data));
const [buy,sell]=report.data.trades.slice(0,2);
if(buy?.side!=='buy'||sell?.side!=='sell')throw Error('No complete buy/sell example in the historical snapshot');
setReplayBar(buy.signal_t);
const started=await h.request('/api/v1/automation/start',{backtest_id:report.data.id,budget:2000,confirm:'启动自动模拟交易'});
if(!started.data.ok)throw Error(JSON.stringify(started.data));
const entered=await h.request('/api/v1/automation/tick',{});
if(entered.data.outcome!=='filled'||owned<=0)throw Error('Replay buy failed: '+JSON.stringify(entered.data));
setReplayBar(sell.signal_t);
const exited=await h.request('/api/v1/automation/tick',{});
if(exited.data.outcome!=='filled'||owned!==0)throw Error('Replay sell failed: '+JSON.stringify(exited.data));
const port=Number(process.env.QUANT_DEMO_PORT||8787);
http.createServer(async(req,res)=>{
  try{
    if(req.url==='/current-daily-plan.json'){
      const current=await readFile(new URL('../src/current-daily-plan.json',import.meta.url));
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(current);return;
    }
    const body=[];for await(const part of req)body.push(part);
    const request=new Request(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body:Buffer.concat(body)}:{})});
    const response=await worker.fetch(request,h.env);
    let bytes=Buffer.from(await response.arrayBuffer());
    if(req.url==='/'&&response.headers.get('content-type')?.includes('text/html'))bytes=Buffer.from(bytes.toString().replace('<body>','<body><div class="local-demo-banner">本地研究页：日线栏目使用真实历史样本；交易相关功能由本地替身回放，并非 Alpaca Paper 实际成交</div>'));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(bytes);
  }catch(error){res.writeHead(500);res.end(error.message);}
}).listen(port,'127.0.0.1',()=>console.log(`Local demo: http://127.0.0.1:${port}/#showcase · ${allBars.length} historical bars · two replay fills`));
