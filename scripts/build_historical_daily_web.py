"""Publish a small, readable snapshot of completed market-wide daily research."""
from __future__ import annotations

import json

from fetch_daily_strategy_data import ROOT


REPORT = ROOT / "reports" / "point_in_time_cn" / "report.json"
OUT = ROOT / "web_platform" / "src" / "historical-daily-results.json"
NAMES = {
    "liquidity_only": "成交额前五",
    "relative_momentum": "半年相对动量",
    "trend_momentum": "趋势加动量",
    "near_52week_high": "接近年内高点",
    "pullback_trend": "趋势中回调",
    "low_volatility": "低波动加趋势",
}
VARIANTS = {"original": "原始仓位", "vol_06": "6%波动目标"}


def main():
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    rows = []
    for strategy, variants in report["results"].items():
        for variant, label in VARIANTS.items():
            item = variants[variant]
            rows.append({"strategy": NAMES[strategy], "variant": label,
                         "development": item["development"], "holdout": item["holdout"],
                         "trade_count": item["trade_count"],
                         "meets_goal_both_periods": all(
                             item[period]["cagr_pct"] >= 8 and
                             item[period]["max_drawdown_pct"] >= -5
                             for period in ("development", "holdout"))})
    output = {"generated_at": report["generated_at"], "data": report["data"],
              "initial_cash_cny": report["initial_cash_cny"], "rows": rows,
              "markets": {"CN": "已完成全市场历史回测", "HK": "港股历史行情未取得，暂不展示收益",
                          "US": "美股历史行情未取得，暂不展示收益"}}
    OUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("saved", OUT, "rows", len(rows))


if __name__ == "__main__":
    main()
