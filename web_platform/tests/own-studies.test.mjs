import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {eligibleStudies,studyRules,stockLabel} from '../src/own-studies-ui.mjs';
const read=name=>JSON.parse(readFileSync(new URL('../src/own-research/'+name,import.meta.url),'utf8'));
const manifest=read('manifest.json');
test('offline research remains separate from execution and only lists supported markets',()=>{
 assert.equal(manifest.status,'research_only');assert.equal(manifest.studies.length,10);
 assert.equal(eligibleStudies(manifest,'fundamental','US').length,0);
 assert.equal(eligibleStudies(manifest,'daily','CN').length,2);
 assert.match(stockLabel('SHSE.600036'),/600036/);
});
for(const study of manifest.studies)test(study.id+' preserves selected evidence and chronology',()=>{
 const data=read(study.id+'.json');
 assert.equal(data.execution,'research_only');assert.equal(data.id,study.id);
 assert.equal(data.trades.length,study.trade_count);assert.equal(data.decisions.length,study.decision_count);
 assert.equal(data.selected.trade_count,data.trades.length);
 assert.equal(data.equity[0].date,data.selected.full.start);assert.equal(data.equity.at(-1).date,data.selected.full.end);
 assert.ok(data.equity.every((x,i)=>Number.isFinite(x.equity)&&x.equity>0&&(!i||x.date>data.equity[i-1].date)));
 assert.ok(data.decisions.every(d=>!d.execute_on||d.date<d.execute_on));
 assert.ok(data.trades.every(t=>['buy','sell'].includes(t.side)&&t.units>0&&t.price>0));
 assert.ok(data.trials.some(t=>t.config.name===data.selected.config.name));
 assert.equal(data.selected.verified_target,false);
 assert.ok(studyRules(data.selected.config).every(x=>typeof x==='string'&&!x.includes('undefined')));
 assert.equal(Object.keys(data.source_hashes).length,5);
});
test('financial study does not imply uncollected 2025 financial evidence',()=>{
 const data=read('CN-fundamental-v1.json');assert.equal(data.selected.full.end,'2024-12-31');
 assert.match(studyRules(data.selected.config)[0],/当时已披露/);
});
