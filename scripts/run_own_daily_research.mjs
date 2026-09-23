// Read-only research launcher. Secrets stay in child environment; never in reports.
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {unseal} from '../web_platform/src/longbridge.mjs';
const root=new URL('../',import.meta.url),web=new URL('web_platform/',root);
function read(name){try{return Object.fromEntries(readFileSync(new URL(name,web),'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(s=>/^[A-Z_]+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).replace(/^['"]|['"]$/g,'')];}));}catch{return {};}}
const vars=read('.dev.vars'),cn=read('.env.myquant-local');
let credentials;
try {const folder=new URL('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/',web);
for(const file of readdirSync(folder).filter(f=>f.endsWith('.sqlite')&&f!=='metadata.sqlite')){
 const db=new DatabaseSync(fileURLToPath(new URL(file,folder)),{readOnly:true});
 try {const row=db.prepare('SELECT ciphertext FROM longbridge_connection WHERE id=1').get();if(row)credentials=await unseal(vars,row.ciphertext);} finally {db.close();}
}}catch {console.log('HK saved credentials unavailable');}
const env={...process.env,PYTHONUTF8:'1',PYTHONPATH:fileURLToPath(root),ALPACA_PAPER_API_KEY:vars.ALPACA_PAPER_API_KEY||'',ALPACA_PAPER_API_SECRET:vars.ALPACA_PAPER_API_SECRET||'',MYQUANT_SIM_TOKEN:cn.MYQUANT_SIM_TOKEN||'',MYQUANT_DATA_TOKEN:cn.MYQUANT_DATA_TOKEN||''};
if(credentials)Object.assign(env,{LONGBRIDGE_APP_KEY:credentials.app_key,LONGBRIDGE_APP_SECRET:credentials.app_secret,LONGBRIDGE_ACCESS_TOKEN:credentials.access_token});
const child=spawn(fileURLToPath(new URL('.venv-data/Scripts/python.exe',root)),['-u','scripts/own_daily_data.py',...process.argv.slice(2)],{cwd:fileURLToPath(root),env,stdio:['inherit','pipe','pipe'],windowsHide:true});
let lastProgress=Date.now();
child.stdout.on('data',data=>{lastProgress=Date.now();process.stdout.write(data);});
child.stderr.on('data',data=>process.stderr.write(data));
const idleTimer=process.argv.includes('--fundamental-collect')?setInterval(()=>{if(Date.now()-lastProgress>20000){console.error('Research collector idle timeout; completed batches are resumable.');child.kill();}},5000):null;
const timer=setTimeout(()=>child.kill(),60*60*1000);
child.on('exit',code=>{clearTimeout(timer);if(idleTimer)clearInterval(idleTimer);process.exit(code??1);});
