"""Read-only gmtrade terminal check. Does not enable or submit trades."""
import json
import os
import runpy
import argparse
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
runpy.run_path(str(root / 'scripts/run_myquant_local.py'), run_name='config_only')
from gmtrade import api
from gmtrade.api import trade
from quant_system.myquant_bridge import json_value

parser = argparse.ArgumentParser()
parser.add_argument('--endpoint', choices=['', '127.0.0.1:7001', 'localhost:7001'], default='')
args = parser.parse_args()
result = {'at': datetime.now(timezone.utc).isoformat(), 'mode': 'local-terminal', 'endpoint': args.endpoint or '(SDK default)', 'orders_submitted': 0}
api.set_token(os.environ['MYQUANT_SIM_TOKEN'])
api.set_endpoint(args.endpoint)  # Terminal default or explicit loopback only.
code = trade.py_gmi_login(os.environ['MYQUANT_SIM_ACCOUNT_ID'])
result['login_code'] = code
if code == 0:
    cash = json_value(api.get_cash(account=os.environ['MYQUANT_SIM_ACCOUNT_ID']))
    result['account_matches'] = isinstance(cash, dict) and cash.get('account_id') == os.environ['MYQUANT_SIM_ACCOUNT_ID']
    result['cash_readable'] = isinstance(cash, dict) and 'available' in cash
    positions = api.get_positions(account=os.environ['MYQUANT_SIM_ACCOUNT_ID'])
    result['positions_count'] = len(positions) if isinstance(positions, list) else None
else:
    result['cash_readable'] = False
path = root / 'web_platform/.lan/myquant-terminal-check.json'
path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
