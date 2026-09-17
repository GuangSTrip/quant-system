# 下次继续：分钟策略库与网页成果演示

三市场策略库最新移交状态、真实数据接入步骤及低频组员接口建议，见 [三市场策略库移交（2026-09-17）](STRATEGY_LIBRARY_HANDOFF_2026-09-17.md)。下文是此前工作记录，若有差异以新移交文档和当前源码为准。

## 当前状态

- 仓库有未提交改动；不要清理或覆盖。旧的分析报告 `docs/HFT_STRATEGY_LIBRARY_REVIEW_2026-09-16.md` 也仍是未跟踪文件。
- 网页新增“成果演示”首屏，展示数据来源、交易标的与规则、回测盈亏拆解、模拟订单及其状态。当前本地演示入口为 `http://127.0.0.1:8787/#showcase`，进程由本次会话启动，跨会话不保证存活。
- 2026-09-17 新增 `#library` 三市场分钟策略库：开盘区间突破、VWAP 均值回归、波动率自适应动量，分别展示美股、港股、A股普通股票，共 9 份报告。美股使用真实但只有 5 个交易日的 SPY 历史快照；港股和 A股使用确定性合成分钟样本，绝不可把其盈亏当作历史绩效。A股普通股票按 T+1 模拟，港股午休和交易单位分别处理。研究模块 `web_platform/src/minute-library.mjs` 不提交券商订单，低频组员可沿用报告字段。
- 三市场策略库现显示策略与同条件基准的资金曲线、盘中回撤曲线和逐笔回测成交。曲线从每根分钟线计算，网页每 5 根采样；合成样本曲线是展示功能测试，不是实证研究。原有 `#research` 回测页也有曲线，但只覆盖当前美股 Paper 策略。
- 真实分钟数据接入点已经落地：将符合 `web_platform/README.md` 格式的 JSON 快照放到被 Git 忽略的 `web_platform/demo-data/library-inputs/`，运行 `node scripts/build.mjs` 后按市场/标的/策略生成报告；网页“标的”列表从报告自动生成。现有演示默认只有 SPY、0700.HK、600000.SH 各一个标的；港股与 A股仍为合成样本，尚未实现 Tushare API 自动拉取或多标的实时交易。
- 2026-09-17 后续完善：港股和 A股演示样本改为固定种子伪随机路径（HK seed 4107、CN seed 6129），两次构建产物 SHA-256 一致；网页增加同一标的三策略对照表及价格图买卖点。所有合成数值仍标为流程验证，不能当作策略收益证据。浏览器已检查三市场都有对照行、资金/回撤/价格曲线和买卖标记。
- 本地登录：`course_test` / `fixture-only-password-123`，仅为测试替身凭据。
- 演示历史数据为 `web_platform/demo-data/SPY-1Min-snapshot.json`：Yahoo Finance Chart 的 SPY 1 分钟公开历史快照，2026-09-09 至 2026-09-15，共 1951 根原始分钟线，常规时段用于回测的为 1950 根，覆盖 5 个交易日。`web_platform/scripts/fetch-demo-data.mjs` 可更新该快照，但 Yahoo Chart 非正式接口，不用于生产。
- 演示策略：SPY（跟踪标普 500 的 ETF，而不是 500 只股票分别下单）、开盘 15 分钟区间突破、0 基点阈值、预算 2000 美元、单边成本 10 基点。交易范围在服务端限定为 SPY、QQQ、AAPL、MSFT；一次仅运行一个标的。正式 Alpaca IEX 分钟回测窗口已放宽至 2—30 个日历日并处理分页；本地快照仍只有 5 个交易日。
- 演示回测：18 笔买卖，扣成本前约亏 11.71 美元，交易成本约 27.43 美元，净亏约 39.14 美元（约为策略预算的 1.96%）。同预算、同单边成本、每天首根开盘买入末根收盘卖出的日内基准净亏约 21.83 美元；策略落后基准约 17.31 美元。引擎版本 `course-intraday-1.2.0` 修正了此前跨夜基准的不公平比较，并使当日收盘平仓成本计入当天净值。不要为使样本盈利而在这 5 天上挑参数；应保留亏损结果并做更长、样本外验证。
- 本地模拟按真实历史信号回放了一买一卖，并由券商替身返回 `filled`；绝不是 Alpaca Paper 实际成交。演示模式 API、页面连接状态及侧栏均标示“本地券商替身”。本机没有 Alpaca API 凭证，线上站点未更新，真实 Paper 联机验收未完成。
- 新策略由 `web_platform/src/engine.mjs` 共用，`server.mjs` 回测与 `automation.mjs` 决策调用同一规则。Python 原有研究仍是独立旧基线，尚未改造成统一策略源。

## 已验证

- `web_platform`: `node scripts/build.mjs`、`node --test tests/*.test.mjs`（90/90 通过）、`node scripts/validate-artifact.mjs`。浏览器实际检查过 `#showcase`、`#research`、`#automation`、`#library`；本地截图在 Codex visualizations 目录。
- Python: `conda run -n quant-system python -m unittest discover -s tests -q`（29/29 通过）。该 Conda 环境没有 pytest，仓库本来也使用 unittest。
- `git diff --check` 无实质错误；Windows 只有 LF/CRLF 提示。

## 下次优先处理

1. 先执行 `git status --short`，确认保留本次未提交改动；按需用 `node scripts/build.mjs` 与 `node scripts/demo.mjs` 重启本地演示。
2. 复核老师对首屏的反馈：交易代码、ETF 含义、5 日样本限制、亏损拆解是否一眼可读。把真正的研究窗口与演示快照区分清楚。
3. 若要真实 Alpaca Paper 验收，需在部署环境安全配置用户自己的 Paper 密钥和网站登录；切勿把密钥写入仓库或演示脚本。完成后仅在开市时验证真实行情、订单接收、成交/未成交回报，并在网页明确标示来源。
4. 下一阶段再做更长历史和样本外测试，固定股票池与参数后比较开盘突破、VWAP 与同预算日内基准；避免用这 5 日数据筛选获利参数。确认调度频率（现有 Sites 约 10 分钟一次）与分钟策略的实际执行差距。

## 参考

- 主流平台允许固定股票池并在订单中显示代码与状态：[QuantConnect Manual Universes](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/universe-selection/manual-universes)、[QuantConnect Backtest Orders](https://www.quantconnect.com/docs/v2/cloud-platform/api-reference/backtest-management/read-backtest/orders)。
- Alpaca 历史分钟线单页最多 10000 条且需处理 `next_page_token`：[Alpaca Historical Bars](https://docs.alpaca.markets/us/v1.4.2/reference/stockbars)。
