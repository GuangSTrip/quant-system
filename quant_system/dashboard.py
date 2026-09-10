"""Local, report-driven dashboard with no broker or credential access."""

from __future__ import annotations

import csv
import ipaddress
import json
import mimetypes
import secrets
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlparse

from .config import SystemConfig, load_config


STATIC_ROOT = Path(__file__).with_name("dashboard_static")


def _read_json(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def _read_csv(path: Path) -> List[Dict[str, str]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))
    except (FileNotFoundError, OSError):
        return []


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class DashboardStore:
    """Read local run artifacts and manage only the local paper halt marker."""

    def __init__(self, report_dir: str, config_path: str, root: Optional[Path] = None) -> None:
        self.root = (root or Path.cwd()).resolve()
        self.report_dir = self._resolve(report_dir)
        self.config_path = self._resolve(config_path)
        self.config: SystemConfig = load_config(str(self.config_path))
        self.state_dir = self._resolve(self.config.paper_trading.state_directory)
        self.audit_path = self._resolve(self.config.paper_trading.audit_log_path)

    def _resolve(self, value: str) -> Path:
        candidate = Path(value)
        return (candidate if candidate.is_absolute() else self.root / candidate).resolve()

    @property
    def halt_path(self) -> Path:
        return self.state_dir / "HALT"

    def set_halted(self, halted: bool) -> None:
        if halted:
            self.halt_path.parent.mkdir(parents=True, exist_ok=True)
            self.halt_path.write_text("Dashboard manual halt\n", encoding="utf-8")
        elif self.halt_path.exists():
            self.halt_path.unlink()
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": "kill_switch",
            "halted": halted,
            "reason": "Dashboard manual halt" if halted else "Dashboard confirmed resume",
            "source": "local_dashboard",
        }
        with self.audit_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    def _curve(self) -> List[Dict[str, Any]]:
        rows = _read_csv(self.report_dir / "equity_curve.csv")
        if len(rows) > 240:
            last_index = len(rows) - 1
            rows = [rows[round(i * last_index / 239)] for i in range(240)]
        return [
            {
                "timestamp": row.get("timestamp", ""),
                "equity": _number(row.get("equity")),
                "benchmark": _number(row.get("benchmark_equity")),
                "drawdown": _number(row.get("drawdown")),
                "gross_leverage": (
                    _number(row.get("gross_exposure")) / _number(row.get("equity"), 1.0)
                    if _number(row.get("equity"), 1.0) else 0.0
                ),
                "risk_halt": str(row.get("risk_halt", "")).lower() == "true",
            }
            for row in rows
        ]

    def _positions(self) -> List[Dict[str, Any]]:
        rows = _read_csv(self.report_dir / "positions.csv")
        if not rows:
            return []
        latest = max(row.get("timestamp", "") for row in rows)
        current = [row for row in rows if row.get("timestamp", "") == latest]
        normalized = [
            {
                "symbol": row.get("symbol", "—"),
                "quantity": _number(row.get("quantity")),
                "close": _number(row.get("close")),
                "market_value": _number(row.get("market_value")),
                "weight": _number(row.get("weight")),
            }
            for row in current
        ]
        return sorted(normalized, key=lambda row: abs(row["weight"]), reverse=True)

    def _trades(self) -> List[Dict[str, Any]]:
        rows = _read_csv(self.report_dir / "trades.csv")[-12:]
        rows.reverse()
        return [
            {
                "timestamp": row.get("timestamp", ""),
                "symbol": row.get("symbol", "—"),
                "side": row.get("side", "—"),
                "quantity": _number(row.get("quantity")),
                "price": _number(row.get("price")),
                "notional": _number(row.get("notional")),
                "fill_ratio": _number(row.get("fill_ratio")),
            }
            for row in rows
        ]

    def _audit(self) -> List[Dict[str, Any]]:
        try:
            lines = self.audit_path.read_text(encoding="utf-8").splitlines()[-20:]
        except (FileNotFoundError, OSError):
            return []
        records = []
        for line in reversed(lines):
            try:
                value = json.loads(line)
                records.append({
                    "timestamp": value.get("timestamp", ""),
                    "event": value.get("event", "unknown"),
                    "summary": self._audit_summary(value),
                })
            except json.JSONDecodeError:
                continue
        return records

    @staticmethod
    def _audit_summary(value: Dict[str, Any]) -> str:
        event = value.get("event", "unknown")
        if event == "kill_switch":
            return "模拟交易已暂停" if value.get("halted") else "模拟交易已恢复"
        if event == "order_plan":
            return "生成 %s 笔模拟订单计划" % value.get("order_count", 0)
        if event == "reconciliation":
            return "持仓对账一致" if value.get("matched") else "持仓对账存在差异"
        return str(event).replace("_", " ")

    def snapshot(self) -> Dict[str, Any]:
        curve = self._curve()
        metrics = _read_json(self.report_dir / "metrics.json", {})
        manifest = _read_json(self.report_dir / "run_manifest.json", {})
        paper = self.config.paper_trading
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "report": {
                "name": self.report_dir.name,
                "available": bool(curve and metrics),
                "data_start": manifest.get("market_data_start", curve[0]["timestamp"] if curve else None),
                "data_end": manifest.get("market_data_end", curve[-1]["timestamp"] if curve else None),
                "rows": manifest.get("market_data_rows"),
            },
            "metrics": metrics,
            "curve": curve,
            "positions": self._positions(),
            "trades": self._trades(),
            "audit": self._audit(),
            "safety": {
                "mode": "paper_only",
                "paper_submission_enabled": bool(paper.enabled),
                "kill_switch_active": self.halt_path.exists(),
                "broker_endpoint": "paper-api.alpaca.markets",
                "credentials_accessed": False,
                "order_submission_available": False,
            },
        }


class DashboardHandler(BaseHTTPRequestHandler):
    store: DashboardStore
    token: str

    def log_message(self, format: str, *args: Any) -> None:
        print("Dashboard: " + format % args)

    def _headers(self, status: HTTPStatus, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()

    def _json(self, payload: Dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8")
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/snapshot":
            payload = self.store.snapshot()
            payload["action_token"] = self.token
            self._json(payload)
            return
        target = "index.html" if path in {"", "/"} else path.lstrip("/")
        if target not in {"index.html", "styles.css", "app.js"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = (STATIC_ROOT / target).read_bytes()
        content_type = mimetypes.guess_type(target)[0] or "application/octet-stream"
        self._headers(HTTPStatus.OK, content_type + ("; charset=utf-8" if target.endswith((".html", ".css", ".js")) else ""))
        self.wfile.write(content)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in {"/api/safety/halt", "/api/safety/resume"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if self.headers.get("X-Dashboard-Token") != self.token:
            self._json({"error": "invalid action token"}, HTTPStatus.FORBIDDEN)
            return
        if self.headers.get_content_type() != "application/json":
            self._json({"error": "JSON request required"}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        length = min(int(self.headers.get("Content-Length", "0")), 4096)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json({"error": "invalid JSON"}, HTTPStatus.BAD_REQUEST)
            return
        halted = path.endswith("/halt")
        if not halted and payload.get("confirmation") != "恢复模拟盘":
            self._json({"error": "resume confirmation required"}, HTTPStatus.BAD_REQUEST)
            return
        self.store.set_halted(halted)
        self._json({"ok": True, "safety": self.store.snapshot()["safety"]})


def serve_dashboard(report_dir: str, config_path: str, host: str, port: int) -> int:
    try:
        address = ipaddress.ip_address("127.0.0.1" if host == "localhost" else host)
    except ValueError as exc:
        raise ValueError("Dashboard host must be localhost or a loopback IP") from exc
    if not address.is_loopback:
        raise ValueError("Dashboard is local-only; use 127.0.0.1 or ::1")
    store = DashboardStore(report_dir, config_path)
    handler = type("ConfiguredDashboardHandler", (DashboardHandler,), {"store": store, "token": secrets.token_urlsafe(24)})
    server = ThreadingHTTPServer((host, port), handler)
    print("Course dashboard: http://%s:%d" % (host, server.server_port))
    print("Local reports only; broker credentials and order submission are disabled.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard stopped.")
    finally:
        server.server_close()
    return 0


def add_dashboard_arguments(parser: Any) -> None:
    parser.add_argument("--dashboard", action="store_true", help="Serve the local course dashboard")
    parser.add_argument("--dashboard-report", default=None, help="Report directory shown by the dashboard (defaults to --output)")
    parser.add_argument("--dashboard-host", default="127.0.0.1", help="Loopback host for the dashboard")
    parser.add_argument("--dashboard-port", type=int, default=8765, help="Local dashboard port")
