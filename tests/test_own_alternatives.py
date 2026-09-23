import unittest
import numpy as np
from quant_system import own_daily as engine
from quant_system.own_alternatives import make_selector
from tests.test_own_daily import fixture

class AlternativeTests(unittest.TestCase):
    def test_future_changes_do_not_change_signal_or_beta_proxy(self):
        p=fixture();q=fixture();q.features['ret'][501:]*=20;q.value[501:]*=10;q.features['liquidity'][501:]*=100
        select=make_selector(engine)
        for family in ['residual_reversal','recovery_reversal','distributed_trend','mechanism_mix']:
            c=engine.Design(family=family,liquidity_limit=500,max_stock_vol=.75)
            left,_=select(p,500,c,np.zeros(30));right,_=select(q,500,c,np.zeros(30))
            np.testing.assert_allclose(left,right,atol=0,rtol=0)
            self.assertTrue(np.isfinite(left).all());self.assertGreaterEqual(left.min(),0);self.assertLessEqual(left.sum(),.95+1e-12)
    def test_flat_market_is_not_fabricated_reversal_signal(self):
        p=fixture();p.features['ret'][:]=0
        w,_=make_selector(engine)(p,500,engine.Design(family='residual_reversal'),np.zeros(30))
        np.testing.assert_array_equal(w,np.zeros(30))
    def test_new_mechanism_uses_same_cash_and_fee_accounting(self):
        p=fixture();c=engine.Design(family='mechanism_mix',rebalance=5,regime=False)
        r,f,trades,decisions=engine.run(p,c,weights_fn=make_selector(engine),details=True,stale_writeoff=False,delisted_writeoff=False)
        self.assertGreater(len(trades),0);self.assertGreaterEqual(f.cash.min(),-.001)
        self.assertAlmostEqual(r['attribution_error'],0,places=5)
        self.assertAlmostEqual(f.cost.sum(),sum(r['cost_breakdown'].values()),places=5)
        self.assertGreater(trades[0]['date'],decisions[0]['date'])
if __name__=='__main__':unittest.main()
