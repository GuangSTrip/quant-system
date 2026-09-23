import unittest
from dataclasses import replace
import numpy as np
import pandas as pd
from quant_system.own_daily import Design,Panel,fees,metrics,select_weights,run,prepare_online_model

def fixture():
    rng=np.random.default_rng(1907);n=30;t=850
    dates=pd.bdate_range('2018-01-01',periods=t).strftime('%Y-%m-%d').to_numpy()
    ret=rng.normal(.001,.006,(t,n));close=100*np.exp(np.cumsum(ret,axis=0));op=close*np.exp(rng.normal(0,.001,(t,n)))
    f={'ret':np.vstack([np.zeros(n),close[1:]/close[:-1]-1]),'mom63':np.full((t,n),.1),'mom126':np.full((t,n),.2),'mom252':np.full((t,n),.3),
       'recent5':np.full((t,n),.01),'near_high':np.full((t,n),.95),'sma120':close*.9,'sma200':close*.9,'vol':np.full((t,n),.18),'downside':np.full((t,n),.1),'efficiency':np.full((t,n),.4),'jump_share':np.full((t,n),.1),
       'liquidity':np.full((t,n),1e9),'seen':np.tile(np.arange(t)[:,None]+1,(1,n)),'recent_count':np.full((t,n),30),'recent_jump':np.full((t,n),.05)}
    for key in ['mom63','mom126','mom252','efficiency','near_high','jump_share','downside']:
        f[key]=f[key]*(.8+np.arange(n)[None,:]/n*.4)
    return Panel('US',dates,[f'S{i}' for i in range(n)],op,close,close,np.full((t,n),1e7),np.full((t,n),1e9),f,{'records':{}})

class DailyTests(unittest.TestCase):
    def test_historical_stamp_rates(self):
        self.assertAlmostEqual(fees('CN','2023-08-25',100000,'sell')['tax_exchange']-fees('CN','2023-08-28',100000,'sell')['tax_exchange'],50)
        self.assertGreater(fees('HK','2022-06-01',100000,'buy')['tax_exchange'],fees('HK','2024-06-01',100000,'buy')['tax_exchange'])
        self.assertEqual(fees('CN','2025-01-01',100,'buy')['commission'],5)
        self.assertEqual(fees('US','2025-01-01',100000,'buy')['tax_exchange'],0)
    def test_first_day_drawdown_is_not_dropped(self):
        f=pd.DataFrame([dict(date='2020-01-02',base_date='2020-01-01',base_equity=100,equity=90,cost=10,traded=100,exposure=.8),dict(date='2020-01-03',base_date='2020-01-02',base_equity=90,equity=95,cost=0,traded=0,exposure=.8)])
        m=metrics(f);self.assertAlmostEqual(m['max_drawdown'],.1);self.assertAlmostEqual(m['total_return'],-.05)
    def test_future_prices_do_not_change_past_signals(self):
        p=fixture();w,_=select_weights(p,400,Design(),np.zeros(30));p.value[401:]*=100
        again,_=select_weights(p,400,Design(),np.zeros(30));np.testing.assert_array_equal(w,again)
    def test_next_open_and_cash_conservation(self):
        p=fixture();r,f,trades,decisions=run(p,Design(),details=True)
        self.assertGreater(len(trades),0);self.assertGreaterEqual(f.cash.min(),-.001)
        self.assertEqual(trades[0]['date'],decisions[0]['execute_on']);self.assertGreater(trades[0]['date'],decisions[0]['date'])
        self.assertAlmostEqual(f.cost.sum(),sum(r['cost_breakdown'].values()),places=5)
        self.assertLessEqual(f.exposure.max(),1.05)
        self.assertGreater(run(p,Design(),cost_multiplier=2)[0]['full']['total_cost'],r['full']['total_cost'])
        cash=1e6
        for trade in trades:
            cash+=trade['notional']*(1 if trade['side']=='sell' else -1)-sum(trade[k] for k in ['commission','tax_exchange','slippage'])
        self.assertAlmostEqual(cash,f.cash.iloc[-1],places=5)
    def test_unavailable_open_cannot_fill(self):
        p=fixture();p.opens[253]=np.nan
        _,_,trades,_=run(p,Design(),details=True)
        self.assertNotIn(str(p.dates[253]),[t['date'] for t in trades])
    def test_zero_volume_with_recorded_open_cannot_fill(self):
        p=fixture();p.volume[253]=0
        _,_,trades,_=run(p,Design(),details=True)
        self.assertNotIn(str(p.dates[253]),[t['date'] for t in trades])
    def test_score_ignores_final_period(self):
        import sys
        from pathlib import Path
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
        from evaluate_own_daily import selection_score
        r={'development':{'years':3,'cagr':.2,'max_drawdown':.1,'average_exposure':.7},'retrospective_final':{'cagr':9}}
        a=selection_score(r);r['retrospective_final']['cagr']=-.99;self.assertEqual(a,selection_score(r))
    def test_online_training_waits_for_label_maturity(self):
        p=fixture();prepare_online_model(p);before=p.features['online_beta'][:701].copy()
        q=fixture();q.closes[701:]*=3;q.opens[701:]*=2;prepare_online_model(q)
        np.testing.assert_allclose(before,q.features['online_beta'][:701],atol=0,rtol=0)
        for u in p.metadata['model_updates']:self.assertLessEqual(u['last_label_date'],u['date'])
        self.assertFalse(np.any(p.features['online_beta'][:504]))
        self.assertGreater(np.linalg.norm(p.features['online_beta'][700]),1e-9)
    def test_trailing_exit_observes_cooldown(self):
        p=fixture();p.closes[400:]*=.75;p.opens[400:]*=.75
        _,_,trades,decisions=run(p,Design(trailing_stop=.10),details=True)
        events=[d for d in decisions if d['date']==str(p.dates[400]) and d['stop_symbols']]
        self.assertTrue(events)
        stopped=set(events[0]['stop_symbols'])
        early_buys=[x for x in trades if x['side']=='buy' and x['symbol'] in stopped and str(p.dates[401])<=x['date']<=str(p.dates[420])]
        self.assertEqual(early_buys,[])
    def test_fractional_unit_roundoff_cannot_create_short_position(self):
        p=fixture();p.opens*=1e-12;p.closes*=1e-12
        r,curve,_,_=run(p,Design())
        self.assertGreaterEqual(curve.cash.min(),-.001)
        self.assertTrue(np.isfinite(r['full']['cagr']))
    def test_suspension_retains_property_until_real_price_returns(self):
        p=fixture();p.opens[300:380]=np.nan;p.closes[300:380]=np.nan;p.volume[300:380]=0
        p.value=pd.DataFrame(p.closes).ffill().to_numpy()
        r,f,_,_=run(p,Design(),details=True,stale_writeoff=False,delisted_writeoff=False)
        self.assertEqual(r['stale_or_delisted_writeoff'],0)
        self.assertAlmostEqual(r['attribution_error'],0,places=5)
        self.assertGreater(f.loc[f.date==str(p.dates[370]),'exposure'].iloc[0],0)
        stress=run(p,Design(),stale_writeoff=True)[0]
        self.assertGreater(stress['stale_or_delisted_writeoff'],0)
    def test_delisting_without_settlement_is_flagged_not_cash(self):
        p=fixture();p.metadata['records']={s:{'delisted':str(p.dates[300])} for s in p.symbols}
        p.opens[300:]=np.nan;p.closes[300:]=np.nan;p.volume[300:]=0;p.value=pd.DataFrame(p.closes).ffill().to_numpy()
        r,f,_,_=run(p,Design(),details=True,stale_writeoff=False,delisted_writeoff=False)
        self.assertGreater(r['terminal_unresolved_value'],0)
        self.assertEqual(r['stale_or_delisted_writeoff'],0)
        self.assertAlmostEqual(f.cash.iloc[-1],f.loc[f.date==str(p.dates[299]),'cash'].iloc[0])
    def test_policy_uses_past_liquidity_and_volatility(self):
        from quant_system.own_daily import design_universe
        p=fixture();c=Design(liquidity_limit=12,max_stock_vol=.75)
        a=design_universe(p,c)[0][400].copy();q=fixture();q.features['liquidity'][401:]*=100
        np.testing.assert_array_equal(a,design_universe(q,c)[0][400]);self.assertEqual(int(a.sum()),12)
    def test_cash_and_stock_merger_conserve_value(self):
        p=fixture();symbol='S29';i=29;event=str(p.dates[400]);p.opens[400:,i]=np.nan;p.closes[400:,i]=np.nan;p.volume[400:,i]=0
        p.value=pd.DataFrame(p.closes).ffill().to_numpy()
        actions=[dict(id='test',symbol=symbol,date=event,cash_per_adjusted_unit=10.,acquirer='S0',new_units_per_adjusted_unit=.5)]
        r,f,trades,_=run(p,Design(),details=True,stale_writeoff=False,delisted_writeoff=False,corporate_actions=actions)
        self.assertEqual(len(r['corporate_action_events']),1)
        self.assertAlmostEqual(r['attribution_error'],0,places=5)
        ev=r['corporate_action_events'][0];self.assertGreater(ev['cash_received'],0)
        cash=1e6+ev['cash_received']
        for x in trades:cash+=(x['notional'] if x['side']=='sell' else -x['notional'])-sum(x[k] for k in ['commission','tax_exchange','slippage'])
        self.assertAlmostEqual(cash,f.cash.iloc[-1],places=5)
    def test_account_stop_waits_for_next_open_and_keeps_drawdown(self):
        p=fixture();p.closes[400:]*=.70;p.opens[400:]*=.70
        r,f,trades,decisions=run(p,Design(portfolio_stop=.08,portfolio_pause=20),details=True)
        self.assertTrue(r['portfolio_risk_events']);ev=r['portfolio_risk_events'][0]
        self.assertEqual(ev['date'],str(p.dates[400]))
        self.assertGreater(r['full']['max_drawdown'],.15)
        self.assertEqual([x for x in trades if x['side']=='buy' and str(p.dates[401])<=x['date']<=str(p.dates[420])],[])
        self.assertTrue(any(x['side']=='sell' and x['date']==str(p.dates[401]) for x in trades))

if __name__=='__main__':unittest.main()
