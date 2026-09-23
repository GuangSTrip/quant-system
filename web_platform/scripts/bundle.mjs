import {existsSync,readFileSync} from 'node:fs';
import {parseSharedLogin} from './shared-demo-login.mjs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
// Stage a complete bundle before replacing an active local Worker.
const outfile=resolve(root,process.env.QUANT_WORKER_OUTFILE||'worker/index.js');
const sharedLogin=existsSync(resolve(root,'.lan/share-website-login.enabled'))?parseSharedLogin(readFileSync(resolve(root,'.env.local-login'),'utf8')):null;
const client=await build({define:{__SHARED_DEMO_LOGIN__:JSON.stringify(sharedLogin)},absWorkingDir:root,entryPoints:['src/app.js'],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',legalComments:'none'});
await build({absWorkingDir:root,entryPoints:['src/server.mjs'],bundle:true,outfile,format:'esm',platform:'browser',target:'es2022',loader:{'.html':'text','.css':'text','.js':'text','.json':'text'},plugins:[{name:'embedded-client',setup(b){b.onLoad({filter:/[\\/]app\.js$/},()=>({contents:client.outputFiles[0].text,loader:'text'}));}}],legalComments:'none'});
console.log('Bundled backend and embedded interface assets.');
