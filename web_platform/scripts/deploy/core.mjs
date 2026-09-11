import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
export const PAPER='https://paper-api.alpaca.markets';
export function configuration(state){
  if(!/^[a-z0-9][a-z0-9-]{2,49}$/.test(state.name)||!/^[a-f0-9]{32}$/.test(state.accountId))throw Error('无效的部署名称或 Cloudflare 账户 ID');
  return {name:state.name,account_id:state.accountId,main:'../worker/index.js',compatibility_date:'2026-05-15',workers_dev:true,
    vars:{AUTH_USERNAME:state.username},d1_databases:[{binding:'DB',database_name:state.name+'-db',database_id:state.databaseId,migrations_dir:'../drizzle'}]};
}
export function deploymentURL(output,name){
  const matches=output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/g)||[];
  const url=matches.find(s=>new URL(s).hostname.startsWith(name+'.'));
  if(!url)throw Error('部署命令未返回 workers.dev 网址，请检查 Cloudflare Workers 子域名是否已启用，然后重新运行。');
  return url;
}
export async function withSecrets(directory,secrets,operation){
  const temp=await mkdtemp(join(directory,'upload-'));
  await chmod(temp,0o700);
  const path=join(temp,'secrets.json');
  try {await writeFile(path,JSON.stringify(secrets),{mode:0o600});return await operation(path);}
  finally {await rm(temp,{recursive:true,force:true});}
}
export async function checkPaper(key,secret,request=fetch){
  let response;
  try{response=await request(PAPER+'/v2/account',{headers:{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret},redirect:'manual',signal:AbortSignal.timeout(15000)});}
  catch{throw Error('无法连接 Alpaca Paper，请检查网络后重试。');}
  if(!response.ok)throw Error(`Alpaca Paper 账户检查失败（HTTP ${response.status}），请检查模拟盘 Key ID 与 Secret。`);
  const account=await response.json();
  if(!account.id||account.status!=='ACTIVE'||account.trading_blocked||account.account_blocked)throw Error('模拟账户尚未激活或交易受限。');
}
export async function verifyDeployment(url,credentials,request=fetch){
  const origin=new URL(url).origin;
  if(!origin.startsWith('https://'))throw Error('在线验证需要 HTTPS');
  let cookie;
  async function call(path,body){
    const headers={...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin,'x-quant-action':'1'}:{})};
    const response=await request(origin+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error(`${path} 检查失败（HTTP ${response.status}）`);
    const result=await response.json();
    if(path.endsWith('/login'))cookie=response.headers.get('set-cookie')?.split(';')[0];
    return result;
  }
  try{
    const session=await call('/api/v1/session');
    if(!session.login_enabled||session.auth_mode!=='password')throw Error('网站账号密码未正确配置');
    if(credentials){
      await call('/api/v1/auth/login',credentials);
      if(!cookie||!(await call('/api/v1/session')).operator)throw Error('登录会话检查失败');
    }
    const overview=await call('/api/v1/overview');
    if(!overview.ok)throw Error('网站已发布，但账户／时钟／持仓／订单检查未全部通过。请在网页查看具体错误后运行 npm run deploy:verify。');
    return {login:credentials?'passed':'not_repeated',paper:'passed'};
  }finally{if(cookie)await call('/api/v1/auth/logout',{});}
}
