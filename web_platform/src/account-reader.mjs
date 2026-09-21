// Coalesce account reads across the home page and broker panel, respecting the
// broker's five-second query interval. Never cache authentication failures.
export function createAccountReader(request,clock=()=>Date.now()){
 let cached=null,pending=null,epoch=0;const catalogPending=new Map();
 return {clear(){epoch++;cached=null;pending=null;catalogPending.clear();},async read(path){
  if(['portfolio/catalog','portfolio/catalog?source=latest','portfolio/catalog?source=reference'].includes(path)){
   const key=path==='portfolio/catalog'?'portfolio/catalog?source=latest':path;
   if(catalogPending.has(key))return catalogPending.get(key);
   const task=Promise.resolve().then(()=>request(key)).finally(()=>{if(catalogPending.get(key)===task)catalogPending.delete(key);});catalogPending.set(key,task);return task;
  }
  if(path!=='longbridge/overview')return request(path);
  if(cached&&clock()-cached.at<5500)return cached.data;
  if(pending)return pending;
  const version=epoch;
  const task=(async()=>{try{
   const data=await request(path);
   if(version===epoch&&data.ok)cached={at:clock(),data};
   if(!data.ok&&cached&&version===epoch)return {...cached.data,stale:true,refresh_error:'本次部分查询失败，保留上次成功结果。'};
   return data;
  }catch(e){
   if(e.status===401||e.status===403){cached=null;throw e;}
   if(cached&&version===epoch)return {...cached.data,stale:true,refresh_error:e.message};
   throw e;
  }finally{if(version===epoch)pending=null;}})();pending=task;return task;
 }};
}
