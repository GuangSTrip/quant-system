"""Freeze same-universe, same-calendar initial-basket buy-and-hold references."""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from evaluate_modular_daily import CASH, START, execute, prepare
from evaluate_dynamic_stock_selection import metrics


def buy_and_hold(study):
    panel = study.panel
    ids = study.selections['benchmark'][START]
    target = np.zeros(len(panel.symbols))
    target[ids] = .8 / len(ids)
    units = np.zeros(len(panel.symbols))
    cash = CASH
    cost = traded = 0.
    trades = 0
    curve = []
    fee = {'CN': .0015, 'HK': .002, 'US': .001}[study.market]
    for day in range(START, len(panel.dates)):
        expired = (study.dead <= int(panel.dates[day].replace('-', ''))) & (units > 0)
        units[expired] = 0
        if day == START + 1:
            cash, cost, traded, trades = execute(study, day, target, cash, units, fee)
        equity = cash + np.nansum(np.nan_to_num(panel.valuation[day], nan=0.) * units)
        curve.append({'date': panel.dates[day], 'equity': float(equity)})
    return {'dates': panel.dates[START:],
            'equity': [round(row['equity'] / CASH, 6) for row in curve],
            'full': metrics(curve), 'cost': round(cost, 2),
            'traded_notional': round(traded, 2), 'trade_count': trades,
            'initial_symbols': [panel.symbols[i] for i in ids]}


def main():
    output = {'method': 'First eligible session: choose the 100 most liquid eligible stocks; at the next open buy up to 80% equally, with the same proportional fee and previous-day 1% liquidity cap. Hold without rebalancing; 20% or more remains cash, no interest. Adjusted fractional prices and delisting writeoffs match the research engine.',
              'initial_capital': CASH, 'markets': {}}
    for market in ('CN', 'HK', 'US'):
        output['markets'][market] = buy_and_hold(prepare(market))
        print('buy and hold', market, output['markets'][market]['full'], flush=True)
    (ROOT / 'web_platform' / 'src' / 'course-benchmarks.json').write_text(
        json.dumps(output, ensure_ascii=False, separators=(',', ':')), encoding='utf8')


if __name__ == '__main__':
    main()
