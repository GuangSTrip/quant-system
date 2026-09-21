# Windows 部署与维护

对应 2026-09-21 校园内网版本。现有服务器无需重新初始化；不要在运行目录覆盖数据库、私有配置或重新创建账户。

## 1. 构建和初始化

安装 Node.js 24、Git 和 Python。研究环境可使用 Python 3.12；交易桥接使用独立 Python 3.10 环境安装 gmtrade；行情依赖按 `requirements-market-data.txt` 单独安装。不要混装这三个环境。

```powershell
git clone https://github.com/GuangSTrip/quant-system.git
cd quant-system\web_platform
npm ci
npm run build
npm test
npm run validate
npm run local:setup
npm run local:migrate
```

初始化生成 `.dev.vars` 和 `.env.local-login`，不覆盖已有文件。仅在服务器编辑，禁止上传。数据库迁移包含 A 股执行和持仓归属表。

## 2. 三个平台

- Alpaca：在 `.dev.vars` 填 Paper Key ID 与 Secret。
- 长桥：网站启动后登录，在港股连接界面填模拟账户 App Key、App Secret 和 Access Token；凭证加密保存在本机数据库。
- 掘金：根目录建立 Python 3.10 的 `.venv-myquant`，安装 `gmtrade==3.0.6`。创建 `web_platform/.env.myquant-local`，填 `MYQUANT_SIM_TOKEN` 和 `MYQUANT_SIM_ACCOUNT_ID`。当前服务器采用 `MYQUANT_CONNECTION_MODE=terminal-paper`，并将 `MYQUANT_TERMINAL_PAPER_ACCOUNT_ID` 设为已核对的同一个仿真账户 ID；掘金终端须保持仿真登录。

在 `.dev.vars` 设置 `MYQUANT_BRIDGE_URL="http://127.0.0.1:8765"`、`MYQUANT_BRIDGE_LOCAL_ONLY="true"` 以及自行生成的高熵 `MYQUANT_BRIDGE_SECRET`。创建 `web_platform/.lan` 后，从根目录运行：

```powershell
.\.venv-myquant\Scripts\python.exe -X utf8 scripts/check_myquant_connection.py
.\.venv-myquant\Scripts\python.exe -u scripts/run_myquant_local.py
```

连接成功不代表成交。按页面对账、预览并确认仿真环境后才恢复交易。

## 3. HTTPS 后端与 HTTP 内网入口

后端仅监听 `127.0.0.1:8792`，桥接仅监听 `127.0.0.1:8765`。网关 `scripts/serve-campus.mjs` 在 8791 提供完整功能。

在 `web_platform` 使用 OpenSSL 或组织批准的证书工具生成本机 PEM 证书及私钥；证书需包含 IP SAN `127.0.0.1`：

```powershell
New-Item -ItemType Directory -Force .lan
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout .lan/server-key.pem -out .lan/server-cert.pem -subj /CN=localhost -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
node node_modules/wrangler/bin/wrangler.js dev --local --ip 127.0.0.1 --port 8792 --config wrangler.local.json --local-protocol https --https-key-path .lan/server-key.pem --https-cert-path .lan/server-cert.pem
```

另一终端运行 `node scripts/serve-campus.mjs`。迁移到新服务器时，修改该文件 `hosts` 白名单中的 IP，以及健康检查中的服务器地址，不要删除 Host 检查。校园来源由 `campus-network.mjs` 与防火墙共同限制。

管理员核对目标网段后运行 `scripts/enable-lan-firewall.ps1`。路由脚本含当前校园网参数，迁移时须核对网卡、网关和网段，不能直接照搬。HTTP 未加密，仅供已授权校园网模拟展示。

## 4. 行情、信号和调度

根目录建立 `.venv-data`，安装 `requirements-market-data.txt`。复制 `configs/portfolio_service.example.json` 为 `configs/portfolio_service.local.json`，将 `site_origin` 改为 `https://127.0.0.1:8792` 并核对股票池。

`web_platform/scripts/run-portfolio.mjs` 从私有配置及数据库读取凭证并启动行情生产；需要三个市场对应配置文件存在。核验信号后再启用后台，数据生产不代替网页上的策略授权。

调度需在 `.dev.vars` 设置 `SCHEDULER_LOCAL_ENABLED="true"` 和自行生成的高熵 `SCHEDULER_LOCAL_SECRET`。`node scripts/local-scheduler.mjs --once` 执行一次检查，可能执行已授权策略，运行前先确认策略状态。

## 5. 持续在线任务

维护脚本保留本机实际路径，**并非跨机器一键安装包**。迁移前将 `start-lan.ps1`、`start-research.ps1`、`start-portfolio.ps1`、`start-scheduler.ps1`、`watch-website.ps1` 中的 Node 路径改为本机绝对路径，将 `install-website-uptime.ps1` 中 Windows 身份改为目标普通用户。

先注册普通用户任务 `QuantSystemCampus`、`QuantSystemCampusResearch`，分别运行 `start-lan.ps1`、`start-research.ps1`，工作目录为 `web_platform`，使用隐藏 PowerShell 窗口。`install-website-uptime.ps1` 更新这两项已有任务为 S4U 开机启动并安装每分钟看门狗；同时关闭接通电源时的睡眠/休眠，需管理员权限。

`install-background.ps1` 注册行情与调度任务。为 `start-myquant.ps1` 单独建立普通用户登录触发任务，保持掘金仿真终端登录。券商任务仍依赖用户登录会话。

```powershell
node scripts/check-website-health.mjs
node scripts/check-platforms.mjs
Get-ScheduledTask -TaskName 'QuantSystem*'
```

健康结果中 `backend`、`gateway` 应为 `true`；券商连接需另行核验。不得把停止任务作为清理终端或结束工作的步骤。另一台校园网电脑访问成功，才算完成跨机验收。

## 6. 私有配置和课堂共享登录

不上传 `.dev.vars*`、`.env*`（示例除外）、`.lan`、`.wrangler`、数据库、PEM 私钥及 `configs/*.local.json`。备份也应存放于受保护位置。

干净构建默认不嵌入密码。仅在明确允许共享模拟账户时，本机创建 `.lan/share-website-login.enabled` 后重新构建，才会读取 `.env.local-login` 并在登录弹窗展示。此时生成的 `worker`、`dist` 可能含共享密码，始终被 Git 忽略，不应公开上传。
