"""Causal daily research engine. Fractional adjusted units, never a broker ledger.

Independent market accounts; close signals -> next open; costs are cash debits.
The experiment protocol and unresolved data limitations are part of the result.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from pathlib import Path
import json, math, hashlib
import numpy as np
import pandas as pd

@dataclass(frozen=True)
class Design:
    name:str='adaptive_quality'
    holdings:int=20
    target_vol:float=.18
    breadth_floor:float=.35
    quality:bool=True
    regime:bool=True
    diversify:bool=True
    rebalance:int=5
    momentum_only:bool=False
    equal_benchmark:bool=False
    family:str='quality_momentum'
    trailing_stop:float=0.
    cooldown:int=20
    learned_mix:float=.65
    liquidity_limit:int=1500
    max_stock_vol:float=99.
    portfolio_stop:float=0.
    portfolio_pause:int=20

@dataclass
class Panel:
    market:str
    dates:np.ndarray
    symbols:list
    opens:np.ndarray
    closes:np.ndarray
    value:np.ndarray
    volume:np.ndarray
    amount:np.ndarray
    features:dict
    metadata:dict

def load(root,market,end='2025-12-31',only_symbols=None):
    manifest=json.loads((root/(market+'_manifest.json')).read_text())
    frames={};qa={};providers={}
    for symbol,row in manifest.items():
        if only_symbols is not None and symbol not in only_symbols:continue
        if row['status']!='ok':continue
        file=root/market/(symbol+'.csv.gz')
        if hashlib.sha256(file.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('data hash mismatch: '+symbol)
        f=pd.read_csv(file)
        if f.date.duplicated().any():raise ValueError('duplicate dates: '+symbol)
        if len(f):
            invalid=(f[['open','high','low','close']]<=0).any(axis=1)|(f.high+1e-7<f[['open','low','close']].max(axis=1))|(f.low-1e-7>f[['open','high','close']].min(axis=1))|(f.volume<0)
            qa[symbol]={'invalid_bars':int(invalid.sum()),'large_close_moves':int((f.close.pct_change().abs()>.5).sum())}
            f.loc[invalid,['open','high','low','close']]=np.nan
            frames[symbol]=f.set_index('date').sort_index().loc[:end]
            providers[row['provider']]=providers.get(row['provider'],0)+1
    if not frames:raise ValueError('No downloaded histories: '+market)
    dates=np.array(sorted(set().union(*(f.index for f in frames.values()))))
    def column(key):return np.column_stack([f.reindex(dates)[key].to_numpy(float) for f in frames.values()])
    close=column('close');op=column('open');volume=column('volume')
    valid=(close>0)&(op>0)&np.isfinite(close)&np.isfinite(op)
    close=np.where(valid,close,np.nan);op=np.where(valid,op,np.nan)
    c=pd.DataFrame(close);value=c.ffill().to_numpy();returns=c.ffill().pct_change(fill_method=None).fillna(0)
    # A provider's raw turnover is preferable to adjusted-price * volume.
    amount=column('amount') if all('amount' in f for f in frames.values()) else close*volume
    rolling=c.ffill()
    lr=np.log(rolling).diff()
    downside=returns.clip(upper=0)
    features={
        'ret':returns.to_numpy(),
        'mom63':(rolling.shift(5)/rolling.shift(63)-1).to_numpy(),
        'mom126':(rolling.shift(5)/rolling.shift(126)-1).to_numpy(),
        'mom252':(rolling.shift(21)/rolling.shift(252)-1).to_numpy(),
        'recent5':(rolling/rolling.shift(5)-1).to_numpy(),
        'near_high':(rolling/rolling.rolling(252,min_periods=200).max()).to_numpy(),
        'sma120':rolling.rolling(120).mean().to_numpy(),
        'sma200':rolling.rolling(200).mean().to_numpy(),
        'vol':returns.rolling(60).std().to_numpy()*np.sqrt(252),
        'downside':np.sqrt(downside.pow(2).rolling(60).mean()).to_numpy()*np.sqrt(252),
        'efficiency':(lr.rolling(126).sum()/lr.abs().rolling(126).sum().clip(lower=1e-8)).to_numpy(),
        'jump_share':(returns.clip(lower=0).rolling(63).max()/returns.clip(lower=0).rolling(63).sum().clip(lower=1e-8)).to_numpy(),
        'liquidity':pd.DataFrame(amount).rolling(20,min_periods=15).median().to_numpy(),
        'seen':np.cumsum(np.isfinite(close),axis=0),
        'recent_count':c.rolling(30,min_periods=0).count().to_numpy(),
        'recent_jump':returns.abs().rolling(20).max().to_numpy(),
    }
    master=json.loads((root/(market+'_universe.json')).read_text())
    records={r['symbol']:r for r in master['records']}
    relevant={s for s,r in records.items() if not r.get('listed') or r['listed']<=end}
    meta={'provider_manifest_entries':len(manifest),'histories':len(frames),'initial_universe':len(records),
          'eligible_history_universe':len(relevant),'outside_study_listing_date':len(records)-len(relevant),
          'historically_complete':False,'first':str(dates[0]),'last':str(dates[-1]),
          'failed':sum(r['status']=='failed' for r in manifest.values()),'empty':sum(r['status']=='empty' for r in manifest.values()),
          'not_attempted':len(relevant-set(manifest)),
          'records':records,'source_hashes':{s:manifest[s]['sha256'] for s in frames},'providers':providers,
          'bar_quality':qa,'invalid_bar_total':sum(x['invalid_bars'] for x in qa.values()),
          'large_move_total':sum(x['large_close_moves'] for x in qa.values())}
    return Panel(market,dates,list(frames),op,close,value,volume,amount,features,meta)

def percentile(x,eligible):
    ids=np.flatnonzero(eligible&np.isfinite(x));out=np.zeros(len(x))
    if len(ids):out[ids]=pd.Series(x[ids]).rank(method='average',pct=True).to_numpy()
    return out

def rank_features(p,t,valid):
    f=p.features
    values=[f['mom63'][t],f['mom126'][t],f['mom252'][t],-f['downside'][t],f['efficiency'][t],f['near_high'][t],-np.abs(f['recent5'][t]+.02),-f['jump_share'][t]]
    return np.column_stack([percentile(x,valid)-.5 for x in values])

def prepare_online_model(p):
    """Monthly ridge model using ONLY 21-day outcomes matured at that date.

    Store sufficient statistics, not millions of labeled rows. All blocks enter
    training no earlier than label_end; changing any later price cannot alter beta.
    No final-period hyperparameter fit. Past 756 sessions, fixed regularization.
    """
    if 'online_beta' in p.features:return
    blocks=[];updates=[];betas=np.zeros((len(p.dates),8));previous=np.zeros(8)
    for t in range(252,len(p.dates)):
        if (t-252)%21==0:
            eligible=liquid_eligible(p,t);x=rank_features(p,t,eligible)
            # This precomputed future outcome is not added until its maturity.
            maturity=t+21
            if maturity<len(p.dates):
                valid=eligible&np.isfinite(p.opens[t+1])&np.isfinite(p.closes[maturity])&(p.opens[t+1]>0)
                if valid.sum()>=20:
                    y=np.clip(p.closes[maturity,valid]/p.opens[t+1,valid]-1,-.5,.5);y-=np.mean(y)
                    a=x[valid];blocks.append((t,maturity,a.T@a,a.T@y,len(y)))
            usable=[b for b in blocks if b[1]<=t and b[0]>=t-756]
            count=sum(b[4] for b in usable)
            if len(usable)>=12 and count>=500:
                xx=sum((b[2] for b in usable),np.zeros((8,8)));xy=sum((b[3] for b in usable),np.zeros(8))
                previous=np.linalg.solve(xx+.05*count*np.eye(8),xy)
                updates.append(dict(date=str(p.dates[t]),last_label_date=str(p.dates[max(b[1] for b in usable)]),samples=count,coefficients=previous.tolist()))
        betas[t]=previous
    p.features['online_beta']=betas;p.metadata['model_updates']=updates

def eligible_at(p,t):
    f=p.features
    floor={'CN':20e6,'HK':5e6,'US':5e6}[p.market]
    valid=np.isfinite(p.closes[t])&(p.volume[t]>0)&(f['seen'][t]>=252)&(f['recent_count'][t]>=27)
    valid &= (f['liquidity'][t]>=floor)&np.isfinite(f['mom252'][t])&(f['vol'][t]>.03)
    # Causal quarantine, never exclude an entire history based on future jumps.
    valid &= f['recent_jump'][t]<.5
    return valid

def liquid_eligible(p,t):
    if 'liquid_masks' in p.features:return p.features['liquid_masks'][t].copy()
    valid=eligible_at(p,t)
    if valid.sum()>1500:
        ids=sorted(np.flatnonzero(valid),key=lambda i:(-p.features['liquidity'][t,i],p.symbols[i]))[:1500]
        valid[:]=False;valid[ids]=True
    return valid

def prepare_selection_cache(p):
    if 'liquid_masks' in p.features:return
    masks=np.zeros(p.closes.shape,bool);breadth=np.zeros(len(p.dates))
    for t in range(252,len(p.dates)):
        mask=liquid_eligible(p,t);masks[t]=mask
        if mask.any():breadth[t]=np.mean(p.value[t,mask]>p.features['sma200'][t,mask])
    p.features['liquid_masks']=masks;p.features['breadth_cache']=breadth

def design_universe(p,c):
    """Contemporaneous liquidity subset; never today's index constituents."""
    prepare_selection_cache(p)
    if c.liquidity_limit==1500 and c.max_stock_vol==99.:
        return p.features['liquid_masks'],p.features['breadth_cache']
    key=f'policy_{c.liquidity_limit}_{c.max_stock_vol}'
    if key not in p.features:
        masks=np.zeros(p.closes.shape,bool);breadth=np.zeros(len(p.dates))
        for t in range(252,len(p.dates)):
            ids=np.flatnonzero(p.features['liquid_masks'][t])
            ids=sorted(ids,key=lambda i:(-p.features['liquidity'][t,i],p.symbols[i]))[:c.liquidity_limit]
            ids=[i for i in ids if p.features['vol'][t,i]<=c.max_stock_vol]
            masks[t,ids]=True
            if ids:breadth[t]=np.mean(p.value[t,ids]>p.features['sma200'][t,ids])
        p.features[key]=(masks,breadth)
    return p.features[key]

def select_weights(p,t,c,held):
    f=p.features;valid=design_universe(p,c)[0][t].copy();n=len(p.symbols);w=np.zeros(n)
    if valid.sum()<10:return w,{'eligible':int(valid.sum()),'breadth':0,'selected':[],'exposure':0}
    # Bound computational size using only contemporaneously observed liquidity.
    liquid=sorted(np.flatnonzero(valid),key=lambda i:(-f['liquidity'][t,i],p.symbols[i]))[:1500]
    valid[:]=False;valid[liquid]=True
    breadth=float(np.mean(p.value[t,liquid]>f['sma200'][t,liquid]))
    if c.equal_benchmark:
        # 100 names keep the 1m account benchmark investable after minimum fees.
        ids=liquid[:100];w[ids]=.95/len(ids)
        return w,{'eligible':len(liquid),'breadth':breadth,'selected':[p.symbols[i] for i in ids],'exposure':float(w.sum())}
    momentum=.25*percentile(f['mom63'][t],valid)+.45*percentile(f['mom126'][t],valid)+.30*percentile(f['mom252'][t],valid)
    quality=.50*percentile(f['efficiency'][t],valid)+.30*percentile(-f['downside'][t],valid)+.20*percentile(-f['jump_share'][t],valid)
    score=.65*momentum+.35*quality if c.quality else momentum
    if c.family=='smooth_breakout':
        score=.55*percentile(f['near_high'][t],valid)+.25*momentum+.20*quality if c.quality else .7*percentile(f['near_high'][t],valid)+.3*momentum
    elif c.family=='defensive_momentum':
        score=.60*momentum+.40*percentile(-f['vol'][t],valid)
    elif c.family=='state_blend':
        # Strong breadth rewards continuation; mixed breadth favors mild pullbacks
        # within a positive medium trend. Negative trends never become buys.
        trend=.75*momentum+.25*quality if c.quality else momentum
        pull=.55*momentum+.25*percentile(-np.abs(f['recent5'][t]+.02),valid)+.20*quality if c.quality else .75*momentum+.25*percentile(-np.abs(f['recent5'][t]+.02),valid)
        blend=float(np.clip((breadth-.40)/.25,0,1));score=blend*trend+(1-blend)*pull
    elif c.family=='online_ridge':
        beta=f['online_beta'][t]
        if np.any(beta):
            forecast=rank_features(p,t,valid)@beta
            score=c.learned_mix*percentile(forecast,valid)+(1-c.learned_mix)*quality if c.quality else percentile(forecast,valid)
    positive=valid&(p.value[t]>f['sma120'][t])&(f['mom126'][t]>0)
    if c.momentum_only:positive=valid.copy()
    # Retention bonus is precommitted and small; no future ranks used.
    score=score+.03*(held>0)
    ranked=sorted(np.flatnonzero(positive),key=lambda i:(-score[i],p.symbols[i]))
    chosen=[];history=f['ret'][max(0,t-119):t+1]
    for i in ranked:
        if c.diversify and chosen:
            a=history[:,i];b=history[:,chosen]
            ac=a-a.mean();bc=b-b.mean(axis=0)
            den=np.sqrt((ac*ac).sum()*(bc*bc).sum(axis=0))
            corr=np.divide(ac@bc,den,out=np.zeros(len(chosen)),where=den>1e-12)
            if np.max(corr)>.85:continue
        chosen.append(i)
        if len(chosen)>=c.holdings:break
    if chosen:
        ids=np.array(chosen);iv=1/np.maximum(f['vol'][t,ids],.10)
        base=iv/iv.sum() if not c.momentum_only else np.ones(len(ids))/len(ids)
        base=np.minimum(base,.10)
        exposure=.95
        if c.regime:exposure*=float(np.clip((breadth-c.breadth_floor)/(.70-c.breadth_floor),0,1))
        risk=float(np.std(history[-60:,ids]@base,ddof=1)*np.sqrt(252))
        if not c.momentum_only:exposure*=min(1.,c.target_vol/max(risk,.01))
        w[ids]=base*exposure
    return w,{'eligible':len(liquid),'breadth':breadth,'selected':[p.symbols[i] for i in chosen],'exposure':float(w.sum())}

def fees(market,date,notional,side,multiplier=1.):
    """Per-ticket costs in local currency; explicitly assumed broker tariffs.
    US uses disclosed ad-valorem regulatory reserve instead of fictitious exact TAF.
    HK settlement reserve is conservative; not an account-specific tariff replica.
    """
    if notional<=0:return dict(commission=0.,tax_exchange=0.,slippage=0.)
    if market=='CN':
        commission=max(5.,notional*.0003)
        stamp=(.001 if date<'2023-08-28' else .0005) if side=='sell' else 0
        transfer=.00002 if date<'2022-04-29' else .00001
        tax=notional*(stamp+transfer);slip=notional*.0005
    elif market=='HK':
        commission=max(3.,notional*.0003)+15.
        stamp=.0013 if '2021-08-01'<=date<'2023-11-17' else .001
        trading=.00005 if date<'2023-01-01' else .0000565
        afrc=.0000015 if date>='2022-01-01' else 0
        # Stamp duty rounds UP to a whole HKD; levies to cents.
        tax=math.ceil(notional*stamp)+round(notional*(trading+.000027+afrc),2)+max(2.,notional*.0001)
        if date<'2023-01-01':tax+=.5
        slip=notional*.001
    else:
        commission=0.
        tax=notional*.0001 if side=='sell' else 0.
        slip=notional*.001
    return {k:v*multiplier for k,v in dict(commission=commission,tax_exchange=tax,slippage=slip).items()}

def metrics(curve,start=None,end=None):
    f=curve
    if start is not None:f=f[f.date>=start]
    if end is not None:f=f[f.date<=end]
    if len(f)<2:return None
    # base_equity is previous session equity, retains the first selected day's P&L.
    base=float(f.base_equity.iloc[0]);nav=np.r_[base,f.equity.to_numpy()]
    days=(pd.Timestamp(f.date.iloc[-1])-pd.Timestamp(f.base_date.iloc[0])).days
    ret=f.equity.to_numpy()/f.base_equity.to_numpy()-1
    dd=nav/np.maximum.accumulate(nav)-1
    total=nav[-1]/nav[0]-1;cagr=(nav[-1]/nav[0])**(365.25/max(days,1))-1
    return dict(start=str(f.date.iloc[0]),end=str(f.date.iloc[-1]),sessions=len(f),years=days/365.25,
        total_return=float(total),cagr=float(cagr),max_drawdown=float(-dd.min()),
        sharpe=float(np.mean(ret)/np.std(ret,ddof=1)*np.sqrt(252)) if np.std(ret)>0 else 0.,
        calmar=float(cagr/-dd.min()) if dd.min()<0 else None,
        annual_turnover=float((f.traded/f.base_equity).sum()/(days/365.25)) if days>0 else 0.,
        total_cost=float(f.cost.sum()),average_exposure=float(f.exposure.mean()),
        numeric_target=bool(cagr>=.20 and -dd.min()<=.15))

def run(p,c,*,cost_multiplier=1.,execution_lag=1,details=False,start='2015-01-01',end='2025-12-31',stale_writeoff=True,delisted_writeoff=True,design_schedule=None,corporate_actions=None,weights_fn=None):
    prepare_selection_cache(p)
    if c.family=='online_ridge':prepare_online_model(p)
    cash=1e6;n=len(p.symbols);units=np.zeros(n);target=np.zeros(n);pending={};curve=[];trades=[];decisions=[]
    stale=np.zeros(n,int);last=1e6;first=np.flatnonzero((p.dates>=start)&(p.dates<=end))
    if not len(first):raise ValueError('No evaluation dates')
    first=max(252,int(first[0]));last_day=int(np.flatnonzero(p.dates<=end)[-1]);trade_count=0
    totals=dict(commission=0.,tax_exchange=0.,slippage=0.);writeoffs=0.;rejections=0
    last_breadth=1.;last_signal=-999
    holding_peak=np.zeros(n);blocked_until=np.zeros(n,int)
    records=p.metadata.get('records',{})
    deaths=np.array([records.get(s,{}).get('delisted') or '9999-12-31' for s in p.symbols])
    loss_events=[];attribution=np.zeros(n);terminal_reserve=0.
    action_dates={};action_log=[];corporate_total=0.;symbol_ids={s:i for i,s in enumerate(p.symbols)}
    risk_peak=1e6;risk_paused_until=-1;risk_events=[]
    for action in corporate_actions or []:
        if action['symbol'] not in symbol_ids:continue
        j=int(np.searchsorted(p.dates,action['date']))
        if j>=len(p.dates):continue
        action_dates.setdefault(j,[]).append(action)
    for t in range(first,last_day+1):
        date=str(p.dates[t]);valid=np.isfinite(p.closes[t])&(p.volume[t]>0)
        if design_schedule and date in design_schedule:c=design_schedule[date]
        stale=np.where(valid,0,stale+1)
        price=np.nan_to_num(p.value[t],nan=0);op=np.where(np.isfinite(p.opens[t]),p.opens[t],p.value[t-1]);op=np.nan_to_num(op,nan=0)
        mark_pnl=units*(price-np.nan_to_num(p.value[t-1],nan=0))
        attribution+=mark_pnl;day_writeoff=0.;execution_pnl=0.
        corporate_pnl=0.
        for action in action_dates.get(t,[]):
            i=symbol_ids[action['symbol']];owned=units[i]
            if owned<=0:continue
            old_value=owned*price[i];receipt=owned*action['cash_per_adjusted_unit']
            successor_value=0.;buyer=action.get('acquirer')
            if buyer:
                if buyer not in symbol_ids:raise ValueError('Missing merger successor')
                j=symbol_ids[buyer];received=owned*action['new_units_per_adjusted_unit']
                if not np.isfinite(p.opens[t,j]):raise ValueError('Missing successor event open')
                units[j]+=received;successor_value=received*price[j]
            units[i]=0.;cash+=receipt
            gain=receipt+successor_value-old_value;corporate_pnl+=gain;attribution[i]+=gain
            if details:action_log.append(dict(**action,held_adjusted_units=float(owned),cash_received=float(receipt),successor_marked_value=float(successor_value),pnl=float(gain)))
        corporate_total+=corporate_pnl
        lost=(units>0)&(((deaths<=date)&delisted_writeoff)|((stale>=60)&stale_writeoff))
        if lost.any():
            for i in np.flatnonzero(lost):
                loss=float(units[i]*price[i]);day_writeoff+=loss;attribution[i]-=loss
                if details:loss_events.append(dict(date=date,symbol=p.symbols[i],amount=loss,stale_days=int(stale[i]),reason='master_delisted' if deaths[i]<=date else 'missing_60_sessions'))
            writeoffs+=day_writeoff;units[lost]=0
        daycost=0.;traded=0.
        if t in pending:
            target=pending.pop(t)
            equity_open=cash+float(units@op)
            delta=equity_open*target-units*op
            # Today's positive volume is an execution feasibility check, not
            # a signal input. A recorded open with zero trades cannot fill.
            available=np.isfinite(p.opens[t])&(p.opens[t]>0)&(p.volume[t]>0)&(p.volume[t-1]>0)&(deaths>date)
            if p.market=='CN':
                gap=np.divide(op,p.value[t-1],out=np.ones(n),where=p.value[t-1]>0)-1
                # Historical ST status is unavailable: conservative +/-4.8% guard.
                available &= ((delta<=0)|(gap<.048))&((delta>=0)|(gap>-.048))
            cap=np.nan_to_num(p.features['liquidity'][t-1],nan=0)*.01
            delta=np.clip(delta,-cap,cap)
            # Dust threshold reduces rebalancing churn, never blocks a full exit.
            full_exit=(target==0)&(units>0)
            delta=np.where((np.abs(delta)>=equity_open*.005)|full_exit,delta,0.)
            rejections+=int(np.count_nonzero((delta!=0)&~available));delta=np.where(available,delta,0.)
            for side in ('sell','buy'):
                ids=np.flatnonzero(delta<0 if side=='sell' else delta>0)
                for i in ids:
                    value=min(-delta[i],units[i]*op[i]) if side=='sell' else delta[i]
                    cost=fees(p.market,date,value,side,cost_multiplier)
                    if side=='buy' and value+sum(cost.values())>cash:
                        # Include minimum ticket fees; monotone bisection preserves cash.
                        lo,hi=0.,min(value,cash)
                        for _ in range(25):
                            mid=(lo+hi)/2
                            if mid+sum(fees(p.market,date,mid,side,cost_multiplier).values())<=cash:lo=mid
                            else:hi=mid
                        value=lo;cost=fees(p.market,date,value,side,cost_multiplier)
                    if value<1:continue
                    fee=sum(cost.values());sign=1 if side=='buy' else -1
                    # Minimum ticket charges can exceed tiny sale proceeds.
                    # A cash-only account cannot fund that exit with borrowing.
                    if side=='sell' and cash+value<fee:
                        rejections+=1;continue
                    # A capped full sale can leave a negative floating-point
                    # residue for extremely small adjusted prices / huge units.
                    # The sell notional is already bounded by owned market value.
                    # Exact full exits must erase the position. Tiny residuals
                    # otherwise receive a false retention bonus on later ranks.
                    fully_sold=side=='sell' and value>=units[i]*op[i]
                    units[i]=0. if fully_sold else max(0.,units[i]+sign*value/op[i]);cash-=sign*value+fee
                    fill_pnl=sign*value/op[i]*(price[i]-op[i]);execution_pnl+=fill_pnl;attribution[i]+=fill_pnl-fee
                    if cash<-.001:raise AssertionError(f'cash constraint at {date}: {cash}, {side}, notional={value}, fee={fee}')
                    for k,v in cost.items():totals[k]+=v
                    daycost+=fee;traded+=value;trade_count+=1
                    if details:trades.append(dict(date=date,symbol=p.symbols[i],side=side,notional=value,price=float(op[i]),units=float(value/op[i]),**cost))
        equity=cash+float(units@price)
        holding_peak=np.where(units>0,np.maximum(holding_peak,price),0)
        stop=(units>0)&(holding_peak>0)&(price<holding_peak*(1-c.trailing_stop)) if c.trailing_stop>0 else np.zeros(n,bool)
        if stop.any():blocked_until[stop]=t+c.cooldown
        if t==last_day:
            # Reserve terminal liquidation fees even for non-tradable holdings;
            # no fictional liquidation fill is entered into the trade ledger.
            for i in np.flatnonzero(units>0):
                cost=fees(p.market,date,units[i]*price[i],'sell',cost_multiplier)
                for k,v in cost.items():totals[k]+=v
                daycost+=sum(cost.values());equity-=sum(cost.values())
                attribution[i]-=sum(cost.values());terminal_reserve+=sum(cost.values())
        exposure=float(units@price)/max(equity,1.)
        unexplained=equity-last-(float(mark_pnl.sum())+execution_pnl+corporate_pnl-daycost-day_writeoff)
        if abs(unexplained)>max(1e-5,abs(equity)*1e-10):raise AssertionError(f'P&L reconciliation at {date}: {unexplained}')
        curve.append(dict(date=date,base_date=str(p.dates[t-1]),base_equity=last,equity=equity,cash=cash,exposure=exposure,cost=daycost,traded=traded,mark_pnl=float(mark_pnl.sum()),execution_pnl=execution_pnl,corporate_pnl=corporate_pnl,writeoff=day_writeoff));last=equity
        # Weekly rebalance anchored to observed exchange sessions; emergency
        # breadth deterioration is evaluated daily, but orders still next open.
        breadth=float(design_universe(p,c)[1][t])
        emergency=c.regime and breadth<c.breadth_floor and last_breadth>=c.breadth_floor
        if t==risk_paused_until:risk_peak=equity
        portfolio_trigger=False
        if c.portfolio_stop>0 and t>=risk_paused_until:
            risk_peak=max(risk_peak,equity)
            portfolio_trigger=equity<risk_peak*(1-c.portfolio_stop)
            if portfolio_trigger:
                risk_paused_until=t+c.portfolio_pause
                risk_events.append(dict(date=date,equity=equity,cycle_peak=risk_peak,reentry_not_before=str(p.dates[risk_paused_until]) if risk_paused_until<len(p.dates) else None))
        risk_off=c.portfolio_stop>0 and t<risk_paused_until
        # Retry exits each close while paused, subject to actual next-open
        # availability and capacity. Never assume a stop fills at its threshold.
        if (t-first)%c.rebalance==0 or emergency or stop.any() or portfolio_trigger or risk_off or t==risk_paused_until:
            new,info=(weights_fn or select_weights)(p,t,c,units)
            new[blocked_until>t]=0
            if risk_off:new[:]=0
            info['exposure']=float(new.sum());info['stop_symbols']=[p.symbols[i] for i in np.flatnonzero(stop)]
            info['portfolio_risk_off']=bool(risk_off)
            info['selected']=[p.symbols[i] for i in np.flatnonzero(new>0)]
            if t+execution_lag<=last_day:pending[t+execution_lag]=new
            if details:decisions.append(dict(date=date,execute_on=str(p.dates[t+execution_lag]) if t+execution_lag<=last_day else None,**info))
            last_signal=t
        last_breadth=breadth
    frame=pd.DataFrame(curve)
    result={'config':asdict(c),'cost_multiplier':cost_multiplier,'execution_lag':execution_lag,
        'full':metrics(frame),'development':metrics(frame,end='2020-12-31'),
        'validation':metrics(frame,start='2021-01-01',end='2023-12-31'),
        'retrospective_final':metrics(frame,start='2024-01-01'),
        'yearly':{y:metrics(frame,start=y+'-01-01',end=y+'-12-31') for y in sorted(set(frame.date.str[:4]))},
        'trade_count':trade_count,'cost_breakdown':totals,'stale_or_delisted_writeoff':writeoffs,'blocked_order_count':rejections,
        'verified_target':False,'data_complete':False}
    unresolved=(units>0)&((stale>=20)|(deaths<=str(p.dates[last_day])))
    result.update(valuation_policy={'stale_writeoff':stale_writeoff,'delisted_writeoff':delisted_writeoff},
        terminal_unresolved_value=float((units[unresolved]*price[unresolved]).sum()),terminal_fee_reserve=terminal_reserve,
        attribution_error=float(attribution.sum()-(frame.equity.iloc[-1]-1e6)),corporate_action_pnl=corporate_total)
    result['portfolio_risk_events']=risk_events
    if details:
        result['writeoff_events']=loss_events
        result['corporate_action_events']=action_log
        result['symbol_attribution']=[dict(symbol=p.symbols[i],net_pnl=float(attribution[i])) for i in np.argsort(attribution) if attribution[i]!=0]
        result['unresolved_holdings']=[dict(symbol=p.symbols[i],marked_value=float(units[i]*price[i]),stale_days=int(stale[i]),delisted=str(deaths[i])) for i in np.flatnonzero(unresolved)]
    return result,frame,trades,decisions
