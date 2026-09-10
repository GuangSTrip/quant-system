"""Strategy interface."""

from abc import ABC, abstractmethod
from typing import Dict

import pandas as pd


class Strategy(ABC):
    """A strategy converts completed bars into desired portfolio weights."""

    @abstractmethod
    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> Dict[str, float]:
        """Return target weights to be executed at the next bar's open."""
        raise NotImplementedError

    def reset(self) -> None:
        """Reset state before reusing a strategy in a separate experiment."""
        return None
