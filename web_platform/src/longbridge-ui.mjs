export function createLongbridgePanel(api){
  const $=id=>document.getElementById(id);
  let generation=0,refreshing=false;
  const say=value=>{$('lb-status').textContent=value;};
  function clear(){generation++;$('lb-form').reset();$('lb-results').replaceChildren();$('lb-settings').hidden=true;say('请登录课程账号后连接长桥模拟账户。');}
  async function status(){
    const current=++generation;
    try{const d=await api('longbridge/status');if(current!==generation)return;
      $('lb-settings').hidden=false;$('lb-save').disabled=!d.storage_ready;
      say(!d.storage_ready?'凭证保存服务尚未配置，请联系维护者。':d.configured?'已保存长桥连接。点击“刷新账户”核对资金与持仓。':'尚未连接。请填写模拟账户的三项凭证。');
      $('lb-remove').disabled=!d.configured;
    }catch(e){if(current===generation){$('lb-settings').hidden=true;$('lb-results').replaceChildren();say(e.message);}}
  }
  function table(title,rows,fields,error){
    const section=document.createElement('section'),h=document.createElement('h3');h.textContent=title;section.append(h);
    if(error||!rows?.length){const p=document.createElement('p');p.textContent=error||'暂无记录';section.append(p);}
    else{const wrap=document.createElement('div');wrap.className='table-scroll';const t=document.createElement('table'),head=t.createTHead().insertRow();
      for(const label of Object.values(fields)){const th=document.createElement('th');th.textContent=label;head.append(th);}
      const body=t.createTBody();for(const row of rows){const tr=body.insertRow();for(const key of Object.keys(fields))tr.insertCell().textContent=String(row[key]??'—');}
      wrap.append(t);section.append(wrap);
    }$('lb-results').append(section);
  }
  function render(d){
    $('lb-results').replaceChildren();
    table('账户资金',d.account,{currency:'币种',net_assets:'净资产',total_cash:'现金总额',buy_power:'购买力'},d.errors?.account);
    table('港股持仓',d.positions,{symbol:'代码',symbol_name:'名称',currency:'币种',quantity:'持有股数',available_quantity:'可卖股数',cost_price:'成本价'},d.errors?.positions);
    table('港股当日订单',d.orders,{order_id:'订单号',symbol:'代码',side:'方向',status:'状态',quantity:'委托股数',executed_quantity:'成交股数',executed_price:'成交均价'},d.errors?.orders);
  }
  $('lb-form').addEventListener('submit',async e=>{
    e.preventDefault();const current=++generation,button=$('lb-save');button.disabled=true;say('正在只读验证账户，成功后加密保存…');
    try{const d=await api('longbridge/connect',{app_key:$('lb-key').value,app_secret:$('lb-secret').value,access_token:$('lb-token').value,paper_confirm:$('lb-paper').checked});
      if(current!==generation)return;$('lb-form').reset();$('lb-remove').disabled=false;render({account:d.account,errors:{positions:'保存成功。请稍等 5 秒后刷新账户。',orders:'保存成功。请稍等 5 秒后刷新账户。'}});say(d.message);
    }catch(error){if(current===generation)say(error.message+' 新凭证未保存，原连接未替换。');}
    finally{button.disabled=false;}
  });
  async function refresh(){
    if(refreshing)return;refreshing=true;$('lb-refresh').disabled=true;
    try{
      await status();if($('lb-settings').hidden)return;
      const current=++generation;$('lb-results').replaceChildren();say('正在读取长桥账户…');
      try{const d=await api('longbridge/overview');if(current!==generation)return;render(d);say((d.ok?'查询成功':'部分查询失败')+' · '+d.fetched_at+'。请与长桥模拟账户核对，当前不支持下单。');}
      catch(e){if(current===generation)say(e.message);}
    }finally{refreshing=false;$('lb-refresh').disabled=false;}
  }
  $('lb-refresh').addEventListener('click',refresh);
  $('lb-remove').addEventListener('click',async()=>{
    if(!confirm('移除网站保存的长桥凭证？不会取消券商已有订单。'))return;
    const current=++generation;$('lb-remove').disabled=true;
    try{await api('longbridge/disconnect',{confirm:true});if(current!==generation)return;clear();await status();}
    catch(e){if(current===generation)say(e.message);$('lb-remove').disabled=false;}
  });
  return {status,clear,refresh};
}
