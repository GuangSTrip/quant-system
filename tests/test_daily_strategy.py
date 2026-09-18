"""Check that daily signals cannot trade at the signal day's open."""

import importlib.util
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "evaluate_daily_strategy.py"
SPEC = importlib.util.spec_from_file_location("evaluate_daily_strategy", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
FETCH_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_daily_strategy_data.py"
FETCH_SPEC = importlib.util.spec_from_file_location("fetch_daily_strategy_data", FETCH_SCRIPT)
FETCH = importlib.util.module_from_spec(FETCH_SPEC)
FETCH_SPEC.loader.exec_module(FETCH)


class DailyStrategyTests(unittest.TestCase):
    def test_tushare_a_share_volume_is_converted_from_hands(self):
        rows = []
        for stamp in pd.bdate_range("2025-01-01", periods=252):
            rows.append({"trade_date": stamp.strftime("%Y%m%d"), "open": 10,
                         "high": 11, "low": 9, "close": 10, "vol": 2})
        frame = pd.DataFrame(rows).rename(columns={"trade_date": "date", "vol": "volume"})
        normalized, qa = FETCH.normalize(frame, "CN")
        self.assertEqual(qa["accepted_rows"], 252)
        self.assertEqual(normalized.iloc[0].volume, 200)

    def test_breakout_fills_on_next_session_open(self):
        dates = pd.bdate_range("2025-01-01", periods=120).strftime("%Y-%m-%d")
        close = [100.0] * 100 + [105.0] * 20
        frame = pd.DataFrame({"date": dates, "open": close,
                              "high": [value + 0.2 for value in close],
                              "low": [value - 0.2 for value in close],
                              "close": close, "volume": [100_000] * 120})
        result = MODULE.backtest(frame, "US", 80, 120)
        buys = [trade for trade in result["trades"] if trade["side"] == "buy"]
        self.assertEqual(len(buys), 1)
        self.assertEqual(buys[0]["date"], dates[101])
        self.assertEqual(buys[0]["price"], frame.iloc[101].open)
        altered = frame.copy()
        altered.loc[101, ["high", "close"]] = [200.0, 150.0]
        altered_result = MODULE.backtest(altered, "US", 80, 120)
        altered_buy = next(trade for trade in altered_result["trades"] if trade["side"] == "buy")
        self.assertEqual(altered_buy["date"], buys[0]["date"])
        self.assertEqual(altered_buy["shares"], buys[0]["shares"])


if __name__ == "__main__":
    unittest.main()
