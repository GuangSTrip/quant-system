# 长桥模拟账户连接

入口：在线网站左侧「港股 · 长桥」（`#longbridge`）。使用已有课程账号登录，在网页输入开发者中心的 App Key、App Secret 和模拟账户 Access Token，勾选模拟账户声明，点击「验证连接并保存」。只读查询账户资金成功后才保存；失败保留原连接。保存后等待 5 秒，点击「刷新账户」读取资金、港股持仓及当日订单。

本次范围为凭证配置与只读账户联调，不包含长桥行情、下单、撤单或自动策略。成功读取资产不能证明账户是模拟环境；接口返回没有经过本项目验证的模拟账户标识，不能仅依靠 Token 前缀、资金余额或用户勾选认定。网页明确标注环境待核验，全部长桥请求限定为 GET 和三个固定只读路径，执行能力始终为 false。下一阶段需确认供应商支持的模拟环境验证方式，再实现订单持久化、幂等恢复、风控、行情及自动执行。

## 凭证保存

站点秘密 `BROKER_CREDENTIAL_KEY` 是 32 字节随机值的 Base64 编码，通过托管设置配置，不进入仓库。可以在部署机器用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` 生成并保存至托管秘密。

三项用户凭证在服务器使用 AES-256-GCM、独立随机 nonce 和固定上下文 AAD 加密，D1 `longbridge_connection` 只保存密文、时间、操作员。密码字段不回显、不存入浏览器 storage，不进入审计、日志或导出。保存成功清空输入；失败保留输入供修正，退出登录清空。该连接为全站课程操作员共享，不是多租户账户。移除连接删除网站密文，不撤销券商 Token 或已有订单。轮换加密主密钥后需重新输入凭证，不可当作无影响的普通配置变更。

现有部署向导仍以 Alpaca 为主；独立部署长桥连接须额外配置上述主密钥，构建包含新增 Drizzle 迁移。未配置主密钥时保存按钮不可用，服务端也拒绝保存。不要将三项凭证写入 `.env.example` 或源码。

## 实现依据与验收

HTTP 地址固定 `https://openapi.longbridge.com`，使用官方 SDK 兼容的传统 API Key 签名（Authorization 直接携带 Access Token，非 OAuth Bearer）。算法参照官方 https://github.com/longbridge/openapi/blob/master/rust/crates/httpclient/src/signature.rs 和 request.rs。账户、持仓和当日订单接口参照 https://open.longbridge.com/zh-CN/docs/trade/asset/account 、https://open.longbridge.com/zh-CN/docs/trade/asset/stock 、https://open.longbridge.com/zh-CN/docs/trade/order/today_orders 。不自动跟随重定向，不发送到用户指定域名，不泄露供应商原始错误。

测试覆盖独立签名对照、AES-GCM 错误密钥与篡改拒绝、认证和 CSRF、保存前只读验证、密文存储、错误凭证保留原连接、移除、固定端点和重定向拒绝。额外 Workerd 测试验证生产运行时加密算法兼容性。自动化使用替身响应，实际凭证由账号持有人在部署后输入，因此不代表实际账户联调或成交已经通过。
