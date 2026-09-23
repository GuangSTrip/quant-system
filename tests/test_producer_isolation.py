import unittest,json,hashlib,tempfile,sys
from pathlib import Path
from datetime import datetime,timezone,timedelta
from unittest.mock import patch
from urllib.error import HTTPError
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import portfolio_service as service

class IsolationTests(unittest.TestCase):
 def test_conflict_keeps_quotes_and_other_signals_and_does_not_resend(self):
  now=datetime.now(timezone.utc);symbols=[str(i)+'.HK' for i in range(1,31)]
  session={'signal_date':'2026-09-21','expires_at':(now+timedelta(days=1)).isoformat()}
  ids=['HK:first','HK:second'];calls=[]
  class Provider:
   def calendar(self,n):return []
   def quotes(self,s,n,c):return {'instruments':[],'asof':n.isoformat(),'is_open':True}
  class Publisher:
   def get(self,p):return {}
   def post(self,p,b):
    calls.append((p,b))
    if p=='portfolio/signals' and b['strategy_id']==ids[0]:raise HTTPError('',409,'conflict',{},None)
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);key='HK:'+session['signal_date']+':'+hashlib.sha256(json.dumps(symbols,sort_keys=True).encode()).hexdigest()
   saved=root/'.paper_state'/'portfolio-signals'/hashlib.sha256((key+service.VERSION).encode()).hexdigest();saved.mkdir(parents=True)
   for i in ids:(saved/(hashlib.sha256(i.encode()).hexdigest()+'.json')).write_text(json.dumps({'signal':{'strategy_id':i}}))
   with patch.object(service,'ROOT',root),patch.object(service,'catalog',return_value={i:{'market':'HK'} for i in ids}),patch.object(service,'session_from_calendar',return_value=session):
    config={'markets':{'HK':{'symbols':symbols,'strategies':ids}}};state={}
    service.run_once(config,{'HK':Provider()},Publisher(),state)
    self.assertEqual(calls[0][0],'portfolio/quotes')
    self.assertTrue(any(p=='portfolio/signals' and b['strategy_id']==ids[1] for p,b in calls))
    self.assertEqual(state['HK:rejected'],[ids[0]])
    count=len(calls);service.run_once(config,{'HK':Provider()},Publisher(),state)
    self.assertEqual([p for p,b in calls[count:]],['portfolio/quotes'])
    self.assertFalse(any('orders' in p for p,b in calls))

if __name__=='__main__':unittest.main()
