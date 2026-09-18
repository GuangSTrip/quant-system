"""Read-only audit of available current stock universes and daily endpoints."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import tushare as ts

from fetch_daily_strategy_data import ROOT, token


def main():
    api = ts.pro_api(token())
    checks = {
        "CN_listed": lambda: api.stock_basic(exchange="", list_status="L", fields="ts_code,name,market,list_date,delist_date"),
        "CN_delisted": lambda: api.stock_basic(exchange="", list_status="D", fields="ts_code,name,market,list_date,delist_date"),
        "HK_listed": lambda: api.hk_basic(list_status="L"),
        "US_list": lambda: api.us_basic(),
        "CN_last_day": lambda: api.daily(trade_date="20260917"),
        "HK_daily_sample": lambda: api.hk_daily(ts_code="00700.HK", start_date="20260901", end_date="20260918"),
        "US_daily_sample": lambda: api.us_daily(ts_code="AAPL", start_date="20260901", end_date="20260918"),
    }
    result = {"checked_at": datetime.now(timezone.utc).isoformat(), "endpoints": {}}
    for name, call in checks.items():
        try:
            frame = call()
            info = {"status": "ok", "rows": len(frame), "columns": list(frame.columns)}
            if "trade_date" in frame and not frame.empty:
                info["latest_trade_date"] = str(frame.trade_date.max())
            if name.endswith("listed") or name == "US_list":
                result.setdefault("lists", {})[name] = frame.to_dict(orient="records")
            result["endpoints"][name] = info
            print(name, "ok", len(frame), flush=True)
        except Exception as error:
            result["endpoints"][name] = {"status": "error", "message": str(error)}
            print(name, "error", str(error)[:180], flush=True)
    out = ROOT / "data" / "universe_access.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", out)


if __name__ == "__main__":
    main()
