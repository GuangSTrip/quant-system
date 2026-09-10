"""Event-driven quantitative research toolkit."""

from .backtest import BacktestResult, Backtester
from .config import SystemConfig, load_config

__all__ = ["BacktestResult", "Backtester", "SystemConfig", "load_config"]
__version__ = "0.1.0"

