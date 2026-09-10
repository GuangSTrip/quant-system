"""Configuration models and YAML loading."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

import yaml


@dataclass
class EngineConfig:
    initial_cash: float = 1_000_000.0
    allow_fractional: bool = False
    rebalance_threshold: float = 0.002
    cash_buffer: float = 0.01


@dataclass
class CostConfig:
    commission_rate: float = 0.0003
    minimum_commission: float = 0.0
    slippage_bps: float = 2.0
    spread_bps: float = 1.0
    market_impact: float = 0.10
    sell_tax_rate: float = 0.0
    annual_cash_rate: float = 0.0
    annual_borrow_rate: float = 0.03
    annual_margin_rate: float = 0.06


@dataclass
class RiskConfig:
    max_position_weight: float = 0.35
    max_gross_leverage: float = 1.0
    max_drawdown: float = 0.20
    drawdown_cooldown_days: int = 20
    allow_short: bool = False
    target_volatility: float = 0.12
    volatility_lookback: int = 60
    fast_volatility_lookback: int = 20
    min_volatility_scale: float = 0.25
    max_volatility_scale: float = 1.0
    max_daily_turnover: float = 0.50
    max_volume_participation: float = 0.10
    drawdown_soft_limit: float = 0.08
    minimum_drawdown_scale: float = 0.50
    max_group_weight: float = 1.0
    asset_groups: Dict[str, str] = field(default_factory=dict)


@dataclass
class StrategyConfig:
    name: str = "sma_cross"
    params: Dict[str, Any] = field(default_factory=dict)
    sleeves: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class ResearchConfig:
    train_fraction: float = 0.70
    objective: str = "robust_score"
    parameter_grid: Dict[str, List[Any]] = field(default_factory=dict)
    cost_stress_multipliers: List[float] = field(default_factory=lambda: [1.0, 2.0, 3.0])
    minimum_trades: int = 5
    walk_forward_folds: int = 3
    bootstrap_samples: int = 1000
    bootstrap_block_size: int = 20


@dataclass
class PaperTradingConfig:
    """Settings for the explicitly opt-in Alpaca paper-trading adapter.

    Credentials are names of environment variables, never credential values.
    """

    enabled: bool = False
    api_key_env: str = "ALPACA_PAPER_API_KEY"
    api_secret_env: str = "ALPACA_PAPER_API_SECRET"
    state_directory: str = ".paper_state"
    audit_log_path: str = "reports/paper_trading/audit.jsonl"
    order_prefix: str = "quant"
    max_retries: int = 3
    retry_backoff_seconds: float = 0.5
    reconciliation_tolerance: float = 0.000001
    data_feed: str = "iex"


@dataclass
class SystemConfig:
    engine: EngineConfig = field(default_factory=EngineConfig)
    costs: CostConfig = field(default_factory=CostConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    strategy: StrategyConfig = field(default_factory=StrategyConfig)
    data: Dict[str, Any] = field(default_factory=dict)
    research: ResearchConfig = field(default_factory=ResearchConfig)
    paper_trading: PaperTradingConfig = field(default_factory=PaperTradingConfig)

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "SystemConfig":
        allowed = {"engine", "costs", "risk", "strategy", "data", "research", "paper_trading"}
        unknown = set(raw) - allowed
        if unknown:
            raise ValueError("Unknown top-level config keys: %s" % sorted(unknown))

        strategy_raw = raw.get("strategy", {})
        config = cls(
            engine=EngineConfig(**raw.get("engine", {})),
            costs=CostConfig(**raw.get("costs", {})),
            risk=RiskConfig(**raw.get("risk", {})),
            strategy=StrategyConfig(**strategy_raw),
            data=dict(raw.get("data", {})),
            research=ResearchConfig(**raw.get("research", {})),
            paper_trading=PaperTradingConfig(**raw.get("paper_trading", {})),
        )
        config.validate()
        return config

    def validate(self) -> None:
        if self.engine.initial_cash <= 0:
            raise ValueError("engine.initial_cash must be positive")
        if self.costs.commission_rate < 0 or self.costs.minimum_commission < 0:
            raise ValueError("commission values cannot be negative")
        if self.costs.slippage_bps < 0:
            raise ValueError("costs.slippage_bps cannot be negative")
        if min(
            self.costs.spread_bps,
            self.costs.market_impact,
            self.costs.sell_tax_rate,
            self.costs.annual_borrow_rate,
            self.costs.annual_margin_rate,
        ) < 0:
            raise ValueError("spread, impact, and tax cannot be negative")
        if not 0 < self.risk.max_position_weight <= self.risk.max_gross_leverage:
            raise ValueError("max_position_weight must be positive and <= max_gross_leverage")
        if self.risk.max_gross_leverage <= 0:
            raise ValueError("risk.max_gross_leverage must be positive")
        if not 0 < self.risk.max_drawdown <= 1:
            raise ValueError("risk.max_drawdown must be in (0, 1]")
        if self.risk.drawdown_cooldown_days < 1:
            raise ValueError("risk.drawdown_cooldown_days must be >= 1")
        if not 0 <= self.engine.rebalance_threshold < 1:
            raise ValueError("engine.rebalance_threshold must be in [0, 1)")
        if not 0 <= self.engine.cash_buffer < 1:
            raise ValueError("engine.cash_buffer must be in [0, 1)")
        if (
            self.risk.target_volatility <= 0
            or self.risk.volatility_lookback < 2
            or self.risk.fast_volatility_lookback < 2
            or self.risk.fast_volatility_lookback > self.risk.volatility_lookback
        ):
            raise ValueError("target volatility must be positive and lookback >= 2")
        if not 0 < self.risk.min_volatility_scale <= self.risk.max_volatility_scale:
            raise ValueError("invalid volatility scale bounds")
        if not 0 < self.risk.max_daily_turnover <= 2:
            raise ValueError("risk.max_daily_turnover must be in (0, 2]")
        if not 0 < self.risk.max_volume_participation <= 1:
            raise ValueError("risk.max_volume_participation must be in (0, 1]")
        if not 0 < self.risk.drawdown_soft_limit < self.risk.max_drawdown:
            raise ValueError("drawdown_soft_limit must be positive and below max_drawdown")
        if not 0 < self.risk.minimum_drawdown_scale <= 1:
            raise ValueError("minimum_drawdown_scale must be in (0, 1]")
        if self.risk.asset_groups and not (
            0 < self.risk.max_group_weight <= self.risk.max_gross_leverage
        ):
            raise ValueError("max_group_weight must be positive and <= max_gross_leverage")
        if not self.strategy.name:
            raise ValueError("strategy.name is required")
        if not 0.5 <= self.research.train_fraction < 0.9:
            raise ValueError("research.train_fraction must be in [0.5, 0.9)")
        if self.research.minimum_trades < 0:
            raise ValueError("research.minimum_trades cannot be negative")
        if self.research.walk_forward_folds < 2:
            raise ValueError("research.walk_forward_folds must be >= 2")
        if self.research.bootstrap_samples < 100 or self.research.bootstrap_block_size < 1:
            raise ValueError("bootstrap requires >= 100 samples and a positive block size")
        if not self.research.cost_stress_multipliers or min(
            self.research.cost_stress_multipliers
        ) <= 0:
            raise ValueError("cost stress multipliers must be positive")
        paper = self.paper_trading
        if not paper.api_key_env or not paper.api_secret_env:
            raise ValueError("paper-trading credential environment-variable names are required")
        if not paper.order_prefix or len(paper.order_prefix) > 48:
            raise ValueError("paper_trading.order_prefix must be 1-48 characters")
        if paper.max_retries < 0 or paper.retry_backoff_seconds < 0:
            raise ValueError("paper-trading retry settings cannot be negative")
        if paper.reconciliation_tolerance < 0:
            raise ValueError("paper-trading reconciliation tolerance cannot be negative")
        if paper.data_feed not in {"iex", "sip", "delayed_sip"}:
            raise ValueError("paper_trading.data_feed must be iex, sip, or delayed_sip")


def load_config(path: str) -> SystemConfig:
    """Load and validate a UTF-8 YAML configuration file."""
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    if not isinstance(raw, dict):
        raise ValueError("Config root must be a mapping")
    return SystemConfig.from_dict(raw)
