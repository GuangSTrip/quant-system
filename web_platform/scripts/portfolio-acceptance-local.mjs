import {login,request,logout} from './local-client.mjs';import {readFileSync,existsSync,writeFileSync} from 'node:fs';
const file=new URL('../.lan/portfolio-acceptance-20260921.json',import.meta.url),data=existsSync(file)?JSON.parse(readFileSync(file)):{runs:[],events:[]},mode=process.argv[2];const save=()=>writeFileSync(file,JSON.stringify(data,null,2));
await login();try{
 if(mode==='start-cn-fill'){
  const old=data.runs.find(r=>r.market==='CN'),current=(await request('portfolio')).data.runs.find(r=>r.market==='CN');
  if(!old||current?.run_id!==old.run_id||old.budget!==10000)throw Error('Unexpected CN state');
  for(const action of ['pause','release']){const r=await request('portfolio/'+action,{market:'CN'});if(r.status!==200)throw Error('Cannot '+action);data.events.push({at:new Date().toISOString(),mode:action,market:'CN',data:r.data});save();}
  data.archived_runs=[...(data.archived_runs||[]),old];data.runs=data.runs.filter(r=>r.market!=='CN');
  const row={market:'CN',id:old.id,budget:14500,stage:'prepared'};data.runs.push(row);save();const r=await request('portfolio/start',{strategy_id:row.id,budget:row.budget,confirm:'启动组合自动模拟交易'});row.response={http:r.status,data:r.data};row.run_id=r.data.runs?.find(r=>r.market==='CN')?.run_id;save();console.log(JSON.stringify({market:'CN',http:r.status,run_id:row.run_id,error:r.data.error}));
 }else if(mode==='start'){
  const current=(await request('portfolio')).data;if(current.runs.length)throw Error('Existing runs: do not replace');
  for(const [market,id,budget] of [['CN','CN:momentum:monthly:equal:base',10000],['HK','HK:defensive_mix:monthly:vol12:base',62000]]){
   if(data.runs.some(r=>r.market===market))throw Error('Run already attempted');
   const row={market,id,budget,stage:'prepared'};data.runs.push(row);save();const r=await request('portfolio/start',{strategy_id:id,budget,confirm:'启动组合自动模拟交易'});row.response={http:r.status,data:r.data};row.run_id=r.data.runs?.find(s=>s.market===market)?.run_id;save();console.log(JSON.stringify({market,http:r.status,run_id:row.run_id,error:r.data.error}));
  }
 }else if(mode==='state'){
  const r=await request('portfolio');data.events.push({at:new Date().toISOString(),mode,data:r.data});save();console.log(JSON.stringify({runs:r.data.runs,decisions:r.data.decisions.filter(d=>data.runs.some(r=>r.run_id===d.run_id)).map(d=>({id:d.id,phase:d.phase,orders:d.payload.orders}))}));
 }else if(['pause','resume','tick','liquidate','release'].includes(mode)){
  const market=process.argv[3],saved=data.runs.find(r=>r.market===market),state=(await request('portfolio')).data.runs.find(r=>r.market===market);if(!saved?.run_id||state?.run_id!==saved.run_id)throw Error('Run ownership mismatch');
  const r=await request('portfolio/'+mode,{market,confirm:mode==='liquidate'?'平仓并停止组合':'启动组合自动模拟交易'});data.events.push({at:new Date().toISOString(),mode,market,http:r.status,data:r.data});save();console.log(JSON.stringify({mode,market,http:r.status,ok:r.data.ok,outcome:r.data.outcome,message:r.data.message,error:r.data.error,code:r.data.code}));
 }
}finally{save();await logout();}
