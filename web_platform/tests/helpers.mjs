import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../worker/index.js';

export class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));this.fail=null;}
  withSession(){return this;}
  prepare(sql){const self=this;return {sql,values:[],bind(...values){this.values=values;return this;},run(){if(self.fail?.(sql))throw Error('injected storage failure');const x=self.sqlite.prepare(sql).run(...this.values);return {success:true,meta:{changes:Number(x.changes)}};},first(){if(self.fail?.(sql))throw Error('injected storage failure');return self.sqlite.prepare(sql).get(...this.values)||null;},all(){if(self.fail?.(sql))throw Error('injected storage failure');return {results:self.sqlite.prepare(sql).all(...this.values)};}};}
  async batch(statements){this.sqlite.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.run());this.sqlite.exec('COMMIT');return out;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
  get(sql,...args){return this.sqlite.prepare(sql).get(...args);}
  rows(sql,...args){return this.sqlite.prepare(sql).all(...args);}
  close(){this.sqlite.close();}
}
export function bars(count=180){const end=new Date();end.setUTCHours(4,0,0,0);end.setUTCDate(end.getUTCDate()-1);return Array.from({length:count},(_,i)=>{const c=100+i*.5+Math.sin(i/7)*2;return {t:new Date(end.getTime()-(count-1-i)*86400000).toISOString(),o:c-.2,c,h:c+1,l:c-1,v:50000};});}
export const orderInput=(extra={})=>({symbol:'SPY',side:'buy',type:'limit',qty:1,limit_price:100,time_in_force:'day',confirm:true,idempotency_key:crypto.randomUUID(),...extra});
export const TEST_LOGIN={username:'course_test',password:'fixture-only-password-123'};
const TEST_PASSWORD_RECORD='{"version":1,"iterations":100000,"salt":"bTVAWrQmnE4kq5ANnxB6ZVqnqbVv9qYHSItIxnUBT-U","hash":"Sh3y0ydmvh_wqBu9E0i1thcyJ3k2uBNTOQ_QOfW8L2A"}';
export class Broker {
  constructor(){
    this.calls=[];this.orders=new Map();this.account={currency:'USD',status:'ACTIVE',equity:'100000',last_equity:'100000',cash:'100000',buying_power:'200000',long_market_value:'0',short_market_value:'0',trading_blocked:false,account_blocked:false};
    this.clock={is_open:true,timestamp:new Date().toISOString(),next_open:new Date(Date.now()+86400000).toISOString(),next_close:new Date(Date.now()+3600000).toISOString()};this.positions=[];this.historical=bars();this.onPost=null;this.onGet=null;this.lookupMissing=false;
    this.quote={latestQuote:{t:this.clock.timestamp,ap:100.02,bp:99.98},latestTrade:{t:this.clock.timestamp,p:100},dailyBar:{t:new Date(Date.now()-86400000).toISOString(),c:100},prevDailyBar:{t:new Date(Date.now()-2*86400000).toISOString(),c:99}};
  }
  posts(){return this.calls.filter(c=>c.method==='POST'&&c.url.pathname==='/v2/orders');}
  put(payload,extra={}){const item={...payload,id:crypto.randomUUID(),status:'new',filled_qty:'0',filled_avg_price:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...extra};this.orders.set(item.client_order_id,item);return item;}
  async fetch(url,options={}){
    const u=new URL(url),method=options.method||'GET',payload=options.body?JSON.parse(options.body):null;this.calls.push({url:u,method,payload,headers:options.headers});
    if(!['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(u.origin))throw Error('Forbidden host');
    const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    if(method==='GET'&&this.onGet){const custom=await this.onGet(u);if(custom)return custom;}
    if(method==='POST'&&u.pathname==='/v2/orders'){if(this.onPost)return this.onPost(payload);return response(this.put(payload));}
    if(u.pathname==='/v2/orders:by_client_order_id'){const found=this.lookupMissing?null:this.orders.get(u.searchParams.get('client_order_id'));return found?response(found):response({message:'not found'},404);}
    if(method==='DELETE'){const order=[...this.orders.values()].find(o=>u.pathname==='/v2/orders/'+o.id);if(!order)return response({message:'not found'},404);order.status='canceled';return new Response(null,{status:204});}
    if(u.pathname==='/v2/account')return response(this.account);
    if(u.pathname==='/v2/clock')return response(this.clock);
    if(u.pathname==='/v2/positions')return response(this.positions);
    if(u.pathname==='/v2/orders')return response([...this.orders.values()].filter(o=>u.searchParams.get('status')!=='open'||!['filled','canceled','expired','rejected'].includes(o.status)));
    if(u.pathname.startsWith('/v2/assets/'))return response({id:'fixture-asset-id',symbol:decodeURIComponent(u.pathname.split('/').pop()),tradable:true,status:'active',class:'us_equity'});
    if(u.pathname.endsWith('/snapshot'))return response(this.quote);
    if(u.pathname==='/v2/stocks/bars')return response({bars:{[u.searchParams.get('symbols')]:this.historical},next_page_token:null});
    if(u.pathname==='/v2/account/portfolio/history')return response({timestamp:[1700000000,1700086400],equity:[100000,100050]});
    throw Error('Unexpected request '+method+' '+u.pathname);
  }
}
export function setup(t){
  const db=new D1(),broker=new Broker(),real=globalThis.fetch;
  globalThis.fetch=broker.fetch.bind(broker);
  const env={DB:db,ALPACA_PAPER_API_KEY:'test-paper-key',ALPACA_PAPER_API_SECRET:'test-paper-secret',AUTH_USERNAME:TEST_LOGIN.username,AUTH_PASSWORD_RECORD:TEST_PASSWORD_RECORD};
  t.after(()=>{globalThis.fetch=real;db.close();});
  let sessionCookie=null;
  async function request(path,payload,opts={}){
    if(opts.auth!==false&&!path.startsWith('/api/v1/auth/')&&!sessionCookie){const session=await request('/api/v1/auth/login',TEST_LOGIN,{auth:false});if(session.status!==200)throw Error('Fixture login failed: '+JSON.stringify(session.data));sessionCookie=session.response.headers.get('set-cookie').split(';')[0];}
    const method=payload===undefined?'GET':'POST',headers={'content-type':'application/json',origin:'https://quant.test','x-quant-action':'1',...(opts.auth===false?{}:{cookie:sessionCookie}),...opts.headers};
    const r=await worker.fetch(new Request('https://quant.test'+path,{method,headers,...(payload===undefined?{}:{body:JSON.stringify(payload)})}),opts.env||env);return {status:r.status,data:await r.json(),response:r};
  }
  async function resume(){const r=await request('/api/v1/control',{halted:false,confirm:'恢复模拟盘'});if(r.status!==200)throw Error(JSON.stringify(r.data));return r;}
  return {db,broker,env,request,resume};
}
