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
- 网页平台 Node 全量 34 项通过，使用真实 SQLite 和 HTTP 替身。
- 真实 Workerd 传输回归通过，无外部网络。
- 生产 ESM 产物可加载并导出 `fetch`。

自动化测试覆盖功能和故障恢复，不能替代生产账号的成交回报或真实浏览器人工验收。以上限制在交付说明中保留，避免将未验证部分写成已完成。
