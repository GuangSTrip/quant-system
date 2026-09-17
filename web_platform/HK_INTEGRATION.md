# 港股富途接入：第一阶段

基于 main `bd512a60a1eea6a6487800016d150a683c7e6e54`，开发分支 `codex/hk-futu-paper`。

本阶段提供可连接富途 OpenD 的港股模拟账户只读链路：网页 → 网站认证后台 → HTTPS 桥接 → 本机 OpenD。包括资金、持仓、订单和股票快照；不创建或撤销订单，不启动港股策略。不改变 Alpaca 交易接口，也不把策略库的合成数据标记为实时行情。未配置时显示未配置，而非虚构余额。

## 部署与验证

1. 在常驻电脑或服务器安装官方 OpenD，使用牛牛账号登录并完成首次使用确认。在模拟交易中启用港股账户；使用官方 `OpenSecTradeContext(filter_trdmarket=TrdMarket.HK).get_acc_list()` 查询账户列表，选择 `trd_env=SIMULATE`、`sim_acc_type=STOCK`、`trdmarket_auth` 含 HK 的 `acc_id`。不要选真实、期权或其他市场账户。API 行情权限须单独验证。
2. 同一机器创建 Python 虚拟环境并安装 `python -m pip install futu-api`。在服务端环境配置 `FUTU_HK_PAPER_ACC_ID` 和随机生成的 `FUTU_BRIDGE_TOKEN`（至少 32 字符）。运行 `python web_platform/futu_bridge/app.py`。默认监听 `127.0.0.1:8788`，连接 OpenD `127.0.0.1:11111`。SDK 验证通过后将实际版本冻结到部署环境；本阶段尚无真实 SDK 联调证据。
3. 使用 HTTPS 反向代理将独立域名转发至桥接端口，保留 Authorization 请求头；OpenD 端口仅本机访问。建议服务管理器自动重启桥接程序；OpenD 重新登录仍可能需要账号持有人操作。网站后台配置 `FUTU_BRIDGE_URL=https://你的桥接域名`（根地址，无路径）及相同的秘密 `FUTU_BRIDGE_TOKEN`。这两项需在托管环境单独配置；现有 Alpaca 部署向导不自动创建 OpenD 服务。
4. 构建并部署此分支的网站，登录课程操作员账号，进入「港股模拟账户」，输入 `700`、`0700.HK` 或 `HK.00700` 并查询。与牛牛港股模拟账户核对资金、持仓及订单；检查报价时间和实际每手股数。休市报价可能停留在上一交易时段，不应仅依据查询成功认定为新鲜行情。

报价时间按香港时区展示；账户统计明确请求 HKD。刷新采用人工查询，避免多个网页轮询耗尽 OpenD 限频。账户查询每次先重新校验配置账户的模拟环境和市场；任一子查询失败保留其他成功结果，页面指出失败部分。服务端不返回券商原始错误或账户编号。

## 测试

在仓库根目录运行 `python -m unittest discover -s tests -v`；桥接测试为 `python -m unittest discover -s web_platform/futu_bridge -p 'test_*.py' -v`。在 `web_platform` 运行 `npm ci`、`npm run build`、`npm test`、`npm run validate`。桥接测试注入 SDK 替身，不代表实际账户已连通。

## 下一阶段

先完成 OpenD 实际账户只读验收，再加入 HKD 预算、整手数量、交易时段及行情时效检查，建立独立的港股订单意图、去重、未知订单恢复与审计记录，然后开放限价下单和撤单。最后对齐分钟策略库的规则和执行信号、接入真实分钟数据与常驻调度。不得把美股的美元风控、股票白名单和调度日历直接复用到港股。

富途模拟盘不提供独立成交查询接口，未来应根据订单 `dealt_qty`、`dealt_avg_price`、订单状态与持仓核对成交。本阶段网页可以显示这些字段，但没有提交任何验收订单。

官方资料：https://openapi.futunn.com/futu-api-doc/qa/trade.html 、https://openapi.futunn.com/futu-api-doc/intro/authority.html 、https://openapi.futunn.com/futu-api-doc/quote/get-market-snapshot.html 。
