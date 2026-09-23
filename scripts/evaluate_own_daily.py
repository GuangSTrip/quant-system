"""Run the preregistered grid; select ONLY with development-period metrics."""
from pathlib import Path
from dataclasses import replace
import argparse, hashlib, itertools, json, sys, time, platform
import numpy as np
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from quant_system.own_daily import Design,load,run

def write(path,obj):
    path.write_text(json.dumps(obj,ensure_ascii=False,indent=2,allow_nan=False,default=str),encoding='utf8')

def selection_score(r):
    m=r['development']
    if not m or m['years']<2:return -1e9
    # Fixed beforehand, no validation/final information used for ranking.
    return m['cagr']-2*max(0,m['max_drawdown']-.15)-.10*max(0,.20-m['average_exposure'])

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--market',required=True,choices=['CN','HK','US']);parser.add_argument('--tag',default='initial');parser.add_argument('--quick',action='store_true');parser.add_argument('--version',type=int,default=1,choices=[1,2,3]);args=parser.parse_args()
    out=ROOT/'reports'/'own_daily_v1'/args.tag/args.market;out.mkdir(parents=True,exist_ok=True)
    p=load(ROOT/'data'/'own_daily_v1',args.market)
    meta={k:v for k,v in p.metadata.items() if k!='records'};write(out/'data_audit.json',meta)
    configs=[Design(name=f'q_h{h}_v{int(v*100)}_b{int(b*100)}',holdings=h,target_vol=v,breadth_floor=b)
             for h,v,b in itertools.product([15,25],[.14,.18,.22],[.25,.35])]
    if args.version==2:
        configs=[Design(name=f'{family}_v{int(v*100)}_r{rebalance}_s{int(stop*100)}',holdings=15,target_vol=v,breadth_floor=.25,
                        family=family,rebalance=rebalance,trailing_stop=stop)
                 for family,v,rebalance,stop in itertools.product(['quality_momentum','smooth_breakout','state_blend'],[.18,.24],[5,21],[0.,.10])]
    if args.version==3:
        configs=[Design(name=f'online_h{h}_v{int(v*100)}_mix{int(mix*100)}',holdings=h,target_vol=v,breadth_floor=.25,
                        family='online_ridge',rebalance=21,trailing_stop=.10,learned_mix=mix)
                 for h,v,mix in itertools.product([15,25],[.18,.24],[.65,1.])]
    if args.quick:configs=configs[:2]
    source_hash=hashlib.sha256((ROOT/'quant_system'/'own_daily.py').read_bytes()).hexdigest()
    (out/'engine_snapshot.py').write_bytes((ROOT/'quant_system'/'own_daily.py').read_bytes())
    (out/'universe_snapshot.json').write_bytes((ROOT/'data'/'own_daily_v1'/(args.market+'_universe.json')).read_bytes())
    protocol={'engine_sha256':source_hash,'selection':'development CAGR minus 2 * drawdown excess above 15%, less low-exposure penalty; no final data used',
              'runtime':{'python':platform.python_version(),'numpy':np.__version__,'pandas':pd.__version__},
              'version':args.version,'trial_count':len(configs),'universe_sha256':hashlib.sha256(json.dumps(meta['source_hashes'],sort_keys=True).encode()).hexdigest(),
              'strict_untouched_holdout':False,'data_audit':meta,'configs':[c.__dict__ for c in configs]}
    write(out/'experiment.json',protocol)
    rows=[]
    for i,c in enumerate(configs):
        t=time.monotonic();r,_,_,_=run(p,c);rows.append(r);write(out/'trials.json',rows)
        print(json.dumps({'market':args.market,'trial':i+1,'name':c.name,'full':r['full'],'seconds':round(time.monotonic()-t,1)}),flush=True)
    selected=max(rows,key=selection_score);c=next(c for c in configs if c.name==selected['config']['name'])
    result,curve,trades,decisions=run(p,c,details=True)
    if 'model_updates' in p.metadata:write(out/'model_updates.json',p.metadata['model_updates'])
    curve.to_csv(out/'equity.csv',index=False);pd.DataFrame(trades).to_csv(out/'trades.csv',index=False);write(out/'decisions.json',decisions)
    checks={}
    variants={'pure_momentum':Design(name='pure_momentum',holdings=c.holdings,quality=False,regime=False,diversify=False,momentum_only=True),
              'liquid_top100_equal_weight':Design(name='liquid_top100_equal_weight',equal_benchmark=True,rebalance=21),
              'no_quality':replace(c,name='no_quality',quality=False),
              'no_breadth_regime':replace(c,name='no_breadth_regime',regime=False),
              'no_correlation_filter':replace(c,name='no_correlation_filter',diversify=False)}
    if c.trailing_stop:variants['no_trailing_stop']=replace(c,name='no_trailing_stop',trailing_stop=0)
    for name,config in variants.items():
        r,f,_,_=run(p,config);checks[name]=r;f.to_csv(out/(name+'_equity.csv'),index=False)
    for name,kwargs in {'double_cost':{'cost_multiplier':2},'extra_day_delay':{'execution_lag':2},'no_stale_writeoff':{'stale_writeoff':False}}.items():
        checks[name]=run(p,c,**kwargs)[0]
    result.update(selection_score=selection_score(result),checks=checks,data_audit=meta,trial_count=len(rows),
        status='exploratory_not_verified',reason='Incomplete historical universe/coverage and retrospective holdout; no verified target claim')
    write(out/'report.json',result)
    def pct(x):return f'{x*100:.2f}%'
    lines=['# '+args.market+' 自研日线研究结果','',
        '**探索性回测；不代表已完成全市场历史验证。**','',
        f'下载有数据 {meta["histories"]} 只 / 初始清单 {meta["initial_universe"]} 只；未尝试 {meta["not_attempted"]}、失败 {meta["failed"]}、返回空 {meta["empty"]}。',
        f'开发期固定评分选中 `{c.name}`；共 {len(rows)} 个配置。未用后期收益倒选。','',
        '|区间|年化收益|最大回撤|累计收益|数值门槛|','|---|---:|---:|---:|---|']
    for k in ['development','validation','retrospective_final','full']:
        m=result[k]
        if m:lines.append(f'|{k}: {m["start"]}—{m["end"]}|{pct(m["cagr"])}|{pct(m["max_drawdown"])}|{pct(m["total_return"])}|{"通过" if m["numeric_target"] else "未通过"}|')
    lines+=['','## 对照与压力测试','','|方案|全段年化|全段回撤|','|---|---:|---:|']
    for k,r in checks.items():lines.append(f'|{k}|{pct(r["full"]["cagr"])}|{pct(r["full"]["max_drawdown"])}|')
    lines+=['','## 费用与局限','',f'初始资金100万本币；成交 {result["trade_count"]} 笔；费用拆分：`{result["cost_breakdown"]}`。',
        '佣金、税费和滑点逐笔扣除。期末保留卖出费用准备金。复权价格分数单位，非真实整手交易账本。',
        'A股缺少历史ST与逐日涨跌停价格，采用保守开盘缺口限制；港股池存在幸存者偏差；美股证券类型和更名映射尚不完备。停牌持仓不能成交，连续60个观察日缺少有效成交价或已到退市日时保守核销，另列不核销敏感性。',
        '低于流动性门槛的股票仍在初始池；信号时只对当时合格、成交额最高1500只评分。所有指标基于日收盘净值，未计算盘中回撤。',
        '既有研究看过部分后期数据，所以2024—2025是回溯评估而非严格独立未接触样本外。',
        '当前数值即使达到20%/15%，也不等于完整目标达成。原始曲线、逐笔交易、决策、全部参数试验和数据哈希保存在同目录。']
    (out/'REPORT.md').write_text('\n'.join(lines),encoding='utf8')
    print(json.dumps({'market':args.market,'selected':c.name,'full':result['full'],'output':str(out)}),flush=True)

if __name__=='__main__':main()
