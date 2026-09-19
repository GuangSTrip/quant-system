import importlib.util
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

_BRIDGE_PATH = Path(__file__).parents[1] / "quant_system" / "myquant_bridge.py"
_SPEC = importlib.util.spec_from_file_location("quant_system_myquant_bridge_test", _BRIDGE_PATH)
assert _SPEC and _SPEC.loader
_BRIDGE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _BRIDGE
_SPEC.loader.exec_module(_BRIDGE)
AshareOrder = _BRIDGE.AshareOrder
BridgeError = _BRIDGE.BridgeError
BridgeStore = _BRIDGE.BridgeStore
MyQuantBridge = _BRIDGE.MyQuantBridge
_Command = _BRIDGE._Command
native_status = _BRIDGE.native_status


class FakeAccount:
    id = "account-1"
    name = "A股仿真"
    cash = {"available": 10_000.0, "nav": 10_000.0}
    status = {"state": "connected"}

    def __init__(self, positions=None):
        self._positions = positions or []

    def positions(self):
        return self._positions


class FakeContext:
    def __init__(self, account):
        self._account = account

    def account(self, account_id):
        return self._account if account_id == self._account.id else None


class FakeGM:
    OrderSide_Buy = 1
    OrderSide_Sell = 2
    PositionEffect_Open = 1
    PositionEffect_Close = 2
    OrderType_Limit = 1
    OrderType_Market = 2

    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    def get_unfinished_orders(self):
        return []

    def get_execution_reports(self):
        return []

    def order_volume(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("network loss after send")
        return [{"cl_ord_id": "native-1", "order_id": "order-1", "status": 1, "symbol": kwargs["symbol"]}]

    def order_cancel(self, _order):
        return None


class MyQuantBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = BridgeStore(str(Path(self.tmp.name) / "state.sqlite"))
        self.account = FakeAccount()
        self.context = FakeContext(self.account)
        self.gm = FakeGM()
        self.bridge = MyQuantBridge(self.store, self.gm, "account-1", "bridge-secret")
        self.bridge.bind_context(self.context)
        self.bridge.start(self.context, start_server=False)
        self.store.set_halted(False, "test", "tester")

    def tearDown(self):
        self.bridge.stop()
        self.store.close()
        self.tmp.cleanup()

    def order(self, **changes):
        raw = {"client_id": "cn-order-0001", "symbol": "SHSE.600000", "side": "buy", "type": "limit", "quantity": 100, "limit_price": 10.0}
        raw.update(changes)
        return raw

    def test_preview_enforces_cn_symbol_lot_and_cash(self):
        preview = self.bridge.preview(self.order(), "tester")
        self.assertEqual(preview["estimated_notional"], 1000.0)
        with self.assertRaisesRegex(BridgeError, "整手"):
            self.bridge.preview(self.order(quantity=101), "tester")
        with self.assertRaisesRegex(BridgeError, "资金"):
            self.bridge.preview(self.order(quantity=2000), "tester")
        with self.assertRaisesRegex(BridgeError, "代码"):
            self.bridge.preview(self.order(symbol="600000.SH"), "tester")
        with self.assertRaisesRegex(BridgeError, "仅支持限价单"):
            self.bridge.preview(self.order(type="market", limit_price=None), "tester")

    def test_native_status_normalizes_sdk_spelling_variants(self):
        self.assertEqual(native_status("OrderStatus_Cancelled"), "canceled")
        self.assertEqual(native_status("OrderStatus_Partially_Filled"), "partially_filled")

    def test_intent_is_idempotent_and_conflicts_are_blocked(self):
        first, created = self.store.intent(AshareOrder.from_payload(self.order()), "tester")
        again, reused = self.store.intent(AshareOrder.from_payload(self.order()), "tester")
        self.assertTrue(created)
        self.assertFalse(reused)
        self.assertEqual(first["client_id"], again["client_id"])
        with self.assertRaisesRegex(BridgeError, "幂等键"):
            self.store.intent(AshareOrder.from_payload(self.order(quantity=200)), "tester")

    def test_strategy_thread_places_only_queued_intent_and_records_native_receipt(self):
        order = AshareOrder.from_payload(self.order())
        self.store.intent(order, "tester")
        command = _Command("submit", {"order": order.__dict__}, "tester", threading.Event())
        self.bridge._commands.put(command)
        self.bridge.process(self.context)
        self.assertTrue(command.done.is_set())
        self.assertIsNone(command.error)
        saved = self.store.order(order.client_id)
        self.assertEqual(saved["status"], "new")
        self.assertEqual(saved["native_client_id"], "native-1")
        self.assertEqual(len(self.gm.calls), 1)
        self.assertEqual(self.gm.calls[0]["volume"], 100)

    def test_uncertain_submit_halts_bridge(self):
        self.bridge.gm = FakeGM(fail=True)
        order = AshareOrder.from_payload(self.order())
        self.store.intent(order, "tester")
        command = _Command("submit", {"order": order.__dict__}, "tester", threading.Event())
        self.bridge._commands.put(command)
        self.bridge.process(self.context)
        self.assertIsNotNone(command.error)
        self.assertEqual(self.store.order(order.client_id)["status"], "unknown")
        self.assertTrue(self.store.control()["halted"])

    def test_odd_lot_sell_is_only_allowed_for_full_available_position(self):
        self.account._positions = [{"symbol": "SZSE.000001", "available_now": 101}]
        self.bridge.refresh(self.context)
        self.bridge.preview(self.order(client_id="cn-order-0002", symbol="SZSE.000001", side="sell", quantity=101), "tester")
        with self.assertRaisesRegex(BridgeError, "整手"):
            self.bridge.preview(self.order(client_id="cn-order-0003", symbol="SZSE.000001", side="sell", quantity=1), "tester")

    def test_restart_never_replays_a_persisted_queued_intent(self):
        self.store.intent(AshareOrder.from_payload(self.order()), "tester")
        restarted = MyQuantBridge(self.store, self.gm, "account-1", "bridge-secret")
        restarted.bind_context(self.context)
        restarted.start(self.context, start_server=False)
        saved = self.store.order("cn-order-0001")
        self.assertEqual(saved["status"], "unknown")
        self.assertTrue(self.store.control()["halted"])
        self.assertEqual(self.gm.calls, [])

    def test_http_status_is_authenticated_and_exposes_no_token(self):
        self.bridge.start(self.context, host="127.0.0.1", port=0)
        address = f"http://127.0.0.1:{self.bridge._server.server_port}/v1/status"
        with self.assertRaises(HTTPError) as rejected:
            urlopen(address)
        self.assertEqual(rejected.exception.code, 401)
        request = Request(address, headers={"X-MyQuant-Bridge-Secret": "bridge-secret"})
        with urlopen(request) as response:
            body = response.read().decode("utf-8")
        self.assertIn('"connected":true', body)
        self.assertNotIn("account-1", body)
        self.assertNotIn("MYQUANT_SIM_TOKEN", body)


if __name__ == "__main__":
    unittest.main()
