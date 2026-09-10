# SOTA 对标研究与验证结论

## “SOTA 一致”的可操作定义

量化领域不存在一个跨市场、跨容量、跨风险预算都成立的单一 SOTA 收益数字。本项目用两个可审计标准替代营销式表述：

1. **系统能力对标**：数据时间前沿、Alpha/组合/风控/执行边界、现实成本、订单状态、研究复现和实盘安全。
2. **策略表现对标**：同数据、同成本、同风险约束下超过公开强基线，并在只用开发集选择后，于留出集、市场阶段、成本压力和多重试验校正中保持成立。

## 调研依据

- QuantConnect LEAN 把 Universe、Alpha、Portfolio Construction、Risk Management、Execution 作为稳定模块，并用流式时间前沿减少未来函数：<https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/algorithm-engine>
- Microsoft Qlib 把数据、模型、策略、回测和工作流管理组成可复现研究链路：<https://github.com/microsoft/qlib/blob/main/docs/index.rst>
- AQR 的跨世纪证据支持多资产时间序列趋势在不同宏观阶段的稳健性，而不是选择某个回测期“最佳参数”：<https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing>
- 趋势滤波器研究强调真正重要的是多样化、仓位、成本、动态交易和风险管理：<https://www.aqr.com/Insights/Research/Journal-Article/Which-Trend-Is-Your-Friend>
- 风险平价的理论与实证基础来自低风险资产较高风险调整收益和资本效率：<https://www.aqr.com/insights/research/journal-article/leverage-aversion-and-risk-parity>
- 近期稳健组合研究继续强调协方差收缩、成本内生化和尾部约束，而非无约束均值方差优化：<https://arxiv.org/abs/2406.00610>、<https://arxiv.org/abs/2412.11575>

## 当前能力矩阵

| 能力 | 当前状态 | 与成熟系统的差距 |
|---|---|---|
| 流式时间前沿、T 收盘信号/T+1 开盘成交 | 已实现并测试 | 日频；尚无逐笔事件时钟 |
| 跨资产数据、调整价、本地不可变缓存与指纹 | 已实现 | 公司行动仍依赖数据供应商调整值 |
| 多周期趋势、横截面/双动量、风险平价、多 Alpha | 已实现 | 尚无基本面、期权、期货期限结构与另类数据 |
| 单仓/资产组/总敞口/波动/回撤风险 | 已实现 | 尚无完整保证金阶梯与券商实时风控回报 |
| 点差、滑点、冲击、参与率、部分成交 | 已实现 | 日线近似；没有 L2 队列和微观结构撮合 |
| 开发/留出、walk-forward、Bootstrap、成本压力 | 已实现 | 尚无分布式实验集群和组合式交叉验证集群 |
| 多重试验校正、概率/折损 Sharpe | 已实现 | 尚未接入实验注册中心强制统计预算 |
| PaperBroker 订单状态机 | 已实现 | 真实券商适配、断线恢复、持仓对账仍未完成 |
| 回测/实盘同策略代码 | 部分实现 | Broker 边界已有；生产事件循环仍需建设 |

## SOTA 基准协议

- 数据：VTI、QQQ、IWM、EFA、EEM、VNQ、TLT、IEF、TIP、GLD、DBC、BIL。
- 公共区间：2008-01 至 2026-08，12 个资产，56,184 行共同交易日数据。
- 开发/留出切分：前 70% / 后 30%；只按开发集 Sharpe 选择策略。
- 强基线：等权、滚动风险平价、单周期趋势、固定多周期趋势、双动量、长短趋势、动态/危机平衡多 Alpha。
- 成本：佣金 3 bps、滑点 2 bps、点差 1 bp、非线性冲击、成交量参与率与部分成交；额外重复 2×、3×、5×成本。
- 统计：概率 Sharpe、候选策略数量校正后的折损 Sharpe、20 日区块 Bootstrap。
- 容量：10 万、100 万、1000 万、1 亿美元初始资金，重新执行冲击与部分成交模型。
- 市场阶段：全球金融危机、危机后扩张、COVID 冲击、2022 通胀冲击和 2023 年以后。

权威输出位于 `reports/sota_benchmark/`。完整样本排名不能替代留出结果；报告中的 `selected_on_development` 才是协议允许选择的策略。

## 优化结论

- 动态多 Alpha 在开发集排名第一，留出期仍保持正收益和正 Sharpe，说明选择没有在留出期反转。
- 危机平衡组合处于另一个 Pareto 点：收益较低，但最大回撤和 Calmar 更好，适合更重视资本保全的账户。
- 快速波动窗口与渐进降风险降低了最大回撤，但略微牺牲 Sharpe；已保留为稳健配置并明确展示消融结果。
- 1.5 倍敞口的风险目标配置没有提高策略质量，成本后 Sharpe 更低，因此不作为默认方案。杠杆结果保留在 `reports/sota_risk_targeted/`，防止只汇报成功实验。
- 长短趋势在 ETF 代理、借券成本和当前资产池下不占优；默认生产配置保持 long-only。

这些证据证明的是“公开可复现基准下具竞争力”，不是未来收益保证，也不等于拥有期货、期权、另类数据和低延迟基础设施的封闭式机构系统。
