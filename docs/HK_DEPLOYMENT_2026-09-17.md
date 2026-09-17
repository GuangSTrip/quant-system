# 港股接入上线记录 · 2026-09-17

原公开网址：https://quant-system-course-dashboard.able-stork-1502.chatgpt.site

Sites 版本 15 于 2026-09-17 15:27:18 UTC 成功发布；源提交 57c2ccbe634ed1cbe9bd5bf8a1d8f6ca0da8c7d2，部署 appgdep_6aac06c914208191b5edb389585354f1，保留公开访问、独立课程账号与原环境 revision 4。

本次网站业务源码对应 GitHub 港股分支 eda9d16f850af0546e9c26602c82b42eac1ba180 的 web_platform，包含最新 main 的三市场分钟策略库及港股只读账户入口。打包构建与 94 项网页测试通过；此前同分支通过原 Python 29 项、桥接 4 项及 Worker 运行时检查。未进行已登录在线浏览器验收；部署成功不等于富途联调成功。

检查生产配置后确认尚无 FUTU_BRIDGE_URL / FUTU_BRIDGE_TOKEN，因此当前网站港股页面会显示未配置。未连接富途实际账户，未提交订单。策略库中港股与 A 股仍为标注清楚的合成研究样本。

完整港股交易交付仍未完成。下一步需要账号持有人在常驻电脑或服务器登录 OpenD，并部署本分支的桥接服务（见 web_platform/HK_INTEGRATION.md），完成模拟账户和行情权限校验。其后仍需开发港股下单、撤单、持久化订单意图及恢复、市场风控、策略执行与常驻调度，并取得真实模拟成交和对账证据。现阶段仅只读接入代码上线，不应宣称港股自动交易可用。
