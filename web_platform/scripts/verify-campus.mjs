import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/HITSZ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin='http://10.250.27.137:8791';
const vars=Object.fromEntries(readFileSync(new URL('../.env.local-login',import.meta.url),'utf8').trim().split(/\r?\n/).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(origin+'/#daily');await page.locator('#sign-in').waitFor({state:'visible'});
 const postHeaders={origin,'content-type':'application/json','x-quant-action':'1'};
 assert.equal((await context.request.post(origin+'/api/v1/orders',{headers:postHeaders,data:{}})).status(),401);
 assert.equal((await context.request.post(origin+'/api/v1/auth/login',{headers:{...postHeaders,origin:'http://foreign.example'},data:{}})).status(),403);
 for(const path of ['/.dev.vars','/__scheduled','/cdn-cgi/handler/scheduled'])assert.equal((await context.request.get(origin+path)).status(),404);
 await page.locator('#sign-in').click();await page.locator('#login-username').fill(vars.USERNAME);await page.locator('#login-password').fill(vars.PASSWORD);
 await page.locator('#login-submit').click();await page.locator('#sign-out').waitFor({state:'visible'});
 let session=await (await context.request.get(origin+'/api/v1/session')).json();assert.equal(session.operator,true);
 const cookie=(await context.cookies()).find(c=>c.name==='quant_lan_session');assert.ok(cookie);assert.equal(cookie.httpOnly,true);assert.equal(cookie.secure,false);assert.equal(cookie.sameSite,'Strict');
 const uuid=await page.evaluate(()=>({secureContext:isSecureContext,id:crypto.randomUUID()}));assert.equal(uuid.secureContext,false);assert.match(uuid.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 await page.reload();assert.equal((await (await context.request.get(origin+'/api/v1/session')).json()).operator,true);
 for(const path of ['portfolio','automation','longbridge/status','cn/status'])assert.equal((await context.request.get(origin+'/api/v1/'+path)).status(),200,path);
 // Invalid preview reaches backend validation without submitting any order.
 const preview=await context.request.post(origin+'/api/v1/orders/preview',{headers:postHeaders,data:{}});assert.equal(preview.status(),400);
 const previewBody=await preview.json();assert.notEqual(previewBody.code,'CSRF');
 const catalog=await (await context.request.get(origin+'/api/v1/portfolio/catalog')).json();assert.equal(catalog.strategies.length,178);assert.ok(catalog.strategies.filter(e=>e.market==='CN').every(e=>e.broker==='myquant'));
 await page.goto(origin+'/#portfolio');await page.locator('#pf-market').waitFor();await page.locator('#pf-market').selectOption('CN');await page.waitForFunction(()=>document.querySelector('#pf-capability')?.textContent.includes('myquant'));assert.equal(await page.locator('#pf-start').isEnabled(),true);
 await page.screenshot({path:fileURLToPath(new URL('../.lan/campus-full.png',import.meta.url)),fullPage:false});
 assert.equal((await context.request.post(origin+'/api/v1/auth/logout',{headers:postHeaders,data:{}})).status(),200);
 assert.equal((await (await context.request.get(origin+'/api/v1/session')).json()).operator,false);
 assert.deepEqual(errors,[]);
 const result={at:new Date().toISOString(),origin,browserLogin:true,sessionAfterReload:true,logout:true,httpCookie:true,csrfBlocked:true,anonymousTradingBlocked:true,devEndpointsBlocked:true,privateFilesBlocked:true,httpUUID:true,authenticatedBusinessReads:true,previewValidation:true,catalogCount:catalog.strategies.length,ordersSubmitted:0};
 writeFileSync(new URL('../.lan/campus-verification.json',import.meta.url),JSON.stringify(result,null,2));console.log(result);
}finally{await browser.close();}
