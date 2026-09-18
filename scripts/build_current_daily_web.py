"""Publish active daily-market decisions without any fixed ticker list."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web_platform" / "src" / "current-daily-plan.json"


def main():
    audit = json.loads((ROOT / "data" / "universe_access.json").read_text(encoding="utf-8"))
    cn = json.loads((ROOT / "reports" / "current_daily" / "CN.json").read_text(encoding="utf-8"))
    data = {
        "generated_at": cn["generated_at"],
        "goal": {"min_annual_return_pct": 8, "max_drawdown_pct": 5,
                 "validated": False},
        "markets": {
            "CN": cn,
            "HK": {"market": "HK", "status": "data_incomplete", "listed": audit["endpoints"]["HK_listed"]["rows"],
                   "reason": "可取得港股列表；港股日线接口当前按小时限流，未取得全市场完整日线与复权历史，禁止用旧固定名单代替。",
                   "selected": [], "order_intentions": [], "broker_submitted": False},
            "US": {"market": "US", "status": "data_incomplete", "listed_returned": audit["endpoints"]["US_list"]["rows"],
                   "reason": "可取得美股列表部分返回；美股日线接口当前按小时限流，未完成全市场当日筛选，禁止用旧固定名单代替。",
                   "selected": [], "order_intentions": [], "broker_submitted": False},
        },
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("saved", OUT)


if __name__ == "__main__":
    main()
