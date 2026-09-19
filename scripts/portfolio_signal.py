"""Replay registered daily strategies with the historical decision kernel.

No orders are submitted here. Optional publication uploads signals to the website;
the separately authorized server scheduler owns all account/order state.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import urllib.request
import urllib.parse
import http.cookiejar
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from evaluate_modular_daily import ROOT, START, prepare, simulate
from refine_daily_research import china_selection, CN_NAMES

VERSION = 'modular-close-1'


def catalog():
    old = json.loads((ROOT/'web_platform/src/modular-daily-results.json').read_text())
    new = json.loads((ROOT/'web_platform/src/daily-refinement.json').read_text())
    entries = {}
    for market, value in old['markets'].items():
        for r in value['combinations'] + new['markets'][market]['experiments']:
            key = ':'.join([market,r['selection'],r['timing'],r['allocation'],r.get('risk_policy') or 'base'])
            entries[key] = {'market':market, 'selection':r['selection'], 'timing':r['timing'],
                            'allocation':r['allocation'], 'risk_policy':r.get('risk_policy')}
    return entries


def canonical_symbol(symbol, market):
    return str(int(symbol.split('.')[0]))+'.HK' if market=='HK' else symbol


def produce(study, strategy_id, session):
    config = catalog()[strategy_id]
    if config['market'] != study.market:
        raise ValueError('Market mismatch')
    p = study.panel
    if p.dates != sorted(set(p.dates)) or len(p.dates) <= START:
        raise ValueError('History must be unique, chronological and warmed up')
    if session['signal_date'] != p.dates[-1]:
        raise ValueError('Cache does not end at the latest complete market session')
    # Missing histories must not silently remove securities or turn an outage into liquidation.
    latest = np.isfinite(p.closes[-1]) & (p.closes[-1] > 0)
    suspended = set(session.get('suspended_symbols', []))
    missing = [s for s, valid in zip(p.symbols, latest) if not valid and s not in suspended]
    if missing:
        raise ValueError('Incomplete last session; missing or unverified suspensions: '+','.join(missing[:10]))
    trace = {}
    decisions = []
    def capture(event):
        trace.update(event)
        state = event["state"]
        decisions.append({"t":event["date"],"rebalanced":bool(event["rebalanced"]),
            "reason":"收盘重新计算目标，排队至下一交易日开盘" if event["rebalanced"] else "收盘沿用此前目标，未发出新的调仓指令",
            "targets":[{"symbol":canonical_symbol(s,study.market),"weight":float(w)} for s,w in state["target"].items() if w>0]})
    result = simulate(study, **{k:v for k,v in config.items() if k!='market'}, trace=capture)
    final = trace['state']
    if final['decision_day'] < START:
        raise ValueError('No complete decision')
    hasher = hashlib.sha256()
    hasher.update(json.dumps({'dates':p.dates,'symbols':p.symbols,'config':config},sort_keys=True).encode())
    for array in (p.opens,p.closes,p.valuation,p.volumes,p.turnover,study.dead):
        hasher.update(np.asarray(array,dtype='<f8').tobytes())
    for name, array in sorted(study.features.items()):
        hasher.update(name.encode());hasher.update(np.asarray(array,dtype='<f8').tobytes())
    hasher.update(json.dumps({k:{str(d):v.tolist() for d,v in days.items()} for k,days in study.selections.items()},sort_keys=True).encode())
    targets = [{'symbol':canonical_symbol(s,study.market),'weight':float(w)} for s,w in final['target'].items() if w>0]
    signal = {'schema_version':1,'strategy_version':VERSION,'strategy_id':strategy_id,
              'market':study.market,'currency':{'CN':'CNY','HK':'HKD','US':'USD'}[study.market],
              'available':True,'signal_date':p.dates[-1],'rebalance_date':p.dates[final['decision_day']],
              'origin':p.dates[0]+':'+hashlib.sha256(json.dumps(p.symbols).encode()).hexdigest(),'data_digest':hasher.hexdigest(),'targets':targets,
              'cash_weight':1-sum(t['weight'] for t in targets),
              'liquidity_caps':{canonical_symbol(s,study.market):max(0,float(v)*.01) if np.isfinite(v) else 0 for s,v in zip(p.symbols,p.turnover[-1])},
              **{k:session[k] for k in ('data_asof','execute_after','expires_at')}}
    stamps = [datetime.fromisoformat(signal[k].replace('Z','+00:00')) for k in ('data_asof','execute_after','expires_at')]
    if any(s.tzinfo is None for s in stamps) or not stamps[0]<stamps[1]<stamps[2]:
        raise ValueError('Explicit timezone-aware close/next-session calendar required')
    return {'dates':p.dates[START:],'signal':signal,'backtest':{**result,'decisions':decisions},'state':final,'config':config,
            'note':'Adjusted-price fractional research; paper uses raw prices, lots and actual fills. Risk policy follows the replay model equity.'}


class Publisher:
    def __init__(self, url):
        self.url = url.rstrip('/')
        parsed=urllib.parse.urlsplit(self.url)
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or not parsed.hostname:
            raise ValueError('A plain website origin without credentials/path is required')
        if parsed.scheme!='https' and not (parsed.scheme=='http' and parsed.hostname in ('localhost','127.0.0.1','::1')):
            raise ValueError('HTTPS required')
        # Do not forward credentials to redirected hosts.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        self.client = urllib.request.build_opener(NoRedirect(),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.post('auth/login',{'username':os.environ['QUANT_USERNAME'],'password':os.environ['QUANT_PASSWORD']})

    def get(self, path):
        with self.client.open(self.url+'/api/v1/'+path,timeout=30) as response:
            return json.load(response)

    def post(self, path, body):
        request=urllib.request.Request(self.url+'/api/v1/'+path,data=json.dumps(body,allow_nan=False).encode(),
            headers={'Content-Type':'application/json','Origin':self.url,'X-Quant-Action':'1'},method='POST')
        with self.client.open(request,timeout=30) as response:
            result=json.load(response)
        if not result.get('ok'): raise RuntimeError('Publication failed')
        return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list',action='store_true')
    parser.add_argument('--strategy-id')
    parser.add_argument('--session',type=Path,help='Verified market calendar JSON, not a weekday guess')
    parser.add_argument('--output',type=Path,default=ROOT/'reports/portfolio/latest.json')
    parser.add_argument('--publish',help='Website origin. Credentials from QUANT_USERNAME/QUANT_PASSWORD')
    args=parser.parse_args()
    if args.list:
        print(json.dumps(catalog(),ensure_ascii=False,indent=2));return
    if args.strategy_id not in catalog() or not args.session: parser.error('--strategy-id and --session required')
    session=json.loads(args.session.read_text())
    market=catalog()[args.strategy_id]['market']
    study=prepare(market, end_date=session['signal_date'])
    if catalog()[args.strategy_id]['selection'] in CN_NAMES: china_selection(study)
    result=produce(study,args.strategy_id,session)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf8')
    if args.publish:
        publisher=Publisher(args.publish)
        try: publisher.post('portfolio/signals',result['signal'])
        finally: publisher.post('auth/logout',{})
    print('Saved replay and signal:',args.output)

if __name__=='__main__':main()
