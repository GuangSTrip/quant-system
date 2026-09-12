import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const client=await build({absWorkingDir:root,entryPoints:['src/app.js'],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',legalComments:'none'});
await build({absWorkingDir:root,entryPoints:['src/server.mjs'],bundle:true,outfile:resolve(root,'worker/index.js'),format:'esm',platform:'browser',target:'es2022',loader:{'.html':'text','.css':'text','.js':'text','.json':'text'},plugins:[{name:'embedded-client',setup(b){b.onLoad({filter:/\/app\.js$/},()=>({contents:client.outputFiles[0].text,loader:'text'}));}}],legalComments:'none'});
console.log('Bundled backend and embedded interface assets.');
