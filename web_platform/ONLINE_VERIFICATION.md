> 历史文档：本文保留原阶段研究与部署记录。当前三市场校园内网定稿、已验收范围和部署入口以[2026-09-21 最终交付说明](../docs/FINAL_DELIVERY.md)为准；本文中的旧入口和“尚未接入”等状态不代表当前版本。

# 在线故障修复与验收证据 · 2026-09-11

站点：https://quant-system-course-dashboard.able-stork-1502.chatgpt.site

## 已复现并修复的故障

账户、时钟、持仓、订单同时显示超时。生产日志中的失败发生在 0–2 毫秒内。使用与生产相同的 Workerd API 语义复现发现，`redirect: 'error'` 在网络请求发出前抛出 TypeError；原异常处理将其归为网络超时。Node 的 fetch 与原 HTTP 替身接受这一参数，因此原本的测试未发现部署差异。

`src/transport.mjs` 改为 `redirect: 'manual'`，显式拒绝全部 3xx，不跟随重定向。主机保持 Paper／Data 固定值。日志增加方法、路径、主机、状态码、耗时和脱敏原因，区分请求配置错误与网络不确定结果。订单超时仍通过固定 client order ID 查询，不自动重复提交。

复现和回归：`workerd test tests/workerd/transport.capnp`；实际使用 Workerd `1.20260515.1`。测试既断言旧参数在 Workerd 中失败，也验证修复后的 GET、Data GET、POST、DELETE、404、3xx 拒绝和错误脱敏。测试所有出站请求绑定到本地 fixture，不能作为实际成交证据。

## 已观察到的实际生产响应

Sites 版本 4 部署源提交：`8f4615726ca043e73cffff6cf9babfbb50c2373c`。

以下来自生产 Worker 的 `broker_http_response` 日志，不是本地测试输出。时间均为 UTC。

| 时间 | 主机 | 请求 | 状态 | 耗时 |
| --- | --- | --- | --- | --- |
| 05:51:53.277 | paper-api.alpaca.markets | GET /v2/account | 200 | 107 ms |
| 05:51:53.279 | paper-api.alpaca.markets | GET /v2/clock | 200 | 109 ms |
| 05:51:53.279 | paper-api.alpaca.markets | GET /v2/orders | 200 | 109 ms |
| 05:51:53.296 | paper-api.alpaca.markets | GET /v2/positions | 200 | 126 ms |
| 05:51:53.242 | data.alpaca.markets | GET /v2/stocks/SPY/snapshot | 200 | 112 ms |
| 05:51:53.240 | paper-api.alpaca.markets | GET /v2/account/portfolio/history | 200 | 115 ms |

此证据确认服务端可连通配置的 Paper 账户与行情服务，没有证明订单成交。HTTP 200、订单已接收和成交是不同的验收阶段。

## 实际成交验收状态

截至此记录，尚未取得本次课程验收订单的实际券商成交回报。执行环境拒绝直接访问生产站点；当前连接的 Alpaca 工具提供行情读取，不提供订单提交。未绕过操作员身份验证，也未通过部署时自动下单或公开无认证路由代替正式操作。

已增加「交付验收」页面及服务端流程，供已登录操作员执行，并保存真实回报。完整步骤见 `COURSE_ACCEPTANCE.md`。只有九项全部通过的最新记录可以导出为完整验收结果；未完成项、排队单和失败项保留原状态。

## 自动化验证范围

- 原 Python 项目全量 29 项通过。
- 网页平台 Node 全量 40 项通过，使用真实 SQLite 和 HTTP 替身。
- 真实 Workerd 传输回归通过，无外部网络。
- 生产 ESM 产物可加载并导出 `fetch`。

自动化测试覆盖功能和故障恢复，不能替代生产账号的成交回报或真实浏览器人工验收。以上限制在交付说明中保留，避免将未验证部分写成已完成。

## 成交证据的线上核查

订单状态写入 D1 成功后记录 `paper_order_receipt`，包含券商订单 ID、平台订单号、标的、方向、状态、成交股数、均价和成交时间；不记录请求头或凭据。验收结果保存成功后记录 `paper_acceptance_result`，包含验收号、九项结论、持仓差额和对账结果。这样可以通过生产日志核对网页实际操作的结果；持久化失败时不记录成功验收事件。

撤单验证重试会直接查询／撤销原订单，即使市场已经开市、排队勾选发生变化，也不会创建另一笔测试单。重新查询发现券商拒绝时，响应明确为失败。

## 独立账号认证更新

按用户明确授权，将操作员认证改为网站账号密码，无需绑定 OpenAI 用户。新增独立会话与登录限流迁移，保留原有交易表和审计。登录／退出、会话过期／轮换、错误密码、伪造 Cookie、OpenAI 头不能授权、来源校验、限流和会话写入失败均已通过接口测试；真实 Workerd 验证密码校验兼容性。网站登录密码由管理员独立配置，不写入交付源码。此次认证更新不代表实际成交验收已经通过。


## 2026-09-12 证券类别校验修复

用户报告正常模拟挂单被提示“标的不可交易或不属于课程证券范围”。已定位：应用直接读取 Alpaca Trading REST 的证券详情 JSON，但错误地使用了 Python SDK 模型字段 `asset_class`；REST 实际字段为 `class`。此前测试替身也使用错误字段，掩盖了问题。

先仅将测试替身改成官方 REST 字段，旧版本休市限价挂单回归由成功变为失败，重现误拒绝。修复改为严格读取 `class`，并保留 `us_equity`、`active` 与布尔 `tradable=true` 的交易限制。订单预览也调用相同检查，提交时再次读取，防止预览后状态变化。证券不存在、不可交易、非活跃、类别不支持和资料不完整分别给出包含代码的具体提示；校验失败不写入订单意图、不调用券商下单接口。

新增 8 项回归，覆盖官方 REST 字段、休市限价排队、各类拒绝与预览后变化。测试仍使用本地 HTTP 替身，不代表在线成交。字段依据：[Alpaca 官方证券返回示例](https://docs.alpaca.markets/us/docs/fractional-trading#supported-assets)。
