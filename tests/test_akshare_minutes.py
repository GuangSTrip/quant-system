"""Check the market-data normalization without making network requests."""

import importlib.util
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).resolve().parents[1] / "web_platform" / "scripts" / "fetch-akshare-minutes.py"
SPEC = importlib.util.spec_from_file_location("fetch_akshare_minutes", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AkshareNormalizationTests(unittest.TestCase):
    def test_a_share_hands_and_invalid_open_are_recorded(self):
        frame = pd.DataFrame([
            {"时间": "2026-09-17 09:30:00", "开盘": 10, "最高": 10.1,
             "最低": 9.9, "收盘": 10.05, "成交量": 2},
            {"时间": "2026-09-17 09:31:00", "开盘": 0, "最高": 10.1,
             "最低": 10, "收盘": 10.05, "成交量": 3},
        ])
        bars, qa = MODULE.normalize(frame, "CN")
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]["v"], 200)
        self.assertEqual(qa["invalid_ohlcv"], 1)
        self.assertEqual(qa["rows_by_local_day"], {"2026-09-17": 1})

    def test_us_china_wall_clock_maps_to_new_york_session(self):
        frame = pd.DataFrame([{"时间": "2026-09-17 21:30:00", "开盘": 100,
                               "最高": 101, "最低": 99, "收盘": 100.5, "成交量": 10}])
        bars, qa = MODULE.normalize(frame, "US")
        self.assertEqual(qa["accepted_rows"], 1)
        self.assertEqual(bars[0]["t"], "2026-09-17T21:30:00+08:00")


if __name__ == "__main__":
    unittest.main()
