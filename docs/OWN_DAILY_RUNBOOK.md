# 三市场自研日线研究：运行与复核

此目录是离线研究，不调用订单API，不自动部署网页或修改正在运行的策略。

## 文件与流程

1. `scripts/run_own_daily_research.mjs`在本机子进程环境中注入已有平台行情凭证。不能上传私有配置，也不能把环境变量打印到日志。
2. `scripts/own_daily_data.py`读取证券主表、分页采集2014—2025日线；支持缓存续传、清单失败记录、内容SHA-256；覆盖旧数据前按哈希归档。
3. `scripts/audit_own_daily.py`核对哈希、每年覆盖、异常价格、未取得数据及来源差异。
4. `quant_system/own_daily.py`实现三市场独立的信号、账户、费用和风险层。
5. `scripts/evaluate_own_daily.py`依照登记的参数网格逐个测试，只用开发期选参，保存全试验、成交、决策、净值、代码/股票池快照。
6. `scripts/reproduce_own_daily.py`使用对应引擎快照和原数据哈希复核主候选收益、回撤、成本。
7. `scripts/report_own_daily.py`生成本地完整报告及HTML预览。不会上传网络。

## 本机命令（在项目根目录执行）

```powershell
# 只读能力探测，CN/HK/US分别执行
node scripts/run_own_daily_research.mjs --market CN --probe

# 缓存续传；掘金SDK仅单线程，HTTP源允许小规模并发
node scripts/run_own_daily_research.mjs --market CN --collect --seconds 1500
node scripts/run_own_daily_research.mjs --market US --collect --workers 4 --seconds 900

# 港股长桥额度不足时的公开数据探索；来源统一，但不代表数据已验证
node scripts/run_own_daily_research.mjs --market HK --collect --workers 4 --yahoo --uniform-source --seconds 900

.venv-data/Scripts/python.exe scripts/audit_own_daily.py
.venv-data/Scripts/python.exe -m unittest tests.test_own_daily -v

# 版本1/2/3分别登记12/24/8个配置；不同市场分别执行
.venv-data/Scripts/python.exe scripts/evaluate_own_daily.py --market CN --tag final_v1 --version 1
.venv-data/Scripts/python.exe scripts/evaluate_own_daily.py --market CN --tag final_v2 --version 2
.venv-data/Scripts/python.exe scripts/evaluate_own_daily.py --market CN --tag final_v3 --version 3

.venv-data/Scripts/python.exe scripts/reproduce_own_daily.py reports/own_daily_v1/final_v3/CN
.venv-data/Scripts/python.exe scripts/report_own_daily.py
```

替换`CN`即可独立运行`HK`或`US`。不合并账户或币种。新数据/新策略版本应使用新tag，不覆盖旧结果后冒称同一实验。早期`broker_initial`和`expanded_*`是开发过程快照，数据和代码仍在变化；正式比较使用`final_v*`中的同一冻结引擎与各市场固定缓存。

## 明确的局限

- 本轮试验预算每市场44个登记配置，不能把反复搜索得到的最好结果当独立发现。
- 完整历史普通股池尚未取得：A股主表不含北交所；港股是当前名单；美股有大量空历史及更名映射缺失。
- 港股两来源差异及负复权价格已实际发现，不能把统一成一个来源视为问题解决。屏蔽异常棒只防止程序计算不合法收益，也会改变有效样本，不能因此声称不存在偏差。
- 行业分类、真实整手、点时ST/涨跌停、退市现金/换股结算仍缺少。所有原型不作为交易执行指令。
- 股票分红、拆并股依赖供应商复权，不等于已经逐项核对。美股1bp卖出监管费和港股结算费预留是成本假设，必须结合实际账户/历史费率才能做到精确复刻。
- 收益目标未达到时如实保留失败，不能通过取消成本、调整起始资金分母、删掉熊市或把全段结果说成样本外来宣称达标。

## 数据不能上传的部分

本次脚本不在研究报告中写入凭证，但不要打包整个项目或`.venv`、`.lan`、`.dev.vars`、`.env*`、数据库。共享时只选策略源码、研究说明、脱敏报告和有权分享的行情文件；平台行情可能受供应商再分发条款约束。
