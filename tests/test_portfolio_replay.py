"""Golden parity against pre-integration e4648b1 plus replay/provider contracts."""
import json
import sys
import tempfile
import unittest
from datetime import datetime,timezone,timedelta
from pathlib import Path
from unittest.mock import patch
import numpy as np
import pandas as pd
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from evaluate_modular_daily import Study,simulate,DecisionState,decide_close
from evaluate_dynamic_stock_selection import Panel
from portfolio_signal import catalog,produce
from portfolio_providers import session_from_calendar
from portfolio_service import refresh,run_once


def fixture(market='US'):
    rng=np.random.default_rng(412);n=40;days=560
    dates=pd.bdate_range('2024-01-02',periods=days).strftime('%Y-%m-%d').tolist()
    c=100*np.exp(np.cumsum(rng.normal(.0002,.012,(days,n)),axis=0))
    frame=pd.DataFrame(c);ret=frame.pct_change(fill_method=None).fillna(0).to_numpy()
    volume=np.full_like(c,500000.);opens=c*np.exp(rng.normal(0,.002,c.shape))
    symbols=[f'S{i:02}' if market=='US' else f'{i+1}.HK' if market=='HK' else f'{600000+i}.SH' for i in range(n)]
    p=Panel(dates,symbols,opens,c,c.copy(),volume,c*volume)
    features={'vol':pd.DataFrame(ret).rolling(120,min_periods=100).std().to_numpy()*np.sqrt(252),
              'returns':ret,'sma':frame.rolling(120).mean().to_numpy(),
              'entry':frame.rolling(55).max().shift(1).to_numpy(),
              'exit':frame.rolling(20).min().shift(1).to_numpy()}
    selections={}
    names=sorted({r['selection'] for r in catalog().values()})
    for i,name in enumerate(names):
        selections[name]={day:np.array([(j+(day//21)+i)%n for j in range(30 if name in ('earnings_value','dividend_defensive','balanced_value','smooth_momentum') else 20)]) for day in range(252,days,21)}
    dead=np.full(n,99991231);dead[0]=int(dates[500].replace('-',''))
    return Study(market,p,features,selections,{},dead)




class PortfolioReplayTests(unittest.TestCase):
    def assert_result_close(self, actual, expected, path='result'):
        if isinstance(expected, dict):
            self.assertEqual(set(actual), set(expected), path)
            for key in expected: self.assert_result_close(actual[key], expected[key], f'{path}.{key}')
        elif isinstance(expected, list):
            self.assertEqual(len(actual), len(expected), path)
            for i, value in enumerate(expected): self.assert_result_close(actual[i], value, f'{path}[{i}]')
        elif isinstance(expected, float):
            np.testing.assert_allclose(actual, expected, rtol=1e-10, atol=1e-8, err_msg=path)
        else:
            self.assertEqual(actual, expected, path)

    def test_all_178_registered_variants_match_original_research_engine(self):
        expected=json.loads((Path(__file__).parent/'fixtures/portfolio_original_golden.json').read_text())
        studies={m:fixture(m) for m in ['CN','HK','US']}
        self.assertEqual(set(expected['results']),set(catalog()))
        for key,config in catalog().items():
            with self.subTest(strategy=key):
                result=simulate(studies[config['market']],**{k:v for k,v in config.items() if k!='market'})
                self.assert_result_close(result,expected['results'][key])

    def test_breakout_holding_state_and_risk_phase_survive_serialization(self):
        s=fixture();state=DecisionState.empty(len(s.panel.symbols))
        for day in range(252,300):state,_=decide_close(s,day,'near_high','breakout','inverse_vol',state,1e6,1e6,'risk06')
        raw=json.loads(json.dumps(state.export(s.panel.symbols)));lookup={s:i for i,s in enumerate(s.panel.symbols)}
        restored=DecisionState(np.array([lookup[s] for s in raw['selected']]),np.array([s in raw['active'] for s in s.panel.symbols]),np.array([raw['target'][s] for s in s.panel.symbols]),raw['decision_day'])
        for day in range(300,340):
            state,a=decide_close(s,day,'near_high','breakout','inverse_vol',state,1e6,1e6,'risk06')
            restored,b=decide_close(s,day,'near_high','breakout','inverse_vol',restored,1e6,1e6,'risk06')
            self.assertEqual(a,b);self.assertEqual(state.export(s.panel.symbols),restored.export(s.panel.symbols))

    def test_signal_is_exact_final_kernel_target_not_curve_inference(self):
        s=fixture();key='US:near_high:breakout:inverse_vol:base';d=s.panel.dates[-1]
        session={'signal_date':d,'data_asof':d+'T21:00:00Z','execute_after':(pd.Timestamp(d)+pd.offsets.BDay()).strftime('%Y-%m-%d')+'T14:30:00Z','expires_at':(pd.Timestamp(d)+pd.offsets.BDay()).strftime('%Y-%m-%d')+'T21:00:00Z'}
        out=produce(s,key,session);trace=[];simulate(s,'near_high','breakout','inverse_vol',trace=trace)
        self.assertEqual({t['symbol']:t['weight'] for t in out['signal']['targets']},{symbol:w for symbol,w in trace[-1]['state']['target'].items() if w>0})
        self.assertAlmostEqual(out['signal']['cash_weight']+sum(t['weight'] for t in out['signal']['targets']),1)
        self.assertEqual([d['t'] for d in out['backtest']['decisions']], out['dates'])
        self.assertEqual(out['backtest']['decisions'][-1]['targets'], out['signal']['targets'])
        self.assertEqual(len(out['backtest']['trades']), out['backtest']['trade_count'])
        self.assertTrue(all(t['signal_t']<t['t'] for t in out['backtest']['trades']))
        self.assertAlmostEqual(sum(t['cost'] for t in out['backtest']['trades']), out['backtest']['cost'], places=2)
        for event in trace:
            self.assertAlmostEqual(event['cash']+sum(h['qty']*h['price'] for h in event['holdings']), event['equity'], places=6)
        for row, event in zip(out['backtest']['decisions'], trace):
            self.assertEqual(row['rebalanced'], event['rebalanced'])
            self.assertEqual({t['symbol']:t['weight'] for t in row['targets']}, {s:w for s,w in event['state']['target'].items() if w>0})
        s.panel.closes[-1,1]=np.nan
        with self.assertRaisesRegex(ValueError,'Incomplete'):produce(s,key,session)

    def test_calendar_uses_actual_holiday_and_half_day_sessions_with_finalization_delay(self):
        utc=timezone.utc
        sessions=[{'date':'2026-11-25','open':datetime(2026,11,25,14,30,tzinfo=utc),'close':datetime(2026,11,25,21,tzinfo=utc)},
                  {'date':'2026-11-27','open':datetime(2026,11,27,14,30,tzinfo=utc),'close':datetime(2026,11,27,18,tzinfo=utc)},
                  {'date':'2026-11-30','open':datetime(2026,11,30,14,30,tzinfo=utc),'close':datetime(2026,11,30,21,tzinfo=utc)}]
        r=session_from_calendar(sessions,datetime(2026,11,27,18,5,tzinfo=utc));self.assertEqual(r['signal_date'],'2026-11-25');self.assertEqual(r['expires_at'],'2026-11-27T18:00:00Z')
        r=session_from_calendar(sessions,datetime(2026,11,27,18,20,tzinfo=utc));self.assertEqual(r['signal_date'],'2026-11-27');self.assertEqual(r['execute_after'],'2026-11-30T14:30:00Z')

    def test_incomplete_provider_history_never_publishes_partial_cache(self):
        class Provider:
            market='US'
            def histories(self,symbols,end):return {s:pd.DataFrame([{'date':'2026-09-17','open':100,'high':101,'low':99,'close':100,'volume':100}]) for s in symbols}
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):refresh(Provider(),['A','B'],{'signal_date':'2026-09-18'},Path(folder))
            self.assertEqual(list(Path(folder).glob('**/*.csv.gz')),[])

    def test_data_producer_refresh_replay_publication_pipeline_never_calls_orders(self):
        s=fixture();end=s.panel.dates[-1];moment=datetime.fromisoformat(end+'T22:00:00+00:00')
        class Provider:
            market='US'
            def calendar(self,now):
                return [{'date':end,'open':moment.replace(hour=14,minute=30),'close':moment.replace(hour=21)},
                        {'date':(moment+timedelta(days=1)).date().isoformat(),'open':(moment+timedelta(days=1)).replace(hour=14,minute=30),'close':(moment+timedelta(days=1)).replace(hour=21)}]
            def histories(self,symbols,end):
                return {symbol:pd.DataFrame({'date':s.panel.dates,'open':s.panel.opens[:,i],
                    'high':np.maximum(s.panel.opens[:,i],s.panel.closes[:,i])*1.01,
                    'low':np.minimum(s.panel.opens[:,i],s.panel.closes[:,i])*.99,
                    'close':s.panel.closes[:,i],'volume':s.panel.volumes[:,i]}) for i,symbol in enumerate(symbols)}
        class Publisher:
            def __init__(self):self.calls=[]
            def post(self,path,payload):self.calls.append((path,payload));return {'ok':True}
        publisher=Publisher();config={'markets':{'US':{'symbols':s.panel.symbols,'strategies':['US:near_high:breakout:inverse_vol:base']}}}
        import portfolio_service
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'.paper_state').mkdir()
            with patch.object(portfolio_service,'ROOT',root),patch.object(portfolio_service,'datetime',wraps=datetime) as clock:
                clock.now.return_value=moment;state={};run_once(config,{'US':Provider()},publisher,state)
                self.assertEqual([p for p,_ in publisher.calls],['portfolio/backtests','portfolio/signals'])
                self.assertEqual(publisher.calls[0][1]['signal'],publisher.calls[1][1])
                self.assertEqual(publisher.calls[1][1]['signal_date'],end)
                self.assertEqual(len(publisher.calls[1][1]['liquidity_caps']),40)
                run_once(config,{'US':Provider()},publisher,state);self.assertEqual(len(publisher.calls),2)
                with patch.object(Provider,'histories',side_effect=AssertionError('restart must reuse frozen data')):
                    run_once(config,{'US':Provider()},publisher,{})
                self.assertEqual(publisher.calls[1],publisher.calls[3])

if __name__=='__main__':unittest.main()
