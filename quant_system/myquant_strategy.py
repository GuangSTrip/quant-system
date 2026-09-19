"""Local HTTP bridge pinned to MyQuant's official paper service.

No MODE_LIVE terminal connection: gmtrade is loaded only by main(), and its
endpoint cannot be set from environment or web input. SDK calls run serially
on the main thread; status is reconciled by polling complete daily orders.
"""
from __future__ import annotations
import os
import time
from .myquant_bridge import bridge_from_environment, json_value

PAPER_ENDPOINT = 'api.myquant.cn:9000'


class PaperService:
    def __init__(self, sdk, token, account_id):
        self.sdk, self.account_id = sdk, account_id
        self.paper_environment_verified = False
        sdk.set_endpoint(PAPER_ENDPOINT)
        sdk.set_token(token)
        result = sdk.login(sdk.account(account_id=account_id, account_alias='quant-paper'))
        if result not in (None, 0):
            raise RuntimeError('仿真账户登录失败')
        self.paper_environment_verified = True
        self.name = '掘金官方仿真服务'
        self.status = {'environment': 'paper', 'endpoint': PAPER_ENDPOINT}

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
        rows = self._rows(self.sdk.get_cash())
        if len(rows) != 1:
            raise RuntimeError('指定仿真账户资金无法确认')
        return rows[0]

    def positions(self):
        return self._rows(self.sdk.get_positions())

    def get_unfinished_orders(self):
        return self._rows(self.sdk.get_unfinished_orders())

    def get_orders(self):
        return self._rows(self.sdk.get_orders())

    def get_execution_reports(self):
        return self._rows(self.sdk.get_execution_reports())

    def order_volume(self, **kwargs):
        if kwargs.get('account') != self.account_id:
            raise RuntimeError('订单账户不匹配')
        return self._rows(self.sdk.order_volume(**kwargs))

    def order_cancel(self, order):
        if order.get('account_id') != self.account_id:
            raise RuntimeError('撤单账户不匹配')
        return self.sdk.order_cancel(order)


def main():
    from gmtrade import api
    service = PaperService(api, os.environ['MYQUANT_SIM_TOKEN'], os.environ['MYQUANT_SIM_ACCOUNT_ID'])
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
