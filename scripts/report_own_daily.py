"""Create a local, self-contained research report without publishing or trading."""
from pathlib import Path
import json,html,math
import pandas as pd
from evaluate_own_daily import selection_score
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reports'/'own_daily_v1'
LABELS={'CN':'A股','HK':'港股','US':'美股'}
def pct(x):return f'{x*100:.2f}%'
def chart(frame,title):
    values=frame.equity.to_numpy()/float(frame.base_equity.iloc[0]);stride=max(1,len(values)//700)
    ids=list(range(0,len(values),stride))
    if ids[-1]!=len(values)-1:ids.append(len(values)-1)
    lo=min(float(values.min()),1.);hi=max(float(values.max()),1.);span=max(hi-lo,.05)
    points=' '.join(f'{45+650*i/max(1,len(values)-1):.1f},{200-160*(values[i]-lo)/span:.1f}' for i in ids)
    y=200-160*(1-lo)/span
    return f'<svg viewBox="0 0 730 245" role="img" aria-label="{html.escape(title)}"><title>{html.escape(title)}</title><line x1="45" x2="695" y1="{y:.1f}" y2="{y:.1f}" stroke="#adb9c8" stroke-dasharray="5 4"/><polyline points="{points}" fill="none" stroke="#225fc9" stroke-width="2"/><text x="45" y="226">{frame.date.iloc[0]}</text><text x="600" y="226">{frame.date.iloc[-1]}</text><text x="4" y="44">{hi:.2f}</text><text x="4" y="202">{lo:.2f}</text></svg>'

def main():
    audit=json.loads((OUT/'DATA_AUDIT.json').read_text(encoding='utf8'))
    summary={'goal':{'cagr':.20,'max_drawdown':.15},'verified_target':False,'markets':{},'data_audit':audit}
    md=['# 三市场自研日线研究：本轮结论','','**本轮未完成经验证的三市场年化≥20%、最大回撤≤15%目标。**',
        '费用已计入；已实现策略、下载缓存、三轮研究、对照消融、成本压力与复现工具。下列是有明确数据限制的探索性结果，不是已验证投资业绩。','',
        '|市场|实际回测区间|扣成本年化|最大回撤|累计收益|有历史数据/初始清单|','|---|---|---:|---:|---:|---:|']
    sections=[];registry=[]
    for market in ['CN','HK','US']:
        variants=[];trials=[]
        for version in [1,2,3]:
            folder=OUT/f'final_v{version}'/market;r=json.loads((folder/'report.json').read_text(encoding='utf8'))
            variants.append((folder,r));trials.extend(json.loads((folder/'trials.json').read_text(encoding='utf8')))
            experiment=json.loads((folder/'experiment.json').read_text(encoding='utf8'))
            for trial in json.loads((folder/'trials.json').read_text(encoding='utf8')):
                registry.append(dict(market=market,version=version,name=trial['config']['name'],engine_sha256=experiment['engine_sha256'],
                    full_cagr=trial['full']['cagr'],full_max_drawdown=trial['full']['max_drawdown'],full_cost=trial['full']['total_cost'],
                    development_cagr=trial['development']['cagr'],validation_cagr=trial['validation']['cagr'],retrospective_cagr=trial['retrospective_final']['cagr'],
                    numeric_target=trial['full']['numeric_target'],verified_target=False))
        folder,r=max(variants,key=lambda item:selection_score(item[1]));m=r['full'];meta=r['data_audit']
        numeric=sum(x['full']['numeric_target'] for x in trials)
        summary['markets'][market]={'selected_report':str(folder.relative_to(ROOT)),'selected_config':r['config'],'full':m,
            'development':r['development'],'validation':r['validation'],'retrospective_final':r['retrospective_final'],
            'trial_count':len(trials),'numeric_pass_count':numeric,'verified_target':False,
            'cost_breakdown':r['cost_breakdown'],'checks':{k:v['full'] for k,v in r['checks'].items()},'data_audit':meta}
        md.append(f'|{LABELS[market]}|{m["start"]}—{m["end"]}|{pct(m["cagr"])}|{pct(m["max_drawdown"])}|{pct(m["total_return"])}|{meta["histories"]}/{meta["initial_universe"]}|')
        frame=pd.read_csv(folder/'equity.csv');table='<table><tr><th>区间</th><th>年化</th><th>最大回撤</th></tr>'
        for name,key in [('开发期','development'),('验证期','validation'),('后期回溯','retrospective_final'),('全段','full')]:
            z=r[key];table+=f'<tr><td>{name}</td><td>{pct(z["cagr"])}</td><td>{pct(z["max_drawdown"])}</td></tr>'
        table+='</table>'
        sections.append(f'<section><h2>{LABELS[market]} · {pct(m["cagr"])} 年化 / {pct(m["max_drawdown"])} 回撤</h2><p>开发期评分选中：<code>{html.escape(r["config"]["name"])}</code>。{len(trials)} 个登记配置中，全段数值同时达标 {numeric} 个；验证通过数仍为0。</p>{chart(frame,LABELS[market]+"净值（含费用）")}{table}<p>缓存历史 {meta["histories"]} 只；异常价格棒 {meta["invalid_bar_total"]} 根；超过50%的单日变动 {meta["large_move_total"]} 次（未逐项解释，不等于全部错误）。<a href="{folder.relative_to(OUT).as_posix()}/REPORT.md">完整对照与费用</a></p></section>')
    md+=['','## 如何选择与如何解释','',
        '每市场在同一冻结数据和引擎上测试12个固定评分配置、24个机制改进配置、8个在线学习配置。各版本主候选及最终展示候选均只按开发期固定评分选择，未按全段最好成绩倒选。2024—2025曾被既有研究部分观察，明确称回溯评估。',
        '最大回撤使用完整策略账户日收盘净值，初始资金每市场100万本币；不是把小额策略预算塞进大账户降低回撤。实际交易成本逐笔进入现金和净值，期末未卖持仓还扣卖出成本准备金。',
        '年化目标和回撤目标必须同时满足。即使个别探索参数数值满足，数据完整性、复权和退市结算未通过时，也不视为目标完成。','',
        '## 数据接口实际结果','',
        '- 掘金：取得沪深证券主表及历史日线，含部分已退市股票。主表不含北交所；历史ST/涨跌停状态、公司行动和退市结算仍不完整。2025年后才上市的股票保留在初始表中，但不要求其有2014—2025行情。',
        '- Alpaca：SIP测试股票2015为空、2020与2025有数据；IEX测试2020仅部分覆盖。当前和非活跃证券名单均已读取。大量代码无历史返回，且更名/代码复用/证券类型尚未完整审计。正式探索使用SIP，实际净值从2017开始。',
        '- 长桥：测试股票可取得2015、2020、2025历史，但触发301607，当前自然月最多100个历史标的。停止请求新标的，不通过下单或购买套餐绕开。',
        '- 港股补充：港交所当前股票清单+公开Yahoo行情。原长桥文件按哈希归档。抽查两来源发现重大差异，Yahoo本身也有负复权价格或OHLC异常；港股仍有当前幸存者池、缺少退市及公司行动问题。因此只能研究，不能作为通过证据。','',
        '## 已做的实质验证','',
        '历史费率切换、首日亏损计入回撤、成交晚于信号、缺价不得成交、现金账本与逐笔成交一致、在线标签成熟门禁、未来价格扰动不改变过去系数、退出冷静期。冻结引擎、股票池、行情SHA-256及复现命令一并保存。',
        '基准为同一合格池中当时流动性最高100只的等权组合（并非官方指数）；另有纯动量、去除质量/广度/相关性/退出规则的消融、全部成本加倍、成交再延迟一天、停牌不核销的敏感性。','',
        '## 不能解释为已解决的部分','',
        '没有完整历史股票池与公司行动，不能保证历史收益真实可执行；复权分数单位不是整手真实股数账本。保守涨跌停缺口过滤不等于精确还原A股可成交性。连续60个交易日无有效价格时核销是压力假设，不是实际退市结算。',
        '没有证据保证通过继续调参数就能得到三市场同时达标。下一步的前提是补齐可靠历史证券主表、退市结算、复权公司行动和历史交易限制，而不是继续在有偏数据上追逐20%。','',
        '## 文件入口','',
        '- 策略与费用定义：`docs/OWN_DAILY_RESEARCH_PROTOCOL.md`、`docs/OWN_DAILY_RESEARCH_V2.md`、`docs/OWN_DAILY_RESEARCH_V3.md`。',
        '- 源码：`quant_system/own_daily.py`；采集：`scripts/own_daily_data.py`；评估：`scripts/evaluate_own_daily.py`。',
        '- 本目录每个final_v*/市场目录包含全部试验、逐笔成交、决策、净值、引擎快照、数据哈希和报告。',
        '- `DATA_AUDIT.json`保存覆盖率、失败、异常；`SUMMARY.json`保存本报告结构化数据。','',
        '本轮没有提交、撤销订单，也没有更改线上策略或停止网站服务。']
    (OUT/'RESEARCH_REPORT.md').write_text('\n'.join(md),encoding='utf8')
    (OUT/'SUMMARY.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8')
    pd.DataFrame(registry).to_csv(OUT/'ALL_TRIALS.csv',index=False,encoding='utf-8-sig')
    page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>三市场自研策略研究</title><style>body{font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#f3f6fa;color:#15263e}main{max-width:1050px;margin:auto;padding:38px 24px}h1{font-size:32px;margin-bottom:8px}h2{font-size:22px}section{background:white;border:1px solid #dbe3ed;padding:24px;margin:22px 0;border-radius:12px}svg{width:100%;max-height:330px}svg text{font-size:12px;fill:#52647a}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:9px;border-bottom:1px solid #e4e9ef}.notice{padding:18px;background:#fff0d4;border-left:5px solid #bf7c0a}code{overflow-wrap:anywhere}a{color:#225fc9}</style><main><h1>三市场自研日线策略</h1><p>含手续费 · 完整账户净值 · 开发期选参 · 2026-09-22研究批次</p><div class="notice"><b>尚未完成目标验证。</b>目标为各市场扣成本后年化≥20%、最大回撤≤15%。以下是存在股票池、复权及退市数据缺口的探索结果，不能视为已验证业绩。</div>'''+''.join(sections)+'''<section><h2>研究记录</h2><p>三轮44种登记配置；先开发后评估，保留失败结果。每市场100万本币，无杠杆。来源差异、数据异常和手续费假设均在完整报告中披露。</p><p><a href="RESEARCH_REPORT.md">完整研究报告</a> · <a href="DATA_AUDIT.json">数据审计</a> · <a href="SUMMARY.json">结构化结果</a></p></section></main></html>'''
    (OUT/'index.html').write_text(page,encoding='utf8')
    print(json.dumps({m:{'cagr':r['full']['cagr'],'max_drawdown':r['full']['max_drawdown'],'numeric_pass_count':r['numeric_pass_count']} for m,r in summary['markets'].items()}))
if __name__=='__main__':main()
