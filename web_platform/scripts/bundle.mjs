import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
await build({absWorkingDir:root,entryPoints:['src/server.mjs'],bundle:true,outfile:resolve(root,'worker/index.js'),format:'esm',platform:'browser',target:'es2022',loader:{'.html':'text','.css':'text','.js':'text','.json':'text'},legalComments:'none'});
console.log('Bundled backend and embedded interface assets.');
