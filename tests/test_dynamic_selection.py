"""Causality and execution checks for the daily selection research."""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from evaluate_dynamic_stock_selection import Panel, run, select, WARMUP  # noqa: E402


def sample_panel():
    dates = pd.bdate_range("2024-01-01", periods=280).strftime("%Y-%m-%d").tolist()
    symbols = [f"S{i}" for i in range(6)]
    closes = np.column_stack([100 * (1 + (i + 1) * 0.00035) ** np.arange(280)
                              for i in range(6)])
    opens = closes * 0.999
    volume = np.full_like(closes, 1_000_000.0)
    return Panel(dates, symbols, opens, closes, closes.copy(), volume, closes * volume)


class DynamicSelectionTests(unittest.TestCase):
    def test_future_prices_cannot_change_today_selection(self):
        panel = sample_panel()
        selected, picks = select(panel, WARMUP, "relative_momentum")
        altered = sample_panel()
        altered.closes[WARMUP + 1:] *= 100
        altered.opens[WARMUP + 1:] *= 100
        new_selected, new_picks = select(altered, WARMUP, "relative_momentum")
        self.assertEqual(selected, new_selected)
        self.assertEqual(picks, new_picks)
        self.assertLessEqual(sum(selected.values()), 0.90 + 1e-9)
        self.assertTrue(all(weight <= 0.25 for weight in selected.values()))

    def test_signals_fill_only_on_next_open_with_whole_lots(self):
        panel = sample_panel()
        result = run(panel, "CN", "relative_momentum")
        self.assertTrue(result["decisions"])
        first = result["decisions"][0]
        self.assertEqual(first["signal_date"], panel.dates[WARMUP])
        self.assertEqual(first["fill_date"], panel.dates[WARMUP + 1])
        self.assertTrue(result["trades"])
        for trade in result["trades"]:
            self.assertGreaterEqual(trade["date"], first["fill_date"])
            self.assertEqual(trade["shares"] % 100, 0)
        self.assertEqual(result["curve"][0]["equity"], 10_000_000.0)


if __name__ == "__main__":
    unittest.main()
