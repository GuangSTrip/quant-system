import {login,request,logout} from './local-client.mjs';import {writeFileSync,readFileSync} from 'node:fs';
const names=JSON.parse(readFileSync(new URL('../src/stock-names.json',import.meta.url))).names;
await login();try{
 const entries=(await request('portfolio/catalog')).data.strategies,results=[];
 for(let offset=0;offset<entries.length;offset+=4){
  const chunk=await Promise.all(entries.slice(offset,offset+4).map(async e=>{
   const report=await request('portfolio/report?id='+encodeURIComponent(e.id)+'&source=latest'),explanation=await request('portfolio/explanation?id='+encodeURIComponent(e.id));
   const r=report.data.report,s=explanation.data.signal;
   return {id:e.id,market:e.market,report:report.status===200&&r?.dates.length===r?.equity.length&&r?.dates.length>100&&r.equity.every(Number.isFinite),replay:!!r?.decisions?.length,signal:explanation.status===200&&!!s,signal_date:s?.signal_date,missing_names:s?.targets.filter(t=>!names[t.symbol]).map(t=>t.symbol)||[],error:report.data.error||explanation.data.error};
  }));results.push(...chunk);
 }
 const summary={at:new Date().toISOString(),total:results.length,report_pass:results.filter(r=>r.report).length,replay_pass:results.filter(r=>r.replay).length,signal_pass:results.filter(r=>r.signal).length,missing_names:results.flatMap(r=>r.missing_names),failures:results.filter(r=>!r.report||!r.replay||!r.signal)};
 writeFileSync(new URL('../.lan/catalog-acceptance-20260921.json',import.meta.url),JSON.stringify({summary,results},null,2));console.log(JSON.stringify(summary));
}finally{await logout();}
