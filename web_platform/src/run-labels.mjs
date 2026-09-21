export function runLabel(run){
 if(!run?.run_id)return '尚未启动';
 if(run.enabled)return run.exit_requested?'正在结束 · 等待平仓':'运行中';
 if(['completed','liquidated'].includes(run.outcome||run.reason))return '已结束';
 return '已暂停';
}
export function runReason(value){
 const labels={waiting_existing_orders:'等待启动前的原有订单结束',submitted:'已提交模拟委托，等待成交回报',waiting_session:'等待开市或执行时间',pending_orders:'等待已有委托处理完成',waiting_data:'等待有效行情',already_evaluated:'本轮信号已处理',no_order:'当前无需买卖',paused:'已暂停',fault:'发生异常，已暂停',completed:'执行已完成'};
 return labels[value]||String(value||'尚未启动').replaceAll('全局交易','美股交易').replaceAll('全局暂停','美股交易暂停');
}
