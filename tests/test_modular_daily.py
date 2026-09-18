"""Checks for portfolio execution and risk budgeting, using small fixtures."""
import sys
import unittest
from unittest.mock import patch
import pandas as pd
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from evaluate_modular_daily import Study, execute, allocate, apply_risk_policy, simulate
from evaluate_dynamic_stock_selection import Panel


def study(market='US'):
    close=np.full((65,2),100.);volume=np.full_like(close,100000.)
    panel=Panel(['2025-01-01']*65,['A','B'],close.copy(),close,close.copy(),volume,volume*close)
    returns=np.tile([.02,-.02],(65,1));returns[::2]*=-1
    return Study(market,panel,{'vol':np.full_like(close,.3),'returns':returns},{},{},np.array([99991231]*2))


class ModularDailyTests(unittest.TestCase):
    def test_delay_stress_moves_fills_to_the_second_following_session(self):
        s=study();s.panel.dates=pd.bdate_range('2025-11-17',periods=65).strftime('%Y-%m-%d').tolist()
        s.panel.turnover[:]=1e10;s.selections={'example':{0:np.array([0,1])}}
        with patch('evaluate_modular_daily.START',0):
            normal=simulate(s,'example','monthly','equal')
            delayed=simulate(s,'example','monthly','equal',execution_lag=2)
        self.assertEqual(normal['exposure'][0],0)
        self.assertGreater(normal['exposure'][1],0)
        self.assertEqual(delayed['exposure'][:2],[0,0])
        self.assertGreater(delayed['exposure'][2],0)

    def test_ratcheting_cushion_reduces_exposure_and_locks_cash_at_floor(self):
        s=study();w=np.array([.4,.4])
        np.testing.assert_allclose(apply_risk_policy(s,64,w,'cushion07',1e6,1e6),[.21,.21])
        below=apply_risk_policy(s,64,w,'cushion07',.92e6,1e6)
        np.testing.assert_equal(below,[0.,0.])
        np.testing.assert_equal(w,[.4,.4])

    def test_risk_target_does_not_leverage_and_reject_same_day_execution(self):
        s=study();w=np.array([.4,.4])
        np.testing.assert_allclose(apply_risk_policy(s,64,w,'risk06',1e6,1e6),w)
        s.features['returns'][:,1]=s.features['returns'][:,0]
        reduced=apply_risk_policy(s,64,w,'risk06',1e6,1e6)
        self.assertLess(reduced.sum(),w.sum())
        realized=np.std(s.features['returns'][5:65]@reduced,ddof=1)*np.sqrt(252)
        self.assertAlmostEqual(realized,.06)
        with self.assertRaises(ValueError):simulate(s,'x','monthly','equal',execution_lag=0)

    def test_liquidity_cap_cannot_read_execution_day_total_volume(self):
        s=study();s.panel.turnover[9]=0
        units=np.zeros(2)
        cash,fees,_,orders=execute(s,10,np.array([.8,0]),1_000_000.,units,.001)
        self.assertEqual(orders,0);self.assertEqual(cash,1_000_000.);self.assertEqual(fees,0)
        s.panel.turnover[10]*=100000
        cash,_,_,orders=execute(s,10,np.array([.8,0]),cash,units,.001)
        self.assertEqual(orders,0)

    def test_suspended_position_cannot_be_sold_at_forward_filled_price(self):
        s=study();s.panel.opens[10,0]=np.nan;units=np.array([100.,0.])
        cash,_,_,orders=execute(s,10,np.zeros(2),0.,units,.001)
        self.assertEqual(cash,0);self.assertEqual(orders,0);self.assertEqual(units[0],100.)

    def test_opening_gap_blocks_new_cn_purchase_and_adverse_sale(self):
        s=study('CN');s.panel.opens[10]=[106.,94.];units=np.array([0.,100.])
        cash,_,_,orders=execute(s,10,np.array([.8,0]),100_000.,units,.0015)
        self.assertEqual(orders,0);self.assertEqual(cash,100_000.);np.testing.assert_equal(units,[0.,100.])

    def test_transaction_costs_do_not_create_borrowing(self):
        s=study();s.panel.turnover[9]=1e12;units=np.zeros(2)
        cash,fees,traded,_=execute(s,10,np.array([.5,.5]),100_000.,units,.01)
        self.assertGreaterEqual(cash,-1e-8)
        self.assertAlmostEqual(cash+float((units*100).sum())+fees,100_000.)
        self.assertGreater(traded,0)

    def test_portfolio_risk_uses_covariance_not_sum_of_stock_volatilities(self):
        s=study();ids=np.array([0,1]);active=np.ones(2,dtype=bool)
        # Perfectly offsetting returns give no portfolio volatility; exposure is not cut.
        w=allocate(s,64,ids,active,'vol08')
        np.testing.assert_allclose(w,[.1,.1])  # 10% single-stock concentration cap
        s.features['returns'][:,1]=s.features['returns'][:,0]
        s.features['returns']*=10
        reduced=allocate(s,64,ids,active,'vol08')
        self.assertLess(reduced.sum(),w.sum())


if __name__=='__main__':unittest.main()
