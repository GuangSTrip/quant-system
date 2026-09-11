import {broker} from './transport.mjs';
const env={ALPACA_PAPER_API_KEY:' fixture-key ',ALPACA_PAPER_API_SECRET:' fixture-secret '};
function check(value,message){if(!value)throw new Error(message);}
export default {async test(){
  let legacyError='';try{new Request('https://paper-api.alpaca.markets/v2/account',{redirect:'error'});}catch(error){legacyError=error.message;}
  check(legacyError.includes('redirect'),'Regression must reproduce the unsupported legacy option');
  const account=await broker(env,'/v2/account');check(account.status==='ACTIVE','GET failed in Workers');
  check((await broker(env,'/v2/stocks/SPY/snapshot',{data:true})).host==='data.alpaca.markets','Data host mismatch');
  const order=await broker(env,'/v2/orders',{method:'POST',payload:{client_order_id:'fixture-id',symbol:'SPY',qty:'1'}});check(order.client_order_id==='fixture-id'&&order.status==='new','POST failed');
  check((await broker(env,'/v2/orders/broker-fixture-order',{method:'DELETE'})).accepted,'DELETE failed');
  check(await broker(env,'/missing',{allow404:true})===null,'404 lookup failed');
  let redirect;try{await broker(env,'/redirect');}catch(error){redirect=error;}check(redirect?.code==='BROKER_REDIRECT','Redirect was not rejected');
  let rejected;try{await broker(env,'/failure');}catch(error){rejected=error;}check(rejected?.brokerStatus===401&&!rejected.message.includes('fixture-secret'),'Broker error or redaction failed');
  console.log('PASS: Workerd GET, data, POST, DELETE, 404, redirect refusal, and error redaction. No external network is used.');
}};
