# 组合策略与模拟执行交付

本次只修改、验证及提交代码，不发布网站、不配置线上秘密、不调用在线账户下单。基线为 `e4648b1`；已有 main/港股兼容合并继续保留。本文取代早先交接中“日线组合尚未接入”的实现状态说明。

## 当前功能与范围

- 「组合策略」统一展示 178 个已注册日线组合：CN 64、HK 57、US 57；当前候选置顶，支持历史净值、指标、报告下载以及导入最新重放回测。
- 美股组合通过 Alpaca Paper，港股组合通过长桥限价单执行。服务器调度与浏览器独立；网页关闭不停止已授权策略。
- A 股回测与信号协议可用，自动执行返回 `ADAPTER_UNAVAILABLE`。没有凭空提供 A 股券商，也没有把 A 股代码发送到美股/港股通道。
- 原五个在线单标的/分钟策略、长桥定投、历史分钟研究、Python 多资产 CLI 继续保留各自入口和原有能力。历史分钟实验及 Python 多资产实验不是本次 178 个日线组合注册表中的自动执行策略。
- 每个市场/已接账户允许一个组合运行；美股和港股可以同时运行。暂停保留管理权；同账户旧自动策略和手工新增订单互斥。支持暂停、恢复、显式平仓、确认空仓后释放并选择另一个策略。暂不支持同账户多策略共享同一证券。

## 从数据到委托

```text
Alpaca / Longbridge 行情、交易日历
    ↓（独立常驻 Python 服务，只有读券商能力）
完整日线 → 固定预热起点重放 → 版本化目标权重 + 输入摘要
    ↓ 既有网站登录、CSRF、同日不可覆盖
D1 信号 / 回测报告
    ↓ 原生 scheduled 或已配置 GitHub OIDC 调度
账户与成交账本核对 → 目标差额 → 卖单 → 等待回报 → 买单
    ↓ 沿用券商锁、预算、风控、幂等、审计
Alpaca Paper / Longbridge Paper
```

`evaluate_modular_daily.decide_close()` 是历史回测和信号生成共用的决策函数。保留 21 个交易日重选、5 日波动更新、55/20 通道持有状态、全名单分配后把未激活部分留现金、CN 新选股逻辑及风险政策。服务从固定 2024 起点重放，不把重启日当第零天；输入起点与证券池摘要冻结。

信号由授权的行情生产器发布，是受信任的策略输入。服务器校验版本、市场、币种、日期、期限、权重、数据摘要、证券范围与前日流动性限额，不在 Worker 里重新计算数年/数千股票的因子。维护者不能把任意手写目标文件当成已经验证的研究信号。策略规则变动必须升级 Python `VERSION` 和网页 `PORTFOLIO_VERSION`，并重新回测。

## 本地使用（无需部署）

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[longbridge]'
.venv/bin/python -m unittest discover -s tests -v
cd web_platform
npm ci
npm run build
npm test
npm run validate
# 仅本机券商替身，绝不连接真实券商：
node scripts/demo.mjs
```

访问 `http://127.0.0.1:8787/#portfolio`。本地演示身份在 `web_platform/tests/helpers.mjs` 的 `TEST_LOGIN`，只对隔离演示有效，不能用作线上密码。页面横幅和账户来源明确区分替身成交。

### 重放已有研究缓存

```bash
.venv/bin/python scripts/portfolio_signal.py --list
.venv/bin/python scripts/portfolio_signal.py \
  --strategy-id HK:near_high:monthly:inverse_vol:risk06 \
  --session /path/to/verified-session.json \
  --output reports/portfolio/HK.json
```

session 文件字段：`signal_date`（最新完整交易日）、`data_asof`（实际收盘时间）、`execute_after`（下一交易日开盘）、`expires_at`（该日收盘）；时间必须含时区。不能用工作日推算代替交易所日历。可在组合页分别导入回测和最新信号；历史过期信号不能授权交易。

CN 复用历史全市场缓存和月度基本面快照，需先补齐原研究数据下载步骤。仓库不包含原始行情缓存；本次保留既有真实历史报告，未声称从缺失的原始数据重跑了完整历史市场。

### 后续接入自己的实例时的行情服务

`configs/portfolio_service.example.json` 给出 30 只/市场的接口示例池，不是投资推荐，也不是历史报告的完整股票池。**股票池和数据供应商变化会改变结果**，应先看生产器生成的新回测，再决定是否授权。可替换为经验证的固定证券池（至少 30 只），不能在已有策略运行中随意替换。

配置自己的 `site_origin`；不复用历史课程网站地址。常驻服务所需环境变量：

| 用途 | 环境变量 |
|---|---|
| 网站已存在的操作员 | `QUANT_USERNAME`, `QUANT_PASSWORD` |
| 美股只读行情 | `ALPACA_PAPER_API_KEY`, `ALPACA_PAPER_API_SECRET` |
| 港股只读行情 SDK | `LONGBRIDGE_APP_KEY`, `LONGBRIDGE_APP_SECRET`, `LONGBRIDGE_ACCESS_TOKEN` |

```bash
.venv/bin/python scripts/portfolio_service.py --config /path/to/private-service-config.json --once
# 日常由进程管理器常驻运行，配置异常退出告警及重启：
.venv/bin/python scripts/portfolio_service.py --config /path/to/private-service-config.json
```

服务从券商日历处理假期、半日市和美股时区，在收盘后 15 分钟才更新完整日线；`strategies: "all"` 重放所配置市场全部组合，也可列出策略 ID 减少计算。独立缓存不修改原研究数据，失败/缺失证券不会默默缩小股票池或发布清仓信号。冻结的每日结果保存在忽略 Git 的 `.paper_state/portfolio-signals/`，重启复用同份输入/目标；一个本机进程锁阻止重复生产器。

港股在正常交易日/时段每约 30 秒发布未复权价格、证券状态和实际每手股数，行情必须在 120 秒内；稀疏成交或权限不足导致旧报价时停止新增，不能以旧价格冒充实时。持仓中已落选证券仍包含在请求中。美股报价及资产可交易校验由网站直接读取券商。

服务只发布回测、信号、行情，不启用策略或发送订单。网站仍需增量迁移 `0005_quiet_jack_flag.sql`、配置已有券商通道及后台调度、设置适合组合规模的单笔/当日限额，然后由操作员在页面授权预算。当前代码默认不启动任何策略。

GitHub 调度不再硬编码其他账号的站点，也不再因推送代码触发交易检查。需要显式设置仓库变量 `PAPER_SCHEDULER_ENABLED=true`、`PAPER_SITE_ORIGIN`，并与服务器的 OIDC repository/audience 配置相符。未配置时跳过；本次没有设置这些变量或触发线上执行。原生 Worker 调度沿用 `SCHEDULER_NATIVE=true`。组合调仓的网络子请求可能超过 Worker 免费层额度，需要根据股票数配置运行资源。

## 执行与恢复规则

- 实际股数用未复权报价、实时持仓、可用现金和动态每手股数计算；目标落选证券归零；不根据复权研究份额直接发单。
- 普通策略单按上一完整日成交额 1% 限制，忽略小于策略权益 0.05% 的调整。显式操作员平仓走实际持仓及券商风控，独立于研究流动性约束。
- 先卖后买；卖单尚未终态时不预计释放现金。未完全完成的卖出不盲目追单，暂停并显示原因。部分买入/撤单不在同一调仓决策下追买，下一次有效调仓重新计算差额。
- 每个阶段先持久化全部订单意图，再调用原券商执行器；幂等编号包含运行、调仓日、阶段和证券。未知、拒绝、回报不匹配会阻断；需要查询原订单，而不是换一个编号重发。
- 崩溃租约不会自动接管；暂停落库失败时保留租约。租约超时后需对账恢复，过期的已保存委托不能跨交易日新发。
- 同日信号有数据库唯一约束和内容冲突校验。信号过期/行情过期只等待新数据；持仓漂移、账户连接变化、规则版本变化会暂停。
- 原 Alpaca 风控保留；动态股票仅在内部组合调用中扩展白名单，仍逐证券调用资产可交易性检查，手工接口没有开放任意代码。
- 长桥所有 HTTP 请求固定携带 `X-Papertrading: true`，对应官方 SDK 的模拟环境保护，禁止静默回退实盘。协议依据：[官方 SDK 配置源码](https://github.com/longbridge/openapi/blob/main/rust/src/config.rs)。仍需券商实际环境验收。
- 行情生产器使用已锁定 Longbridge Python 4.5.0 API，日历和每手字段依据[官方接口文档](https://longbridge.github.io/openapi/python/reference_all/)。本次离线验证了 SDK 配置构造，没有读取真实凭证或请求真实账户。

研究假设与执行并非同一种成交模型：研究是下一开盘、复权可分割份额；在线采用调度到达时的限价整手单，不保证开盘成交。组合风险政策目前跟随同规则重放的模型净值；实际持仓、现金和券商风控独立校验。策略现金账以成交金额加保守费用储备估算，账户实际现金再次约束买入。公司行动、碎股或外部操作导致账本偏差时暂停，不自动“修正”成额外买卖。

## 扩展接口

| 扩展 | 修改点与约束 |
|---|---|
| 新选股/择时/仓位规则 | Python 决策核、注册定义及研究报告；升级版本，加入对照测试；策略只输出目标，不直接调用券商 |
| 新数据商 | `portfolio_providers.PROVIDERS`：实现 `calendar(now)`、`histories(symbols,end)`，港股式独立报价另实现 `quotes()`；完整数据验证后发布 |
| 新市场/券商 | `MARKETS` 元数据、代码规范、`createPortfolio.adapters[market]`：`exclusive`, `available`, `snapshot`, `reconcile`, `ledger`, `submit`；必须接现有认证、锁、审计、风控 |
| A 股 | 除接券商外，实现 T+1 可卖库存、板块/整手/涨跌停/停牌、准确日历、公司行动与人民币现金，不允许仅改市场标签 |
| 同账户多策略 | 当前明确不支持；后续需独立子账户或证券级所有权、资金预留和净额分摊账本，不能直接去掉互斥 |

## 验证证据

- Python 53 项及旧富途桥接 4 项通过，包含 178 个注册组合逐项对照合并前 `e4648b1` 的确定性研究结果；固定种子 560 日/40 证券，覆盖成本、落选、通道状态和风险分配。对照摘要在 `tests/fixtures/portfolio_original_golden.json`。
- 数据生产器测试覆盖读取、完整性校验、共享核重放、回测/信号发布、同周期不重复生产；日历测试含假期与半日市。
- 网页 153 项测试通过，包含 US/HK 组合真实路由到券商替身、整手、流动性、先持久化、未知订单、并发调度、发布冲突、暂停竞争、平仓、成交持仓对账、原功能及数据库增量兼容。
- 本地构建、ESM 产物验证和真实 Workerd 传输/认证/长桥加密签名检查。
- 浏览器本机页面检查市场切换、历史曲线、能力提示；全部交易回报来自隔离替身。本次没有在线成交或在线部署证据。
