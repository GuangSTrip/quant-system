"""Load local-only secrets and run the official paper bridge without echoing them."""
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
os.chdir(root / 'web_platform' / '.lan')

def read_values(path):
    values = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[key.strip()] = value
    return values

private = read_values(root / 'web_platform' / '.env.myquant-local')
site = read_values(root / 'web_platform' / '.dev.vars')
for name in ('MYQUANT_SIM_TOKEN', 'MYQUANT_SIM_ACCOUNT_ID'):
    if not private.get(name):
        raise SystemExit('Missing local configuration: ' + name)
    os.environ[name] = private[name]
if not site.get('MYQUANT_BRIDGE_SECRET'):
    raise SystemExit('Missing bridge secret')
os.environ['MYQUANT_BRIDGE_SECRET'] = site['MYQUANT_BRIDGE_SECRET']
os.environ['MYQUANT_BRIDGE_STATE_PATH'] = str(root / 'web_platform' / '.lan' / 'myquant-state.sqlite')
os.environ['MYQUANT_BRIDGE_MAX_ORDER_NOTIONAL'] = '10000'
os.environ['MYQUANT_CONNECTION_MODE'] = private.get('MYQUANT_CONNECTION_MODE', 'official-paper')
os.environ['MYQUANT_TERMINAL_PAPER_ACCOUNT_ID'] = private.get('MYQUANT_TERMINAL_PAPER_ACCOUNT_ID', '')

if __name__ == '__main__':
    from quant_system.myquant_strategy import main
    # SDK output may include identifiers: keep raw diagnostics in the private .lan directory.
    main()
