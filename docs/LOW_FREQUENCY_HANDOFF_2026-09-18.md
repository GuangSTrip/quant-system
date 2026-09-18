# 给低频策略组员的交接

日期：2026-09-18。当前停止新增策略搜索，交付已有数据、算法、结果和继续研究的边界。结论先看 [策略总结](STRATEGY_SUMMARY_2026-09-18.md)。

提交前已同步组员的低频 ETF 提交 `b27d9af`。该独立研究线另见 [低频 ETF 策略与数据](LOW_FREQUENCY_STRATEGIES.md)、[组员低频交接](NEXT_LOW_FREQUENCY_CODEX_HANDOFF.md)，入口配置为 `configs/low_frequency_etf.yaml`，数据准备为 `scripts/prepare_low_frequency_data.py`。其中固定 6 ETF 与本轮三市场动态股票池是不同实验，不能混算收益；其历史缓存不随这次 Git 提交传输，本机未重跑该套历史回测。

## 1. 两套代码不要混淆

本轮因分钟数据限制改做日线，本身已属于日频/较低换手研究：每 21 日重选，部分策略每天检查退出条件。因此与低频组有重叠，可直接复用动态选股与组合引擎，不必再实现同样的三市场数据读取。

- 新三市场股票组合：`scripts/evaluate_modular_daily.py`、`scripts/refine_daily_research.py`，结果为本次交接主线。
- 旧多资产 Python 系统：`quant_system/strategies/`、`portfolio.py`、`backtest.py`、`risk.py` 和 `configs/`，包含趋势、动量、多周期和集成策略。根目录旧交接介绍的是这条线，其 `sota_production.yaml` 命名不代表通过了本次三市场验证。

本轮没有把两个账户、两套回测结果或两组策略合并。若低频组继续做周/月频、多资产或价值策略，请单独标识配置和结果，不覆盖现有候选。

## 2. 数据交接范围

| 内容 | 本地位置 | 实际范围与用途 |
|---|---|---|
| A 股全市场日线 | `data/point_in_time_cn/*.csv.gz` | 658 个交易日，2024-01-02—2026-09-17；清单 5904 个上市/退市代码不代表每个代码每天有行情 |
| A 股历史估值/股息 | `data/modular_daily/CN_basic/*.csv.gz` | 33 个月度快照，`pe_ttm`、`dv_ttm`、`total_mv` 等；不是完整财报质量因子库 |
| A/港股清单 | `data/universe_access.json` | 动态历史过滤所需清单等；实际选股仅沪深 A 股，未纳入北交所 |
| 港股日线 | `data/modular_daily/HK/*.csv.gz` | 315 只通过检查；从 2462 个当前清单候选中自动抽取 600 只尝试下载 |
| 美股日线 | `data/modular_daily/US/*.csv.gz` | 392 只通过检查；从 6171 个普通证券候选中自动抽取 600 只尝试下载 |
| 港美股下载记录 | `data/modular_daily/HK_manifest.json`、`US_manifest.json` | 来源、请求和成功情况；不能将缺失股票当零收益 |
| 美股清单原始文件 | `data/international_universe/` | 当前交易所清单，用于解释抽样来源 |

港股对齐后 667 日、美股 680 日；各自交易日历不相同。港美股采用新浪复权数据，经 AkShare 获取。A 股通过 `load_cn` 读取日线并用 `close/pre_close` 串接调整价格。现金不计息，公司行动由调整价格近似处理。

局限：港美股存在当前存续名单、下载成功和数据质量筛选偏差；全序列日变动超过 65% 的股票被排除，也可能排除真实行情，故不是无偏全市场研究。A 股没有完整历史 ST 和精确限价信息。财务变量必须使用信号日之前的历史快照，不能用今天财务数据回填过去。

数据约 118.4 MiB，上限 1 GB。本轮不继续下载；若后续扩容，先统计已有数据和新增估计，超过上限须由用户决定。`data/` 与 `reports/` 不进 Git，交接缓存时仅复制上表的行情/清单和必要报告，**排除 `data/tushare_token.txt` 及所有凭据**。其他同学用自己的权限下载；本机 Token 是原始单行文本，不是 `token=...` 格式。

## 3. 引擎结构与复用方法

`Study` 包含 `market`、`panel`、`features`、`selections`、`metadata`、`dead`。`Panel` 提供日期、代码、开收盘、前向估值、成交量和成交额矩阵。矩阵行是日期，列是证券；缺失开盘不能用前向估值冒充成交价。

| 函数 | 用途 |
|---|---|
| `prepare(market)` | 读缓存、算历史滚动指标、生成原四种动态选股名单 |
| `china_selection(study)` | 注入新增四种 A 股选股及其历史名单；返回名单记录 |
| `allocate(study, day, ids, active, allocation)` | 由入选名单、激活状态生成 0—1 目标权重 |
| `apply_risk_policy(...)` | 按历史波动或净值缓冲进一步缩仓 |
| `simulate(...)` | 下一开盘撮合、费用、现金、持仓、净值与指标 |

要复现 A 股本轮候选，先 `study=prepare('CN')`，再 `china_selection(study)`，然后 `simulate(study,'smooth_momentum','trend','vol08')`。港股为 `simulate(prepare('HK'),'near_high','monthly','inverse_vol',risk_policy='risk06')`；美股为 `simulate(prepare('US'),'near_high','breakout','inverse_vol')`。从项目根目录导入时需将 `scripts` 加入 Python 模块搜索路径；直接运行下列脚本已处理正常脚本路径。

目前时间切分硬编码为 2025 开发段、2026 复核段，252 日预热。不是支持任意年份的通用滚动验证框架；扩充更早历史时需先参数化区间、相位和切分，避免重新计算导致整个换股日历改变。

## 4. 复现步骤

在项目根目录，使用已配置的 `quant-system` conda 环境：

```powershell
conda activate quant-system
$env:PYTHONIOENCODING='utf-8'
# 需要完整缓存；下面只计算，不下载，不下单
python scripts/evaluate_modular_daily.py
python scripts/refine_daily_research.py
# 校验核心撮合/仓位逻辑
python -m unittest discover -s tests -p test_modular_daily.py
```

第一步重建原有三市场 144 组报告；第二步读取这些报告，重建新增 34 组与压力检查。重跑会覆盖对应结果文件，继续改规则前应另存本次报告和源代码版本，不能把改后的结果仍称为本次冻结结果。

只看已有成果，无需重跑回测：

```powershell
Set-Location web_platform
npm ci
npm run build
$env:QUANT_DEMO_PORT='8765'
node scripts/demo.mjs
```

浏览器打开 http://127.0.0.1:8765/#daily 。若已有进程占用端口，确认是否是本项目旧服务，再复用或重启，不要直接换掉用户熟悉的入口。Node 使用 24；本地演示交易部分为替身，不能算券商 Paper 成交记录。只展示静态结果时，网页内置 JSON 足够，不需要 Token。

数据获取脚本保留在 `fetch_modular_research_inputs.py`、`fetch_cn_point_in_time_daily.py` 等处；本次交接不要求重新抓取。网络权限、接口频率和凭据按接手环境配置，勿假设每台机器已有相同权限。

## 5. 报告字段和网页接入

- 原库：`reports/modular_daily/{CN,HK,US}.json` → `web_platform/src/modular-daily-results.json`。
- 本轮：`reports/daily_refinement/{CN,HK,US}.json` → `web_platform/src/daily-refinement.json`。
- 页面模块：`daily-workbench.mjs`、`daily-refinement.mjs`；资源注册在 `assets.mjs`、`server.mjs`。改源文件后重新构建。
- `dates` 与 `equity`、`exposure` 逐点对齐。`equity` 是相对 100 万初始资金的净值比率；`exposure` 是 0—1 比例。
- `full`、`development`、`review` 分别存全段、2025、2026 指标；`cagr_pct` 为百分数，`max_drawdown_pct` 在 JSON 中为负数，页面取其相反数显示跌幅。
- `selected` 是本轮事后探索候选，`previous` 是上次答复口径的候选；`double_cost`、`delayed_open` 只对应本轮候选，不随页面其他实验选择而变化。
- `selection_history` 记录调仓日名单；本轮文件主要记录新增 A 股名单，港美股原名单在原报告 `metadata.selection_history` 中。报告不是完整逐笔账户账本，也没有每日完整目标权重。

新增策略时保留规则、参数、股票池定义和成本；使用独立 ID 和报告文件。页面的原有 4×3×4 自由组合与其测试假设固定，新增维度需同步 UI 和测试；不要把新算法结果塞到旧 ID 下。

## 6. 后续研究优先级（尚未执行）

1. 冻结当前规则，选择未参与调参的更早历史或后续数据验证。2026 年已经被反复查看，不能继续叫独立样本外。
2. A 股优先分析收益来源、换手与成交延迟敏感性，比较更慢的退出/换仓是否改善成本后表现；已有 7.04% 年化并不稳健。
3. 港美股优先补历史成分和跨来源价格核对，再考虑扩大股票池；不能靠只保留成功下载且走势平稳的证券提高成绩。
4. 如做周/月频，将收盘信号与下期实际可成交时点分开，保持行业/个股集中度、现金占用与成本可比较。
5. 新“质量”策略需要历史可得财报及公告时间；现有股息率、市盈率快照不足以代表完整盈利质量因子。

最终比较同时报告累计/年化、回撤、逐年表现、基准、仓位与成本压力；不要只根据全段最高收益宣布最优。原有结果和失败实验也应保留。
