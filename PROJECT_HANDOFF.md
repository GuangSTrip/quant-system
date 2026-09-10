# 项目交接说明

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

随后可继续实现本地网页控制面板，优先展示净值、回撤、绩效指标、当前持仓、模拟盘订单和 kill switch。不要在没有 paper-only 凭据与人工复核时开启订单提交。
