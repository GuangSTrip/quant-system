from pathlib import Path
import hashlib,json,tempfile,unittest
import numpy as np
import pandas as pd
from quant_system import own_daily as engine
from quant_system.own_fundamental import make_selector
from tests.test_own_daily import fixture

def data(root,p,missing=False,future_pub=False):
    manifest={}
    for t in [400,600]:
        day=str(p.dates[t]);f=pd.DataFrame(dict(symbol=p.symbols,pub_date=str(p.dates[t+1] if future_pub else p.dates[t-10]),rpt_date=str(p.dates[t-100]),data_type=101,
            ttl_ast=np.arange(30)+100.,net_prof_pcom=np.arange(30)+5.,ttl_eqy_pcom=np.arange(30)+50.,net_cf_oper=np.full(30,np.nan) if missing else np.arange(30)+10.,pe_ttm=np.arange(30)+10.))
        path=root/(day+'.csv.gz');f.to_csv(path,index=False,compression='gzip');manifest[day]=dict(status='ok',sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    (root/'manifest.json').write_text(json.dumps(manifest));return manifest

class FundamentalTests(unittest.TestCase):
    def test_snapshot_cannot_trade_on_its_observation_date(self):
        p=fixture();c=engine.Design(family='fundamental_quality',regime=False)
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);data(root,p);s=make_selector(engine,p,root)
            w,_=s(p,400,c,np.zeros(30));np.testing.assert_array_equal(w,np.zeros(30))
            w,info=s(p,401,c,np.zeros(30));self.assertGreater(w.sum(),0);self.assertLess(info['snapshot'],p.dates[401])
            self.assertLessEqual(w.sum(),.95+1e-12)
    def test_future_publication_rejected(self):
        p=fixture()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);data(root,p,future_pub=True)
            with self.assertRaises(ValueError):make_selector(engine,p,root)
    def test_missing_cashflow_is_not_imputed(self):
        p=fixture()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);data(root,p,missing=True);s=make_selector(engine,p,root)
            w,_=s(p,500,engine.Design(family='fundamental_value_quality'),np.zeros(30));np.testing.assert_array_equal(w,np.zeros(30))
if __name__=='__main__':unittest.main()
