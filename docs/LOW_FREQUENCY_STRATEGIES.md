# 低频策略与历史数据

## 固定研究范围

本入口只整理日线信号、周度或月度参数更新的低频策略。回测使用当日收盘后
生成的目标仓位，并在下一根日线开盘成交，不包含日内信号、逐笔撮合或高频策略。

固定资产池为 6 只流动性较好的美国 ETF：

| 代码 | 暴露 | 在组合中的作用 |
|---|---|---|
| SPY | 美国大盘股 | 核心权益与买入持有参照 |
| QQQ | Nasdaq-100 | 成长型权益 |
| TLT | 长期美国国债 | 利率与防御资产 |
| GLD | 黄金 | 避险与通胀相关资产 |
| VNQ | 美国 REITs | 房地产周期 |
| DBC | 综合商品 | 商品与通胀周期 |

该池有意保持简单。它可以检验跨资产趋势、动量和风险配置，但不代表全球完整
可投资集，也没有处理 ETF 上市前偏差、基金关闭或替代标的选择偏差。

## 已整合策略

`--benchmark` 会在同一份数据、成本模型和风险约束下运行以下低频策略：

| 策略 | 信号或配置 | 典型更新频率 |
|---|---|---|
| equal_weight | 等权基线 | 权重漂移超过阈值时 |
| sma_cross_50_200 | 50/200 日均线 | 日线观察、低换手 |
| risk_parity | 63 日滚动风险平价 | 21 个交易日 |
| single_horizon_trend | 84/168 日趋势 | 5 个交易日 |
| multi_horizon_trend | 21/63/126/252 日连续趋势 | 5 个交易日 |
| cross_sectional_momentum | 126 日动量，跳过最近 5 日 | 21 个交易日 |
| dual_momentum | 权益相对动量加绝对动量防守 | 21 个交易日 |
| long_short_multi_horizon | 多周期多空趋势 | 5 个交易日 |
| adaptive_multi_alpha | 趋势与横截面动量动态组合 | 子策略各自频率 |
| balanced_multi_alpha | 风险平价、趋势、双动量组合 | 子策略各自频率 |
| crisis_balanced_alpha | 风险平价、多空趋势、动量组合 | 子策略各自频率 |
| online_expert_ensemble | 只用已实现收益在线调整专家权重 | 日线评估 |

默认可运行策略是只按前 70% 开发期选出的 long-only
`multi_horizon_trend`；多空版本只作为研究对照，不是默认生产候选。

## 当前盈利验收

在冻结快照和当前成本模型下，`multi_horizon_trend` 是开发期选出的默认候选，
未用留出期重新选策略或参数。留出期从 2023-11-16 开始，结果如下：

| 检查项 | 结果 |
|---|---:|
| 完整样本 CAGR | 11.03% |
| 完整样本 Sharpe | 1.158 |
| 完整样本最大回撤 | -15.66% |
| 留出期 CAGR | 19.33% |
| 留出期 Sharpe | 1.828 |
| 留出期最大回撤 | -8.41% |
| 5 倍交易成本下留出期 CAGR | 17.43% |
| Bootstrap 年化收益为正概率 | 100.0% |
| 多重试验校正后 Sharpe 概率 | 90.4% |

只有 `validation_gates` 全部通过，命令才返回退出码 0；任一盈利、成本、统计或
容量门槛失败时仍会保存完整报告，但返回退出码 2，不能把该候选标为通过。
这些数字是历史回测证据，不是未来盈利保证。当前留出期较短且主要覆盖近期市场，
仍需扩展到 2008 年危机等更长历史后再考虑真实资金。

## 历史快照

快照来源为 [Yahoo Finance 数据的公开课程研究归档](https://github.com/hhhx-lab/-ETF-)，固定到上游提交
`899d6f075577ef50da6954c4a693f040f7001d3c`。区间是 2018-01-02 至
2026-05-29，每只 ETF 2,113 根日线，共 12,678 行。原始文件保存普通 OHLC、
Adj Close 和 Volume；加载时统一用 `Adj Close / Close` 调整 OHLC，成交量不变。

准备并校验数据：

```bash
python3 scripts/prepare_low_frequency_data.py
```

本地文件哈希正确时该命令只做离线校验；需要显式重新下载时增加 `--refresh`。

脚本固定校验 SHA-256：

```text
8fe8d4ccf9d0fa9660b898d88c510ac71505b0907a6cef37989d3c0dc8fed8c5
```

`data/` 默认不进入 Git；正式研究应保存原始快照、哈希和运行报告，不应在选参后
静默更新数据。Yahoo 归档适合课程和初步研究，投入资金前应向交易所、基金公司
或专业供应商复核公司行动、交易日和价格。该快照覆盖 2018 年以来的波动、
COVID 冲击和 2022 年通胀冲击，但不包含 2008 年金融危机；报告中早于 2018 年
的市场阶段为空，不能算作已经验证。

## 运行

先运行冻结的默认组合：

```bash
python3 -m quant_system \
  --config configs/low_frequency_etf.yaml \
  --output reports/low_frequency_etf
```

再运行全部策略的同口径比较、开发/留出切分、市场阶段和成本压力：

```bash
python3 -m quant_system --benchmark \
  --config configs/low_frequency_etf.yaml \
  --output reports/low_frequency_benchmark
```

核心结果分别是 `metrics.json`、`tearsheet.md`、
`strategy_comparison.csv` 和 `benchmark_report.md`。选择策略时只看开发期排名，
再检查未参与选择的留出期；完整样本最佳结果不能当作样本外证据。
