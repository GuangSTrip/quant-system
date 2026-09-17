"""Market-data loading, validation, and deterministic demo generation."""

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd


REQUIRED_COLUMNS = ("timestamp", "symbol", "open", "high", "low", "close", "volume")


def validate_bars(frame: pd.DataFrame) -> pd.DataFrame:
    """Return normalized long-form OHLCV bars or raise a useful error."""
    missing = set(REQUIRED_COLUMNS) - set(frame.columns)
    if missing:
        raise ValueError("Missing market-data columns: %s" % sorted(missing))

    bars = frame.loc[:, REQUIRED_COLUMNS].copy()
    bars["timestamp"] = pd.to_datetime(bars["timestamp"], errors="raise")
    bars["symbol"] = bars["symbol"].astype(str)
    numeric = ["open", "high", "low", "close", "volume"]
    bars[numeric] = bars[numeric].apply(pd.to_numeric, errors="raise")
    if bars.empty:
        raise ValueError("Market data is empty")
    if bars[["open", "high", "low", "close"]].le(0).any().any():
        raise ValueError("OHLC prices must be positive")
    if bars["volume"].lt(0).any():
        raise ValueError("Volume cannot be negative")
    if (bars["high"] < bars[["open", "close", "low"]].max(axis=1)).any():
        raise ValueError("High price is inconsistent with OHLC values")
    if (bars["low"] > bars[["open", "close", "high"]].min(axis=1)).any():
        raise ValueError("Low price is inconsistent with OHLC values")
    if bars.duplicated(["timestamp", "symbol"]).any():
        raise ValueError("Duplicate timestamp/symbol rows found")
    return bars.sort_values(["timestamp", "symbol"]).reset_index(drop=True)


def data_quality_report(frame: pd.DataFrame) -> Dict[str, Any]:
    """Summarize coverage and suspicious observations after structural validation."""
    bars = validate_bars(frame)
    all_dates = pd.Index(sorted(bars["timestamp"].unique()))
    symbol_reports = {}
    for symbol, group in bars.groupby("symbol"):
        group = group.sort_values("timestamp")
        returns = group["close"].pct_change()
        missing_dates = len(all_dates.difference(pd.Index(group["timestamp"])))
        stale = group["close"].eq(group["close"].shift())
        symbol_reports[str(symbol)] = {
            "rows": int(len(group)),
            "start": pd.Timestamp(group["timestamp"].iloc[0]).isoformat(),
            "end": pd.Timestamp(group["timestamp"].iloc[-1]).isoformat(),
            "missing_union_dates": int(missing_dates),
            "zero_volume_rows": int(group["volume"].eq(0).sum()),
            "stale_close_rows": int(stale.sum()),
            "absolute_return_over_20pct": int(returns.abs().gt(0.20).sum()),
        }
    return {
        "rows": int(len(bars)),
        "symbols": int(bars["symbol"].nunique()),
        "timestamps": int(len(all_dates)),
        "duplicate_rows": 0,
        "symbol_details": symbol_reports,
    }


def load_csv(path: str) -> pd.DataFrame:
    """Load long-form OHLCV bars from CSV."""
    return validate_bars(pd.read_csv(Path(path)))


def verify_file_sha256(path: str, expected_sha256: str) -> None:
    """Reject a local snapshot when it does not match its frozen checksum."""
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if digest.lower() != expected_sha256.lower():
        raise ValueError(
            "Market-data checksum mismatch for %s: expected %s, got %s"
            % (path, expected_sha256, digest)
        )


def load_yahoo_wide_csv(path: str) -> pd.DataFrame:
    """Load a two-level yfinance CSV and return adjusted long-form OHLCV bars.

    ``yfinance.download`` writes fields on the first header row and tickers on
    the second.  OHLC values are multiplied by Adj Close / Close so prices are
    continuous across distributions and splits; volume is left unchanged.
    """
    source = Path(path)
    wide = pd.read_csv(source, header=[0, 1], index_col=0)
    if not isinstance(wide.columns, pd.MultiIndex):
        raise ValueError("Yahoo wide CSV must have field and ticker header rows")

    fields = {str(value).strip() for value in wide.columns.get_level_values(0)}
    required = {"Adj Close", "Close", "Open", "High", "Low", "Volume"}
    missing = required - fields
    if missing:
        raise ValueError("Yahoo wide CSV is missing fields: %s" % sorted(missing))

    timestamps = pd.to_datetime(wide.index, errors="coerce")
    frames = []
    symbols = sorted(
        {
            str(value).strip().upper()
            for field, value in wide.columns
            if str(field).strip() in required and str(value).strip()
        }
    )
    for symbol in symbols:
        columns = {}
        for field in required:
            key = (field, symbol)
            if key not in wide.columns:
                raise ValueError("Yahoo wide CSV is missing %s for %s" % (field, symbol))
            columns[field] = pd.to_numeric(wide[key], errors="coerce").to_numpy(dtype=float)
        factor = np.divide(
            columns["Adj Close"],
            columns["Close"],
            out=np.full(len(wide), np.nan),
            where=np.isfinite(columns["Close"]) & (columns["Close"] != 0),
        )
        adjusted_open = columns["Open"] * factor
        adjusted_close = columns["Adj Close"]
        # Independent floating-point multiplication can put an adjusted high
        # below close (or low above it) by ~1e-14. Preserve the price envelope.
        adjusted_high = np.maximum.reduce(
            [columns["High"] * factor, adjusted_open, adjusted_close]
        )
        adjusted_low = np.minimum.reduce(
            [columns["Low"] * factor, adjusted_open, adjusted_close]
        )
        frame = pd.DataFrame(
            {
                "timestamp": timestamps,
                "symbol": symbol,
                "open": adjusted_open,
                "high": adjusted_high,
                "low": adjusted_low,
                "close": adjusted_close,
                "volume": columns["Volume"],
            }
        ).dropna()
        frames.append(frame)
    if not frames:
        raise ValueError("Yahoo wide CSV contains no ticker data")
    return validate_bars(pd.concat(frames, ignore_index=True))


def align_panel(frame: pd.DataFrame, method: str = "union") -> pd.DataFrame:
    """Align a multi-asset panel without synthesizing prices."""
    bars = validate_bars(frame)
    if method == "union":
        return bars
    if method != "intersection":
        raise ValueError("panel_alignment must be union or intersection")
    counts = bars.groupby("timestamp")["symbol"].nunique()
    required = bars["symbol"].nunique()
    common_dates = counts.index[counts == required]
    aligned = bars.loc[bars["timestamp"].isin(common_dates)].copy()
    if aligned.empty:
        raise ValueError("No common timestamps across all symbols")
    return aligned.reset_index(drop=True)


def generate_synthetic_data(
    symbols: Iterable[str],
    start: str = "2020-01-01",
    periods: int = 756,
    seed: int = 7,
    drift: float = 0.00025,
    volatility: float = 0.012,
    autocorrelation: float = 0.0,
) -> pd.DataFrame:
    """Generate reproducible business-day OHLCV data for demos and tests."""
    symbols = list(symbols)
    if not symbols:
        raise ValueError("At least one symbol is required")
    if periods < 2 or volatility < 0 or not -0.95 < autocorrelation < 0.95:
        raise ValueError("invalid periods, volatility, or autocorrelation")

    dates = pd.bdate_range(start=start, periods=periods)
    rows = []
    for index, symbol in enumerate(symbols):
        rng = np.random.default_rng(seed + index * 1009)
        overnight = rng.normal(drift * 0.25, volatility * 0.35, periods)
        shocks = rng.normal(0.0, volatility * 0.9, periods)
        intraday = np.empty(periods)
        previous_return = drift * 0.75
        for i, shock in enumerate(shocks):
            intraday[i] = (
                drift * 0.75
                + autocorrelation * (previous_return - drift * 0.75)
                + shock * np.sqrt(1.0 - autocorrelation**2)
            )
            previous_return = intraday[i]
        open_prices = np.empty(periods)
        close_prices = np.empty(periods)
        previous_close = 80.0 + index * 35.0
        for i in range(periods):
            open_prices[i] = previous_close * np.exp(overnight[i])
            close_prices[i] = open_prices[i] * np.exp(intraday[i])
            previous_close = close_prices[i]
        spread = np.abs(rng.normal(0.004, 0.002, periods))
        highs = np.maximum(open_prices, close_prices) * (1.0 + spread)
        lows = np.minimum(open_prices, close_prices) * np.maximum(0.01, 1.0 - spread)
        volumes = rng.integers(500_000, 5_000_000, periods)
        rows.extend(
            zip(dates, [symbol] * periods, open_prices, highs, lows, close_prices, volumes)
        )
    return validate_bars(pd.DataFrame(rows, columns=REQUIRED_COLUMNS))


def load_stooq(
    symbols: List[str], start: str = "2005-01-01", end: str = "2099-12-31"
) -> pd.DataFrame:
    """Download daily bars from Stooq's public CSV endpoint.

    This is intentionally optional: research remains reproducible from local CSV files.
    Symbols use Stooq notation such as ``SPY.US`` or ``QQQ.US``.
    """
    if not symbols:
        raise ValueError("At least one Stooq symbol is required")
    frames = []
    for symbol in symbols:
        query = urlencode(
            {
                "s": symbol.lower(),
                "d1": pd.Timestamp(start).strftime("%Y%m%d"),
                "d2": pd.Timestamp(end).strftime("%Y%m%d"),
                "i": "d",
            }
        )
        url = "https://stooq.com/q/d/l/?" + query
        with urlopen(url, timeout=30) as response:
            frame = pd.read_csv(response)
        expected = {"Date", "Open", "High", "Low", "Close", "Volume"}
        if not expected.issubset(frame.columns):
            raise ValueError("Stooq returned no valid data for %s" % symbol)
        frame = frame.rename(
            columns={
                "Date": "timestamp",
                "Open": "open",
                "High": "high",
                "Low": "low",
                "Close": "close",
                "Volume": "volume",
            }
        )
        frame["symbol"] = symbol.upper()
        frames.append(frame.loc[:, REQUIRED_COLUMNS])
    return validate_bars(pd.concat(frames, ignore_index=True))


def load_yahoo(
    symbols: List[str], start: str = "2005-01-01", end: str = "2099-12-31"
) -> pd.DataFrame:
    """Download split/dividend-adjusted daily bars from Yahoo's chart endpoint."""
    if not symbols:
        raise ValueError("At least one Yahoo symbol is required")
    start_epoch = int(pd.Timestamp(start, tz="UTC").timestamp())
    end_epoch = int((pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)).timestamp())
    frames = []
    for symbol in symbols:
        query = urlencode(
            {
                "period1": start_epoch,
                "period2": end_epoch,
                "interval": "1d",
                "events": "history",
                "includeAdjustedClose": "true",
            }
        )
        url = "https://query1.finance.yahoo.com/v8/finance/chart/%s?%s" % (symbol, query)
        request = Request(url, headers={"User-Agent": "Mozilla/5.0 quant-research/0.1"})
        with urlopen(request, timeout=30) as response:
            payload = json.load(response)
        result = payload.get("chart", {}).get("result")
        if not result:
            raise ValueError("Yahoo returned no valid data for %s" % symbol)
        result = result[0]
        quotes = result["indicators"]["quote"][0]
        adjusted = result["indicators"].get("adjclose", [{}])[0].get("adjclose")
        close = np.asarray(quotes["close"], dtype=float)
        factor = np.ones(len(close))
        if adjusted is not None:
            adjusted_array = np.asarray(adjusted, dtype=float)
            factor = np.divide(
                adjusted_array,
                close,
                out=np.ones(len(close)),
                where=np.isfinite(close) & (close != 0),
            )
        frame = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(result["timestamp"], unit="s", utc=True).tz_localize(None),
                "symbol": symbol.upper(),
                "open": np.asarray(quotes["open"], dtype=float) * factor,
                "high": np.asarray(quotes["high"], dtype=float) * factor,
                "low": np.asarray(quotes["low"], dtype=float) * factor,
                "close": close * factor,
                "volume": quotes["volume"],
            }
        ).dropna()
        frames.append(frame)
    return validate_bars(pd.concat(frames, ignore_index=True))


def load_data(config: Dict[str, Any]) -> pd.DataFrame:
    """Construct a data source from the config's ``data`` section."""
    source_type = config.get("type", "synthetic")
    cache_path = config.get("cache_path")
    if cache_path and config.get("prefer_cache", True) and Path(cache_path).exists():
        return align_panel(load_csv(cache_path), config.get("panel_alignment", "union"))

    def finish(frame: pd.DataFrame) -> pd.DataFrame:
        if cache_path:
            destination = Path(cache_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            frame.to_csv(destination, index=False)
        return align_panel(frame, config.get("panel_alignment", "union"))

    if source_type == "csv":
        path = config.get("path")
        if not path:
            raise ValueError("data.path is required for CSV data")
        return load_csv(path)
    if source_type == "yahoo_wide_csv":
        path = config.get("path")
        if not path:
            raise ValueError("data.path is required for yahoo_wide_csv data")
        expected_sha256 = config.get("sha256")
        if expected_sha256:
            verify_file_sha256(path, str(expected_sha256))
        frame = load_yahoo_wide_csv(path)
        requested = [str(symbol).upper() for symbol in config.get("symbols", [])]
        if requested:
            missing = sorted(set(requested) - set(frame["symbol"].unique()))
            if missing:
                raise ValueError("Yahoo wide CSV is missing configured symbols: %s" % missing)
            frame = frame.loc[frame["symbol"].isin(requested)].copy()
        if config.get("start"):
            frame = frame.loc[frame["timestamp"] >= pd.Timestamp(config["start"])].copy()
        if config.get("end"):
            frame = frame.loc[frame["timestamp"] <= pd.Timestamp(config["end"])].copy()
        if frame.empty:
            raise ValueError("No yahoo_wide_csv rows remain after symbol/date filtering")
        return align_panel(frame, config.get("panel_alignment", "union"))
    if source_type == "synthetic":
        return finish(generate_synthetic_data(
            symbols=config.get("symbols", ["AAA", "BBB", "CCC"]),
            start=config.get("start", "2020-01-01"),
            periods=int(config.get("periods", 756)),
            seed=int(config.get("seed", 7)),
            drift=float(config.get("drift", 0.00025)),
            volatility=float(config.get("volatility", 0.012)),
            autocorrelation=float(config.get("autocorrelation", 0.0)),
        ))
    if source_type == "stooq":
        return finish(load_stooq(
            symbols=list(config.get("symbols", [])),
            start=config.get("start", "2005-01-01"),
            end=config.get("end", "2099-12-31"),
        ))
    if source_type == "yahoo":
        return finish(load_yahoo(
            symbols=list(config.get("symbols", [])),
            start=config.get("start", "2005-01-01"),
            end=config.get("end", "2099-12-31"),
        ))
    raise ValueError("Unsupported data.type: %s" % source_type)
