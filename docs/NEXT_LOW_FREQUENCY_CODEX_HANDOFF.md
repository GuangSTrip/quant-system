# 下一位 Codex：低频策略交接

更新时间：2026-09-17

## 可直接使用的开局提示词

> 请接手仓库 `/home/bfq/quant-system` 的低频 ETF 研究。先运行
> `git status --short` 和 `git log -3 --oneline --decorate`，然后完整阅读
> `docs/LOW_FREQUENCY_STRATEGIES.md`、`configs/low_frequency_etf.yaml`、
> `quant_system/data.py`、`quant_system/benchmarking.py` 和本交接文档。
> 不要清理其他组员的改动，不要提交 `data/`、`reports/`、密钥或未确认授权的
> 原始行情。先复现数据校验、单策略回测、12 策略基准和测试，再开始修改。
> 策略只能按开发集选择；留出集、成本压力和统计门禁失败时必须保留失败结果，
> 不得继续针对留出集调参，也不得宣称未来收益有保证。

## 已完成范围

- 固定低频资产池：`SPY`、`QQQ`、`TLT`、`GLD`、`VNQ`、`DBC`。
- 固定日线快照：2018-01-02 至 2026-05-29，每只 2,113 根，共 12,678 行。
- 数据入口：`yahoo_wide_csv`，支持两层 Yahoo/yfinance CSV、复权 OHLC、
  标的/日期过滤、面板对齐和 SHA-256 校验。
- 统一比较 12 个低频候选；信号使用已完成日线，下一交易日开盘成交。
- 当前默认候选：只按前 70% 开发期选出的 long-only
  `multi_horizon_trend`，不是按完整样本或留出期倒选。
- 报告包含完整绩效、逐年收益、市场阶段、成本压力、容量压力、风险消融、
  Bootstrap 和多重试验校正。
- 研究与基准命令只有在全部验证门禁通过时返回退出码 0；失败返回 2，报告仍保留。

## 数据与复现

数据来源固定到上游提交
`899d6f075577ef50da6954c4a693f040f7001d3c`：

```text
https://cdn.jsdelivr.net/gh/hhhx-lab/-ETF-@899d6f075577ef50da6954c4a693f040f7001d3c/data/raw/etf_prices_raw.csv
```

预期 SHA-256：

```text
8fe8d4ccf9d0fa9660b898d88c510ac71505b0907a6cef37989d3c0dc8fed8c5
```

从仓库根目录运行：

```bash
python3 scripts/prepare_low_frequency_data.py

python3 -m quant_system \
  --config configs/low_frequency_etf.yaml \
  --output reports/low_frequency_etf

python3 -m quant_system --benchmark \
  --config configs/low_frequency_etf.yaml \
  --output reports/low_frequency_benchmark

python3 -m unittest discover -s tests -q
```

`data/` 和 `reports/` 被 `.gitignore` 排除。首次接手必须执行准备脚本并重建报告，
不要因为本机碰巧存在这些文件而跳过复现。

## 当前冻结结果

单策略完整样本：

| 指标 | 结果 |
|---|---:|
| 总收益 | 140.80% |
| CAGR | 11.03% |
| Sharpe | 1.158 |
| 最大回撤 | -15.66% |
| 交易笔数 | 1,627 |

基准流程的留出期从 2023-11-16 开始：

| 指标 | 结果 |
|---|---:|
| 留出期 CAGR | 19.33% |
| 留出期 Sharpe | 1.828 |
| 留出期最大回撤 | -8.41% |
| 5 倍成本下留出期 CAGR | 17.43% |
| Bootstrap 年化收益为正概率 | 100.0% |
| 多重试验校正后 Sharpe 概率 | 90.4% |
| 验证门禁 | PASS |

完整样本等权基准总收益为 166.51%，高于策略的 140.80%；策略优势是较低波动和
回撤以及较高 Sharpe，不应表述为完整样本绝对收益跑赢基准。

## 主要文件

- `configs/low_frequency_etf.yaml`：冻结资产池、成本、风控、策略和数据哈希。
- `scripts/prepare_low_frequency_data.py`：下载或复用本地快照并执行哈希与质量检查。
- `quant_system/data.py`：Yahoo 宽表解析和统一数据入口。
- `quant_system/benchmarking.py`：12 策略同口径比较与验证门禁。
- `quant_system/cli.py`：门禁状态输出和失败退出码。
- `docs/LOW_FREQUENCY_STRATEGIES.md`：面向使用者的策略、数据和结果说明。
- `reports/low_frequency_etf/`：本地生成的单策略完整报告，不提交 Git。
- `reports/low_frequency_benchmark/`：本地生成的策略比较报告，不提交 Git。

## 下一步优先级

1. 获取有明确研究/展示授权、覆盖 2007 年以前的日线数据，验证 2008 年金融危机；
   不得用新数据反复调参后仍称其为同一个留出集。
2. 增加第二个完全隔离的时间或数据源外部验证集，并记录代码提交指纹。
3. 复核 Yahoo 归档的拆分、分红、交易日和价格后，再讨论真实资金。
4. 需要课堂展示时，可用 `reports/low_frequency_etf` 启动本地只读面板；跨频率
   网页整合前先定义报告协议，不要把 Python 日线策略与分钟策略视为同一实现。

当前交付只证明冻结历史样本上的可复现结果，不证明未来盈利，也未达到真实资金
上线标准。
