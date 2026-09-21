"""Paper bridge using official service or explicitly confirmed local terminal.

Both SDK endpoints are fixed constants, never arbitrary environment/web URLs.
Terminal mode requires an exact operator-confirmed paper account binding.
"""
from __future__ import annotations
import os
import time
from .myquant_bridge import bridge_from_environment, json_value

PAPER_ENDPOINT = 'api.myquant.cn:9000'
TERMINAL_ENDPOINT = '127.0.0.1:7001'


class PaperService:
    endpoint = PAPER_ENDPOINT
    service_name = '掘金官方仿真服务'
    verification = 'official-paper-endpoint'

    def __init__(self, sdk, token, account_id):
        self.sdk, self.account_id = sdk, account_id
        self.paper_environment_verified = False
        sdk.set_token(token)
        sdk.set_endpoint(self.endpoint)
        result = sdk.login(sdk.account(account_id=account_id, account_alias='quant-paper'))
        if result not in (None, 0):
            raise RuntimeError('仿真账户登录失败')
        self.name = self.service_name
        self.status = {'environment': 'paper', 'endpoint': self.endpoint, 'verification': self.verification}
        # gmtrade 3.0.6 returns None on BOTH login success and failure.
        # Require actual cash for this exact account before declaring it ready.
        self.cash
        self.paper_environment_verified = True

    def __getattr__(self, name):
        if name.startswith(('OrderSide_', 'OrderType_', 'PositionEffect_')):
            return getattr(self.sdk, name)
        raise AttributeError(name)

    def _rows(self, value):
        # gmtrade may return a list of objects or a DataFrame.
        if hasattr(value, 'to_dict') and hasattr(value, 'columns'):
            value = value.to_dict('records')
        else:
            value = json_value(value)
        rows = value if isinstance(value, list) else [value] if isinstance(value, dict) else None
        if rows is None:
            raise RuntimeError('仿真服务返回无效数据')
        if any(not isinstance(r, dict) for r in rows):
            raise RuntimeError('仿真服务返回无效记录')
        return [r for r in rows if str(r.get('account_id', '')) == self.account_id]

    def account(self, account_id):
        return self if account_id == self.account_id else None

    @property
    def cash(self):
        rows = self._rows(self.sdk.get_cash(account=self.account_id))
        if len(rows) != 1:
            raise RuntimeError('指定仿真账户资金无法确认')
        return rows[0]

    def positions(self):
        return self._rows(self.sdk.get_positions(account=self.account_id))

    def get_unfinished_orders(self):
        return self._rows(self.sdk.get_unfinished_orders(account=self.account_id))

    def get_orders(self):
        return self._rows(self.sdk.get_orders(account=self.account_id))

    def get_execution_reports(self):
        return self._rows(self.sdk.get_execution_reports(account=self.account_id))

    def order_volume(self, **kwargs):
        if kwargs.get('account') != self.account_id:
            raise RuntimeError('订单账户不匹配')
        return self._rows(self.sdk.order_volume(**kwargs))

    def order_cancel(self, order):
        if order.get('account_id') != self.account_id:
            raise RuntimeError('撤单账户不匹配')
        return self.sdk.order_cancel(order)


class TerminalPaperService(PaperService):
    endpoint = TERMINAL_ENDPOINT
    service_name = '掘金本机终端 · 已确认仿真账户'
    verification = 'operator-confirmed-paper-account'

    def __init__(self, sdk, token, account_id, confirmed_paper_account_id):
        if not confirmed_paper_account_id or account_id != confirmed_paper_account_id:
            raise RuntimeError('本机终端账户必须与操作员确认的仿真账户完全一致')
        super().__init__(sdk, token, account_id)


def main():
    from gmtrade import api
    mode = os.getenv('MYQUANT_CONNECTION_MODE', 'official-paper')
    if mode == 'terminal-paper':
        service = TerminalPaperService(api, os.environ['MYQUANT_SIM_TOKEN'], os.environ['MYQUANT_SIM_ACCOUNT_ID'],
                                       os.getenv('MYQUANT_TERMINAL_PAPER_ACCOUNT_ID', ''))
    elif mode == 'official-paper':
        service = PaperService(api, os.environ['MYQUANT_SIM_TOKEN'], os.environ['MYQUANT_SIM_ACCOUNT_ID'])
    else:
        raise RuntimeError('不支持的掘金连接模式')
    bridge = bridge_from_environment(service)
    bridge.bind_context(service)
    try:
        bridge.start(service)  # loopback only; no environment override
        while True:
            bridge.process(service)
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        bridge.stop()
        bridge.store.close()


if __name__ == '__main__':
    main()
