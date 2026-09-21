export function installSharedLogin(shared){
if(!shared?.username||!shared?.password)return;

document.addEventListener('DOMContentLoaded',()=>{
 const form=document.getElementById('login-form');if(!form)return;
 const box=document.createElement('section');box.className='notice';box.setAttribute('aria-label','大作业共享登录信息');
 const title=document.createElement('strong');title.textContent='大作业演示 · 共享模拟账户';
 const note=document.createElement('p');note.textContent='以下仅为网站登录信息。所有用户操作同一组模拟账户。';
 const status=document.createElement('p');status.setAttribute('role','status');status.textContent='正在读取共享登录信息…';
 box.append(title,note,status);form.querySelector('.stack').before(box);
 let loaded=false,loading=false;
 async function load(){if(loaded||loading)return;loading=true;
  try{const data=shared;
   const fields={};
   for(const [key,label]of [['username','共享账号'],['password','共享密码']]){
    const wrap=document.createElement('label');wrap.textContent=label;
    const input=document.createElement('input');input.type='text';input.readOnly=true;input.value=data[key];input.setAttribute('aria-label',label);input.autocomplete='off';fields[key]=input;
    const copy=document.createElement('button');copy.type='button';copy.textContent='复制'+(key==='username'?'账号':'密码');
    copy.onclick=async()=>{try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(input.value);else{input.focus();input.select();if(!document.execCommand('copy'))throw Error();}status.textContent='已复制，可粘贴到下方登录框。';}catch{input.focus();input.select();status.textContent='已选中，请按 Ctrl+C 复制。';}};
    wrap.append(input,copy);box.append(wrap);
   }
   const fill=document.createElement('button');fill.type='button';fill.className='primary';fill.textContent='一键填入账号和密码';
   fill.onclick=()=>{document.getElementById('login-username').value=fields.username.value;document.getElementById('login-password').value=fields.password.value;status.textContent='已填入，请点击下方“登录”。';document.getElementById('login-submit').focus();};
   box.append(fill);status.textContent='可分别复制，也可一键填入后点击登录。';loaded=true;
  }catch{status.textContent='共享登录信息暂不可用，请关闭弹窗后重试，或使用原账号登录。';}finally{loading=false;}
 }
 new MutationObserver(()=>{if(document.getElementById('login-dialog').open)load();}).observe(document.getElementById('login-dialog'),{attributes:true,attributeFilter:['open']});
 if(document.getElementById('login-dialog').open)load();
});
}
