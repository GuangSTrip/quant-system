"""Exercise the local daily page through Chrome DevTools, using existing Chrome."""
import base64,json,time
from pathlib import Path
import requests,websocket
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'reports'/'modular_daily'/'browser';OUT.mkdir(exist_ok=True,parents=True)
pages=requests.get('http://127.0.0.1:9229/json',timeout=5).json()
ws=websocket.create_connection(next(p['webSocketDebuggerUrl'] for p in pages if p['type']=='page'),origin='http://127.0.0.1:9229',timeout=15)
seq=0;errors=[]
def cdp(method,params=None):
    global seq
    seq+=1;ws.send(json.dumps({'id':seq,'method':method,'params':params or {}}))
    while True:
        r=json.loads(ws.recv())
        if r.get('method')=='Runtime.exceptionThrown':errors.append(r['params'])
        if r.get('id')==seq:
            if 'error' in r:raise RuntimeError(r['error'])
            return r.get('result',{})
def js(expression):
    r=cdp('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True})
    if 'exceptionDetails' in r:raise RuntimeError(r['exceptionDetails'])
    return r.get('result',{}).get('value')
def pause():js('new Promise(r=>setTimeout(r,900))')
def select(key,value):js(f"document.getElementById('dq-{key}').value={json.dumps(value)};document.getElementById('dq-{key}').dispatchEvent(new Event('change'))")
def shot(name):
    raw=cdp('Page.captureScreenshot',{'format':'png','captureBeyondViewport':False})['data']
    (OUT/(name+'.png')).write_bytes(base64.b64decode(raw))
cdp('Runtime.enable');cdp('Page.enable')
cdp('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1100,'deviceScaleFactor':1,'mobile':False})
cdp('Page.navigate',{'url':'http://127.0.0.1:8765/#daily'});pause()
for _ in range(10):
    if js("!!document.querySelector('#dq-chart svg')"):break
    pause()
assert js("!!document.querySelector('#dq-chart svg')"),js('document.body.innerText')
assert js("document.querySelectorAll('#dq-markets button').length")==3
for _ in range(10):
    if js("!!document.querySelector('#dr-chart svg')"):break
    pause()
assert js("!!document.querySelector('#dr-chart svg')")
for market in ['CN','HK','US']:
    js(f"document.querySelector('[data-market={market}]').click()")
    assert js("document.querySelectorAll('#dr-choice option').length")>=9
    assert js("document.querySelectorAll('#dr-metrics tr').length")==4
    js("document.querySelector('#dr-mode').value='drawdown';document.querySelector('#dr-mode').dispatchEvent(new Event('change'))")
    assert js("document.querySelectorAll('#dr-chart svg path').length")>=2
    js("document.querySelector('#dr-choice').selectedIndex=2;document.querySelector('#dr-choice').dispatchEvent(new Event('change'))")
    assert js("!!document.querySelector('#dr-chart svg')")
js("document.querySelector('[data-market=HK]').click();document.querySelector('#dr-mode').value='equity';document.querySelector('#dr-mode').dispatchEvent(new Event('change'));document.querySelector('#dr-heading').scrollIntoView({block:'start'})")
pause();shot('refinement-hong-kong')
js("document.querySelector('#dq-original').open=true")
for market in ['CN','HK','US']:
    js(f"document.querySelector('[data-market={market}]').click()")
    assert js("document.querySelectorAll('#dq-selection option').length")==4
    assert js("document.querySelectorAll('#dq-timing option').length")==3
    assert js("document.querySelectorAll('#dq-allocation option').length")==4
    assert js("document.querySelectorAll('#dq-chart svg path').length")>=2
    for mode in ['equity','drawdown','exposure']:select('mode',mode);assert js("!!document.querySelector('#dq-chart svg')")
js("document.querySelector('[data-market=HK]').click()")
select('mode','equity');select('period','review')
js("document.querySelector('#dq-title').scrollIntoView({block:'start'})");pause();shot('hong-kong-curves')
select('selection','low_vol');select('timing','trend');select('allocation','vol08')
assert '低波动' in js("document.querySelector('#dq-title').textContent")
js("document.querySelector('#dq-help-allocation').focus()")
assert js("getComputedStyle(document.querySelector('#dq-tip-allocation')).display")=='block'
js("document.activeElement.blur();document.querySelector('#dq-reset').click();window.scrollTo(0,0)");pause();shot('desktop-overview')
cdp('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True});pause()
assert js('document.documentElement.scrollWidth<=window.innerWidth+1'),js('[document.documentElement.scrollWidth,window.innerWidth]')
shot('mobile-overview')
assert not errors,errors
result={'markets':3,'combinations_per_market':48,'dropdowns_and_charts':'passed','tooltips':'passed','mobile_overflow':'none','javascript_exceptions':len(errors)}
(OUT/'verification.json').write_text(json.dumps(result,indent=2),encoding='utf8')
print(json.dumps(result));ws.close()
