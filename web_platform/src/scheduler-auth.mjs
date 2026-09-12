import {requireValue} from './engine.mjs';
const ISSUER='https://token.actions.githubusercontent.com';
let cached=null;
const decode=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
export async function verifyScheduler(request,env,fetcher=fetch){
  requireValue(env.SCHEDULER_REPOSITORY&&env.SCHEDULER_REPOSITORY_ID&&env.SCHEDULER_OWNER_ID&&env.SCHEDULER_AUDIENCE,'后台调度尚未配置',503,'SCHEDULER_UNAVAILABLE');
  const token=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
  requireValue(token.length<20000&&token.split('.').length===3,'调度身份无效',401,'SCHEDULER_UNAUTHORIZED');
  const [h,p,s]=token.split('.');let header,claims;
  try{header=JSON.parse(new TextDecoder().decode(decode(h)));claims=JSON.parse(new TextDecoder().decode(decode(p)));}catch{requireValue(false,'调度身份无效',401,'SCHEDULER_UNAUTHORIZED');}
  const now=Date.now()/1000,repo=env.SCHEDULER_REPOSITORY;
  const subjects=[`repo:${repo}:ref:refs/heads/main`,`repo:${repo.split('/')[0]}@${env.SCHEDULER_OWNER_ID}/${repo.split('/')[1]}@${env.SCHEDULER_REPOSITORY_ID}:ref:refs/heads/main`];
  requireValue(header.alg==='RS256'&&typeof header.kid==='string'&&claims.iss===ISSUER&&claims.aud===env.SCHEDULER_AUDIENCE&&subjects.includes(claims.sub)&&claims.repository===repo&&claims.repository_id===env.SCHEDULER_REPOSITORY_ID&&claims.repository_owner_id===env.SCHEDULER_OWNER_ID&&claims.ref==='refs/heads/main'&&claims.workflow_ref===repo+'/.github/workflows/paper-scheduler.yml@refs/heads/main'&&['schedule','workflow_dispatch','push'].includes(claims.event_name)&&Number.isFinite(claims.exp)&&claims.exp>now&&Number.isFinite(claims.nbf)&&claims.nbf<=now+30&&Number.isFinite(claims.iat)&&claims.iat<=now+30&&now-claims.iat<600,'调度身份不匹配或已过期',401,'SCHEDULER_UNAUTHORIZED');
  let keys=cached?.until>Date.now()?cached.keys:null;
  if(!keys?.some(k=>k.kid===header.kid)){
    const r=await fetcher(ISSUER+'/.well-known/jwks',{redirect:'manual',signal:AbortSignal.timeout(10000)});
    requireValue(r.ok,'无法验证调度签名',503,'SCHEDULER_KEYS_UNAVAILABLE');keys=(await r.json()).keys;
    requireValue(Array.isArray(keys),'无法验证调度签名',503,'SCHEDULER_KEYS_UNAVAILABLE');cached={keys,until:Date.now()+300000};
  }
  const jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA');requireValue(jwk,'调度签名未知',401,'SCHEDULER_UNAUTHORIZED');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  requireValue(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(s),new TextEncoder().encode(h+'.'+p)),'调度签名无效',401,'SCHEDULER_UNAUTHORIZED');
  return {source:'github',run_id:claims.run_id};
}
