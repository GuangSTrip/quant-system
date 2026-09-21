import stockNames from './stock-names.json' with {type:'json'};
export function cnSymbol(value){
 const s=String(value||'').trim().toUpperCase();
 if(/^(SHSE|SZSE)\.\d{6}$/.test(s))return s;
 const suffix=s.match(/^(\d{6})\.(SH|SZ)$/);if(suffix)return (suffix[2]==='SH'?'SHSE.':'SZSE.')+suffix[1];
 if(/^[036]\d{5}$/.test(s))return (s[0]==='6'?'SHSE.':'SZSE.')+s;
 throw new Error('请输入6位A股代码，例如600036；也可填写600036.SH或SHSE.600036。');
}
export function cnName(value){const s=String(value||'').replace(/^SHSE\./,'').replace(/^SZSE\./,'');const key=String(value||'').startsWith('SHSE.')?s+'.SH':String(value||'').startsWith('SZSE.')?s+'.SZ':s;return stockNames.names[key]||'名称暂缺';}
