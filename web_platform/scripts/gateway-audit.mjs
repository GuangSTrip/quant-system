import {appendFile,stat,rename,rm} from 'node:fs/promises';

// Never copy headers, request bodies, URL queries, cookies, or authentication data.
export function auditRecord(event) {
 const row={at:new Date().toISOString(),event:String(event.event||'unknown').slice(0,40),ip:String(event.ip||'').slice(0,64)};
 for(const key of ['method','reason'])if(event[key])row[key]=String(event[key]).slice(0,80);
 if(event.path)row.path=String(event.path).split(/[?#]/,1)[0].slice(0,200);
 for(const key of ['status','ms'])if(Number.isFinite(event[key]))row[key]=event[key];
 return row;
}
export function createGatewayAudit(file,{maxBytes=2*1024*1024,maxQueued=256}={}) {
 let pending=Promise.resolve(),queued=0;
 const state={written:0,dropped:0,errors:0};
 const log=event=>{
  if(queued>=maxQueued){state.dropped++;return;}
  const line=JSON.stringify(auditRecord(event))+'\n';queued++;
  pending=pending.then(async()=>{
   const size=await stat(file).then(s=>s.size,e=>{if(e.code==='ENOENT')return 0;throw e;});
   if(size+Buffer.byteLength(line)>maxBytes){await rm(file+'.previous',{force:true});if(size)await rename(file,file+'.previous');}
   await appendFile(file,line,{mode:0o600});state.written++;
  }).catch(()=>{state.errors++;}).finally(()=>{queued--;});
 };
 return {log,state,flush:()=>pending};
}
