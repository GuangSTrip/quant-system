# 项目交接说明

> **2026-09-18 三市场日线研究交接入口：**[策略总结与当前候选](docs/STRATEGY_SUMMARY_2026-09-18.md)、[模拟盘接入组员](docs/PAPER_INTEGRATION_HANDOFF_2026-09-18.md)、[低频策略组员](docs/LOW_FREQUENCY_HANDOFF_2026-09-18.md)。下文保留原多资产低频系统的历史说明，不代表本轮三市场股票组合已接入模拟盘。

## 项目目标

本项目是一套 Python 编写的多资产中低频量化研究与模拟交易系统。它覆盖数据校验、策略信号、组合构建、风险控制、现实成本回测、稳健性研究和 Alpaca Paper Trading，目标是用于课程展示和后续模拟盘验证，不承诺未来收益。

## 当前策略

生产候选使用多策略组合：约 60% 多周期时间序列趋势与约 40% 横截面动量，并根据策略近期波动动态调整权重。资产池覆盖美国及海外股票、房地产、国债、通胀资产、黄金、商品和短期国债 ETF。

## 主要入口

- `quant_system/cli.py`：命令行入口。
- `quant_system/backtest.py`：日频回测引擎。
- `quant_system/benchmarking.py`：策略基准与压力测试。
- `quant_system/broker.py`：本地 PaperBroker 与 Alpaca Paper Trading 适配器。
- `quant_system/live.py`：Alpaca 日频订单计划。
- `configs/sota_production.yaml`：冻结的生产候选配置。
- `configs/alpaca_paper.yaml`：默认禁止下单的 Alpaca 模拟盘配置。
- `docs/`：架构、验证、SOTA 调研和上线边界。

## 安全边界

- Alpaca 适配器固定连接 paper 域，不支持真实交易域。
- `paper_trading.enabled` 默认是 `false`；还需显式命令参数才能提交纸面订单。
- API 密钥只能通过环境变量注入，不得写入仓库、聊天、配置或日志。
- `.paper_state/`、市场数据缓存、回测报告和审计日志不进入 Git。
- 历史回测不代表未来收益；模拟盘应运行多个调仓周期后再评价。

## 接手后的第一步

```bash
python3 -m pip install -e .
python3 -m unittest discover -s tests -v
python3 -m quant_system --config configs/sota_production.yaml --output reports/sota_production
```

本地网页控制面板已经实现，可通过 `python3 -m quant_system --dashboard
--config configs/alpaca_paper.yaml --dashboard-report reports/sota_production`
启动。它展示净值、回撤、绩效指标、期末持仓、回测成交、模拟盘审计和
kill switch；固定监听本机地址，不读取凭据，且没有订单提交接口。
该本地面板仍用于读取原有研究产物；在线课程平台使用下面的独立服务端执行入口。

## 历史在线交付状态 · 2026-09-11

用户已明确要求并授权公开部署与实际 Alpaca Paper 操作，并要求使用独立账号密码代替 OpenAI 身份绑定。在线地址为 https://quant-system-course-dashboard.able-stork-1502.chatgpt.site ，Sites 版本 8 已于 2026-09-11 发布。站点源码提交为 `ce0097963bb3f68a352045f2037055230922a4d8`；本仓库 `web_platform/` 保存对应可构建源码。

在线平台包括账户／订单轮询、IEX 行情、三种参数策略回测、持久化数据快照、订单计划、预检与人工确认提交、逐笔／批量撤单、服务端暂停／恢复、限额修改、对账与审计。操作员以独立的课程网站账号密码登录，服务端凭据已配置。首次交易需对账并恢复；浏览器不接收券商密钥。

订单意图必须先持久化再发送。幂等 ID 防止重复提交，超时后查券商记录；无法确认时阻断新增，主动对账恢复。状态和审计使用 D1，迁移在 `web_platform/drizzle/`。所有交易端点固定到 Paper。

修复：Workerd 不接受 `redirect: 'error'`，导致所有券商请求在发送前被误报超时。改为 `manual` 并显式拒绝 3xx；固定 Paper／Data 主机与错误脱敏保留。生产日志已经记录账户、时钟、持仓、订单、行情和净值历史实际返回 HTTP 200。

「交付验收」新增持久化九项检查：在线读取、历史数据、快照回放、交易前对账、实际委托接收、1 股成交、独立撤单、持仓差额和成交后对账。操作员分别确认两笔测试单，可重新打开记录、查询券商回报和导出 Markdown／JSON。全部通过须有真实成交股数、均价、时间、撤单终态和对账证据。

验证：Python 29 项、新网页 40 项自动化测试通过，真实 Workerd 传输／密码校验回归与生产产物验证通过。自动化测试使用真实 SQLite 和模拟 HTTP，不替代实际券商成交。本次执行环境拒绝直接访问生产站点，连接的 Alpaca 工具无订单提交能力；尚未取得本次验收订单成交回报，需在已登录的网页操作员会话完成。课堂操作步骤、生产证据和能力边界见 `web_platform/COURSE_ACCEPTANCE.md` 与 `web_platform/ONLINE_VERIFICATION.md`。

版本 6 在订单与验收结果持久化后记录脱敏的 `paper_order_receipt`／`paper_acceptance_result` 生产事件，可从正式日志核查成交股数、均价、时间和对账结论。撤单验证跨开市恢复直接查询／撤销原订单，不受排队选项变化影响；重新查询出的拒单明确返回失败。

版本 8 使用 `AUTH_USERNAME` 与秘密 `AUTH_PASSWORD_RECORD`，不再使用 `OPERATOR_EMAIL` 或 OpenAI 身份头。密码盐和 PBKDF2 校验记录只配置在服务端；会话令牌以 Secure／HttpOnly／SameSite=Strict Cookie 传递，数据库保存其摘要，8 小时过期，退出立即撤销当前会话。修改账号或密码记录使旧会话失效。新增迁移只增加 `auth_sessions`、`auth_limits`，不改写旧迁移或交易数据；旧 `owner_id` 字段保留作历史数据而不参与授权。登录密码单独交付，不放在仓库或网页代码中。

上述历史版本未提供后台自动策略交易（2026-09-12 已增加）、高频、任意代码沙箱、机构多租户、AI 编排或真实资金交易；原 Python 多资产策略和网页单标的研究使用不同引擎，不把二者的回测结果混为一谈。


## 2026-09-11 独立部署交付

`web_platform/DEPLOY.md` 是组员部署入口：获取代码进入目录、`npm ci`、`npm run deploy`。Node 构建不再依赖 Bash。锁定 Wrangler 4.131.0 的向导负责 Cloudflare OAuth、账户选择、独立 D1、迁移、Paper 凭证预检、密码生成、秘密上传、公开部署和在线读／认证检查；提供更新保留数据、单独在线复查、密码重置与本地 dry-run。独立部署不复用原 Sites 项目身份。

验证：47 项 Node、29 项 Python，通过 Wrangler 实际 dry-run、两份 SQL 本地 D1 迁移和 workerd 2026-09-10 传输／认证回归。尚无组员 Cloudflare 账户的远端首部署证据，实际券商成交也仍待页面验收，不能将本地验证记作远端成交。详细前置条件、Workers CPU 额度、失败恢复和实例迁移见 DEPLOY.md。


## 2026-09-12 自动策略交付

新增持久化后台执行器、3 张增量迁移表、GitHub OIDC 调度接口、Cloudflare scheduled handler、网页自动策略控制和运行证据导出。使用既有 Paper 订单风控与幂等引擎；启动需登录授权与新鲜调度心跳；首次所选标的空仓；同日决策不重复提交；暂停、未知订单、对账与仓位偏差均有明确处理。运行与限制详见 web_platform/AUTOMATION.md；不能把替身成交当作在线成交。

## 当前课程交付口径

用户已将目标收敛为自动量化交易系统，不再以机构平台全部 PRD 为本次交付门槛。当前验收、部署与证据统一参见 `docs/COURSE_DELIVERY.md`。仓库补充故障暂停持久化失败时保留执行租约的恢复保护，以及自动运行全量测试的 CI；恢复保护无 schema 变化。在线版本必须以实际 Sites 发布记录为准，不根据 GitHub 提交推定已上线。

## 2026-09-12 发布恢复完成

开发环境恢复后，核对平台全部业务源码与 GitHub `dcbbce1b062d08184b9d75cb8b91fa1497224a9d` 一致，重新构建并通过 73 项网页测试。Sites 11 已于 10:23:28 UTC 成功发布，源提交 `9fad22e1d1e47413c04d5de0bb7dd7322c4cc4ef`，保留环境 revision 4 和原公开网址。恢复补丁现已两端同步，无新增数据库迁移。GitHub Actions 已通过完整 29 项 Python、73 项 Node、构建及 Workerd 兼容性校验。实际自动成交仍待券商证据；交付流程与状态见 `docs/COURSE_DELIVERY.md`。


## 2026-09-19 main 与港股兼容整合

以 main d02fe7a 的完整文件集为基线，保留研究成果与 Alpaca 执行，迁入长桥独立模拟交易模块。补齐 0003/0004 迁移、测试和旧富途只读桥接。配置、策略边界、已验证和待验收项见 docs/HK_MAIN_INTEGRATION_2026-09-19.md；不得再次用仅包含变更文件的树替换完整仓库。
