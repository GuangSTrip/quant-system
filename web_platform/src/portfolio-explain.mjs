import rawDefinitions from './portfolio-rules.json' with {type:'json'};
const definitions=typeof rawDefinitions==='string'?JSON.parse(rawDefinitions):rawDefinitions;
const cnRules={
 earnings_value:'在满足交易与历史数据要求的股票中，剔除市值最小的 30%，按盈利收益率（正市盈率的倒数）从高到低选最多 30 只。',
 dividend_defensive:'剔除市值最小的 30%，要求盈利且有股息。按股息率排名占 60%、低波动排名占 40% 打分，选最多 30 只。',
 balanced_value:'剔除市值最小的 30%，要求正市盈率；把盈利收益率、半年动量（跳过最近 5 日）、低波动三个排名等权相加，选最多 30 只。',
 smooth_momentum:'剔除市值最小的 30%；半年涨幅（跳过最近 5 日）除以波动率的排名占 50%，近 120 日上涨天数比例的排名占 50%，选最多 30 只。'
};
export function describeStrategy(entry){
 const c=entry.config;
 return {selection:cnRules[c.selection]||definitions.selection[c.selection]?.description||'未提供规则说明',timing:definitions.timing[c.timing]?.description,allocation:definitions.allocation[c.allocation]?.description,
 risk:c.risk_policy==='cushion07'?'按历史重放净值高点的 93% 设置缓冲线，以缓冲比例的 6 倍限制股票仓位，最多 80%。这是仓位规则，不保证回撤不超过 7%。':c.risk_policy?`额外将预计年化波动压向 ${c.risk_policy==='risk06'?'6%':'8%'}；依据历史重放模型计算，不是收益或回撤保证。`:'没有额外的组合缓冲规则，仍需通过交易限额与账户检查。',
 cadence:'每 21 个交易日重选股票；每日收盘检查买卖条件。波动目标或额外风险规则每 5 个交易日还会重算仓位，净值缓冲规则每日检查。模拟盘在信号指定窗口内按条件执行，不保证开盘即成交。'};
}
export function budgetPreview(signal,budget,context=null,now=Date.now()){
 const blockers=[];
 if(!signal)return {rows:[],cash_amount:null,blockers:['尚无最新信号，无法计算股票分配。']};
 if(now>=Date.parse(signal.expires_at))blockers.push('信号已过期，等待后台更新；下表仅供解释旧信号。');
 if(now<Date.parse(signal.execute_after))blockers.push('尚未到信号允许的执行时间。');
 if(!context)blockers.push('尚未读取账户与有效报价，只展示目标金额。');
 else{if(!context.is_open)blockers.push('当前休市，等待开市及有效报价。');if(context.pending)blockers.push('账户存在未完成委托，策略等待订单结束后再执行。');if(context.cash<budget)blockers.push('预算超过账户可用现金；实际买入还需检查资金与卖出回报。');}
 const weights=new Map(signal.targets.map(t=>[t.symbol,t.weight]));
 const symbols=[...new Set([...weights.keys(),...(context?.positions||[]).filter(p=>p.qty>0).map(p=>p.symbol)])];
 const rows=symbols.map(symbol=>{
  const weight=weights.get(symbol)||0,amount=budget*weight,held=context?(context.positions.find(p=>p.symbol===symbol)?.qty||0):null,q=context?.quotes?.[symbol];
  const reliable=!!q&&q.tradable&&Number.isFinite(q.price)&&q.price>0&&Number.isSafeInteger(q.lot)&&q.lot>0;
  const target=weight===0?0:reliable?Math.floor(amount/q.price/q.lot)*q.lot:null;
  const delta=target!==null&&held!==null?target-held:null;
  return {symbol,weight,amount,held,price:reliable?q.price:null,lot:reliable?q.lot:null,target_qty:target,delta,action:delta===null?'待账户 / 报价':delta>0?'预计买入':delta<0?'预计卖出':weight>0&&target===0?'预算不足一手':'保持不变'};
 });
 if(rows.some(r=>r.weight>0&&r.price===null))blockers.push('部分股票没有有效报价，暂不估算股数。');
 const minimums=rows.filter(r=>r.weight>0&&r.price!==null).map(r=>r.price*r.lot/r.weight);
 const minimumBudget=minimums.length?Math.ceil(Math.min(...minimums)*1.003):null;
 if(rows.length&&rows.every(r=>r.target_qty===0)&&rows.some(r=>r.weight>0))blockers.push('当前预算分到每只股票后均不足一手，预计不会买入。按当前价格，预算约需至少 '+minimumBudget.toLocaleString('zh-CN')+' 才可能买入其中一只；最终仍以实时价格与交易限额为准。');

 if(minimumBudget&&rows.some(r=>r.price===null)&&rows.filter(r=>r.price!==null).every(r=>r.target_qty===0))blockers.push('已有有效报价的股票均不足一手；按这些报价至少约需 '+minimumBudget.toLocaleString('zh-CN')+' 的预算才可能买入一只，其余股票需等待报价后判断。');
 return {rows,minimum_budget:minimumBudget,cash_amount:budget*signal.cash_weight,blockers,note:'按输入预算计算目标，不是已提交订单；未计费用、滑点、流动性上限、资金先后释放及全部交易限制。已有运行应结合当前资产与成交账本核对。'};
}
