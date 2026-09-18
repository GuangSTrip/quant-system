import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from evaluate_dynamic_stock_selection import Panel  # noqa: E402
from evaluate_risk_budget import forecast_vol  # noqa: E402


class RiskBudgetCausalityTests(unittest.TestCase):
    def test_later_prices_cannot_change_current_volatility_forecast(self):
        closes = np.array([[100 + i * 0.1, 90 + i * 0.15] for i in range(100)], dtype=float)
        panel = Panel([str(i) for i in range(100)], ["A", "B"], closes, closes,
                      closes, np.ones_like(closes), closes)
        first = forecast_vol(panel, 70, {"A": 0.5, "B": 0.5})
        closes[71:] *= 100
        second = forecast_vol(panel, 70, {"A": 0.5, "B": 0.5})
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
