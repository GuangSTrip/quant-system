import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {makePasswordRecord} from '../src/auth.mjs';
import {configuration,deploymentURL,withSecrets,checkPaper,verifyDeployment} from './deploy/core.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),directory=resolve(root,'.quant-deploy');
const statePath=resolve(directory,'state.json'),configPath=resolve(directory,'wrangler.json');
const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
const flags=process.argv.slice(2);
if(flags.some(x=>!['--verify','--dry-run','--reset-password'].includes(x))||flags.length>1)throw Error('用法：npm run deploy，或 npm run deploy:verify，或 npm run deploy:check');
async function run(args,{capture=false,interactive=false}={}){
  return new Promise((accept,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',...(interactive?{}:{CI:'true'})},stdio:interactive?'inherit':['ignore','pipe','pipe']});
    let output='',errors='';
    if(!interactive){child.stdout.on('data',chunk=>{output+=chunk;if(!capture)process.stdout.write(chunk);});child.stderr.on('data',chunk=>{errors+=chunk;if(!capture)process.stderr.write(chunk);});}
    child.on('error',()=>reject(Error('无法启动部署工具，请先运行 npm ci')));
    child.on('close',code=>{if(code===0)return accept(output);if(capture)process.stderr.write(errors);reject(Error(`部署步骤失败（退出码 ${code}）。修复上方错误后可重新运行，不会创建新的实例。`));});
  });
}
async function prompt(label,{secret=false,fallback=''}={}){
  if(!process.stdin.isTTY)throw Error('首次配置／登录检查需要交互式终端，请在自己的电脑运行 npm run deploy。');
  let muted=false;
  const output=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk,encoding);done();}});
  const input=createInterface({input:process.stdin,output,terminal:true});
  process.stdout.write(label+(fallback?` [${fallback}]`:'')+': ');
  muted=secret;
  try{return (await input.question('')).trim()||fallback;}finally{muted=false;input.close();if(secret)process.stdout.write('\n');}
}
async function save(state){
  await writeFile(statePath+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});
  await rename(statePath+'.tmp',statePath);
}
async function config(state){await writeFile(configPath,JSON.stringify(configuration(state),null,2)+'\n');}
async function main(){
  if(Number(process.versions.node.split('.')[0])<24)throw Error('请先安装 Node.js 24 或更高版本。');
  await mkdir(directory,{recursive:true,mode:0o700});
  let state;
  try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(flags.includes('--dry-run')){
    await run(['scripts/build.mjs']);
    const path=resolve(directory,'check.json');
    const draft=configuration({name:'quant-local-check',accountId:'0'.repeat(32),username:'check',databaseId:'00000000-0000-0000-0000-000000000000'});
    await writeFile(path,JSON.stringify(draft));
    await run([wrangler,'deploy','--dry-run','--config',path,'--outdir',resolve(directory,'check-output')]);
    console.log('本地部署打包检查通过；未连接云账户或发送订单。');return;
  }
  if(flags.includes('--verify')){
    if(!state?.url)throw Error('没有已记录的网址，请先完成 npm run deploy。');
    const password=await prompt('网站登录密码',{secret:true});
    await verifyDeployment(state.url,{username:state.username,password});
    console.log('在线登录、数据库会话、Paper 账户读取与退出检查通过。未提交订单。');return;
  }
  let who;
  try{who=JSON.parse(await run([wrangler,'whoami','--json'],{capture:true}));}
  catch{await run([wrangler,'login'],{interactive:true});who=JSON.parse(await run([wrangler,'whoami','--json'],{capture:true}));}
  const accounts=who.accounts||[];
  if(!accounts.length)throw Error('Cloudflare 账号没有可用账户，请在控制台完成账户创建。');
  if(!state){
    let account=accounts[0];
    if(accounts.length>1){accounts.forEach((a,i)=>console.log(`${i+1}. ${a.name} (${a.id})`));const index=Number(await prompt('选择 Cloudflare 账户序号',{fallback:'1'}))-1;account=accounts[index];if(!account)throw Error('无效账户序号');}
    const name='quant-course-'+randomBytes(6).toString('hex');
    console.log('创建独立网站：'+name);
    const username=await prompt('新网站登录账号',{fallback:'course'});
    if(!username||username.length>100)throw Error('网站账号必须为 1—100 字符');
    state={version:1,name,username,accountId:account.id,configured:false};configuration(state);await save(state);
  }
  if(!accounts.some(a=>a.id===state.accountId))throw Error('当前 Cloudflare 账号与已有部署不匹配，请登录原账户。');
  if(flags.includes('--reset-password')&&!state?.configured)throw Error('请先完成首次部署，再重置网站密码。');
  let secrets,credentials;
  if(!state.configured){
    const key=await prompt('Alpaca Paper Key ID',{secret:true});
    const secret=await prompt('Alpaca Paper Secret Key',{secret:true});
    if(!key||!secret)throw Error('Key ID 和 Secret Key 均不能为空');
    await checkPaper(key,secret);
    const password=randomBytes(18).toString('base64url');
    credentials={username:state.username,password};
    secrets={ALPACA_PAPER_API_KEY:key,ALPACA_PAPER_API_SECRET:secret,AUTH_PASSWORD_RECORD:await makePasswordRecord(password)};
    console.log(`\n请现在保存新网站登录信息（只在此终端显示）：\n账号：${state.username}\n密码：${password}\n`);
  }
  if(flags.includes('--reset-password')){
    const password=randomBytes(18).toString('base64url');
    credentials={username:state.username,password};
    secrets={AUTH_PASSWORD_RECORD:await makePasswordRecord(password)};
    console.log(`请保存重置后的登录信息：账号 ${state.username}，密码 ${password}`);
  }
  await run(['scripts/build.mjs']);
  await config(state);
  if(!state.databaseId){
    const databases=JSON.parse(await run([wrangler,'d1','list','--json','--config',configPath],{capture:true}));
    const existing=databases.find(d=>d.name===state.name+'-db');
    if(existing)state.databaseId=existing.uuid;
    else{
      await run([wrangler,'d1','create',state.name+'-db','--binding','DB','--update-config','--config',configPath]);
      const generated=JSON.parse(await readFile(configPath,'utf8'));state.databaseId=generated.d1_databases.find(d=>d.binding==='DB')?.database_id;
    }
    if(!state.databaseId)throw Error('未取得数据库 ID，请保留本地配置并重试。');
    await save(state);await config(state);
  }
  await run([wrangler,'d1','migrations','apply','DB','--remote','--config',configPath]);
  const args=[wrangler,'deploy','--config',configPath];
  const output=secrets?await withSecrets(directory,secrets,path=>run([...args,'--secrets-file',path])):await run(args);
  state.url=deploymentURL(output,state.name);state.configured=true;await save(state);
  console.log(`\n网址：${state.url}\n后续更新重新运行 npm run deploy；已有数据库和登录信息会保留。`);
  await verifyDeployment(state.url,credentials);
  console.log(`检查通过：${credentials?'网站登录、数据库会话、退出、':''}Paper 账户／时钟／持仓／订单。请打开网页按「使用说明」操作，首次交易默认暂停。`);
}
main().catch(error=>{console.error('\n'+error.message+'\n若已出现网站网址，部署可能已成功；可稍后运行 npm run deploy:verify 单独复查。');process.exitCode=1;});
