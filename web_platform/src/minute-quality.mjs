export function minuteQuality(bars,market){
 const spec={US:{zone:'America/New_York',windows:[[570,960]],expected:390},HK:{zone:'Asia/Hong_Kong',windows:[[570,720],[780,960]],expected:330},CN:{zone:'Asia/Shanghai',windows:[[570,690],[780,900]],expected:240}}[market];
 if(!spec)throw Error('未知市场');
 const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:spec.zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),days=new Map();let outside=0;
 for(const b of bars){const p=Object.fromEntries(fmt.formatToParts(new Date(b.t)).map(x=>[x.type,x.value])),minute=Number(p.hour)*60+Number(p.minute),date=p.year+'-'+p.month+'-'+p.day;if(!spec.windows.some(([a,z])=>minute>=a&&minute<z)){outside++;continue;}days.set(date,(days.get(date)||0)+1);}
 return {timezone:spec.zone,received:bars.length,outside_session:outside,sessions:[...days].map(([date,rows])=>({date,rows,reference_missing:Math.max(0,spec.expected-rows)})),note:'缺口按常规完整交易日分钟数估算；未区分半日市、停牌、无成交及供应商漏数，不填造缺失行情。'};
}
