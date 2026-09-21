// Explicitly shared classroom website login. Never read broker configuration here.
export function parseSharedLogin(source){
 const values={};
 for(const line of source.split(/\r?\n/)){const i=line.indexOf('=');if(i<1)continue;const key=line.slice(0,i).trim();if(key==='USERNAME'||key==='PASSWORD')values[key]=line.slice(i+1);}
 if(!values.USERNAME||!values.PASSWORD)throw Error('Shared website login is not configured');
 return {username:values.USERNAME,password:values.PASSWORD};
}
