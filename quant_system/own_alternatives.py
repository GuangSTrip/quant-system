"""Mechanism alternatives; all signals use only data through the current close.

The engine dependency is explicitly injected so frozen experiments can replay
both the accounting implementation and the selector without importing live code.
"""
import numpy as np
import pandas as pd

def prepare(p,engine):
    if 'alternative_features' in p.features:return
    engine.prepare_selection_cache(p)
    r=pd.DataFrame(p.features['ret'])
    # The market proxy needs only 20 past sessions, independently of the stock
    # strategy's 252-session warmup, so beta has a genuine warmup history.
    masks=np.zeros(p.closes.shape,bool);floor={'CN':20e6,'HK':5e6,'US':5e6}[p.market]
    for t in range(20,len(p.dates)):
        valid=np.isfinite(p.closes[t])&(p.volume[t]>0)&(p.features['seen'][t]>=20)&(p.features['liquidity'][t]>=floor)
        ids=sorted(np.flatnonzero(valid),key=lambda i:(-p.features['liquidity'][t,i],p.symbols[i]))[:500]
        masks[t,ids]=True
    lag=np.vstack([np.zeros(len(p.symbols),bool),masks[:-1]])
    count=lag.sum(axis=1)
    # Prior-close universe supplies today's cross-sectional market proxy.
    market=pd.Series(np.divide(np.where(lag,r.to_numpy(),0).sum(axis=1),count,out=np.zeros(len(count)),where=count>0))
    mean=r.rolling(126,min_periods=100).mean();market_mean=market.rolling(126,min_periods=100).mean()
    covariance=r.mul(market,axis=0).rolling(126,min_periods=100).mean()-mean.mul(market_mean,axis=0)
    variance=market.rolling(126,min_periods=100).var(ddof=0).clip(lower=1e-8)
    beta=covariance.div(variance,axis=0).clip(-2,4).where(market.rolling(126,min_periods=100).count()>=100,axis=0).shift(1)
    residual=r-beta.mul(market,axis=0)
    sigma=residual.rolling(60,min_periods=40).std().shift(5).clip(lower=.002)
    price=pd.DataFrame(p.value)
    p.features['alternative_features']={
        'shock_z':(residual.rolling(5).sum()/(sigma*np.sqrt(5))).to_numpy(),
        'old_return':(price.shift(63)/price.shift(252)-1).to_numpy(),
        'recovery63':(price/price.shift(63)-1).to_numpy(),
        'sma20':price.rolling(20).mean().to_numpy(),
        'recent_jump5':r.abs().rolling(5).max().to_numpy(),
        'market_proxy':market.to_numpy(),
    }

def make_selector(engine):
    def selector(p,t,c,held):
        prepare(p,engine)
        f=p.features;a=f['alternative_features'];mask,breadths=engine.design_universe(p,c)
        valid=mask[t].copy();n=len(p.symbols);breadth=float(breadths[t]);parts={}
        def allocation(ids,cap):
            w=np.zeros(n)
            if len(ids):
                inverse=1/np.maximum(f['vol'][t,ids],.10);w[ids]=np.minimum(inverse/inverse.sum(),cap)
            return w
        def pick(score,eligible,limit):
            return sorted(np.flatnonzero(eligible&np.isfinite(score)),key=lambda i:(-score[i],p.symbols[i]))[:limit]
        # Broad time-series trend: liquid names passing their own trend filters,
        # not the largest past-return winners. A 2% cap preserves cash when few pass.
        trend=valid&(p.value[t]>f['sma200'][t])&(a['sma20'][t]>f['sma120'][t])
        ids=pick(f['liquidity'][t],trend,100);parts['distributed_trend']=allocation(ids,.02)
        # Market-beta residual reversal is only a proxy for temporary dislocation;
        # earnings and industry effects are NOT known or removed here.
        z=a['shock_z'][t]
        shock=valid&(z<-.5)&(z>-3)&(a['recent_jump5'][t]<.20)
        if breadth<.35:shock[:]=False
        ids=pick(-z,shock,25);parts['residual_reversal']=allocation(ids,.10)
        # Long-horizon laggards with an observed recovery, not fundamental value.
        recovery=valid&(a['recovery63'][t]>0)&(p.value[t]>f['sma120'][t])
        ids=pick(-a['old_return'][t],recovery,25);parts['recovery_reversal']=allocation(ids,.10)
        if c.family=='mechanism_mix':w=.50*parts['distributed_trend']+.25*parts['residual_reversal']+.25*parts['recovery_reversal']
        elif c.family in parts:w=parts[c.family]
        else:raise ValueError('Unknown alternative mechanism: '+c.family)
        # No leverage: risk targeting can only reduce this allocation.
        history=f['ret'][max(0,t-59):t+1]
        risk=float(np.std(history@w,ddof=1)*np.sqrt(252));w*=.95*min(1.,c.target_vol/max(risk,.01))
        return w,dict(eligible=int(valid.sum()),breadth=breadth,selected=[p.symbols[i] for i in np.flatnonzero(w>0)],
                      exposure=float(w.sum()),mechanism=c.family,estimated_vol=risk)
    return selector
