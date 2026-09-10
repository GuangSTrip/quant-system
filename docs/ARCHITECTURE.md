# 系统架构

## 数据流

```text
DataSource → validation/audit → Strategy/Alpha → target weights
    → RiskManager → order sizing → execution simulation
    → positions/cash ledger → performance & research reports
```

系统借鉴 LEAN 的 Algorithm Framework，把信号、组合、风险与执行解耦；借鉴 Qlib 的 workflow 思想，把数据、模型/策略、回测和实验记录串成可复现研究流程。代码保持纯 Python/Pandas，以便审计和二次开发。

## 模块职责

- `data.py`：长表 OHLCV 契约、结构校验、质量报告和数据源。
- `strategies/`：只观察已完成 K 线并输出目标权重，不记账、不撮合。
- `risk.py`：在订单产生前裁剪目标权重并按组合实际波动缩放。
- `backtest.py`：事件顺序、账户账本、执行现实模型和完整审计记录。
- `broker.py`：订单生命周期与未来真实券商的稳定接口边界。
- `performance.py`：绝对、相对和尾部风险指标。
- `research.py`：训练选参、未触碰留出集、walk-forward、Bootstrap 和成本压力。

## 时序不变量

交易日 T 收盘完成后策略才能读取 T 的 bar；目标权重最早在 T+1 的开盘执行。交易成本在成交时扣除，持仓在 T+1 收盘盯市。任何新模块都必须保持这一不变量，否则会引入前视偏差。

## 扩展方式

- 新策略：实现 `Strategy.on_bar` 并在策略注册表注册。
- 新数据源：返回标准长表后统一经过 `validate_bars`。
- 新券商：实现 `Broker.submit/cancel/on_bar`，再增加账户同步、幂等 client order id 和断线恢复。
- 新成本模型：把报价点差、成交量曲线与冲击模型封装成独立 ExecutionModel；当前日线模型是保守近似。

