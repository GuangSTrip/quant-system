> 历史文档：本文保留原阶段研究与部署记录。当前三市场校园内网定稿、已验收范围和部署入口以[2026-09-21 最终交付说明](FINAL_DELIVERY.md)为准；本文中的旧入口和“尚未接入”等状态不代表当前版本。

# 本地课堂数据与模拟账户接入

## 已完成，无需用户找数据

- 免费公开 Yahoo 1 分钟数据已按 7 日分段下载并接入三市场默认报告，覆盖 2026-08-24 至 2026-09-18。
- US SPY：19 个交易日，原始 7410 根，回测时段内 7409 根；HK 腾讯：20 日，6621 / 6600 根；CN 浦发：20 日，4757 / 4752 根。非交易时段剔除，缺口不补造。
- 开盘区间突破、VWAP 回归、自适应动量的 9 份默认报告已重建。参数重算使用同一批快照。数据已冻结在仓库，课堂播放不依赖实时行情请求。
- 全样本、前后段、双倍成本已运行；后段少于 10 日，仍标为样本不足，不能据此宣称长期有效。
- 178 个组合中 162 个能从原研究档案直接恢复选股日期与候选名单，已接入时间轴及 HTML 导出。名单不是持仓或成交。剩余 16 个 A 股扩展组合未保存对应名单，不伪造。
- 所有旧组合完整的逐日持仓/现金/逐笔成交仍缺少原始数据，不能由净值曲线恢复。现有选股名单展示不等于已经完成完整旧回测复现。

刷新公开行情（不需要注册、API Key 或付费）：

```sh
.venv/bin/python scripts/fetch_public_classroom_minutes.py --update-defaults
npm --prefix web_platform run build
```

抓取失败时保留对应市场原快照；每次保存来源 URL、抓取时间和 SHA256。公开接口可变更或限流，不承诺永久服务。运行中的 Node 演示进程需重启才能载入新构建。

## 两个本地入口

- `http://127.0.0.1:8791/`：课堂研究与替身交易演示。
- `http://127.0.0.1:8792/`：真实券商模拟账户连接；本地持久化数据库，无假账户或假成交。默认暂停，无自动后台调度；填 Key 不会启动策略或下单。

## 现在用户只需做这些

1. 用编辑器打开 `web_platform/.dev.vars`，仅填写 `ALPACA_PAPER_API_KEY` 和 `ALPACA_PAPER_API_SECRET` 两个空值。必须使用 Paper Key。不要修改自动生成的其他字段。
2. 打开 `web_platform/.env.local-login` 查看本地网页登录用户名和密码，在 8792 页面登录。
3. 在 8792「港股交易」填写 App Key、App Secret、模拟账户 Access Token，勾选模拟账户声明并验证连接。凭证加密保存在本地数据库，不是 Git。
4. 告诉助手“本地已填好”，即可重启并进行只读账户/持仓/订单连接检验。无需发送密钥到聊天。网站登录密码不同于券商账户密码。

这两个私有文件均被 Git 忽略、权限 0600。不要把它们截图、上传或提交。

从干净仓库启动（不部署、不登录 Cloudflare）：

```sh
npm --prefix web_platform run local:setup
npm --prefix web_platform run build
npm --prefix web_platform run local:migrate
npm --prefix web_platform run local:paper
```

`local:setup` 不覆盖已有私有文件。数据库保存在 `.wrangler`，关闭本地服务后仍保留。模拟账户连接完成不代表自动下单已验收；本地尚未启用后台调度。

## A 股掘金

2026-09-19 检查官方 PyPI 的 gmtrade 3.0.6：仅 Windows / Linux x86（包括 x86_64），CPython 3.6–3.10 wheel；没有 macOS/Apple Silicon wheel，故没有在当前 Mac 强行安装不兼容软件。

需要一台 Windows x86_64 或 Linux x86_64 机器；建议 Python 3.10。用户只需说明有没有这样的电脑；没有也不影响策略课堂展示。不要求先购买或开通账户。

在兼容机器安装官方包 `python -m pip install gmtrade==3.0.6`，准备 `MYQUANT_SIM_TOKEN`、`MYQUANT_SIM_ACCOUNT_ID`，再按 `MYQUANT_A_SHARE.md` 配置桥接。不要用 `gm` 的实盘模式替代仿真。远程桥接与连接验证尚未完成。

官方来源：https://pypi.org/project/gmtrade/ 、https://sim.myquant.cn/sim/help/Python.html
