"""Broker boundary, deterministic simulator, and Alpaca paper-trading adapter."""

import json
import os
import time
import uuid
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

from .config import CostConfig, PaperTradingConfig, RiskConfig


class OrderStatus(str, Enum):
    NEW = "NEW"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"


@dataclass
class Order:
    symbol: str
    quantity: float
    created_at: pd.Timestamp
    order_id: str = ""
    filled_quantity: float = 0.0
    average_fill_price: float = 0.0
    status: OrderStatus = OrderStatus.NEW

    def __post_init__(self) -> None:
        if not self.order_id:
            self.order_id = uuid.uuid4().hex
        if not self.symbol or self.quantity == 0:
            self.status = OrderStatus.REJECTED

    @property
    def remaining_quantity(self) -> float:
        return self.quantity - self.filled_quantity


@dataclass
class Fill:
    order_id: str
    timestamp: pd.Timestamp
    symbol: str
    quantity: float
    price: float
    commission: float


class Broker(ABC):
    @abstractmethod
    def submit(self, order: Order) -> str:
        raise NotImplementedError

    @abstractmethod
    def cancel(self, order_id: str) -> bool:
        raise NotImplementedError

    @abstractmethod
    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> List[Fill]:
        raise NotImplementedError


class PaperBroker(Broker):
    """Fill market orders at bar open with spread/slippage and partial fills."""

    def __init__(
        self, costs: CostConfig, max_volume_participation: float = 0.10
    ) -> None:
        if not 0 < max_volume_participation <= 1:
            raise ValueError("max_volume_participation must be in (0, 1]")
        self.costs = costs
        self.max_volume_participation = max_volume_participation
        self.orders: Dict[str, Order] = {}

    def submit(self, order: Order) -> str:
        self.orders[order.order_id] = order
        return order.order_id

    def cancel(self, order_id: str) -> bool:
        order = self.orders.get(order_id)
        if order is None or order.status in {OrderStatus.FILLED, OrderStatus.CANCELLED}:
            return False
        order.status = OrderStatus.CANCELLED
        return True

    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> List[Fill]:
        fills: List[Fill] = []
        for order in list(self.orders.values()):
            if order.status not in {OrderStatus.NEW, OrderStatus.PARTIALLY_FILLED}:
                continue
            bar = bars.get(order.symbol)
            if bar is None:
                continue
            remaining = order.remaining_quantity
            cap = float(bar["volume"]) * self.max_volume_participation
            quantity = (1.0 if remaining > 0 else -1.0) * min(abs(remaining), cap)
            direction = 1.0 if quantity > 0 else -1.0
            friction = self.costs.slippage_bps / 10_000.0 + self.costs.spread_bps / 20_000.0
            price = float(bar["open"]) * (1.0 + direction * friction)
            notional = abs(quantity * price)
            commission = max(self.costs.minimum_commission, notional * self.costs.commission_rate)
            if quantity < 0:
                commission += notional * self.costs.sell_tax_rate
            previous_absolute = abs(order.filled_quantity)
            order.filled_quantity += quantity
            order.average_fill_price = (
                order.average_fill_price * previous_absolute + price * abs(quantity)
            ) / (previous_absolute + abs(quantity))
            order.status = (
                OrderStatus.FILLED
                if abs(order.remaining_quantity) < 1e-12
                else OrderStatus.PARTIALLY_FILLED
            )
            fills.append(
                Fill(order.order_id, pd.Timestamp(timestamp), order.symbol, quantity, price, commission)
            )
        return fills


class AlpacaAPIError(RuntimeError):
    """An Alpaca request failed after safe retries."""


@dataclass(frozen=True)
class AccountSnapshot:
    equity: float
    cash: float
    buying_power: float
    trading_blocked: bool
    account_blocked: bool


@dataclass(frozen=True)
class ReconciliationReport:
    matched: bool
    expected: Dict[str, float]
    actual: Dict[str, float]
    differences: Dict[str, float]


class AuditLog:
    """Append-only, structured local audit trail. It deliberately excludes secrets."""

    def __init__(self, path: str) -> None:
        self.path = Path(path)

    def write(self, event: str, **fields: Any) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        record = {"timestamp": pd.Timestamp.utcnow().isoformat(), "event": event, **fields}
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


class AlpacaPaperBroker(Broker):
    """A conservative REST adapter for Alpaca *paper* trading only.

    The adapter checks an existing ``client_order_id`` before posting, which makes
    restarts and retry-after-timeout safe. It never accepts a live trading URL.
    ``request_fn`` exists for deterministic tests; production uses urllib only,
    keeping the base installation dependency-free.
    """

    PAPER_URL = "https://paper-api.alpaca.markets"
    DATA_URL = "https://data.alpaca.markets"
    TERMINAL = {"filled", "canceled", "expired", "rejected", "suspended", "calculated"}

    def __init__(
        self,
        settings: PaperTradingConfig,
        risk: Optional[RiskConfig] = None,
        request_fn: Optional[Callable[[str, str, Mapping[str, str], Optional[Mapping[str, Any]]], Any]] = None,
    ) -> None:
        self.settings = settings
        self.risk = risk
        self._request_fn = request_fn
        self.orders: Dict[str, Order] = {}
        self.remote_orders: Dict[str, Dict[str, Any]] = {}
        self.audit = AuditLog(settings.audit_log_path)
        if not self.PAPER_URL.startswith("https://paper-api.alpaca.markets"):
            raise ValueError("Alpaca adapter is hard-wired to the paper endpoint")

    @classmethod
    def from_environment(
        cls, settings: PaperTradingConfig, risk: Optional[RiskConfig] = None
    ) -> "AlpacaPaperBroker":
        missing = [key for key in (settings.api_key_env, settings.api_secret_env) if not os.getenv(key)]
        if missing:
            raise ValueError("Missing Alpaca paper credential environment variables: %s" % ", ".join(missing))
        return cls(settings, risk)

    def _headers(self) -> Dict[str, str]:
        key = os.getenv(self.settings.api_key_env)
        secret = os.getenv(self.settings.api_secret_env)
        if not key or not secret:
            raise ValueError("Alpaca paper credentials are unavailable in the environment")
        return {
            "APCA-API-KEY-ID": key,
            "APCA-API-SECRET-KEY": secret,
            "Content-Type": "application/json",
        }

    @property
    def halt_path(self) -> Path:
        return Path(self.settings.state_directory) / "HALT"

    def set_halted(self, halted: bool, reason: str = "manual") -> None:
        """Persist a local kill switch; clearing it is an equally explicit action."""
        if halted:
            self.halt_path.parent.mkdir(parents=True, exist_ok=True)
            self.halt_path.write_text(reason + "\n", encoding="utf-8")
        elif self.halt_path.exists():
            self.halt_path.unlink()
        self.audit.write("kill_switch", halted=halted, reason=reason)

    def is_halted(self) -> bool:
        return self.halt_path.exists()

    @property
    def expected_positions_path(self) -> Path:
        return Path(self.settings.state_directory) / "expected_positions.json"

    def save_expected_positions(self, expected: Mapping[str, float]) -> None:
        """Persist intended post-trade quantities for next-startup reconciliation."""
        self.expected_positions_path.parent.mkdir(parents=True, exist_ok=True)
        clean = {str(symbol): float(quantity) for symbol, quantity in expected.items()
                 if abs(float(quantity)) > self.settings.reconciliation_tolerance}
        self.expected_positions_path.write_text(json.dumps(clean, sort_keys=True), encoding="utf-8")
        self.audit.write("expected_positions_saved", expected=clean)

    def load_expected_positions(self) -> Optional[Dict[str, float]]:
        if not self.expected_positions_path.exists():
            return None
        with self.expected_positions_path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
        return {str(symbol): float(quantity) for symbol, quantity in raw.items()}

    def _request(
        self, method: str, path: str, payload: Optional[Mapping[str, Any]] = None
    ) -> Any:
        """Call a paper endpoint; retry only transient HTTP/network failures."""
        headers = self._headers()
        retryable = {429, 500, 502, 503, 504}
        for attempt in range(self.settings.max_retries + 1):
            try:
                if self._request_fn:
                    response = self._request_fn(method, path, headers, payload)
                    return response
                url = self.PAPER_URL + path
                body = json.dumps(payload).encode("utf-8") if payload is not None else None
                request = Request(url, data=body, headers=headers, method=method)
                with urlopen(request, timeout=15) as response:  # nosec: fixed HTTPS paper URL
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except HTTPError as exc:
                text = exc.read().decode("utf-8", errors="replace")
                if exc.code not in retryable or attempt >= self.settings.max_retries:
                    raise AlpacaAPIError("Alpaca %s %s failed (%s): %s" % (method, path, exc.code, text)) from exc
            except URLError as exc:
                if attempt >= self.settings.max_retries:
                    raise AlpacaAPIError("Alpaca %s %s network failure: %s" % (method, path, exc)) from exc
            time.sleep(self.settings.retry_backoff_seconds * (2 ** attempt))
        raise AssertionError("unreachable")

    def _data_request(self, path: str) -> Any:
        """Fetch market data with the same credentials, without any order capability."""
        retryable = {429, 500, 502, 503, 504}
        for attempt in range(self.settings.max_retries + 1):
            try:
                if self._request_fn:
                    return self._request_fn("GET", "DATA:" + path, self._headers(), None)
                request = Request(self.DATA_URL + path, headers=self._headers(), method="GET")
                with urlopen(request, timeout=15) as response:  # nosec: fixed HTTPS data URL
                    raw = response.read().decode("utf-8")
                    return json.loads(raw)
            except HTTPError as exc:
                if exc.code not in retryable or attempt >= self.settings.max_retries:
                    raise AlpacaAPIError("Alpaca market-data request failed: %s" % exc) from exc
            except URLError as exc:
                if attempt >= self.settings.max_retries:
                    raise AlpacaAPIError("Alpaca market-data request failed: %s" % exc) from exc
            time.sleep(self.settings.retry_backoff_seconds * (2 ** attempt))
        raise AssertionError("unreachable")

    def account(self) -> AccountSnapshot:
        raw = self._request("GET", "/v2/account")
        snapshot = AccountSnapshot(
            equity=float(raw["equity"]), cash=float(raw["cash"]),
            buying_power=float(raw["buying_power"]),
            trading_blocked=bool(raw.get("trading_blocked", False)),
            account_blocked=bool(raw.get("account_blocked", False)),
        )
        self.audit.write("account_sync", equity=snapshot.equity, cash=snapshot.cash,
                         buying_power=snapshot.buying_power, trading_blocked=snapshot.trading_blocked)
        return snapshot

    def positions(self) -> Dict[str, float]:
        raw = self._request("GET", "/v2/positions")
        positions = {str(item["symbol"]): float(item["qty"]) for item in raw}
        self.audit.write("positions_sync", positions=positions)
        return positions

    def open_orders(self) -> List[Dict[str, Any]]:
        """Return only this strategy's outstanding orders after a process restart."""
        raw = self._request("GET", "/v2/orders?" + urlencode({"status": "open", "limit": "500"}))
        managed = [dict(order) for order in raw if str(order.get("client_order_id", "")).startswith(self.settings.order_prefix + "-")]
        self.audit.write("open_orders_sync", count=len(managed))
        return managed

    def clock(self) -> Mapping[str, Any]:
        return self._request("GET", "/v2/clock")

    def latest_mid_prices(self, symbols: List[str]) -> Dict[str, float]:
        """Return latest bid/ask midpoints for plan generation; no stale CSV is used."""
        if not symbols:
            return {}
        path = "/v2/stocks/quotes/latest?" + urlencode(
            {"symbols": ",".join(sorted(symbols)), "feed": self.settings.data_feed}
        )
        raw = self._data_request(path)
        quotes = raw.get("quotes", {})
        prices: Dict[str, float] = {}
        for symbol in symbols:
            quote = quotes.get(symbol)
            if not quote:
                continue
            bid, ask = float(quote.get("bp", 0)), float(quote.get("ap", 0))
            if bid > 0 and ask > 0:
                prices[symbol] = (bid + ask) / 2.0
        missing = sorted(set(symbols) - set(prices))
        if missing:
            raise ValueError("No usable latest Alpaca quote for: %s" % ", ".join(missing))
        self.audit.write("quote_sync", symbols=sorted(prices), feed=self.settings.data_feed)
        return prices

    def daily_bars(self, symbols: List[str], start: pd.Timestamp) -> pd.DataFrame:
        """Download completed daily OHLCV bars required by the daily strategies."""
        if not symbols:
            return pd.DataFrame(columns=["timestamp", "symbol", "open", "high", "low", "close", "volume"])
        query = urlencode({
            "symbols": ",".join(sorted(symbols)), "timeframe": "1Day",
            "start": pd.Timestamp(start).isoformat(), "feed": self.settings.data_feed,
            "limit": "10000",
        })
        raw = self._data_request("/v2/stocks/bars?" + query)
        rows: List[Dict[str, Any]] = []
        for symbol, bars in raw.get("bars", {}).items():
            for bar in bars:
                rows.append({"timestamp": pd.Timestamp(bar["t"]), "symbol": symbol,
                             "open": float(bar["o"]), "high": float(bar["h"]),
                             "low": float(bar["l"]), "close": float(bar["c"]),
                             "volume": float(bar["v"])})
        data = pd.DataFrame(rows, columns=["timestamp", "symbol", "open", "high", "low", "close", "volume"])
        if data.empty:
            raise ValueError("Alpaca returned no daily bars")
        self.audit.write("daily_bars_sync", symbols=sorted(symbols), rows=len(data), start=str(start))
        return data.sort_values(["timestamp", "symbol"]).reset_index(drop=True)

    def _client_order_id(self, order: Order) -> str:
        # Alpaca limits this field to 128 characters; deterministic order IDs aid recovery.
        return "%s-%s" % (self.settings.order_prefix, order.order_id[:72])

    def _get_by_client_id(self, client_order_id: str) -> Optional[Dict[str, Any]]:
        try:
            raw = self._request("GET", "/v2/orders:by_client_order_id?" + urlencode({"client_order_id": client_order_id}))
            return dict(raw)
        except AlpacaAPIError as exc:
            if "(404)" in str(exc):
                return None
            raise

    def _assert_can_submit(self, order: Order) -> None:
        if order.status == OrderStatus.REJECTED:
            raise ValueError("Invalid order cannot be sent to Alpaca")
        if not self.settings.enabled:
            raise PermissionError("paper_trading.enabled is false; refusing to submit an order")
        if self.is_halted():
            raise PermissionError("local paper-trading kill switch is active")
        account = self.account()
        if account.trading_blocked or account.account_blocked:
            raise PermissionError("Alpaca paper account is blocked for trading")

    def submit(self, order: Order) -> str:
        self._assert_can_submit(order)
        client_id = self._client_order_id(order)
        existing = self._get_by_client_id(client_id)
        if existing is not None:
            self.orders[order.order_id] = order
            self.remote_orders[order.order_id] = existing
            self._update_local_order(order, existing)
            self.audit.write("order_idempotent_recovery", local_order_id=order.order_id,
                             client_order_id=client_id, alpaca_order_id=existing.get("id"))
            return str(existing["id"])
        quantity = abs(order.quantity)
        payload = {
            "symbol": order.symbol,
            "qty": str(quantity),
            "side": "buy" if order.quantity > 0 else "sell",
            "type": "market",
            "time_in_force": "day",
            "client_order_id": client_id,
        }
        remote = dict(self._request("POST", "/v2/orders", payload))
        self.orders[order.order_id] = order
        self.remote_orders[order.order_id] = remote
        self._update_local_order(order, remote)
        self.audit.write("order_submitted", local_order_id=order.order_id, client_order_id=client_id,
                         alpaca_order_id=remote.get("id"), symbol=order.symbol, quantity=order.quantity)
        return str(remote["id"])

    def _update_local_order(self, order: Order, remote: Mapping[str, Any]) -> None:
        filled = float(remote.get("filled_qty") or 0.0)
        order.filled_quantity = filled if order.quantity > 0 else -filled
        order.average_fill_price = float(remote.get("filled_avg_price") or 0.0)
        state = str(remote.get("status", "new")).lower()
        if state == "filled":
            order.status = OrderStatus.FILLED
        elif state in {"partially_filled", "pending_new", "accepted", "new"}:
            order.status = OrderStatus.PARTIALLY_FILLED if filled else OrderStatus.NEW
        elif state in {"canceled", "expired"}:
            order.status = OrderStatus.CANCELLED
        elif state in {"rejected", "suspended"}:
            order.status = OrderStatus.REJECTED

    def cancel(self, order_id: str) -> bool:
        order = self.orders.get(order_id)
        remote = self.remote_orders.get(order_id)
        if order is None or remote is None or order.status in {OrderStatus.FILLED, OrderStatus.CANCELLED}:
            return False
        self._request("DELETE", "/v2/orders/%s" % remote["id"])
        order.status = OrderStatus.CANCELLED
        self.audit.write("order_cancelled", local_order_id=order_id, alpaca_order_id=remote["id"])
        return True

    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> List[Fill]:
        """Poll submitted orders so the common broker interface has no hidden state."""
        fills: List[Fill] = []
        for local_id, order in self.orders.items():
            remote = self.remote_orders.get(local_id)
            if remote is None or str(remote.get("status", "")).lower() in self.TERMINAL:
                continue
            updated = dict(self._request("GET", "/v2/orders/%s" % remote["id"]))
            previous = abs(order.filled_quantity)
            self.remote_orders[local_id] = updated
            self._update_local_order(order, updated)
            filled = abs(order.filled_quantity) - previous
            if filled > 0:
                sign = 1.0 if order.quantity > 0 else -1.0
                fills.append(Fill(order.order_id, pd.Timestamp(timestamp), order.symbol, sign * filled,
                                  order.average_fill_price, 0.0))
                self.audit.write("order_fill_sync", local_order_id=local_id, quantity=sign * filled,
                                 price=order.average_fill_price, status=order.status.value)
        return fills

    def reconcile(self, expected_positions: Mapping[str, float]) -> ReconciliationReport:
        actual = self.positions()
        symbols = set(expected_positions) | set(actual)
        differences = {symbol: actual.get(symbol, 0.0) - float(expected_positions.get(symbol, 0.0))
                       for symbol in sorted(symbols)}
        differences = {symbol: value for symbol, value in differences.items()
                       if abs(value) > self.settings.reconciliation_tolerance}
        report = ReconciliationReport(not differences, dict(expected_positions), actual, differences)
        self.audit.write("reconciliation", matched=report.matched, differences=differences)
        return report

    def plan_target_orders(
        self, targets: Mapping[str, float], prices: Mapping[str, float], account: AccountSnapshot,
        plan_id: str = "",
    ) -> List[Order]:
        """Convert already-risk-approved target weights into a no-side-effect order plan."""
        if account.equity <= 0:
            raise ValueError("Account equity must be positive")
        if self.risk:
            gross = sum(abs(float(weight)) for weight in targets.values())
            if gross > self.risk.max_gross_leverage + 1e-12:
                raise ValueError("Target gross exposure exceeds configured risk cap")
            for symbol, weight in targets.items():
                if abs(float(weight)) > self.risk.max_position_weight + 1e-12:
                    raise ValueError("Target position cap exceeded: %s" % symbol)
                if not self.risk.allow_short and float(weight) < 0:
                    raise ValueError("Short target rejected by configured risk policy: %s" % symbol)
        current = self.positions()
        plan: List[Order] = []
        for symbol in sorted(set(targets) | set(current)):
            if symbol not in prices or float(prices[symbol]) <= 0:
                raise ValueError("No positive executable price for %s" % symbol)
            desired = account.equity * float(targets.get(symbol, 0.0)) / float(prices[symbol])
            if not self.risk or not self.risk.allow_short:
                desired = max(0.0, desired)
            delta = desired - current.get(symbol, 0.0)
            if abs(delta) > self.settings.reconciliation_tolerance:
                token = "%s|%s|%s|%.8f" % (plan_id, symbol, "buy" if delta > 0 else "sell", delta)
                stable_id = hashlib.sha256(token.encode("utf-8")).hexdigest()[:32]
                plan.append(Order(symbol, delta, pd.Timestamp.utcnow(), order_id=stable_id))
        self.audit.write("order_plan", order_count=len(plan), targets=dict(targets))
        return plan

    def submit_plan(self, orders: List[Order]) -> List[str]:
        """Submit a precomputed plan only during the regular market session."""
        clock = self.clock()
        if not bool(clock.get("is_open", False)):
            raise PermissionError("Alpaca market clock is closed; paper orders were not submitted")
        return [self.submit(order) for order in orders]
