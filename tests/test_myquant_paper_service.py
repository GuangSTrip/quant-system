import unittest
from types import SimpleNamespace
from quant_system.myquant_strategy import PaperService, PAPER_ENDPOINT, TerminalPaperService, TERMINAL_ENDPOINT

class PaperServiceTests(unittest.TestCase):
    def test_terminal_requires_exact_confirmed_paper_account(self):
        calls=[]
        sdk=SimpleNamespace(set_endpoint=lambda x:calls.append(x),set_token=lambda x:None,
            account=lambda **kw:kw,login=lambda a:None,
            get_cash=lambda **kw:{'account_id':kw['account'],'available':1000})
        for confirmed in ('', 'another-account'):
            with self.assertRaises(RuntimeError):TerminalPaperService(sdk,'fixture','sim-1',confirmed)
        self.assertEqual(calls,[])
        service=TerminalPaperService(sdk,'fixture','sim-1','sim-1')
        self.assertEqual(calls,[TERMINAL_ENDPOINT])
        self.assertEqual(service.status['verification'],'operator-confirmed-paper-account')
        self.assertTrue(service.paper_environment_verified)

    def test_fixed_endpoint_account_isolation_and_order_routing(self):
        calls=[]
        sdk=SimpleNamespace(set_endpoint=lambda x:calls.append(('endpoint',x)),set_token=lambda x:None,
            account=lambda **kw:kw,login=lambda a:0,get_cash=lambda **kw:[{'account_id':kw['account'],'available':1000},{'account_id':'other','available':99999}],
            get_positions=lambda **kw:[{'account_id':'other','volume':999}],order_volume=lambda **kw:[{'account_id':kw['account'],'cl_ord_id':'order-1'}])
        service=PaperService(sdk,'fixture-token','sim-1')
        self.assertEqual(calls,[('endpoint',PAPER_ENDPOINT)])
        self.assertTrue(service.paper_environment_verified)
        self.assertEqual(service.cash['available'],1000)
        self.assertEqual(service.positions(),[])
        self.assertEqual(service.order_volume(account='sim-1')[0]['cl_ord_id'],'order-1')
        with self.assertRaises(RuntimeError):service.order_volume(account='other')
        sdk.get_cash=lambda **kw:[]
        with self.assertRaises(RuntimeError):_ = service.cash

    def test_failed_login_does_not_enable_trading(self):
        sdk=SimpleNamespace(set_endpoint=lambda x:None,set_token=lambda x:None,account=lambda **kw:kw,login=lambda a:7)
        with self.assertRaises(RuntimeError):PaperService(sdk,'fixture','sim-1')

    def test_sdk_none_login_requires_confirmed_account_cash(self):
        sdk=SimpleNamespace(set_endpoint=lambda x:None,set_token=lambda x:None,
            account=lambda **kw:kw,login=lambda a:None,get_cash=lambda **kw:None)
        with self.assertRaises(RuntimeError):PaperService(sdk,'fixture','sim-1')
        sdk.get_cash=lambda **kw:{'account_id':'wrong-account','available':1000}
        with self.assertRaises(RuntimeError):PaperService(sdk,'fixture','sim-1')

    def test_actual_sdk_protobuf_cash_keeps_zero_balances_and_account_binding(self):
        try:
            from gmtrade.pb.account_pb2 import Cash
        except ImportError:
            self.skipTest('gmtrade optional SDK is not installed')
        sdk=SimpleNamespace(set_endpoint=lambda x:None,set_token=lambda x:None,
            account=lambda **kw:kw,login=lambda a:None,
            get_cash=lambda **kw:Cash(account_id=kw['account'],available=0))
        service=PaperService(sdk,'fixture','sim-1')
        self.assertTrue(service.paper_environment_verified)
        self.assertEqual(service.cash['available'],0)
