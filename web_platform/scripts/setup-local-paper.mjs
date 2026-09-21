// Local files only. No cloud login, deployment or broker request.
import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {makePasswordRecord} from '../src/auth.mjs';
const root=new URL('../',import.meta.url),password=randomBytes(18).toString('base64url');
const vars=[
 '# Local paper credentials. Fill only the two Alpaca values; do not commit this file.',
 'ALPACA_PAPER_API_KEY=""','ALPACA_PAPER_API_SECRET=""',
 'AUTH_USERNAME="classroom"',
 "AUTH_PASSWORD_RECORD='"+await makePasswordRecord(password)+"'",
 'BROKER_CREDENTIAL_KEY='+JSON.stringify(randomBytes(32).toString('base64')),
 'MYQUANT_BRIDGE_URL=""','MYQUANT_BRIDGE_SECRET=""',
 '# Longbridge keys are entered in the local webpage after login.'
].join('\n')+'\n';
try {
 await writeFile(new URL('.dev.vars',root),vars,{flag:'wx',mode:0o600});
 await writeFile(new URL('.env.local-login',root),'USERNAME=classroom\nPASSWORD='+password+'\n',{flag:'wx',mode:0o600});
 console.log('已生成 .dev.vars 和 .env.local-login（仅本人可读，均被 Git 忽略）。请在编辑器填写 Alpaca Key；长桥凭证在本地网页填写。');
} catch(e){if(e.code==='EEXIST')console.log('本地配置已存在，未覆盖。');else throw e;}
