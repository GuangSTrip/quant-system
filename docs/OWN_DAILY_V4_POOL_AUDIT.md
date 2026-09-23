# 美股证券名称漏筛修正

第四轮初次跑完后检查证券主表，发现部分NYSE普通股名称没有Common/Ordinary/Class字样，JPM、LLY、TDOC因此未进入原池。统一加入Inc/Incorporated/Corp/Corporation/Co/Company/Ltd/Limited/PLC/REIT等公司名称候选；保留原有ETF、基金、优先股、权证、票据等排除规则。未按历史收益或具体赢家名单补股。

初始清单由14558扩展至19020，补请求4462个代码；重试570项瞬时网络失败后，有历史数据从3588增加至5560（新增1972），13460返回空，失败0。名称仍不能严格证明历史证券类型，退市和代码复用仍需审计；不宣称是完整全美普通股数据库。

原报告`reports/own_daily_v4/US`保留。使用完全相同12个候选和选择规则，在`expanded/US`重新运行；换股接收方出现新数据后同步重建公司行动映射。最终美股风险补充实验依赖扩展后的候选。数据修复不算策略创新，也不得把新旧股票池的结果差异全部归功于策略。

公司行动记录来自[Alpaca官方接口](https://docs.alpaca.markets/us/reference/corporateactions-1)。接口早期覆盖稀少，且未保证公告生成时点；本次仅用于按处理日期重建账本，不作为预测因子。

抽查现金收购：MYOK每股225美元、KDMN每股9.50美元，与公司正式完成公告一致：
- https://news.bms.com/news/details/2020/Bristol-Myers-Squibb-Completes-Acquisition-of-MyoKardia-Strengthening-Companys-Leading-Cardiovascular-Franchise/default.aspx
- https://www.sanofi.com/en/media-room/press-releases/2021/2021-11-09-14-05-00-2330525

LVGO换股以接口最终现金4.24美元及0.592股TDOC为准，不能套用早期公告11.33美元再重复计入特别股息；复权现金分红由价格序列承担。最终条款参考[Teladoc 2021年报](https://www.sec.gov/Archives/edgar/data/1477449/000155837022002260/tdoc-20211231x10k.htm)。没有可核对原始价格的事件继续保留未决状态。
