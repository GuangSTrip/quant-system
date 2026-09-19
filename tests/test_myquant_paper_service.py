import unittest
from types import SimpleNamespace
from quant_system.myquant_strategy import PaperService, PAPER_ENDPOINT

class PaperServiceTests(unittest.TestCase):
    def test_fixed_endpoint_account_isolation_and_order_routing(self):
        calls=[]
        sdk=SimpleNamespace(set_endpoint=lambda x:calls.append(('endpoint',x)),set_token=lambda x:None,
            account=lambda **kw:kw,login=lambda a:0,get_cash=lambda:[{'account_id':'sim-1','available':1000},{'account_id':'other','available':99999}],
            get_positions=lambda:[{'account_id':'other','volume':999}],order_volume=lambda **kw:[{'account_id':kw['account'],'cl_ord_id':'order-1'}])
        service=PaperService(sdk,'fixture-token','sim-1')
        self.assertEqual(calls,[('endpoint',PAPER_ENDPOINT)])
        self.assertTrue(service.paper_environment_verified)
        self.assertEqual(service.cash['available'],1000)
        self.assertEqual(service.positions(),[])
        self.assertEqual(service.order_volume(account='sim-1')[0]['cl_ord_id'],'order-1')
        with self.assertRaises(RuntimeError):service.order_volume(account='other')
        sdk.get_cash=lambda:[]
        with self.assertRaises(RuntimeError):_ = service.cash

    def test_failed_login_does_not_enable_trading(self):
        sdk=SimpleNamespace(set_endpoint=lambda x:None,set_token=lambda x:None,account=lambda **kw:kw,login=lambda a:7)
        with self.assertRaises(RuntimeError):PaperService(sdk,'fixture','sim-1')
