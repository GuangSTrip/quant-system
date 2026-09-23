"""Freeze course ETF references from the configured read-only data providers.

CN: Tushare fund_daily + fund_adj. HK: AkShare stock_hk_daily(qfq),
whose upstream is Sina. Never serialize the Tushare credential.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import akshare as ak
import numpy as np
import pandas as pd
import tushare as ts

from fetch_daily_strategy_data import ROOT, token


def market_dates(research, market):
    return research['markets'][market]['dates']


def freeze(bars, dates, source, url, adjustment, symbol, name, market):
    by_date = {row['t']: row for row in bars}
    if len(by_date) != len(bars) or any(date not in by_date for date in dates):
        missing = [date for date in dates if date not in by_date]
        raise ValueError(f'{market}: duplicate/missing dates: {missing[:8]}')
    chosen = [by_date[date] for date in dates]
    if any(not all(np.isfinite(row[k]) and row[k] > 0 for k in ('o', 'c', 'turnover')) for row in chosen):
        raise ValueError(f'{market}: nonpositive adjusted OHLC or turnover')
    digest = hashlib.sha256(json.dumps(chosen, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    return {'market': market, 'symbol': symbol, 'name': name, 'source': source,
            'source_url': url, 'adjustment': adjustment, 'sha256_bars': digest,
            'bars': chosen}


def cn_fund(api, dates):
    start, end = dates[0].replace('-', ''), dates[-1].replace('-', '')
    daily = api.fund_daily(ts_code='510300.SH', start_date=start, end_date=end)
    factors = api.fund_adj(ts_code='510300.SH', start_date=start, end_date=end)
    if daily.empty or factors.empty:
        raise ValueError('CN: empty Tushare ETF prices or adjustment factors')
    if daily.trade_date.duplicated().any() or factors.trade_date.duplicated().any():
        raise ValueError('CN: duplicate Tushare ETF dates')
    joined = daily.merge(factors[['trade_date', 'adj_factor']], on='trade_date', validate='one_to_one')
    if len(joined) != len(daily) or joined.adj_factor.isna().any():
        raise ValueError('CN: incomplete ETF adjustment factors')
    joined = joined.sort_values('trade_date')
    latest = float(joined.adj_factor.iloc[-1])
    bars = [{'t': pd.Timestamp(row.trade_date).strftime('%Y-%m-%d'),
             'o': float(row.open * row.adj_factor / latest),
             'c': float(row.close * row.adj_factor / latest),
             'turnover': float(row.amount * 1000)}
            for row in joined.itertuples()]
    return freeze(bars, dates, 'Tushare fund_daily + fund_adj',
                  'https://tushare.pro/document/2?doc_id=127',
                  '每日基金复权因子调整价格；研究用前复权近似，ETF 费用包含在价格中',
                  '510300.SH', '华泰柏瑞沪深300ETF', 'CN')


def hk_fund(dates):
    frame = ak.stock_hk_daily(symbol='02800', adjust='qfq')
    if frame.empty:
        raise ValueError('HK: empty AkShare/Sina ETF history')
    bars = [{'t': str(row.date), 'o': float(row.open), 'c': float(row.close),
             'turnover': float(row.amount)} for row in frame.itertuples()]
    return freeze(bars, dates, f'AkShare {ak.__version__} / Sina HK qfq',
                  'https://github.com/akfamily/akshare/blob/main/akshare/stock/stock_hk_sina.py',
                  '供应商前复权价格；分红再投资口径未单独对账，收益是研究近似',
                  '2800.HK', '盈富基金 · 恒生指数ETF', 'HK')


def main():
    credential = token()
    if not credential:
        raise ValueError('Tushare credential not configured')
    report = json.loads((ROOT / 'web_platform/src/modular-daily-results.json').read_text(encoding='utf8'))
    api = ts.pro_api(credential)
    markets = {'CN': cn_fund(api, market_dates(report, 'CN')),
               'HK': hk_fund(market_dates(report, 'HK'))}
    out = ROOT / 'web_platform/src/course-regional-fund-inputs.json'
    out.write_text(json.dumps({'markets': markets}, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    for market, result in markets.items():
        print(market, result['symbol'], len(result['bars']), result['bars'][0]['t'], result['bars'][-1]['t'])


if __name__ == '__main__':
    main()
