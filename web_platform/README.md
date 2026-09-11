# Quant System 课程模拟交易平台

公开站点：https://quant-system-course-dashboard.able-stork-1502.chatgpt.site

面向单账户美股／ETF的可交互课程平台。网页读取 Alpaca Paper 账户和 IEX 行情；服务器实际执行模拟订单、撤单、风控和对账。原 Python 多资产回测保留为独立研究基线。

## 组员三步独立部署

准备 Node.js 24、自己的 Cloudflare 账户和 Alpaca **Paper Key ID + Secret Key**。

1. 获取仓库代码，进入 `web_platform`（本目录）。
2. 执行 `npm ci`。
3. 执行 `npm run deploy`，按提示登录云账户、输入自己的 Paper 凭证并保存生成的网站账号密码。

向导创建独立数据库与公开 HTTPS 网站，自动检查登录和账户读取。完整前置条件、方案额度、更新、密码重置、失败恢复和验收说明见 **[DEPLOY.md](DEPLOY.md)**。每位组员独立部署，无需 OpenAI 账号；实际模拟成交仍需完成页面中的「交付验收」。

## 课堂操作

1. 打开站点，点击「使用说明」查看完整流程。
2. 点击「账号密码登录」，输入独立的课程账号和密码。无需 OpenAI 账号；访客可查看，课程操作员可修改。分享此账号的人操作同一个模拟账户。
3. 在「风控与对账」检查限额，点击「对账后恢复模拟交易」，输入「恢复模拟盘」。首次部署默认暂停。
4. 查看行情时间、市场时钟、账户与持仓。在「策略与回测」配置双均线、绝对动量或买入持有，运行真实 IEX 日线回测。
5. 保存的报告可重新打开、导出；勾选数据快照可在同一输入上复现。报告可以生成有效期 5 分钟的目标仓位订单计划。
6. 也可在「模拟交易」填写整数股订单。先预览风控结果，再确认提交。休市仅允许明确同意排队的限价单。市价／止损单要求开市且 IEX 报价在 120 秒内。
7. 订单列表显示委托、已成交股数、均价和券商状态。申请撤单后仍需等待券商确认，部分成交不能撤回。
8. 执行对账，查看审计，演示暂停或暂停并撤单。结束课程操作时可保留暂停状态。
9. 在「交付验收」准备一份实际操作记录，依次确认 1 股成交验证单、独立撤单测试单，再查询券商结果。页面显示全部九项检查，报告可重新打开并导出 Markdown 或 JSON。排队委托仍显示待成交。

## 运行与验证

Node.js 24（测试使用 `node:sqlite`），npm lock 固定构建依赖。

```sh
npm ci
npm run build
npm test
npm run validate
```

构建用 esbuild 将 `src/server.mjs`、研究引擎和界面资源编为单个 Worker ES 模块，生成 `worker/index.js` 和 `dist/server/index.js`。只编辑 `src/`；不要手改生成文件。`drizzle/` 是生成并检查过的 schema-only SQL 迁移。部署平台负责创建 D1 `DB` 绑定并应用迁移，运行时不执行 DDL。改 schema 后运行 `npm run db:generate`，已部署迁移不得重写。

服务端配置：`ALPACA_PAPER_API_KEY`、`ALPACA_PAPER_API_SECRET` 为站点秘密；`AUTH_USERNAME` 为课程账号，`AUTH_PASSWORD_RECORD` 为密码校验记录秘密；`DB` 是平台提供的 D1 绑定。密码明文不写入源码、网页、日志或数据库。

认证由网站独立提供，接口为 `POST /api/v1/auth/login`、`POST /api/v1/auth/logout` 和 `GET /api/v1/session`。密码使用随机 32 字节盐、PBKDF2-SHA256 的 100,000 次迭代校验（已在 Workerd 验证）；32 字节随机会话令牌仅置于 Secure／HttpOnly／SameSite=Strict Cookie，D1 只保存令牌摘要。会话 8 小时过期，退出立即撤销当前会话，重新登录会轮换令牌。账号或密码校验记录更新后，旧会话全部失效。登录频率在数据库中限制为每来源每分钟 20 次、全站每分钟 100 次。所有修改请求仍需同源 JSON 与操作标记，OpenAI 身份头不再授予操作权限。

公开访问不需要登录；没有开放注册、多用户隔离或找回密码。课程账号由站点管理员配置。原有 `control.owner_id` 仅保留历史数据，不参与新认证，也不改变已有订单、风控或审计记录。

## 已实现范围

| 领域 | 能力 |
| --- | --- |
| 账户与行情 | Paper 账户／持仓／订单每 15 秒轮询；IEX 行情按需查询；账户历史按区间查询 |
| 研究 | 3 个可参数化日频模板；前一根完整日线产生信号、下一根开盘成交；比例成本、收益／风险指标、基准曲线 |
| 可复现 | 数据、参数、引擎版本不可变保存；报告列表、同快照重跑和 JSON 导出 |
| 订单 | 整数股 market／limit／stop／stop_limit；day／gtc；预检、确认、查询、撤单与 CSV 导出 |
| 故障恢复 | 持久化意图先于券商调用；固定 client order ID；串行提交租约；超时查询；未知状态阻断新增 |
| 风控 | 单笔、当日提交額、单标的仓位、现金／持仓占用、日亏损、行情时效、白名单；服务端暂停与恢复 |
| 对账 | 平台订单同步券商状态；券商现金＋多空市值与净值一致性；未知项阻止恢复 |
| 审计 | 应用层只追加事件，事务覆盖意图／关键控制；SHA-256 摘要校验和导出 |
| 帮助 | 说明弹窗、权限提示、空状态与故障提示 |
| 交付验收 | 实际接口与历史数据检查、同快照重跑、1 股订单回报、独立撤单、持仓差额、对账、持久化报告与导出 |

详见 [COURSE_ACCEPTANCE.md](COURSE_ACCEPTANCE.md)。机构多租户、任意代码沙箱、AI 编排、高频、后台自动调度和真实资金交易不属于已完成能力。

## 约束与恢复

- 订单主机固定为 `https://paper-api.alpaca.markets`，行情为 `https://data.alpaca.markets`。不接受用户传入主机，不使用真实交易端点。
- 浏览器不接收券商密钥；修改需操作员身份、同源请求和操作标记。公开展示模拟账户不代表访客有操作权。
- 每 UTC 日最多 50 个非拒绝提交，额度包括后来撤销的订单；默认单笔 2,500 USD、当日 10,000 USD、单标的 25%、日亏损 5%。设置范围由服务端约束。
- 行情过期、数据库不可用、订单未知、资金字段缺失时拒绝新增。休市参考价最长 7 天。IEX 单交易所行情可能与模拟撮合不同。
- 租约不自动抢占；中断超过 90 秒后需主动对账。查不到的未知订单不因一次 404 就被认定发送失败。
- Kill 先保存暂停，再撤销本平台订单；网络与成交并发使撤单不能保证成功。不自动平仓，不撤外部订单。
- 日亏损在交易预检／提交和恢复时检查，不是后台连续监控；关闭网页不会触发策略交易。券商排队中的 GTC 等订单仍由券商管理。
- 审计摘要检测意外内容变化，不是签名、哈希链、公证或管理员不可篡改存储。对账不覆盖完整资金流水、税费或外部交易账本。
- 本地自动化验证使用 SQLite 和模拟券商 HTTP 响应，验证接口及故障恢复，不构成已部署站点实际成交的证明。

## 2026-09-11 在线修复与证据

账户、时钟、持仓和订单同时“超时”的根因是 Workerd 不支持 `fetch` 的 `redirect: 'error'`；请求在网络发送前就抛异常。现已改为 `manual` 并显式拒绝全部 3xx，保留固定 Paper 主机。实际生产日志已记录六类 Alpaca 请求返回 HTTP 200。

Node 47 项、原 Python 29 项全量测试通过；另在真实 Workerd 中验证 GET、POST、DELETE、404、重定向拒绝、脱敏及独立密码认证兼容性。Workerd 回归使用服务绑定替身，不发出外部订单。具备该运行时后执行：

```sh
workerd test tests/workerd/transport.capnp
workerd test tests/workerd/auth.capnp
```

验证运行时版本为 `1.20260515.1`。详细生产证据、实际成交验收状态和复现方式见 [ONLINE_VERIFICATION.md](ONLINE_VERIFICATION.md)。截至该记录，仅确认在线读取成功；实际成交须以「交付验收」保存的券商回报为准。

## 官方接口依据

- [Alpaca 订单说明](https://docs.alpaca.markets/us/docs/orders-at-alpaca)
- [按 client order ID 查询](https://docs.alpaca.markets/us/reference/getorderbyclientorderid)
- [历史股票日线](https://docs.alpaca.markets/us/reference/stockbars)
- [账户净值历史](https://docs.alpaca.markets/us/reference/getaccountportfoliohistory-1)
