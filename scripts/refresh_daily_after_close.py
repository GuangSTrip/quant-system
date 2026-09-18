"""One-shot local refresh after today's complete A-share daily bar is published.

No broker API is used. The local demo serves the JSON from disk on each page
refresh, so a new signal becomes visible without submitting any orders.
"""
from __future__ import annotations

import subprocess
import sys
import time
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from fetch_daily_strategy_data import ROOT


def main():
    local_tz = ZoneInfo("Asia/Shanghai")
    now = datetime.now(local_tz)
    cutoff = now.replace(hour=17, minute=10, second=0, microsecond=0)
    while now < cutoff:
        time.sleep(min((cutoff - now).total_seconds(), 30))
        now = datetime.now(local_tz)
    expected = now.date().isoformat()
    for attempt in range(17):
        try:
            subprocess.run([sys.executable, str(ROOT / "scripts" / "generate_current_daily_plan.py"), "--limit", "100"],
                           cwd=ROOT, check=True)
            report = json.loads((ROOT / "reports" / "current_daily" / "CN.json").read_text(encoding="utf-8"))
            if report["signal_date"] == expected and report["status"] == "research_signal_ready":
                subprocess.run([sys.executable, str(ROOT / "scripts" / "build_current_daily_web.py")],
                               cwd=ROOT, check=True)
                print("current daily plan refreshed after close", flush=True)
                return
            print("complete daily bar not yet available", attempt + 1, flush=True)
        except Exception as error:
            print("refresh attempt failed", attempt + 1, str(error)[:240], flush=True)
        if attempt < 16:
            time.sleep(300)
    raise RuntimeError("Today's complete daily bar was not available by the final attempt")


if __name__ == "__main__":
    main()
