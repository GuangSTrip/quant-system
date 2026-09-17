import json
import unittest
from types import SimpleNamespace
from app import FutuPaperReader


class Frame:
    def __init__(self, rows): self.data = rows
    def to_json(self, **_): return json.dumps(self.data)


class Trade:
    def __init__(self):
        self.accounts = [dict(acc_id=7, trd_env='SIMULATE', sim_acc_type='STOCK', trdmarket_auth=['HK'])]
        self.calls = []
    def get_acc_list(self): return 0, Frame(self.accounts)
    def read(self, **args):
        self.calls.append(args)
        return 0, Frame([dict(cash=100, code='HK.00700', qty=100)])
    accinfo_query = position_list_query = order_list_query = read


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.trade = Trade()
        self.quote = SimpleNamespace(get_market_snapshot=lambda codes: (0, Frame([dict(code=codes[0], lot_size=500)])))
        sdk = SimpleNamespace(TrdEnv=SimpleNamespace(SIMULATE='SIMULATE'), Currency=SimpleNamespace(HKD='HKD'))
        self.reader = FutuPaperReader(sdk, self.trade, self.quote, 7)
    def test_paper_account_and_dynamic_lots(self):
        result = self.reader.overview('HK.00700')
        self.assertTrue(result['ok'])
        self.assertEqual(result['quote'][0]['lot_size'], 500)
        self.assertTrue(all(c['trd_env']=='SIMULATE' and c['acc_id']==7 for c in self.trade.calls))
        self.assertNotIn('acc_id', json.dumps(result))
    def test_real_wrong_market_and_option_accounts_rejected_before_queries(self):
        for field,value in [('trd_env','REAL'),('trdmarket_auth',['US']),('sim_acc_type','OPTION')]:
            before=self.trade.accounts[0][field];self.trade.accounts[0][field]=value
            with self.assertRaises(RuntimeError):self.reader.overview('HK.00700')
            self.trade.accounts[0][field]=before
        self.assertEqual(self.trade.calls, [])
    def test_quote_failure_preserves_account_and_redacts_error(self):
        self.quote.get_market_snapshot=lambda _: (-1,'sensitive provider error')
        result=self.reader.overview('HK.00700')
        self.assertFalse(result['ok']);self.assertIsNotNone(result['account'])
        self.assertNotIn('sensitive',json.dumps(result))
    def test_invalid_symbol(self):
        with self.assertRaises(ValueError):self.reader.overview('US.SPY')


if __name__ == '__main__': unittest.main()
