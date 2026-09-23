"""Report rejected ideas as prominently as promising ones."""
from pathlib import Path
import json
import pandas as pd
from evaluate_own_daily import selection_score,write
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reports/own_alternatives'
LABEL={'CN':'A股','HK':'港股','US':'美股'}
NAMES={'residual_reversal':'短期残差反转','recovery_reversal':'长期落后后转强','distributed_trend':'分散时序趋势','mechanism_mix':'固定多机制组合'}
def read(p):return json.loads(p.read_text(encoding='utf8'))
def pct(x):return f'{x*100:.2f}%'
def pair(r):return pct(r['full']['cagr'])+' / '+pct(r['full']['max_drawdown'])
def main():
    data={m:read(OUT/m/'report.json') for m in LABEL};trials={m:read(OUT/m/'trials.json') for m in LABEL}
    financial=read(OUT/'fundamental/CN/report.json')
    registry=[];lines=['# 跳出原策略：独立机制与财务信息实验','',
        '**这些是含成本的探索性回测，不是收益承诺或实盘验证。**',
        '**本轮没有找到可替代旧方案的明确优势：28个候选均未同时达到20%年化与15%回撤目标，财务选股也弱于同区间旧策略。保留研究结果，不替换线上策略。**','',
        '本轮没有继续扩大旧动量参数网格，而是检验短期反转、长期转强、分散时序趋势、固定组合，并实际采集历史财务数据测试A股盈利质量/估值。','',
        '## 价格机制对照','',
        '各机制仅测试14%和20%两个波动率目标，下表在各自机制内按截至2020年的固定开发期评分选一个。表格单元格为“扣成本年化 / 最大回撤”；A股与港股2015—2025，美股2017—2025。所有市场独立本金100万本币。','',
        '|机制|A股|港股|美股|','|---|---:|---:|---:|']
    family_picks={}
    for family,label in NAMES.items():
        picks={m:max([r for r in trials[m] if r['config']['family']==family],key=selection_score) for m in LABEL};family_picks[family]=picks
        lines.append('|'+label+'|'+'|'.join(pair(picks[m]) for m in LABEL)+'|')
    lines.append('|上轮保留候选（同引擎重算）|'+'|'.join(pair(data[m]['previous']) for m in LABEL)+'|')
    lines+=['','不同机制并不自动带来分散收益。以上固定多机制组合没有经过全段最优权重搜索，结果未证明优于旧策略；短期反转的高换手成本尤其明显。美股某一分散趋势配置提高收益的同时增加了回撤，不能把这种交换描述为同时改善。','',
        '每市场总体开发期选中的新候选：','', '|市场|新候选|全段年化 / 回撤|2021—2023年化|2024—2025年化|','|---|---|---:|---:|---:|']
    for m,r in data.items():
        s=r['selected'];lines.append(f'|{LABEL[m]}|{s["config"]["name"]}|{pair(s)}|{pct(s["validation"]["cagr"])}|{pct(s["retrospective_final"]["cagr"])}|')
        for trial in trials[m]:registry.append(dict(market=m,experiment='price_mechanism',config=trial['config']['name'],cagr=trial['full']['cagr'],max_drawdown=trial['full']['max_drawdown'],numeric_target=trial['full']['numeric_target']))
    s=financial['selected'];ftrials=read(OUT/'fundamental/CN/trials.json')
    lines+=['','## 实际落地的新信息来源：A股财务质量','',
        '样本探测发现原始年报的部分直接ROE字段为空，因此没有把缺失值当零；改用归母利润、总资产、归母权益和经营现金流计算三个质量比率。估值使用历史PE。','',
        '逐季度读取当时最新披露的原始合并年报，校验发布日期不晚于查询日，至少隔一个交易日才进入信号。财务缺失或报告过旧的股票不能入选。','',
        '财务实验区间为2015—2024，与前表价格机制的2015—2025不同。因后续接口反复无响应，在财务回测开始前按完整可用截面固定这个十年区间，旧策略也按相同区间重算；未完成2025财务实验。','',
        '|方案|年化|最大回撤|','|---|---:|---:|']
    for r in ftrials:
        lines.append(f'|{r["config"]["name"]}|{pct(r["full"]["cagr"])}|{pct(r["full"]["max_drawdown"])}|')
        registry.append(dict(market='CN',experiment='fundamental',config=r['config']['name'],cagr=r['full']['cagr'],max_drawdown=r['full']['max_drawdown'],numeric_target=r['full']['numeric_target']))
    lines+=['',f'开发期评分选中 **{s["config"]["name"]}**：全段 {pair(s)}；累计收益 {pct(s["full"]["total_return"])}。','',
        '|区间 / 压力|年化|最大回撤|','|---|---:|---:|']
    for name,z in [('截至2020开发期',s['development']),('2021—2023',s['validation']),('2024回溯',s['retrospective_final'])]+[(k,v['full']) for k,v in financial['checks'].items()]:
        lines.append(f'|{name}|{pct(z["cagr"])}|{pct(z["max_drawdown"])}|')
    manifest=read(ROOT/'data/own_fundamental_cn_2014_2024/manifest.json')
    lines+=['',f'共{len(manifest)}个历史截面，覆盖{min(manifest)}至{max(manifest)}，共{sum(v["rows"] for v in manifest.values()):,}条股票截面记录。每次取当时最新原始年报，并非季度业绩数据；同一年度报告可在多个截面重复出现。',
        f'旧策略在相同2015—2024区间为 {pair(financial["previous"])}。40个截面表示查询流程完成，不等于所有股票财务历史完整；返回空值或无报告的股票仍被排除。2024-12-31以后未完成的原始采集及查询缺口保留在data/own_fundamental_cn，本次冻结实验没有使用它们。',
        f'主候选费用总计 {s["full"]["total_cost"]:,.2f} 元，佣金/税费/滑点分别为 `{s["cost_breakdown"]}`；期末未决资产账面值 {s["terminal_unresolved_value"]:,.2f} 元。','',
        '## 哪些路线还不能声称已完成','',
        '- 港美财务选股：长桥接口已成功返回700.HK、AAPL.US的2016—2026报表样本，但样本只有财政期结束时间等字段，未确认历史披露时间和当时可得版本。因此本轮没有用当前财报倒填历史，也没有生成伪样本外结果。',
        '- ETF多资产：债券、黄金等可引入不同于股票的收益来源，值得另开实验；本轮股票结果不支持任何具体ETF组合的收益声称。研究范围偏好仍由用户决定。',
        '- 财报预期差/事件：需要公告时间和历史一致预期。当前样本不能直接满足。',
        '- 多空/配对：需要历史可借券、借券费和交易限制，不能忽略做空成本造出高夏普。','',
        '## 费用与执行口径','',
        '所有结果已扣佣金、税费及滑点。A股佣金单边万分之三、最低5元，滑点单边5bp，卖出印花税按日期切换；港股佣金单边万分之三、最低3港元并加15港元平台费，另计印花税、交易征费和结算准备金，滑点10bp；美股按零佣金假设、卖出1bp监管费准备金及单边10bp滑点。它们是统一研究假设，不是逐笔历史券商账单。另做费用翻倍压力。',
        '信号后下一开盘成交；不加杠杆，不计现金利息。使用复权股数及小数单位，尚未完整模拟港股整手和A股历史ST/涨跌停，因此仍是研究账本。最大回撤按每日收盘净值计算。','',
        '## 如何判断是否更好','',
        '同区间、同费用、同初始资金比较，收益和回撤同时报告；不把全段最高收益参数当主候选。28条正式配置记录全部保留；若收益提高但回撤更大，明确属于取舍。',
        f'本轮数值同时满足年化≥20%、最大回撤≤15%的配置数为 {sum(r["numeric_target"] for r in registry)}；数据完整性未验证，verified_target始终为false。',
        '目前所有历史都已被研究观察，新增方案及方法选择也带有历史适应性，2024—2025仅称后段回溯。股票池、公司行动、港股复权和A股开盘缺口限制沿用前轮已披露局限。财务原始数据/供应商历史PE尚未逐公司独立核验；金融业财务比率不完全可比，模型并非行业中性。','',
        '## 下一步研究顺序','',
        '优先考虑跨资产ETF组合，让股票、债券、黄金等不同收益来源参与配置；这属于待验证方向，需要另建历史数据、同样扣费并登记规则。其次是带真实公告时间的财报事件策略，先解决历史数据可得性。暂不继续给本轮失败的反转策略增加参数，也不把四个弱机制做全段最优权重拟合。','',
        '## 自研边界','',
        '自主实现的是各机制定义、信号组合、历史数据校验、费用与事件账本和实验流程；反转、趋势、盈利质量和价值因子均有既有研究，不能包装为首次发明。应把自研理解为有独立实现和可验证设计依据。','',
        '研究线索：[反转与流动性提供](https://www.nber.org/papers/w30917)、[盈利能力研究](https://www.nber.org/papers/w33601)、[趋势研究](https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing)。这些文献支持研究假设，不证明本系统业绩。',
        '数据接口依据：[掘金财务字段与历史时点接口](https://emquant.18.cn/help/doc/python/python_select_api_stock.html)、[长桥财务报表](https://open.longbridge.com/docs/fundamental/fundamental/financial-report)。','',
        '## 文件与复现','',
        '协议：docs/OWN_DAILY_ALTERNATIVES.md、docs/OWN_FUNDAMENTAL_CN.md。源代码：quant_system/own_alternatives.py、quant_system/own_fundamental.py；共用账本quant_system/own_daily.py。',
        '每市场目录保留全部配置、净值、成交、决策、冻结引擎与选择器、输入哈希。`scripts/reproduce_own_alternatives.py reports/own_alternatives/US`复现价格机制；`scripts/reproduce_own_fundamental.py`复现财务实验。',
        '本轮没有下单、撤单、替换线上策略或部署。']
    (OUT/'RESEARCH_REPORT.md').write_text('\n'.join(lines),encoding='utf8')
    write(OUT/'SUMMARY.json',dict(price_mechanisms=data,family_picks=family_picks,fundamental=financial,financial_coverage=manifest,trial_count=len(registry),numeric_pass_count=sum(r['numeric_target'] for r in registry),verified_target=False))
    pd.DataFrame(registry).to_csv(OUT/'ALL_TRIALS.csv',index=False,encoding='utf-8-sig')
    print(json.dumps(dict(trials=len(registry),numeric_pass_count=sum(r['numeric_target'] for r in registry),fundamental=s['full'])))
if __name__=='__main__':main()
