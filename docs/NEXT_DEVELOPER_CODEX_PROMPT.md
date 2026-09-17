# 下一位开发者的 Codex 开局提示词

复制下面的提示词到新的 Codex 任务。先确认你负责的是“真实分钟数据与策略验证”“模拟盘接入”还是“低频策略”；三项可以由不同组员分别完成，不要把模拟盘成交当成分钟策略组员的交付条件。

> 请接手仓库 `D:\哈工大\课程\智能投资\quant-system`。先运行 `git status --short`、查看最新提交，并阅读 `docs/STRATEGY_LIBRARY_HANDOFF_2026-09-17.md`、`web_platform/README.md`、`web_platform/src/minute-library.mjs`、`web_platform/scripts/build-library-demo.mjs`。不要清理或覆盖现有改动；不要把 API 密钥或有许可限制的原始数据提交到 Git。
>
> 项目分工：前一位组员负责美、港、A 股三种分钟级策略的实现、回测验证和网页展示；实际模拟盘接入由其他组员负责；低频策略由另一组员负责。当前 `#library` 是研究展示，不发订单。它包含开盘区间突破、VWAP 均值回归、波动率自适应动量。默认美股 SPY 是 5 日真实短样本，港股 0700.HK 和 A 股 600000.SH 是固定种子合成样本。不要把合成盈亏当成实证收益，也不要把本地券商替身成交当成 Alpaca Paper 成交。
>
> 若你负责**真实数据与策略验证**：先检查可用数据的权限、时区、交易日历、复权和缺失分钟；按 README 的 JSON 格式放到被 Git 忽略的 `web_platform/demo-data/library-inputs/`。构建后核对三策略报告、标的、来源、曲线和成交。冻结参数与股票池，完成样本外和成本敏感性比较，保留亏损结果。把可复现的策略 ID、规则、参数、输入输出和信号样例交给模拟盘组员。
>
> 若你负责**实际模拟盘**：先对比 `web_platform/src/minute-library.mjs` 与 `web_platform/src/engine.mjs`。它们是不同的研究/执行实现，已有美股 Paper 引擎仅支持两种分钟策略；不能把 `#library` 报告直接当作 Paper 策略。选择执行通道后建立一致性测试，区分订单接收、成交及对账证据。Alpaca 凭证只在你自己的安全部署环境配置，不放入聊天、源码或网页；港/A 股不默认由 Alpaca 执行。
>
> 若你负责**低频策略**：保留 `quant_system/` 的 Python 日频研究入口；先定义与成果页共享的报告契约或独立页面，再接展示。不要把 Python 与网页同名策略视为同一实现，也不要静默混用分钟和日线基准、费用或仓位规则。
>
> 验证命令：在 `web_platform` 运行 `npm run build`、`npm test`、`npm run validate`；本地演示运行 `node scripts/demo.mjs`，打开 `http://127.0.0.1:8787/#library`。Python 使用 `conda run -n quant-system python -m unittest discover -s tests -q`。报告你实际运行的结果、未完成事项和负责边界。修改代码后先检查 Git diff，再提交；不要擅自发布网站或宣称实际模拟成交验收通过。

当前更完整的范围、数据格式和交接标准见 [三市场策略库移交](STRATEGY_LIBRARY_HANDOFF_2026-09-17.md)。
