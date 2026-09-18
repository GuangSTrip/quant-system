"""Publish compact, credential-free daily research results for the website."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web_platform" / "src" / "daily-library.json"
MARKETS = {"US": "US_SPY", "HK": "HK_0700_HK", "CN": "CN_600000_SH"}
STRATEGIES = ("donchian_vol", "time_series_momentum", "short_reversal")


def compact(run, detail=False):
    result = {key: run[key] for key in ("from", "to", "sessions", "cost_bps_each_side", "return_pct", "benchmark_pct", "max_drawdown_pct", "total_cost", "trade_count", "open_shares")}
    if detail:
        curve = run["curve"]
        result["curve"] = [p for i, p in enumerate(curve) if i % 5 == 0 or i == len(curve) - 1]
        result["trades"] = run["trades"]
    return result


def main():
    markets, reports = [], []
    for market, stem in MARKETS.items():
        meta = json.loads((ROOT / "data" / ("daily_adjusted" if market == "CN" else "daily") / f"{stem}.meta.json").read_text(encoding="utf-8"))
        meta.setdefault("qa", {"accepted_rows": meta.get("rows")})
        markets.append({key: meta[key] for key in ("market", "symbol", "source", "adjust", "fetched_at", "from", "to", "qa")})
        for strategy in STRATEGIES:
            raw = json.loads((ROOT / "reports" / "daily_strategy" / f"{stem}_{strategy}.json").read_text(encoding="utf-8"))
            assert raw["source_csv_sha256"] == meta["sha256_csv"]
            reports.append({key: raw[key] for key in ("market", "symbol", "strategy", "rules_version", "definition")} | {
                section: compact(raw[section], detail=section == "full") for section in ("full", "development", "holdout", "double_costs")
            })
    universe = json.loads((ROOT / "reports" / "daily_strategy" / "universe_summary.json").read_text(encoding="utf-8"))
    dynamic = json.loads((ROOT / "reports" / "dynamic_selection" / "report.json").read_text(encoding="utf-8"))
    dynamic_web = {"holdout_start": dynamic["holdout_start"], "rules": dynamic["rules"], "markets": {}}
    for market, group in dynamic["markets"].items():
        candidates = {}
        for name, result in group["candidates"].items():
            filled_decisions = [d for d in result["decisions"] if d["fill_date"] is not None]
            candidates[name] = {key: result[key] for key in ("full", "development", "holdout", "double_cost_holdout", "trade_count", "cost_total", "curve")}
            candidates[name]["latest_selection"] = filled_decisions[-1] if filled_decisions else None
        dynamic_web["markets"][market] = {"symbols": group["symbols"], "selected_on_development": group["selected_on_development"],
                                           "candidates": candidates, "benchmark": group["benchmark"]}
    risk = json.loads((ROOT / "reports" / "risk_budget" / "report.json").read_text(encoding="utf-8"))
    risk_web = {"target": risk["target"], "markets": {}}
    for market, group in risk["markets"].items():
        rule = dynamic["markets"][market]["selected_on_development"]
        variants = group["candidates"][rule]
        risk_web["markets"][market] = {
            "rule": rule,
            "development_target_met_by_any_variant": group["selected_on_development"] is not None,
            "variants": {name: {key: result[key] for key in ("development", "holdout", "full")}
                         for name, result in variants.items()},
        }
    coverage = []
    for market, symbols in universe["universe"].items():
        for symbol in symbols:
            meta_path = ROOT / "data" / ("daily_adjusted" if market == "CN" else "daily") / f"{market}_{symbol.replace('.', '_')}.meta.json"
            if not meta_path.exists():
                continue
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta.setdefault("qa", {"accepted_rows": meta.get("rows")})
            coverage.append({key: meta[key] for key in ("market", "symbol", "source", "adjust", "from", "to", "qa")})
    snapshot = {"generated_at": universe["generated_at"], "markets": markets, "coverage": coverage,
                "universe": {key: universe[key] for key in ("selection_note", "groups", "assets", "missing")},
                "dynamic": dynamic_web, "risk_budget": risk_web, "reports": reports}
    OUT.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT}: {len(reports)} reports")


if __name__ == "__main__":
    main()
