> 历史文档：本文保留原阶段研究与部署记录。当前三市场校园内网定稿、已验收范围和部署入口以[2026-09-21 最终交付说明](../docs/FINAL_DELIVERY.md)为准；本文中的旧入口和“尚未接入”等状态不代表当前版本。

# 组员独立部署：三步开始

这条路径把完整网页、服务端交易接口和 D1 数据库部署到组员自己的 Cloudflare Workers。网站公开可访问，实际操作需要独立网站账号；不需要 OpenAI 账号，也不依赖原站点继续运行。每个实例使用自己的 Alpaca Paper 账户。

## 开始前准备

- 安装 **Node.js 24**（包含 npm）；Windows PowerShell、macOS、Linux 均可运行 Node 构建和部署脚本。
- 拥有本私有仓库的读取权限，或者取得组长提供的源码压缩包。仓库保持私有，公开网页与源码访问权限是两回事。
- 自己的 **Cloudflare 账号**，在控制台完成 Workers & Pages 入门设置并注册 `workers.dev` 子域名；无需购买域名。
- 自己的 **Alpaca Paper Key ID 和 Secret Key**，这是两个值。必须来自模拟盘，不能只提供 Key ID。账号需要已激活且允许交易。
- 本机可访问 npm、Cloudflare 和 Alpaca。云账户的服务额度与费用由本人选择；正式汇报前须在自己的方案上完成登录和回测验收。Workers Free 的单请求 CPU 上限为 10ms，密码校验和长区间回测可能超过此额度；需要更高 CPU 额度时选择 Workers Paid，部署向导不会自动购买或升级方案。[官方额度说明](https://developers.cloudflare.com/workers/platform/limits/)

## 三步部署

**1. 获取代码，进入 `web_platform` 文件夹。**

```sh
git clone https://github.com/GuangSTrip/quant-system.git
cd quant-system/web_platform
```

也可以在 GitHub 下载 ZIP，解压后在 `web_platform` 中打开终端，无需 Git。

**2. 安装锁定版本的依赖。**

```sh
npm ci
```

**3. 启动部署向导。**

```sh
npm run deploy
```

按提示在浏览器登录 Cloudflare，选择云账户，输入希望使用的网站账号，再在终端输入自己的 Paper Key ID 和 Secret Key。密钥输入不回显。向导先读取模拟账户验证凭证，再生成网站密码；请立即保存终端显示的账号密码。

向导自动创建随机命名的网站及独立 D1 数据库、应用全部尚未执行的数据库迁移（当前三份）、构建服务、上传运行时秘密并发布。完成后会输出实际 `https://…workers.dev` 网址，并检查登录、会话、账户、市场时钟、持仓、订单和退出。检查过程不会提交或撤销订单。

新网站默认暂停交易。打开网址 → 登录 → 点击「使用说明」；到「风控与对账」检查限额、对账并恢复，再运行研究或预览提交模拟订单。

## 更新、检查和恢复

| 目标 | 操作 |
| --- | --- |
| 更新自己已有的网站 | 在原目录获取新代码，执行 `npm ci`、`npm run deploy`。保留原部署配置，复用数据库、券商秘密和网站密码 |
| 单独复查在线连通与登录 | `npm run deploy:verify`，输入现有网站密码；不重新发布、不下单 |
| 忘记或更换网站密码 | `npm run password:reset`，以原 Cloudflare 账号登录，保存生成的新密码；旧会话失效，模拟盘密钥与交易数据保留 |
| 只检查构建、不创建云资源 | `npm run deploy:check` |
| 运行应用测试 | `npm test`；运行真实 Worker 本地兼容性检查：`npm run test:runtime` |
| 换电脑维护同一实例 | 除源码外，私下复制原 `web_platform/.quant-deploy/state.json`，放到新电脑相同位置；登录原 Cloudflare 账户后部署。该文件保存实例标识，不含 Paper 密钥或网站密码 |
| 给另一个组员新建实例 | 只分享 GitHub 源码或干净源码 ZIP，让对方重新执行三步部署。不要复制你的本地部署状态 |

中途失败可在原目录再次运行。已创建的数据库会按保存的名称恢复；迁移只应用未执行的文件，失败会停止后续发布。首次配置尚未成功发布时，重试需重新输入 Paper 密钥，并会生成新的登录密码。已发布但在线检查失败时，先保留终端网址，用 `deploy:verify` 复查，避免把“已发布”误当作“全部验收通过”。

网站与数据库标识保存在被 Git 忽略的本地部署目录；密钥仅在上传期间写入受限权限临时文件，上传成功或失败后均清理，云端作为 Worker Secrets 保存。强制断电／杀死进程可能留下临时文件，恢复后可删除该目录中的 `upload-*` 临时子目录，保留 `state.json`。网站密码仅在创建／重置时显示，不写入源码和部署状态。

## 常见问题

- **GitHub 返回 404／无权限**：先由仓库所有者授予读取权限，或使用组长提供的源码包。
- **要求注册 workers.dev 子域名**：打开 Wrangler 返回的 Cloudflare 控制台链接，完成一次性 Workers 入门设置，再重新部署。
- **部署成功但访问失败**：先确认网络能访问 `workers.dev`，稍后运行 `npm run deploy:verify`；如所在网络限制该域名，可由云账户管理员绑定自己拥有的域名。
- **Alpaca 401／403**：检查使用的是否为同一组 Paper Key ID 和 Secret Key，以及账号权限。行情使用 IEX，SIP 订阅不是本平台前提。
- **账户接口超时／连接中断**：查看网页具体错误及 Cloudflare Worker 日志，检查外部服务与网络，再复查。原 Workerd `redirect: error` 兼容性故障已经修复；新的失败不能一律归为旧问题。
- **1102 / Exceeded CPU Time**：在 Cloudflare 查看 CPU 指标，缩短回测区间或使用适合该计算负载的 Workers 方案。不要通过削弱密码校验来绕过问题。
- **登录后仍不能下单**：检查是否仍暂停、市场是否开市、行情是否新鲜、风控额度和对账是否通过。错误会在服务端阻止提交。
- **想换另一只模拟账户**：请新建干净实例和数据库，避免把旧账户订单与新账户混合。仅轮换同一账户的 API key 时，可在 Cloudflare Worker Settings 中更新两个 Paper Secret，再执行 `deploy:verify`。

## 交付验收与已验证证据

2026-09-11：47 项 Node 测试、29 项 Python 测试通过；锁定的 Wrangler 4.131.0 完成真实 `deploy --dry-run`，构建包约 205 KiB；原始两份 SQL 迁移在 Wrangler 本地 D1 成功应用；workerd 2026-09-10 通过传输与密码认证回归。自动化测试使用本地券商响应替身。

当前环境没有组员的 Cloudflare 登录，尚未以一个全新云账户执行远端创建、发布和在线验证，也未在 Windows/macOS 实机运行向导。上述本地证据不代替远端部署验收。

原在线站点已确认真实 Paper 数据读取成功；真实成交验收仍须以券商回报为准。每个新实例在「交付验收」执行 1 股成交验证和独立撤单测试，保存九项检查，导出报告交给老师。休市排队、模拟 HTTP 测试或成功登录，都不算已成交。完整流程见 [COURSE_ACCEPTANCE.md](COURSE_ACCEPTANCE.md)，原站点证据见 [ONLINE_VERIFICATION.md](ONLINE_VERIFICATION.md)。

## 部署实现依据

Wrangler 使用官方 OAuth 登录、D1 创建／迁移与 `deploy --secrets-file`。密钥与代码一起发布，后续部署未提供的秘密保留。部署配置由脚本生成，不读取原 Sites 项目标识来创建组员实例。

- [Wrangler 账户命令](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [D1 命令](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
- [Worker 部署命令及 secrets-file](https://developers.cloudflare.com/workers/wrangler/commands/workers/)


## 自动运行

部署向导配置 Cloudflare 原生五分钟 Cron。部署完成后等待真实后台心跳，在网页选择回测和预算并授权启动；此后关闭浏览器仍执行。实例默认暂停，不会因部署或首次心跳而下单。参见 [自动策略说明](AUTOMATION.md) 和 [课程交付清单](../docs/COURSE_DELIVERY.md)。
