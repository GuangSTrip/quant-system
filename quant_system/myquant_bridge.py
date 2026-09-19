"""Safe local bridge between a MyQuant ``gm`` strategy and the web platform.

The MyQuant SDK is a strategy runtime, not an HTTP service.  This module keeps
that boundary explicit: the SDK is called only from the strategy callback
thread, while a small authenticated HTTP server queues commands for that
thread.  Tokens are read by ``myquant_strategy`` from the local environment and
are never accepted by this server or returned in responses.
"""

from __future__ import annotations

import hmac
import json
import os
import queue
import re
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple


CN_SYMBOL = re.compile(r"^(?:SHSE|SZSE)\.\d{6}$")
CLIENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,96}$")
TERMINAL = {"filled", "canceled", "expired", "rejected", "done_for_day", "replaced"}
UNKNOWN = {"unknown", "submitting"}
SENSITIVE_FIELDS = {"account_id", "accountid", "token", "access_token", "refresh_token", "password"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_value(value: Any) -> Any:
    """Convert SDK/protobuf objects to JSON-safe values without introspection leaks."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, Mapping):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_value(item) for item in value]
    if hasattr(value, "items"):
        try:
            return {str(key): json_value(item) for key, item in value.items()}
        except (TypeError, ValueError):
            pass
    if hasattr(value, "__dict__"):
        return {
            str(key): json_value(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    return str(value)


def redact(value: Any) -> Any:
    """Remove credentials and account identifiers before an HTTP response/audit."""
    if isinstance(value, Mapping):
        return {
            str(key): redact(item)
            for key, item in value.items()
            if str(key).lower() not in SENSITIVE_FIELDS
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


class BridgeError(RuntimeError):
    def __init__(self, message: str, status: int = 400, code: str = "BRIDGE_ERROR") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class AshareOrder:
    client_id: str
    symbol: str
    side: str
    order_type: str
    quantity: int
    limit_price: Optional[float]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "AshareOrder":
        client_id = str(payload.get("client_id", "")).strip()
        symbol = str(payload.get("symbol", "")).strip().upper()
        side = str(payload.get("side", "")).strip().lower()
        order_type = str(payload.get("type", "limit")).strip().lower()
        raw_quantity = payload.get("quantity", payload.get("qty"))
        if isinstance(raw_quantity, bool):
            raw_quantity = None
        try:
            quantity = int(raw_quantity)
        except (TypeError, ValueError):
            raise BridgeError("数量必须是正整数", 422, "INVALID_QUANTITY")
        if str(raw_quantity).strip() != str(quantity):
            raise BridgeError("数量必须是正整数，不能使用小数股", 422, "INVALID_QUANTITY")
        if not CLIENT_ID.fullmatch(client_id):
            raise BridgeError("缺少有效的订单幂等键", 422, "INVALID_CLIENT_ID")
        if not CN_SYMBOL.fullmatch(symbol):
            raise BridgeError("A股代码需使用 SHSE.600000 或 SZSE.000001 格式", 422, "INVALID_SYMBOL")
        if side not in {"buy", "sell"}:
            raise BridgeError("买卖方向必须是 buy 或 sell", 422, "INVALID_SIDE")
        # Do not approximate a market order with a stale web quote.  The first
        # release deliberately accepts only priced, limit orders, so its cash
        # and per-order-notional checks are deterministic at submit time.
        if order_type != "limit":
            raise BridgeError("当前桥接仅支持限价单；市价单将在接入实时行情预检后开放", 422, "LIMIT_ONLY")
        if quantity <= 0 or quantity > 1_000_000:
            raise BridgeError("委托数量超出允许范围", 422, "INVALID_QUANTITY")
        raw_price = payload.get("limit_price", payload.get("price"))
        limit_price: Optional[float] = None
        if order_type == "limit":
            try:
                limit_price = float(raw_price)
            except (TypeError, ValueError):
                raise BridgeError("限价单必须填写正的委托价格", 422, "INVALID_PRICE")
            if not limit_price or limit_price <= 0 or limit_price > 1_000_000:
                raise BridgeError("限价必须是正数", 422, "INVALID_PRICE")
        return cls(client_id, symbol, side, order_type, quantity, limit_price)

    @property
    def estimated_notional(self) -> Optional[float]:
        return None if self.limit_price is None else self.quantity * self.limit_price


class BridgeStore:
    """Persistent local intent/order/audit state.  It contains no MyQuant token."""

    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._db:
            self._db.executescript(
                """
                CREATE TABLE IF NOT EXISTS bridge_control (
                  id INTEGER PRIMARY KEY CHECK(id=1), halted INTEGER NOT NULL,
                  reason TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
                );
                INSERT OR IGNORE INTO bridge_control(id,halted,reason,revision,updated_at)
                  VALUES(1,1,'首次启用前请完成对账并恢复',0,'');
                CREATE TABLE IF NOT EXISTS bridge_orders (
                  client_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
                  status TEXT NOT NULL, native_client_id TEXT, native_order_id TEXT,
                  broker_json TEXT, error TEXT, actor TEXT NOT NULL,
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_bridge_orders_status ON bridge_orders(status);
                CREATE TABLE IF NOT EXISTS bridge_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                  actor TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT, details TEXT NOT NULL
                );
                """
            )

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _one(self, sql: str, *values: Any) -> Optional[sqlite3.Row]:
        return self._db.execute(sql, values).fetchone()

    def audit(self, actor: str, kind: str, subject: Optional[str], details: Mapping[str, Any]) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO bridge_events(timestamp,actor,kind,subject,details) VALUES(?,?,?,?,?)",
                (utc_now(), actor[:120] or "bridge", kind, subject, json.dumps(json_value(details), ensure_ascii=False, sort_keys=True)),
            )

    def control(self) -> Dict[str, Any]:
        with self._lock:
            row = self._one("SELECT * FROM bridge_control WHERE id=1")
            assert row is not None
            return {"halted": bool(row["halted"]), "reason": row["reason"], "revision": row["revision"], "updated_at": row["updated_at"]}

    def set_halted(self, halted: bool, reason: str, actor: str) -> Dict[str, Any]:
        with self._lock, self._db:
            now = utc_now()
            self._db.execute(
                "UPDATE bridge_control SET halted=?,reason=?,revision=revision+1,updated_at=? WHERE id=1",
                (int(halted), reason[:300], now),
            )
            self.audit(actor, "halt" if halted else "resume", None, {"reason": reason})
        return self.control()

    def intent(self, order: AshareOrder, actor: str) -> Tuple[Dict[str, Any], bool]:
        payload = json.dumps(asdict(order), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        request_hash = payload
        with self._lock, self._db:
            existing = self._one("SELECT * FROM bridge_orders WHERE client_id=?", order.client_id)
            if existing:
                if existing["request_hash"] != request_hash:
                    raise BridgeError("同一幂等键不能用于不同委托", 409, "IDEMPOTENCY_CONFLICT")
                return self.order(order.client_id), False
            now = utc_now()
            self._db.execute(
                "INSERT INTO bridge_orders(client_id,request_json,request_hash,status,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (order.client_id, payload, request_hash, "queued", actor[:120] or "operator", now, now),
            )
            self.audit(actor, "order_intent", order.client_id, {"order": asdict(order)})
        return self.order(order.client_id), True

    def order(self, client_id: str) -> Dict[str, Any]:
        with self._lock:
            row = self._one("SELECT * FROM bridge_orders WHERE client_id=?", client_id)
            if not row:
                raise BridgeError("未找到此平台订单", 404, "ORDER_NOT_FOUND")
            result = dict(row)
            result["request"] = json.loads(result.pop("request_json"))
            result.pop("request_hash", None)
            result["broker"] = json.loads(result.pop("broker_json")) if result.get("broker_json") else None
            result.pop("broker_json", None)
            return result

    def orders(self, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT client_id FROM bridge_orders ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 300)),)).fetchall()
        return [self.order(row["client_id"]) for row in rows]

    def update_order(
        self,
        client_id: str,
        status: str,
        actor: str,
        broker: Optional[Mapping[str, Any]] = None,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        safe_broker = redact(json_value(broker)) if broker is not None else None
        native_client = str(safe_broker.get("cl_ord_id") or safe_broker.get("client_order_id") or "") if isinstance(safe_broker, Mapping) else ""
        native_order = str(safe_broker.get("order_id") or safe_broker.get("id") or "") if isinstance(safe_broker, Mapping) else ""
        with self._lock, self._db:
            self._db.execute(
                "UPDATE bridge_orders SET status=?,native_client_id=COALESCE(NULLIF(?,''),native_client_id),native_order_id=COALESCE(NULLIF(?,''),native_order_id),broker_json=COALESCE(?,broker_json),error=?,updated_at=? WHERE client_id=?",
                (status, native_client, native_order, json.dumps(safe_broker, ensure_ascii=False, sort_keys=True) if safe_broker is not None else None, error, utc_now(), client_id),
            )
            self.audit(actor, "order_" + status, client_id, {"error": error, "broker": safe_broker})
        return self.order(client_id)

    def by_native_client(self, native_client_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._one("SELECT client_id FROM bridge_orders WHERE native_client_id=?", native_client_id)
        return self.order(row["client_id"]) if row else None

    def unresolved(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT client_id FROM bridge_orders WHERE status IN ('queued','submitting','unknown','pending_cancel') ORDER BY created_at").fetchall()
        return [self.order(row["client_id"]) for row in rows]

    def recover_queued_intents(self) -> List[Dict[str, Any]]:
        """Make pre-restart queued intents explicit rather than replaying them.

        A process restart can happen after the web request is persisted but
        before the strategy callback reaches the broker.  Replaying that intent
        automatically could duplicate an order whose broker result is unknown.
        Mark it unknown, halt, and require an operator reconciliation instead.
        """
        with self._lock:
            rows = self._db.execute(
                "SELECT client_id FROM bridge_orders WHERE status='queued' ORDER BY created_at"
            ).fetchall()
        recovered = []
        for row in rows:
            recovered.append(
                self.update_order(
                    row["client_id"],
                    "unknown",
                    "bridge",
                    error="策略桥接重启前的本地委托未获回执；不会自动重发，请对账确认",
                )
            )
        return recovered

    def events(self, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM bridge_events ORDER BY id DESC LIMIT ?", (max(1, min(limit, 300)),)).fetchall()
        return [{**dict(row), "details": json.loads(row["details"])} for row in rows]


def native_status(value: Any) -> str:
    text = str(value or "new").strip().lower()
    if text.isdigit():
        return {
            "1": "new", "2": "partially_filled", "3": "filled", "4": "done_for_day",
            "5": "canceled", "6": "pending_cancel", "8": "rejected", "9": "suspended",
            "10": "pending_new", "12": "expired", "15": "filled", "18": "new",
        }.get(text, "unknown")
    text = text.replace(" ", "_").replace("-", "_")
    aliases = {
        "cancelled": "canceled",
        "partiallyfilled": "partially_filled",
        "partial_filled": "partially_filled",
        "orderstatus_new": "new",
        "order_status_new": "new",
        "orderstatus_partially_filled": "partially_filled",
        "order_status_partially_filled": "partially_filled",
        "orderstatus_filled": "filled",
        "order_status_filled": "filled",
        "orderstatus_canceled": "canceled",
        "order_status_canceled": "canceled",
        "orderstatus_cancelled": "canceled",
        "order_status_cancelled": "canceled",
        "orderstatus_rejected": "rejected",
        "order_status_rejected": "rejected",
        "orderstatus_expired": "expired",
        "order_status_expired": "expired",
    }
    return aliases.get(text, text)


@dataclass
class _Command:
    kind: str
    payload: Dict[str, Any]
    actor: str
    done: threading.Event
    result: Optional[Dict[str, Any]] = None
    error: Optional[BridgeError] = None


class MyQuantBridge:
    """Owns state, HTTP access and the command queue for one simulated account."""

    def __init__(
        self,
        store: BridgeStore,
        gm: Any,
        account_id: str,
        secret: str,
        max_order_notional: float = 100_000.0,
        command_timeout: float = 12.0,
    ) -> None:
        if not account_id or not secret:
            raise ValueError("MYQUANT_SIM_ACCOUNT_ID and MYQUANT_BRIDGE_SECRET are required")
        self.store, self.gm, self.account_id, self.secret = store, gm, account_id, secret
        self.max_order_notional = float(max_order_notional)
        self.command_timeout = float(command_timeout)
        self._commands: "queue.Queue[_Command]" = queue.Queue()
        self._state_lock = threading.RLock()
        self._snapshot: Dict[str, Any] = {"connected": False, "account": None, "positions": [], "open_orders": [], "execution_reports": [], "updated_at": None, "last_error": None}
        self._server: Optional[ThreadingHTTPServer] = None
        self._server_thread: Optional[threading.Thread] = None

    def start(self, context: Any, host: str = "127.0.0.1", port: int = 8765, start_server: bool = True) -> None:
        recovered = self.store.recover_queued_intents()
        if recovered:
            self.store.set_halted(True, "检测到重启前未确认委托，请对账", "bridge")
        self.refresh(context)
        if not start_server:
            return
        if self._server:
            return
        handler = self._handler_type()
        self._server = ThreadingHTTPServer((host, port), handler)
        self._server.daemon_threads = True
        self._server_thread = threading.Thread(target=self._server.serve_forever, name="myquant-bridge-http", daemon=True)
        self._server_thread.start()
        self.store.audit("bridge", "bridge_started", None, {"host": host, "port": port, "account_bound": True, "recovered_intents": len(recovered)})

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        self.store.audit("bridge", "bridge_stopped", None, {})

    def _handler_type(self):
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "QuantSystemMyQuantBridge/1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def _write(self, status: int, value: Mapping[str, Any]) -> None:
                body = json.dumps(json_value(value), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self) -> bool:
                supplied = self.headers.get("X-MyQuant-Bridge-Secret", "")
                return bool(supplied) and hmac.compare_digest(supplied, bridge.secret)

            def _body(self) -> Dict[str, Any]:
                length = int(self.headers.get("Content-Length", "0") or 0)
                if length < 1 or length > 20_000:
                    raise BridgeError("请求体大小无效", 413, "BODY_TOO_LARGE")
                try:
                    value = json.loads(self.rfile.read(length).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise BridgeError("JSON 格式错误", 400, "INVALID_JSON")
                if not isinstance(value, dict):
                    raise BridgeError("请求必须是 JSON 对象", 400, "INVALID_BODY")
                return value

            def _actor(self) -> str:
                return self.headers.get("X-MyQuant-Actor", "web-operator")[:120]

            def do_GET(self) -> None:  # noqa: N802
                try:
                    if not self._authorized():
                        raise BridgeError("桥接身份校验失败", 401, "BRIDGE_UNAUTHORIZED")
                    path = self.path.split("?", 1)[0]
                    if path == "/v1/health":
                        data = {"ok": True, "connected": bool(bridge.snapshot().get("connected")), "updated_at": bridge.snapshot().get("updated_at")}
                    elif path == "/v1/status":
                        data = {"ok": True, **bridge.view()}
                    elif path == "/v1/orders":
                        data = {"ok": True, "orders": bridge.store.orders()}
                    elif path == "/v1/audit":
                        data = {"ok": True, "events": bridge.store.events()}
                    else:
                        raise BridgeError("接口不存在", 404, "NOT_FOUND")
                    self._write(200, data)
                except BridgeError as exc:
                    self._write(exc.status, {"ok": False, "error": str(exc), "code": exc.code})

            def do_POST(self) -> None:  # noqa: N802
                try:
                    if not self._authorized():
                        raise BridgeError("桥接身份校验失败", 401, "BRIDGE_UNAUTHORIZED")
                    payload, actor, path = self._body(), self._actor(), self.path.split("?", 1)[0]
                    if path == "/v1/orders/preview":
                        data = {"ok": True, "preview": bridge.preview(payload, actor)}
                    elif path == "/v1/orders":
                        data = {"ok": True, "order": bridge.submit(payload, actor)}
                    elif path == "/v1/orders/cancel":
                        data = {"ok": True, "order": bridge.enqueue("cancel", payload, actor)}
                    elif path == "/v1/reconcile":
                        data = {"ok": True, **bridge.enqueue("reconcile", payload, actor)}
                    elif path == "/v1/control":
                        data = {"ok": True, **bridge.enqueue("control", payload, actor)}
                    else:
                        raise BridgeError("接口不存在", 404, "NOT_FOUND")
                    self._write(200, data)
                except BridgeError as exc:
                    self._write(exc.status, {"ok": False, "error": str(exc), "code": exc.code})

        return Handler

    def snapshot(self) -> Dict[str, Any]:
        with self._state_lock:
            return json_value(self._snapshot)

    def view(self) -> Dict[str, Any]:
        snap = self.snapshot()
        return {
            "bridge": {"connected": snap["connected"], "updated_at": snap["updated_at"], "last_error": snap["last_error"]},
            "control": self.store.control(),
            "account": snap["account"],
            "positions": snap["positions"],
            "open_orders": snap["open_orders"],
            "orders": self.store.orders(),
            "unresolved": len(self.store.unresolved()),
        }

    def refresh(self, context: Any) -> Dict[str, Any]:
        try:
            account = context.account(self.account_id)
            if account is None:
                raise BridgeError("策略未绑定指定掘金仿真账户", 503, "ACCOUNT_NOT_BOUND")
            positions = redact(json_value(account.positions())) or []
            open_orders = redact(json_value(self.gm.get_unfinished_orders())) or []
            reports = redact(json_value(self.gm.get_execution_reports())) or []
            snapshot = {"connected": True, "account": {"name": account.name, "cash": redact(json_value(account.cash)), "status": redact(json_value(account.status))}, "positions": positions, "open_orders": open_orders, "execution_reports": reports, "updated_at": utc_now(), "last_error": None}
            with self._state_lock:
                self._snapshot = snapshot
            self._ingest_native(open_orders, "bridge")
            return snapshot
        except Exception as exc:  # SDK error: preserve previous good state and block new orders.
            with self._state_lock:
                self._snapshot = {**self._snapshot, "connected": False, "last_error": str(exc)[:300], "updated_at": utc_now()}
            raise BridgeError("掘金账户同步失败，新增订单已阻断", 503, "BROKER_UNAVAILABLE") from exc

    def _ingest_native(self, orders: Iterable[Any], actor: str) -> None:
        for value in orders:
            order = json_value(value)
            if not isinstance(order, Mapping):
                continue
            native_client = str(order.get("cl_ord_id") or order.get("client_order_id") or "")
            local = self.store.by_native_client(native_client) if native_client else None
            if local:
                status = native_status(order.get("status"))
                if local["status"] != status or local.get("broker") != order:
                    self.store.update_order(local["client_id"], status, actor, order)

    def _position_available(self, symbol: str) -> int:
        for position in self.snapshot().get("positions") or []:
            if str(position.get("symbol", "")).upper() != symbol:
                continue
            for key in ("available_now", "available", "volume"):
                try:
                    return int(float(position.get(key, 0)))
                except (TypeError, ValueError):
                    continue
        return 0

    def _available_cash(self) -> Optional[float]:
        cash = (self.snapshot().get("account") or {}).get("cash") or {}
        for key in ("available", "available_cash", "nav", "cash"):
            try:
                value = float(cash.get(key))
            except (AttributeError, TypeError, ValueError):
                continue
            if value >= 0:
                return value
        return None

    def preview(self, payload: Mapping[str, Any], _actor: str) -> Dict[str, Any]:
        order = AshareOrder.from_payload(payload)
        control = self.store.control()
        if order.quantity % 100 and not (order.side == "sell" and order.quantity == self._position_available(order.symbol)):
            raise BridgeError("买入必须为 100 股整手；卖出仅允许全部卖出时包含零股", 422, "LOT_SIZE")
        if control["halted"]:
            raise BridgeError("A股模拟盘已暂停，请先对账后恢复", 409, "HALTED")
        if not self.snapshot().get("connected"):
            raise BridgeError("掘金桥接未连接，拒绝创建订单", 503, "BRIDGE_OFFLINE")
        notional = order.estimated_notional
        if notional is not None and notional > self.max_order_notional:
            raise BridgeError("委托金额超过桥接单笔上限", 422, "MAX_ORDER_NOTIONAL")
        if order.side == "buy" and notional is not None:
            available = self._available_cash()
            if available is not None and notional > available:
                raise BridgeError("可用资金不足", 422, "INSUFFICIENT_CASH")
        if order.side == "sell" and order.quantity > self._position_available(order.symbol):
            raise BridgeError("可卖持仓不足（A股当日买入不可卖）", 422, "INSUFFICIENT_POSITION")
        return {"order": asdict(order), "estimated_notional": notional, "expires_at": int(time.time()) + 60, "rules": ["A股整手与可卖数量校验通过", "提交后以掘金仿真回报为准", "网络或进程中断后状态未知会自动暂停"]}

    def submit(self, payload: Mapping[str, Any], actor: str) -> Dict[str, Any]:
        if payload.get("confirm") != "提交A股模拟订单":
            raise BridgeError("请输入“提交A股模拟订单”确认", 422, "CONFIRMATION_REQUIRED")
        order = AshareOrder.from_payload(payload)
        self.preview(payload, actor)
        row, created = self.store.intent(order, actor)
        if not created:
            return row
        command = _Command("submit", {"order": asdict(order)}, actor, threading.Event())
        self._commands.put(command)
        if command.done.wait(self.command_timeout):
            if command.error:
                raise command.error
            return command.result or self.store.order(order.client_id)
        return {**self.store.order(order.client_id), "message": "委托已持久化，正在等待掘金策略线程处理；请刷新查询同一订单，不要重复提交。"}

    def enqueue(self, kind: str, payload: Mapping[str, Any], actor: str) -> Dict[str, Any]:
        command = _Command(kind, dict(payload), actor, threading.Event())
        self._commands.put(command)
        if not command.done.wait(self.command_timeout):
            raise BridgeError("桥接策略线程未在限时内响应，请稍后刷新", 503, "BRIDGE_TIMEOUT")
        if command.error:
            raise command.error
        return command.result or {}

    def process(self, context: Any) -> None:
        try:
            self.refresh(context)
        except BridgeError:
            return
        while True:
            try:
                command = self._commands.get_nowait()
            except queue.Empty:
                return
            try:
                if command.kind == "submit":
                    command.result = self._submit_on_strategy_thread(command.payload["order"], command.actor)
                elif command.kind == "cancel":
                    command.result = self._cancel_on_strategy_thread(command.payload, command.actor)
                elif command.kind == "reconcile":
                    command.result = self._reconcile_on_strategy_thread(command.actor)
                elif command.kind == "control":
                    command.result = self._control_on_strategy_thread(command.payload, command.actor)
                else:
                    raise BridgeError("未知桥接命令", 400, "INVALID_COMMAND")
            except BridgeError as exc:
                command.error = exc
            except Exception as exc:
                command.error = BridgeError("桥接命令执行异常，已暂停新增订单", 503, "BRIDGE_COMMAND_FAILED")
                self.store.set_halted(True, "桥接命令异常，请对账", "bridge")
                self.store.audit("bridge", "command_exception", None, {"kind": command.kind, "error": str(exc)[:300]})
            finally:
                command.done.set()

    def _submit_on_strategy_thread(self, raw: Mapping[str, Any], actor: str) -> Dict[str, Any]:
        order = AshareOrder(**raw)
        self.preview(raw, actor)
        self.store.update_order(order.client_id, "submitting", actor)
        try:
            side = self.gm.OrderSide_Buy if order.side == "buy" else self.gm.OrderSide_Sell
            effect = self.gm.PositionEffect_Open if order.side == "buy" else self.gm.PositionEffect_Close
            native = self.gm.order_volume(symbol=order.symbol, volume=order.quantity, side=side, order_type=self.gm.OrderType_Limit, position_effect=effect, price=order.limit_price, account=self.account_id)
            values = json_value(native)
            result = values[0] if isinstance(values, list) and values else (values if isinstance(values, Mapping) else {})
            status = native_status(result.get("status")) if result else "unknown"
            if not result:
                raise RuntimeError("掘金未返回订单回执")
            return self.store.update_order(order.client_id, status, actor, result)
        except Exception as exc:
            self.store.update_order(order.client_id, "unknown", actor, error=str(exc)[:300])
            self.store.set_halted(True, "订单结果未知，请对账后恢复", "bridge")
            raise BridgeError("掘金下单结果未知，已暂停新增订单；请对账，不会自动重发", 503, "ORDER_UNKNOWN") from exc

    def _cancel_on_strategy_thread(self, raw: Mapping[str, Any], actor: str) -> Dict[str, Any]:
        client_id = str(raw.get("client_id", ""))
        row = self.store.order(client_id)
        if row["status"] in TERMINAL:
            return row
        native = row.get("native_client_id")
        if not native:
            raise BridgeError("该订单尚未获得掘金订单号，必须先对账", 409, "CANCEL_UNCERTAIN")
        self.gm.order_cancel({"cl_ord_id": native, "account_id": self.account_id})
        return self.store.update_order(client_id, "pending_cancel", actor)

    def _reconcile_on_strategy_thread(self, actor: str) -> Dict[str, Any]:
        self.refresh(self._context)  # type: ignore[attr-defined]
        unresolved = self.store.unresolved()
        # A queued/unknown submit and a pending cancellation both require an
        # explicit broker result before new orders can be enabled.
        blocking = [row for row in unresolved if row["status"] in {"submitting", "unknown", "pending_cancel"}]
        if blocking:
            self.store.set_halted(True, "对账存在状态未知订单", actor)
        self.store.audit(actor, "reconciliation", None, {"unresolved": len(unresolved), "blocking": len(blocking)})
        return {"timestamp": utc_now(), "ok": not blocking, "unresolved": len(unresolved), "blocking": len(blocking), "orders": unresolved}

    def _control_on_strategy_thread(self, raw: Mapping[str, Any], actor: str) -> Dict[str, Any]:
        halted = raw.get("halted")
        if not isinstance(halted, bool):
            raise BridgeError("暂停状态无效", 422, "INVALID_CONTROL")
        if halted:
            control = self.store.set_halted(True, "操作员暂停", actor)
            if raw.get("cancel"):
                for row in self.store.orders():
                    if row["status"] not in TERMINAL and row.get("native_client_id"):
                        try:
                            self._cancel_on_strategy_thread({"client_id": row["client_id"]}, actor)
                        except BridgeError:
                            pass
            return {"control": control}
        if raw.get("confirm") != "恢复A股模拟盘":
            raise BridgeError("请输入“恢复A股模拟盘”确认", 422, "CONFIRMATION_REQUIRED")
        result = self._reconcile_on_strategy_thread(actor)
        if not result["ok"]:
            raise BridgeError("对账未通过，保持暂停", 409, "RECONCILIATION_FAILED")
        return {"control": self.store.set_halted(False, "操作员对账后恢复", actor), "reconciliation": result}

    def bind_context(self, context: Any) -> None:
        """Store the current strategy context for timer-driven reconciliation only."""
        self._context = context

    def on_order_status(self, order: Any) -> None:
        raw = json_value(order)
        native = str(raw.get("cl_ord_id") or raw.get("client_order_id") or "") if isinstance(raw, Mapping) else ""
        local = self.store.by_native_client(native) if native else None
        if local:
            self.store.update_order(local["client_id"], native_status(raw.get("status")), "myquant_callback", raw)

    def on_execution_report(self, report: Any) -> None:
        raw = json_value(report)
        native = str(raw.get("cl_ord_id") or raw.get("client_order_id") or "") if isinstance(raw, Mapping) else ""
        local = self.store.by_native_client(native) if native else None
        if local:
            self.store.update_order(local["client_id"], native_status(raw.get("status") or "partially_filled"), "myquant_execution", raw)


def bridge_from_environment(gm: Any) -> MyQuantBridge:
    state_path = os.getenv("MYQUANT_BRIDGE_STATE_PATH", ".myquant_bridge_state.sqlite")
    return MyQuantBridge(
        BridgeStore(state_path),
        gm,
        os.environ["MYQUANT_SIM_ACCOUNT_ID"],
        os.environ["MYQUANT_BRIDGE_SECRET"],
        float(os.getenv("MYQUANT_BRIDGE_MAX_ORDER_NOTIONAL", "100000")),
        float(os.getenv("MYQUANT_BRIDGE_COMMAND_TIMEOUT", "12")),
    )
