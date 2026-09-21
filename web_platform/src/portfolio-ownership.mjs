import {requireValue} from './engine.mjs';

// Broker positions are fungible. Ownership is a local quantity ledger, never a
// broker remark or the account's total holding in a symbol.
export function positionMap(positions){
 const result={};
 for(const p of positions){
  requireValue(typeof p.symbol==='string'&&Number.isFinite(p.qty)&&p.qty>=0,'账户持仓不完整或包含做空持仓，请先核对',409,'POSITION_INVALID');
  result[p.symbol]=(result[p.symbol]||0)+p.qty;
 }
 return result;
}
export function ownedPositions(ledger){
 const owned={};
 for(const o of ledger){
  requireValue(['buy','sell'].includes(o.side)&&Number.isFinite(o.filled)&&o.filled>=0&&(!o.filled||Number.isFinite(o.price)&&o.price>0),'成交账本不完整',409,'RECEIPT_INVALID');
  owned[o.symbol]=(owned[o.symbol]||0)+(o.side==='buy'?1:-1)*o.filled;
 }
 for(const [symbol,qty] of Object.entries(owned)){
  requireValue(qty>=-1e-8,'策略卖出超过自有持仓：'+symbol,409,'POSITION_DRIFT');
  if(Math.abs(qty)<1e-8)delete owned[symbol];
 }
 return owned;
}
export function checkOwnership(context,baseline,owned){
 const actual=positionMap(context.positions);
 for(const symbol of new Set([...Object.keys(actual),...Object.keys(baseline),...Object.keys(owned)])){
  requireValue(Math.abs((actual[symbol]||0)-(baseline[symbol]||0)-(owned[symbol]||0))<1e-8,'账户持仓与原有持仓、策略成交记录不一致：'+symbol+'；已暂停，请核对外部交易或公司行动',409,'POSITION_DRIFT');
 }
}
