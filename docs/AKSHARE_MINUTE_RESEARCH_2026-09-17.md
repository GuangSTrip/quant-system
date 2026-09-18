# AkShare 三市场分钟策略研究记录（2026-09-17）

## 数据来源与复现

在 `quant-system` conda 环境已安装 AkShare 1.18.96。`web_platform/scripts/fetch-akshare-minutes.py` 分别调用 `stock_us_hist_min_em`（SPY）、`stock_hk_hist_min_em`（0700.HK）和 `stock_zh_a_hist_min_em`（600000.SH），保存至 Git 忽略的 `web_platform/demo-data/library-inputs/`。输出记录版本、抓取时间、未复权口径、逐日行数、重复/错误/非交易时段行数、诊断性缺失分钟数和 SHA-256。美股东财时间按中国时间解释并转换至纽约交易时段；A 股“手”转换为股。无效开盘价和不合格 OHLCV 被显式计数并剔除。

```powershell
conda run -n quant-system python web_platform/scripts/fetch-akshare-minutes.py
cd web_platform
node scripts/evaluate-minute-research.mjs
npm run build
npm test
npm run validate
```

AkShare 官方文档说明三个 1 分钟接口只提供近期约 5 个交易日且不复权，港美股数据存在延迟。详见 [AkShare 股票接口文档](https://akshare.akfamily.xyz/data/stock/stock.html) 和 [项目数据风险说明](https://github.com/akfamily/akshare/blob/main/docs/data_tips.md)。持续积累合规快照或使用有授权的更长历史数据，才可能做有意义的样本外检验。交易所休市、短日、停牌及供应商时间戳规则需要人工复核；诊断缺口数本身不能判定数据错误。

官方文档还提示 A 股 1 分钟接口的旧交易日开盘价可能全为 0，港美股示例也出现 0 开盘价。脚本会记录并剔除这些行；若不足两天可用数据，直接失败，不使用收盘价伪造下一分钟开盘成交。若该问题持续存在，需改用有真实开盘价的其他授权数据源，或另建并重新验证 5 分钟策略，不能把 5 分钟线直接代入当前按 1 分钟参数设定的规则。

## 本机抓取结果

2026-09-17 本机分别访问三个东财接口，均返回 `ConnectionError: Remote end closed connection without response`。安装 AkShare 成功，但本次 **没有获得美股、港股或 A 股的 AkShare 新行情**，港/A 股仍不能出具真实数据回测结论。脚本保留供网络可访问时直接重跑。不要把网页原有港/A 股固定种子样本视为历史行情。

补充验证用户提供的 Tushare 凭据：`stk_mins` 对 A 股 600000.SH 的 2026-09-14 至 09-16 返回 723 根分钟线，说明该接口可用；随后请求被限制为 **每小时 1 次**。`hk_mins` 返回无权限，美股分钟数据也未取得。因此当前仍没有足够长、已保存的三市场分钟样本来验证原三策略。`scripts/fetch_tushare_cn_minutes.py` 已准备按月份抓取并校验 A 股长样本；需在该账户允许的调用频次内运行，不能把试取的 723 根或失败的长样本请求冒充已完成回测。Tushare 官方说明 [A 股历史分钟接口](https://tushare.pro/document/2?doc_id=370) 与 [港股分钟接口](https://tushare.pro/document/2?doc_id=304) 的权限分别管理。

## 现有真实短样本的对照结果

使用仓库已有的 Yahoo SPY 1 分钟快照（2026-09-09 至 09-15，5 个交易日、1,950 根；SHA-256 和完整结果见 `reports/minute_research/comparison.json`）。固定原三策略参数、预算 2,000 美元、美股单边成本 10 bps；信号使用完成的分钟线，下一根开盘模拟成交，收盘前于最后一根开盘强制平仓。开发段为前 3 日，后 2 日仅作诊断，**不能称为可信样本外验证**。

| 策略 | 5 日成本后收益 | 最大回撤 | 后 2 日收益 | 交易笔数 | 成本翻倍后的 5 日收益 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 开盘区间突破 | -1.87% | -1.96% | -0.30% | 16 | -3.09% |
| VWAP 均值回归 | -0.39% | -0.50% | -0.20% | 14 | -1.45% |
| 波动率自适应动量 | -0.85% | -0.90% | -0.49% | 12 | -1.77% |
| 成交量与 VWAP 确认的开盘突破（实验候选） | -1.97% | -1.97% | -0.43% | 18 | -3.34% |

新候选要求开盘区间上破、位于当日 VWAP 上方、当前分钟量高于之前 20 分钟均量 1.2 倍，跌回区间中点或 VWAP 退出。规则来自开盘突破与异常成交量研究的可检验想法，不是论文结果的直接复现；参考 [Zarattini 等人的美股 ORB 研究](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284) 与 [开盘区间策略的成交量阈值研究](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5198458)。本样本中它没有改善收益或回撤，不应据此选用。

现阶段没有策略满足“高收益、低回撤”的实证要求。真实可成交价差、冲击、港股交易费用、A 股涨跌停与 T+1 库存约束仍需更准确建模；分钟 OHLCV 不含订单簿与队列信息，不能证明低延迟高频可交易性。取得至少跨多种市场状态的长样本后，先冻结股票池和参数，按时间分段留出，再报告成本敏感性、交易数、回撤与市场基准；留出集一旦被查看，就不得当作新样本反复调参。
