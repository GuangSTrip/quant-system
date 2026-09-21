const rows=async(db,s,...v)=>(await db.prepare(s).bind(...v).all()).results;
export function performance(report){
 const m=report?.full||{},number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const annual=number(m.cagr_pct),draw=number(m.max_drawdown_pct),dd=draw===null?null:Math.abs(draw);
 return {annual,drawdown:dd,total:number(m.total_return_pct),ratio:annual!==null&&dd>0?annual/dd:null,from:report?.dates?.[0]||null,to:report?.dates?.at(-1)||null};
}
export function sortStrategies(items,key='recommended'){
 const direction=key==='drawdown'?1:-1;
 return [...items].sort((a,b)=>{if(key==='recommended')return Number(b.recommended)-Number(a.recommended)||a.name.localeCompare(b.name,'zh-CN');const av=a.metrics?.[key],bv=b.metrics?.[key];return (av==null)-(bv==null)||(av==null?0:direction*(av-bv))||a.name.localeCompare(b.name,'zh-CN');});
}
export async function rankedCatalog(db,catalog,source='latest'){
 // Select latest IDs before touching large replay payloads; parse each JSON once.
 const latest=source==='latest'?await rows(db,`WITH latest AS MATERIALIZED (
 SELECT name,id FROM (SELECT name,id,ROW_NUMBER() OVER(PARTITION BY name ORDER BY created_at DESC,id DESC) rn
 FROM artifacts WHERE kind='portfolio_backtest') WHERE rn=1)
 SELECT a.name,json_extract(a.payload,'$.report.full','$.report.dates[0]','$.report.dates[#-1]','$.source','$.comparison') summary,
 (SELECT json_extract(s.payload,'$.origin') FROM portfolio_signals s WHERE s.strategy_id=a.name ORDER BY s.signal_date DESC LIMIT 1) origin
 FROM latest l JOIN artifacts a ON a.id=l.id`):[];
 const map=new Map(latest.map(r=>{const [full,date_from,date_to,source,comparison]=JSON.parse(r.summary);return [r.name,{...r,report_metrics:JSON.stringify(full),date_from,date_to,source,comparison:comparison&&typeof comparison==='object'?JSON.stringify(comparison):comparison}];}));
 return {ok:true,source,strategies:[...catalog.values()].map(({report,...e})=>{
  const imported=map.get(e.id),selected=source==='reference'?report:imported?{full:JSON.parse(imported.report_metrics),dates:[imported.date_from,imported.date_to]}:null,metrics=performance(selected);
  const provenance=source==='reference'?'original-research':imported?.comparison||JSON.stringify([imported?.origin,imported?.source?.replace(/数据摘要 [a-f0-9]{16}/,'同规则数据摘要')]);
  const cohort=selected?JSON.stringify([e.market,source,metrics.from,metrics.to,provenance]):'missing';
  return {...e,metrics,cohort,comparison_source:source==='reference'?'原始研究对照':'当前股票池历史回测',comparison_legacy:source==='latest'&&!imported?.comparison};
 })};
}
