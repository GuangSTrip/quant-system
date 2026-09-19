# 全栈量化研究与交易系统

这是一套本地优先、配置驱动的多资产量化系统。设计参考成熟平台的分层思想：数据 → Alpha → 组合构建 → 风控 → 执行 → 账户 → 研究验证。当前版本完整覆盖日频研究、逼真回测、参数验证和模拟券商边界；真实下单默认关闭。

> 重要：不存在能够诚实保证未来“高且为正”收益的系统。本项目把目标定义为建立**可检验的正期望证据**：未参与选参的样本外收益、walk-forward 一致性、成本压力、Bootstrap 置信区间、基准超额和风险门禁。只有这些证据共同通过，策略才值得进入模拟盘。

## 在线课程交易平台

现已提供可实际操作 Alpaca Paper 的 [在线课程平台](https://quant-system-course-dashboard.able-stork-1502.chatgpt.site)。网页包括真实行情和账户、可参数化回测与数据快照、订单计划、预检／确认提交、撤单、服务端风控、对账和审计。点击右上角「使用说明」可查看完整课堂流程。

公开访客可以查看，使用独立的课程账号和密码登录后可以操作，无需 OpenAI 账号。持有课程账号的人共享同一个模拟账户；会话 8 小时过期，退出立即撤销。首次交易需在风控页对账并恢复。代码位于 [`web_platform/`](web_platform/README.md)，交付范围与验收见 [课程验收说明](web_platform/COURSE_ACCEPTANCE.md)。该平台为单账户美股／ETF日频研究与自动 Paper 执行，也保留手动交易；原有 Python 多资产研究、本地只读面板与此在线执行服务各自保留清晰入口。

组员独立部署只需三步：**获取代码并进入 `web_platform` → `npm ci` → `npm run deploy`**。提前准备 Node.js 24、自己的 Cloudflare 账户和 Alpaca Paper Key ID／Secret Key。向导配置独立网站账号、数据库与公开网址，不依赖 OpenAI 账号。详细步骤、服务额度、更新和故障恢复见 [三步部署说明](web_platform/DEPLOY.md)。

```bash
cd web_platform
npm ci
npm run build
npm test
npm run validate
```

网页测试要求 Node.js 24。当前低频整合后的 Python 测试为 32 项；网页测试与自动策略的完整结果见当前提交的 GitHub Actions。另通过真实 Workerd 传输与密码认证兼容性回归。已修复造成全部账户接口同时报超时的 Workers 请求参数不兼容，生产日志确认账户／时钟／持仓／订单／行情／净值历史读取成功。

「交付验收」页面可实际提交 1 股成交验证单和独立撤单测试单，保存九项检查及券商原始回报，并导出汇报文档。完整成交结论只在收到实际成交、撤单和持仓／账户对账证据后给出。本次尚未取得实际成交回报；模拟券商响应测试不等于在线账户成交证明。详见 [在线验证记录](web_platform/ONLINE_VERIFICATION.md)。

## 港股模拟交易扩展

保留上述研究和 Alpaca Paper 功能，新增独立的长桥港股模拟交易入口：连接账户、查询资金和持仓、限价委托、撤单、成交核对与定时定额限价买入。配置及边界见 [长桥说明](web_platform/LONGBRIDGE.md)，整合验收见 [兼容整合记录](docs/HK_MAIN_INTEGRATION_2026-09-19.md)。三市场日线组合仍为研究模块，尚未接入自动下单；不能将长桥定投执行器当成组合策略。

## 系统能力

| 层 | 已实现 |
|---|---|
| 数据 | CSV、Stooq、可复现合成数据，OHLCV 校验，覆盖率/异常收益/零成交量/陈旧价格审计 |
| Alpha | 均线交叉、时间序列趋势、横截面动量、可加权多策略 ensemble |
| SOTA Alpha | 固定多周期连续趋势、双动量、动态波动加权多 Alpha、危机平衡组合 |
| 组合 | 目标权重、逆波动率配置、绝对动量保护、多策略信号合并 |
| 风控 | 目标单仓上限、目标总杠杆、波动率目标、最大回撤熔断与冷静期、做空开关、换手/成交量限制 |
| 执行 | 下一交易日开盘成交、佣金、税、点差、滑点、非线性市场冲击、部分成交、现金缓冲 |
| 账户 | 逐日盯市、现金利息、融券成本、持仓/敞口/权益/回撤记录 |
| 分析 | CAGR、Sharpe、Sortino、Calmar、VaR、ES、Ulcer、Alpha/Beta、信息比率、基准与成本 |
| 研究 | 参数网格、稳健评分、70/30 留出集、扩展式 walk-forward、区块 Bootstrap、1–5 倍成本压力 |
| 基准 | 12 个低频候选、开发/留出策略选择、市场阶段、消融、折损 Sharpe 与成本压力 |
| 交易边界 | 订单状态机、部分成交、撤单、PaperBroker、Alpaca Paper Trading 适配器；真实 Broker 留作显式适配器 |
| 可追溯 | 配置快照、运行环境、数据质量报告、参数榜单、持仓、成交和 Markdown 报告 |

## 快速开始

环境要求：Python 3.9+。

```bash
python3 -m pip install -e .

# 多策略组合回测
python3 -m quant_system \
  --config configs/portfolio.yaml \
  --output reports/portfolio

# 单策略训练/样本外/walk-forward/压力测试
python3 -m quant_system --research \
  --config configs/research.yaml \
  --output reports/research

# 全量测试
python3 -m unittest discover -s tests -v

# SOTA 同口径基准与留出验证
python3 -m quant_system --benchmark \
  --config configs/sota_benchmark.yaml \
  --output reports/sota_benchmark

# 准备固定 ETF 历史快照并运行低频策略全集
python3 scripts/prepare_low_frequency_data.py
python3 -m quant_system \
  --config configs/low_frequency_etf.yaml \
  --output reports/low_frequency_etf
python3 -m quant_system --benchmark \
  --config configs/low_frequency_etf.yaml \
  --output reports/low_frequency_benchmark

# 当前开发集选中的稳健生产候选（仍然是模拟盘）
python3 -m quant_system \
  --config configs/sota_production.yaml \
  --output reports/sota_production

# 启动课程展示面板（仅监听本机，不读取券商凭据）
python3 -m quant_system \
  --dashboard \
  --config configs/alpaca_paper.yaml \
  --dashboard-report reports/sota_production
```

浏览器打开 `http://127.0.0.1:8765`。面板读取已有的
`metrics.json`、`equity_curve.csv`、`positions.csv`、`trades.csv`
和本地审计日志，展示净值、回撤、绩效指标、期末持仓与成交记录。
网页没有订单提交接口，也不会创建 Alpaca 客户端或读取 API 密钥；
只允许监听 loopback 地址。安全卡可以设置本地 paper kill switch，
恢复时必须输入确认文本，所有动作都会写入本地审计日志。

核心产物：

```text
reports/portfolio/
├── metrics.json             # 完整风险收益指标
├── tearsheet.md             # 人类可读报告
├── equity_curve.csv         # 权益、基准、敞口、回撤、熔断状态
├── positions.csv            # 每日持仓快照
├── trades.csv               # 成交与冲击成本、参与率、成交比例
├── monthly_returns.csv
├── data_quality.json
└── run_manifest.json        # 配置与运行环境快照

reports/research/
├── research_summary.json
├── research_report.md
├── parameter_leaderboard.csv
├── walk_forward.csv
└── cost_stress.csv
```

仓位和杠杆限制约束的是下单时目标值；下一次可成交前，价格变化会造成实际权重小幅漂移。报告同时记录目标限额与收盘观测峰值，生产监控应对漂移设置独立告警阈值。

## 使用真实行情

最稳妥的方式是保存本地 CSV：

```csv
timestamp,symbol,open,high,low,close,volume
2024-01-02,510300.SH,3.42,3.46,3.40,3.45,12345600
```

参照 `configs/csv_example.yaml` 运行。系统也提供 Stooq 日线适配器，示例见 `configs/stooq_example.yaml`；联网数据应下载后固化为不可变 CSV，再用于正式研究，避免供应商历史数据变化破坏复现。

## 正确研究顺序

1. 写下可证伪的策略假设，预先确定标的池和成本模型。
2. 只在训练集探索参数；不要用留出集反复改策略。
3. 要求样本外、walk-forward、多倍成本压力及 Bootstrap 门禁共同通过。
4. 更换市场、起止时间、再平衡日和成本假设，检查参数邻域是否稳定。
5. 冻结代码与配置，至少运行数周模拟盘并逐日对账。
6. 实盘从小资金开始，设置独立于策略进程的券商侧限额和人工 kill switch。

详细设计与实盘边界见 [系统架构](docs/ARCHITECTURE.md)、[验证规范](docs/VALIDATION.md) 和 [实盘上线清单](docs/LIVE_TRADING.md)。
低频策略清单、固定 ETF 池、历史快照来源与运行方式见
[低频策略与历史数据](docs/LOW_FREQUENCY_STRATEGIES.md)；下一位 Codex 的复现顺序、
冻结结果和剩余任务见 [低频 Codex 交接](docs/NEXT_LOW_FREQUENCY_CODEX_HANDOFF.md)。

## Alpaca 模拟盘

系统可连接 Alpaca 的**纸面交易**域；适配器固定使用该域，不能切换到真实交易域。它从环境变量读取密钥，使用实时 bid/ask 中间价生成订单计划，订单带确定性 `client_order_id` 以避免重试或重启重复下单，并记录账户、仓位、计划、成交和对账审计日志。

```bash
# 在 Alpaca 控制台创建 paper-only 密钥后，于当前终端设置：
export ALPACA_PAPER_API_KEY='…'
export ALPACA_PAPER_API_SECRET='…'

# 只读检查（账户、市场状态、持仓）
python3 -m quant_system --config configs/alpaca_paper.yaml --paper-status

# 下载最近日线，按冻结策略产生订单计划；默认绝不下单
python3 -m quant_system --config configs/alpaca_paper.yaml --paper-plan

# 在配置中将 paper_trading.enabled 改为 true 后，才可显式提交；市场关闭时仍会拒绝
python3 -m quant_system --config configs/alpaca_paper.yaml --paper-plan --confirm-paper-orders

# 人工熔断开关（本地持久化，提交前检查）
python3 -m quant_system --config configs/alpaca_paper.yaml --paper-halt
python3 -m quant_system --config configs/alpaca_paper.yaml --paper-resume
```

模拟盘的建议运行方式是：收盘后先运行 `--paper-plan` 检查目标权重和订单；下一个开盘时段经人工确认后运行带确认参数的命令。`reports/paper_trading/audit.jsonl` 是可用于课程展示的审计记录。不要提交密钥，也不要将此配置改造成真实下单程序。

SOTA 调研、能力矩阵、基准协议与诚实差距见 [SOTA 对标研究](docs/SOTA_RESEARCH.md)。

## 当前真实边界

系统尚未处理交易所级别的全部细节，例如复权事件、逐笔撮合、期货换月、保证金阶梯、涨跌停队列、交易所日历差异和券商异步断线恢复。因此它是完整的**日频研究与模拟交易底座**，不是未经适配即可投入资金的生产券商系统。历史或合成数据结果均不构成投资建议。


## 自动量化课程交付

网页新增「自动策略」：从回测报告创建授权运行，后台计算完整日线信号，进行风控并自动提交模拟限价单，支持暂停、恢复、撤单和证据导出。现有在线站点使用 GitHub 定时任务；独立部署使用 Cloudflare Cron。仅单账户、单策略、预置日频模板。详见 [自动策略使用与验收](web_platform/AUTOMATION.md)。

本次按用户确认的“自动量化交易系统”范围交付，功能与在线证据、尚待验证项统一见 [课程交付清单](docs/COURSE_DELIVERY.md)。组员迁移路径保持三步，实例之间使用独立数据库与自己的模拟盘凭证。
