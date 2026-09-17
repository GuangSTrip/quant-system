"""Read-only HK paper bridge. No order mutation or real-account routes exist."""
import hmac
import json
import os
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs


class FutuPaperReader:
    def __init__(self, sdk, trade, quote, account_id):
        self.sdk, self.trade, self.quote = sdk, trade, quote
        self.account_id = int(account_id)
        self.lock = threading.Lock()

    @staticmethod
    def rows(result):
        ret, data = result
        if ret != 0:
            raise RuntimeError('FUTU_REQUEST_FAILED')
        return json.loads(data.to_json(orient='records'))

    def overview(self, symbol):
        if not re.fullmatch(r'HK\.\d{5}', symbol) or symbol == 'HK.00000':
            raise ValueError('INVALID_HK_SYMBOL')
        with self.lock:
            accounts = self.rows(self.trade.get_acc_list())
            valid = [a for a in accounts if int(a['acc_id']) == self.account_id
                     and a.get('trd_env') == 'SIMULATE'
                     and a.get('sim_acc_type') == 'STOCK'
                     and 'HK' in a.get('trdmarket_auth', [])]
            if len(valid) != 1:
                raise RuntimeError('HK_PAPER_ACCOUNT_REQUIRED')
            args = dict(trd_env=self.sdk.TrdEnv.SIMULATE, acc_id=self.account_id)
            result = dict(ok=True, market='HK', environment='SIMULATE', source='Futu OpenAPI',
                          execution_enabled=False, symbol=symbol,
                          fetched_at=datetime.now(timezone.utc).isoformat(), errors={})
            queries = {
                'account': lambda: self.trade.accinfo_query(currency=self.sdk.Currency.HKD, **args),
                'positions': lambda: self.trade.position_list_query(**args),
                'orders': lambda: self.trade.order_list_query(**args),
                'quote': lambda: self.quote.get_market_snapshot([symbol]),
            }
            fields = {
                'account': ['total_assets', 'cash', 'market_val', 'avl_withdrawal_cash'],
                'positions': ['code', 'stock_name', 'qty', 'can_sell_qty', 'cost_price', 'market_val', 'pl_val'],
                'orders': ['order_id', 'code', 'trd_side', 'order_status', 'qty', 'price', 'dealt_qty', 'dealt_avg_price', 'create_time'],
                'quote': ['code', 'name', 'last_price', 'update_time', 'lot_size', 'suspension', 'bid_price', 'ask_price'],
            }
            for name, query in queries.items():
                try:
                    rows = self.rows(query())
                    if name in ('account', 'quote') and not rows:
                        raise RuntimeError('EMPTY_RESPONSE')
                    result[name] = [{k: row.get(k) for k in fields[name]} for row in rows]
                except Exception:
                    result[name] = None
                    result['errors'][name] = '查询失败，请检查 OpenD、行情权限及接口限频'
                    result['ok'] = False
            result['currency'] = 'HKD'
            result['quote_timezone'] = 'Asia/Hong_Kong'
            return result


def handler(reader, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Never log authentication headers or broker responses.

        def reply(self, status, data):
            raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer '+token).encode()):
                return self.reply(401, {'ok': False, 'code': 'UNAUTHORIZED'})
            url = urlparse(self.path)
            if url.path != '/v1/hk/overview':
                return self.reply(404, {'ok': False, 'code': 'NOT_FOUND'})
            try:
                self.reply(200, reader.overview(parse_qs(url.query).get('symbol', ['HK.00700'])[0]))
            except ValueError:
                self.reply(400, {'ok': False, 'code': 'INVALID_HK_SYMBOL'})
            except Exception:
                self.reply(503, {'ok': False, 'code': 'HK_PAPER_UNAVAILABLE'})

        def do_POST(self):
            self.reply(405, {'ok': False, 'code': 'READ_ONLY'})
    return Handler


def main():
    token = os.environ.get('FUTU_BRIDGE_TOKEN', '')
    if len(token) < 32:
        raise SystemExit('FUTU_BRIDGE_TOKEN must contain at least 32 characters')
    account_id = int(os.environ['FUTU_HK_PAPER_ACC_ID'])
    import futu
    trade = futu.OpenSecTradeContext(filter_trdmarket=futu.TrdMarket.HK, host='127.0.0.1', port=11111,
                                    security_firm=futu.SecurityFirm.FUTUSECURITIES)
    quote = futu.OpenQuoteContext(host='127.0.0.1', port=11111)
    server = HTTPServer(('127.0.0.1', int(os.environ.get('FUTU_BRIDGE_PORT', '8788'))),
                        handler(FutuPaperReader(futu, trade, quote, account_id), token))
    try:
        server.serve_forever()
    finally:
        server.server_close()
        trade.close()
        quote.close()


if __name__ == '__main__':
    main()
