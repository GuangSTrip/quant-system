"""Evidence-first v4 report; never choose the full-period return winner."""
from pathlib import Path
import json,html,hashlib
import pandas as pd
from evaluate_own_daily import write
from report_own_daily import chart
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reports/own_daily_v4'
LABEL={'CN':'A股','HK':'港股','US':'美股'}
def read(p):return json.loads(p.read_text(encoding='utf8'))
def pct(x):return f'{x*100:.2f}%'

def main():
    summary=dict(verified_target=False,goal=dict(cagr=.20,max_drawdown=.15),markets={})
    lines=['# 自研策略第四轮优化结果','',
        '**仍未达到三市场分别扣成本年化≥20%、最大回撤≤15%的目标。**',
        '本轮完成账户核对、停牌估值修正、部分并购结算、漏筛股票补采，以及流动性/波动率/账户退出机制检验。改善和失败均保留；不能将数据修复造成的变化称为策略超额收益。','',
        '每市场初始100万本币、不借款、不计现金利息。下面比较使用同一市场的修正账本和最终数据；旧策略也重跑，不能直接用上一报告未修正数字对比。','',
        '|市场|区间|修正后旧策略年化 / 回撤|本轮候选年化 / 回撤|本轮累计收益|',
        '|---|---|---:|---:|---:|']
    detail=[];cards=[];registry=[]
    for market in ['CN','HK','US']:
        base=OUT/('expanded/US' if market=='US' else market);risk=OUT/'risk'/market
        b=read(base/'report.json');r=read(risk/'report.json');s=r['selected'];m=s['full'];old=b['checks']['previous_strategy_corrected']['full']
        lines.append(f'|{LABEL[market]}|{m["start"]}—{m["end"]}|{pct(old["cagr"])} / {pct(old["max_drawdown"])}|{pct(m["cagr"])} / {pct(m["max_drawdown"])}|{pct(m["total_return"])}|')
        summary['markets'][market]=dict(selected_report=str(risk.relative_to(ROOT)),selected=s,previous_corrected=old,
            base=b['selected']['full'],checks=r['checks'],walk_forward=b['walk_forward']['full'],data_audit=b['data_audit'])
        detail+=['',f'## {LABEL[market]}','',f'主候选：`{s["config"]["name"]}`。基础评分 `{s["config"]["family"]}`，成交额前{s["config"]["liquidity_limit"]}、波动率上限75%、25只、21日调仓。账户退出阈值{s["config"]["portfolio_stop"]:.0%}，暂停{s["config"]["portfolio_pause"]}个观察日（阈值0表示未启用）。',
            '基础候选及风险补充均按截至2020年的同一开发评分选择；没有用全段最高收益倒选。','',
            '|区间 / 检查|年化|最大回撤|','|---|---:|---:|']
        for name,key in [('开发期截至2020','development'),('2021—2023','validation'),('2024—2025回溯','retrospective_final')]:
            z=s[key];detail.append(f'|{name}|{pct(z["cagr"])}|{pct(z["max_drawdown"])}|')
        for name,z in [('无账户退出的基础候选',b['selected']['full']),('基础候选逐年选参2021—2025',b['walk_forward']['full']),
                       ('同池前100等权',b['checks']['same_pool_equal_weight']['full'])]+[(k,v['full']) for k,v in r['checks'].items()]:
            detail.append(f'|{name}|{pct(z["cagr"])}|{pct(z["max_drawdown"])}|')
        if market=='US':
            bench=read(base/'SPY_benchmark.json');summary['markets'][market]['SPY_benchmark']=bench
            detail.append(f'|SPY同期持有含交易费用|{pct(bench["full"]["cagr"])}|{pct(bench["full"]["max_drawdown"])}|')
        costs=s['cost_breakdown'];meta=b['data_audit']
        detail+=['',f'逐笔费用合计 {sum(costs.values()):,.2f} 本币：佣金 {costs["commission"]:,.2f}、税费/交易费用估计 {costs["tax_exchange"]:,.2f}、滑点 {costs["slippage"]:,.2f}。包含期末卖出费用准备金 {s["terminal_fee_reserve"]:,.2f}。',
            f'年均双边成交额/权益 {m["annual_turnover"]:.2f} 倍，平均仓位 {pct(m["average_exposure"])}。',
            f'期末连续至少20个观察日缺价或主表已退市的未决资产，最后价格账面值 {s["terminal_unresolved_value"]:,.2f}；这不是已经可取回的现金。归因对账残差 {s["attribution_error"]:.3g}。',
            f'有行情 {meta["histories"]}/{meta["initial_universe"]}；空返回 {meta["empty"]}、失败 {meta["failed"]}、未尝试 {meta["not_attempted"]}。异常价格棒 {meta["invalid_bar_total"]}，不等于全部公司行动异常均已发现。']
        frame=pd.read_csv(risk/'selected_equity.csv')
        cards.append(f'<section><h2>{LABEL[market]}：年化 {pct(m["cagr"])} / 回撤 {pct(m["max_drawdown"])}</h2><p>{m["start"]}—{m["end"]} · 含费用 · 累计 {pct(m["total_return"])}</p>{chart(frame,LABEL[market]+"账户净值")}<p>同口径旧策略：{pct(old["cagr"])} / {pct(old["max_drawdown"])}。本轮未达标。</p></section>')
        paths=[base,risk]+([OUT/'US'] if market=='US' else [])
        for folder in paths:
            rows=read(folder/'trials.json')
            if folder==risk:rows=rows[1:]
            for trial in rows:
                registry.append(dict(market=market,stage=str(folder.relative_to(OUT)),config=trial['config']['name'],
                    cagr=trial['full']['cagr'],max_drawdown=trial['full']['max_drawdown'],development_cagr=trial['development']['cagr'],numeric_target=trial['full']['numeric_target']))
    summary['trial_records']=len(registry);summary['numeric_pass_count']=sum(x['numeric_target'] for x in registry)
    lines+=['','## 怎样解读','',
        '本轮候选不代表所有指标都优于旧策略。A股收益改善但回撤仍大；部分市场通过降低风险牺牲了收益。更低的回撤不能抵消未达到收益目标这一事实。',
        '基础候选的逐年滚动选择与账户退出候选是两项不同实验，单独列示，不能把前者当作后者的独立验证。风险补充是在看过基础结果后提出，存在研究者适应历史的偏差。',
        f'本轮登记 {len(registry)} 条试验记录：三市场各12个基础配置，美股补池后另重跑12个，三市场各4个账户退出配置；数值同时达标 {summary["numeric_pass_count"]} 条。重跑基线、对照和压力测试不计入该数。港股另有16条成交修复前的旧记录保留在before_execution_fix目录，仅供审计，不参与最终评比。']+detail
    lines+=['','## 这轮具体修复','',
        '1. 缺行情60日不再默认清零。不能交易的持仓保留最后价估值，不凭空释放现金；60日归零另列压力测试。保留最后价也可能高估资产，未决值明确单列。',
        '2. 全额卖出明确归零，防止浮点残余错误取得持仓加分。旧报告仍保留冻结引擎；新策略与旧策略均在修正引擎重算。',
        '3. 每日价格损益、成交时点价差、公司行动损益、手续费、核销与净值变化逐日勾稽，现金不得为负；15项自研测试覆盖停牌、现金/换股、延迟退出等。最终成交审计发现港股有开盘价但成交量为零的日期仍被成交，已禁止并重跑港股。',
        '4. 美股新增1972只有历史数据的证券。因公司名称不包含Common Stock而漏掉普通股的问题已按统一规则扩大匹配；仍不宣称证券类型与历史主表完整。',
        '5. 从Alpaca公司行动接口获取历史事件，用事件日前后的未复权价格核对调整单位。可匹配事件按process_date处理，现金并购增加现金、换股增加接收股票；无法确认的继续冻结，未按最后成交价虚构卖出。','',
        '公司行动依据：[Alpaca官方接口](https://docs.alpaca.markets/us/reference/corporateactions-1)。MYOK现金对价抽查依据：[BMS完成公告](https://news.bms.com/news/details/2020/Bristol-Myers-Squibb-Completes-Acquisition-of-MyoKardia-Strengthening-Companys-Leading-Cardiovascular-Franchise/default.aspx)。','',
        '## 仍然存在的实质限制','',
        '- 港股Yahoo存在异常复权/OHLC，历史退市池缺失；本轮没有修复底层公司行动，也不能证明港股收益可靠。',
        '- A股没有北交所完整历史、逐日ST/涨跌停数据和退市实际结算。保守4.8%开盘缺口限制会拒绝一些实际可能成交的订单，可能扭曲亏损与机会。',
        '- 美股公司行动早期覆盖稀少；证券名称分类、代码复用和更名映射仍未完整核对。部分并购只有现金/股票之外的权利，当前无法完整重建。',
        '- 复权分数单位不是真实整手账本；不同提供商的现金分红、税和调整方法未全面复核。US缺原始成交额时使用复权价×量，可能受复权方法影响。',
        '- 佣金、印花税变更、平台费和滑点均计入，但部分税费为估计准备金，不是用户账户的完整逐年精确费率。详见第一轮协议。',
        '- 退出阈值并不是最大回撤承诺：次日跳空、无法卖出、容量限制及重新入场后的亏损仍可能扩大回撤。风险周期峰值可重设，统计账户回撤峰值始终不重设。',
        '- 截至2025年的数据已被研究观察，多轮参数探索本身增加过拟合风险。没有严格未接触留出集，无法保证未来收益。','',
        '## 自研范围与下一步判断','',
        '自主实现的是信号组合、市场广度与资金管理、账户风控、费用和事件账本、实验选择与复现流程；动量、低波动、突破、止损本身是已有方法，不应包装为全新金融理论。',
        '现有证据不支持宣布策略成熟或通过继续加止损就能达标。优先补全公司行动和可成交性，再决定是否研究新的信息来源（如当时可获得的财务质量/盈利修正）；继续在当前价格因子上大规模搜索不能替代证据。','',
        '## 复现和文件','',
        '主入口：`scripts/evaluate_own_daily_v4.py`、`scripts/evaluate_own_daily_risk.py`；协议见`docs/OWN_DAILY_RESEARCH_V4.md`及风险/补池补充文件。',
        '每个实验目录保留引擎、输入哈希、股票主表、公司行动快照、全部配置、逐笔成交、决策和净值。`scripts/reproduce_own_daily.py reports/own_daily_v4/risk/US`可在本机缓存上复现。',
        '本轮未接入线上策略，未提交或撤销订单，未部署。']
    (OUT/'RESEARCH_REPORT.md').write_text('\n'.join(lines),encoding='utf8')
    write(OUT/'SUMMARY.json',summary);pd.DataFrame(registry).to_csv(OUT/'ALL_TRIALS.csv',index=False,encoding='utf-8-sig')
    page='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>第四轮策略优化</title><style>body{font:16px/1.7 system-ui,"Microsoft YaHei";background:#f2f5f9;color:#17304b}main{max-width:960px;margin:auto;padding:30px}section{background:white;border:1px solid #d6dfe9;border-radius:12px;padding:24px;margin:20px 0}svg{width:100%}svg text{font-size:12px}.note{background:#fff1ce;padding:18px}a{color:#175ec1}</style><main><h1>自研日线策略 · 第四轮优化</h1><p class="note">尚未达到年化20% / 最大回撤15%目标。结果含费用，仍有数据与估值限制。</p>'+''.join(cards)+'<p><a href="RESEARCH_REPORT.md">完整研究报告</a> · <a href="SUMMARY.json">结构化数据</a> · <a href="ALL_TRIALS.csv">全部试验</a></p></main></html>'
    (OUT/'index.html').write_text(page,encoding='utf8')
    print(json.dumps(dict(trials=len(registry),numeric_pass=summary['numeric_pass_count'],markets={m:v['selected']['full'] for m,v in summary['markets'].items()})))
if __name__=='__main__':main()
