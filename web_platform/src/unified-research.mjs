import {createCourseResearch} from './course-research.mjs';
import {createOwnStudiesUI} from './own-studies-ui.mjs';
export function createUnifiedResearch(root,chart,onExecute){
 root.innerHTML=`<article class="panel research-picker"><h2>选择你想了解的策略</h2><p>先看选股与买卖规则，再看历史结果；支持在线执行的策略可继续设置模拟预算。</p><div class="research-options" role="group" aria-label="研究方案"><button data-research="teaching" aria-pressed="true">教学组合与分钟策略</button><button data-research="intraday" aria-pressed="false">★ 本组自研 · 日内增强回归</button><button data-research="daily" aria-pressed="false">★ 本组自研 · 日线风控</button><button data-research="alternatives" aria-pressed="false">★ 本组自研 · 反转与趋势</button><button data-research="fundamental" aria-pressed="false">★ 本组自研 · 财务质量</button></div></article><div id="unified-teaching"></div><div id="unified-offline" hidden></div><article id="unified-intraday" class="panel" hidden><span class="badge good">★ 第2组 · 本组自研</span><h2>日内增强均值回归</h2><p>先按价格、流动性、价差和波动筛选美股候选，再研究价格偏离VWAP后的回归；10:00 ET后判断入场，每天最多一次。回到VWAP、达到持有时限或接近收市时申请退出。</p><p>支持固定样本回测与Alpaca模拟执行。历史回测、实时信号和实际成交分别记录；过去表现不代表今天会触发买入。</p><button id="unified-open-intraday" class="primary">查看选股与回测 → 配置模拟</button><p class="caption">打开详情不会启动交易，运行需在预算与回测确认后操作。</p></article>`;
 const teachingRoot=root.querySelector('#unified-teaching'),offlineRoot=root.querySelector('#unified-offline'),intradayRoot=root.querySelector('#unified-intraday');
 const teaching=createCourseResearch(teachingRoot,chart,onExecute),offline=createOwnStudiesUI(offlineRoot,chart);let choice='teaching';
 async function show(next){choice=next;teachingRoot.hidden=next!=='teaching';offlineRoot.hidden=['teaching','intraday'].includes(next);intradayRoot.hidden=next!=='intraday';for(const b of root.querySelectorAll('[data-research]'))b.setAttribute('aria-pressed',String(b.dataset.research===next));if(next==='teaching')await teaching.load();else if(next!=='intraday')await offline.load(next);}
 for(const b of root.querySelectorAll('[data-research]'))b.onclick=()=>show(b.dataset.research);
 root.querySelector('#unified-open-intraday').onclick=()=>onExecute('US:own-enhanced');
 return {load:()=>show(choice)};
}
