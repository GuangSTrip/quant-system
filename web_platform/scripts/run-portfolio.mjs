import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {unseal} from '../src/longbridge.mjs';
const root=new URL('../',import.meta.url);
const read=name=>Object.fromEntries(readFileSync(new URL(name,root),'utf8').split(/\r?\n/).filter(s=>/^[A-Z_]+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).replace(/^['"]|['"]$/g,'')];}));
const vars=read('.dev.vars'),login=read('.env.local-login'),cn=read('.env.myquant-local');
const folder=new URL('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/',root);
let credentials;
for(const file of readdirSync(folder).filter(f=>f.endsWith('.sqlite')&&f!=='metadata.sqlite')){
 const db=new DatabaseSync(fileURLToPath(new URL(file,folder)),{readOnly:true});
 try{const row=db.prepare('SELECT ciphertext FROM longbridge_connection WHERE id=1').get();if(row)credentials=await unseal(vars,row.ciphertext);}finally{db.close();}
}
const env={...process.env,PYTHONUTF8:'1',PYTHONPATH:fileURLToPath(new URL('../',root)),QUANT_USERNAME:login.USERNAME,QUANT_PASSWORD:login.PASSWORD,QUANT_CA_FILE:fileURLToPath(new URL('.lan/server-cert.pem',root)),ALPACA_PAPER_API_KEY:vars.ALPACA_PAPER_API_KEY,ALPACA_PAPER_API_SECRET:vars.ALPACA_PAPER_API_SECRET,MYQUANT_SIM_TOKEN:cn.MYQUANT_SIM_TOKEN,...(cn.MYQUANT_DATA_TOKEN?{MYQUANT_DATA_TOKEN:cn.MYQUANT_DATA_TOKEN}:{})};
if(credentials)Object.assign(env,{LONGBRIDGE_APP_KEY:credentials.app_key,LONGBRIDGE_APP_SECRET:credentials.app_secret,LONGBRIDGE_ACCESS_TOKEN:credentials.access_token});
const args=process.argv.slice(2),script=args[0]==='--names'?'scripts/refresh_stock_names.py':args[0]==='--probe'?'scripts/check_market_data.py':'scripts/portfolio_service.py';
const child=spawn(fileURLToPath(new URL('../.venv-data/Scripts/python.exe',root)),['-u',script,...(args[0]==='--names'?[]:args[0]==='--probe'?args.slice(1):['--config','configs/portfolio_service.local.json',...args])],{cwd:fileURLToPath(new URL('../',root)),env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exit(code??1));
