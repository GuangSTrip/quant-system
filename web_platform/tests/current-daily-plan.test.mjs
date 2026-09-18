import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('active daily page uses a dynamic market screen and blocks expired orders',async()=>{
  const raw=await readFile(new URL('../src/current-daily-plan.json',import.meta.url),'utf8');
  const report=JSON.parse(raw);
  assert.deepEqual(new Set(Object.keys(report.markets)),new Set(['US','HK','CN']));
  assert.equal(report.goal.min_annual_return_pct,8);
  assert.equal(report.goal.max_drawdown_pct,5);
  assert.equal(report.goal.validated,false);
  const cn=report.markets.CN;
  assert.ok(cn.universe.listed>5000&&cn.universe.daily_rows>5000);
  assert.ok(cn.universe.history_screen_size>30);
  assert.ok(cn.universe.history_valid>=20);
  assert.ok(cn.selected.length>0&&cn.selected.length<=5);
  assert.ok(cn.selected.every(x=>x.indicative_shares_at_reference_close>=100&&x.indicative_shares_at_reference_close%100===0));
  assert.equal(cn.status,'expired_daily_open_signal');
  assert.deepEqual(cn.order_intentions,[]);
  assert.equal(cn.broker_submitted,false);
  for(const market of ['US','HK']){
    assert.equal(report.markets[market].status,'data_incomplete');
    assert.deepEqual(report.markets[market].order_intentions,[]);
  }
  assert.ok(!/tushare_token|api_key|access_token/i.test(raw));
});
