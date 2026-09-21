"""Read-only official SDK connection diagnostic; never print credentials."""
import json
import os
import runpy
import socket
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
runpy.run_path(str(root / 'scripts' / 'run_myquant_local.py'), run_name='config_only')
from gmtrade import api
from gmtrade.api import trade

result = {'at': datetime.now(timezone.utc).isoformat(), 'sdk': api.get_version(),
          'endpoint': 'api.myquant.cn:9000', 'orders_submitted': 0}
try:
    with socket.create_connection(('api.myquant.cn', 9000), timeout=8):
        result['tcp_connected'] = True
except OSError:
    result['tcp_connected'] = False
api.set_token(os.environ['MYQUANT_SIM_TOKEN'])
api.set_endpoint('api.myquant.cn:9000')
# login() suppresses the native return code in SDK 3.0.6, so record that code directly.
code = trade.py_gmi_login(os.environ['MYQUANT_SIM_ACCOUNT_ID'])
result['login_code'] = code
result['login_ok'] = code == 0
result['error_description'] = {0:'成功',1000:'Token 错误或无效',1010:'无法获取掘金服务器地址列表',1020:'账户 ID 无效'}.get(code,'其他 SDK 错误')
path = root / 'web_platform' / '.lan' / 'myquant-connection-check.json'
path.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
