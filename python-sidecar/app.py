"""
FinSurfing Quant Sidecar
Python Flask microservice for heavy financial calculations.
Data source: FMP REST API (works on Railway — no Yahoo Finance IP block).

Endpoints:
  GET /health
  GET /indicators?symbol=AAPL
  GET /risk?symbols=AAPL,MSFT,GOOGL&period=252
  GET /greeks?symbol=AAPL&option_type=call&strike=200&expiry=2025-12-19
  GET /ratios?symbol=AAPL

Deploy on Railway as a separate service pointing to this directory.
Set env vars: FMP_API_KEY, PORT (default 5001).
"""

import os
import math
import time
import logging
from datetime import datetime, date
from functools import lru_cache
from typing import Optional

import numpy as np
import requests
from flask import Flask, jsonify, request
from flask_cors import CORS
from scipy.stats import norm

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

FMP_KEY  = os.environ.get('FMP_API_KEY', '')
FMP_BASE = 'https://financialmodelingprep.com/api/v3'
PORT     = int(os.environ.get('PORT', 5001))

# ── FMP helpers ───────────────────────────────────────────────────────────────

_fmp_cache: dict = {}
FMP_TTL = 300  # 5 min cache

def _fmp(path: str, params: dict = None) -> dict | list | None:
    key   = f"{path}|{params}"
    entry = _fmp_cache.get(key)
    if entry and time.time() - entry['ts'] < FMP_TTL:
        return entry['data']

    url = f"{FMP_BASE}{path}"
    p   = {'apikey': FMP_KEY, **(params or {})}
    try:
        r = requests.get(url, params=p, timeout=15)
        r.raise_for_status()
        data = r.json()
        _fmp_cache[key] = {'data': data, 'ts': time.time()}
        return data
    except Exception as e:
        log.warning(f"FMP {path}: {e}")
        return None


def _get_prices(symbol: str, days: int = 365) -> Optional[np.ndarray]:
    """Return closing price array (oldest first) from FMP historical data."""
    data = _fmp(f'/historical-price-full/{symbol}', {'timeseries': days})
    if not data or 'historical' not in data:
        return None
    hist = sorted(data['historical'], key=lambda x: x['date'])
    closes = [float(r['close']) for r in hist if r.get('close')]
    if len(closes) < 30:
        return None
    return np.array(closes)


def _get_multi_prices(symbols: list[str], days: int = 365) -> dict[str, np.ndarray]:
    """Return {symbol: np.array} for a list of symbols."""
    out = {}
    for sym in symbols:
        arr = _get_prices(sym, days)
        if arr is not None:
            out[sym] = arr
    return out


def _get_full_history(symbol: str, days: int = 365):
    """Return list of OHLCV dicts from FMP, sorted oldest first."""
    data = _fmp(f'/historical-price-full/{symbol}', {'timeseries': days})
    if not data or 'historical' not in data:
        return []
    return sorted(data['historical'], key=lambda x: x['date'])


# ── Technical indicator helpers ───────────────────────────────────────────────

def _ema(arr: np.ndarray, span: int) -> np.ndarray:
    k = 2.0 / (span + 1)
    out = np.empty(len(arr))
    out[0] = arr[0]
    for i in range(1, len(arr)):
        out[i] = arr[i] * k + out[i - 1] * (1 - k)
    return out


def _rsi(closes: np.ndarray, period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(closes)
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_g  = np.mean(gains[:period])
    avg_l  = np.mean(losses[:period])
    for g, l in zip(gains[period:], losses[period:]):
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
    return float(100 - 100 / (1 + avg_g / avg_l)) if avg_l else 100.0


def _atr(hist: list, period: int = 14) -> float:
    if len(hist) < period + 1:
        return 0.0
    trs = []
    for i in range(1, len(hist)):
        h, l, c_prev = float(hist[i]['high']), float(hist[i]['low']), float(hist[i - 1]['close'])
        trs.append(max(h - l, abs(h - c_prev), abs(l - c_prev)))
    return float(np.mean(trs[-period:]))


def _stoch_rsi(closes: np.ndarray, period: int = 14) -> Optional[float]:
    if len(closes) < period * 2:
        return None
    rsi_arr = []
    for i in range(period, len(closes)):
        rsi_arr.append(_rsi(closes[i - period: i + 1], period))
    if len(rsi_arr) < period:
        return None
    window = rsi_arr[-period:]
    lo, hi = min(window), max(window)
    return float((rsi_arr[-1] - lo) / (hi - lo) * 100) if hi != lo else 50.0


def _obv_trend(hist: list, window: int = 20) -> str:
    if len(hist) < window + 5:
        return 'neutral'
    obv = [0.0]
    for i in range(1, len(hist)):
        c, c_prev = float(hist[i]['close']), float(hist[i - 1]['close'])
        v = float(hist[i].get('volume') or 0)
        obv.append(obv[-1] + (v if c > c_prev else (-v if c < c_prev else 0)))
    recent_mean   = float(np.mean(obv[-5:]))
    previous_mean = float(np.mean(obv[-window:-5]))
    return 'rising' if recent_mean > previous_mean else 'falling'


# ── /health ────────────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({
        'status':  'ok',
        'service': 'quant-sidecar',
        'fmp_key': bool(FMP_KEY),
        'ts':      datetime.utcnow().isoformat() + 'Z',
    })


# ── /indicators ────────────────────────────────────────────────────────────────

@app.route('/indicators')
def indicators():
    symbol = request.args.get('symbol', '').upper().strip()
    if not symbol:
        return jsonify({'error': 'symbol required'}), 400
    if not FMP_KEY:
        return jsonify({'error': 'FMP_API_KEY not configured on sidecar'}), 503

    hist = _get_full_history(symbol, days=400)
    if not hist:
        return jsonify({'error': f'No price data for {symbol}'}), 404

    closes = np.array([float(r['close']) for r in hist])
    highs  = np.array([float(r['high'])  for r in hist])
    lows   = np.array([float(r['low'])   for r in hist])
    n      = len(closes)
    price  = float(closes[-1])

    # RSI (14)
    rsi = round(_rsi(closes), 2)

    # MACD (12, 26, 9)
    ema12        = _ema(closes, 12)
    ema26        = _ema(closes, 26)
    macd_line    = ema12 - ema26
    signal_line  = _ema(macd_line, 9)
    macd_val     = float(macd_line[-1])
    signal_val   = float(signal_line[-1])
    hist_val     = macd_val - signal_val

    # Bollinger Bands (20, 2)
    if n >= 20:
        sma20    = float(np.mean(closes[-20:]))
        std20    = float(np.std(closes[-20:]))
        bb_upper = sma20 + 2 * std20
        bb_lower = sma20 - 2 * std20
        bb_pct   = float((price - bb_lower) / (bb_upper - bb_lower)) if bb_upper != bb_lower else 0.5
        squeeze  = bool(std20 / sma20 < 0.02) if sma20 else False
    else:
        sma20 = bb_upper = bb_lower = price
        bb_pct = 0.5
        squeeze = False

    # ATR (14)
    atr = round(_atr(hist), 4)

    # EMA 50 & 200
    ema50  = round(float(_ema(closes, 50)[-1]),  4)
    ema200 = round(float(_ema(closes, 200)[-1]), 4) if n >= 200 else None

    # Stoch RSI (14)
    stoch_rsi = _stoch_rsi(closes)

    # OBV trend
    obv_trend = _obv_trend(hist)

    # Annualized volatility
    returns    = np.diff(np.log(closes))
    volatility = round(float(np.std(returns) * math.sqrt(252)), 4)

    # Volume (last bar vs 20-bar avg)
    vols = [float(r.get('volume') or 0) for r in hist]
    vol_ratio = round(vols[-1] / np.mean(vols[-20:]), 2) if np.mean(vols[-20:]) else None

    return jsonify({
        'symbol':    symbol,
        'price':     round(price, 4),
        'rsi':       rsi,
        'rsi_signal': 'overbought' if rsi > 70 else ('oversold' if rsi < 30 else 'neutral'),
        'macd': {
            'macd':   round(macd_val,   4),
            'signal': round(signal_val, 4),
            'hist':   round(hist_val,   4),
            'trend':  'bullish' if hist_val > 0 else 'bearish',
        },
        'bollinger': {
            'upper':   round(bb_upper, 4),
            'middle':  round(sma20,    4),
            'lower':   round(bb_lower, 4),
            'pct_b':   round(bb_pct,   4),
            'squeeze': squeeze,
        },
        'atr':       atr,
        'ema50':     ema50,
        'ema200':    ema200,
        'stoch_rsi': round(stoch_rsi, 2) if stoch_rsi is not None else None,
        'obv_trend': obv_trend,
        'volatility_annualized': volatility,
        'volume_ratio': vol_ratio,
        'trend': {
            'above_ema50':  bool(price > ema50),
            'above_ema200': bool(ema200 and price > ema200),
            'golden_cross': bool(ema200 and ema50 > ema200),
            'death_cross':  bool(ema200 and ema50 < ema200),
        },
        'fetchedAt': datetime.utcnow().isoformat() + 'Z',
    })


# ── /risk ──────────────────────────────────────────────────────────────────────

@app.route('/risk')
def risk():
    symbols_raw = request.args.get('symbols', '')
    period      = min(int(request.args.get('period', 252)), 1260)  # max 5y
    if not symbols_raw:
        return jsonify({'error': 'symbols required (comma-separated)'}), 400
    if not FMP_KEY:
        return jsonify({'error': 'FMP_API_KEY not configured on sidecar'}), 503

    symbols = [s.strip().upper() for s in symbols_raw.split(',') if s.strip()][:20]
    price_data = _get_multi_prices(symbols + ['SPY'], days=period + 30)

    spy_ret = None
    if 'SPY' in price_data and len(price_data['SPY']) > 2:
        spy_ret = np.diff(np.log(price_data['SPY']))

    results = {}
    for sym in symbols:
        if sym not in price_data or len(price_data[sym]) < 30:
            results[sym] = {'error': 'Insufficient data'}
            continue

        prices  = price_data[sym][-period - 1:]
        returns = np.diff(np.log(prices))
        n       = len(returns)

        ann_ret = float(np.mean(returns) * 252)
        ann_vol = float(np.std(returns)  * math.sqrt(252))
        sharpe  = round(ann_ret / ann_vol, 4) if ann_vol else 0.0

        var_95 = round(float(np.percentile(returns, 5)),  4)
        var_99 = round(float(np.percentile(returns, 1)),  4)

        cum   = np.cumprod(1 + returns)
        peak  = np.maximum.accumulate(cum)
        dd    = (cum - peak) / peak
        max_dd = round(float(np.min(dd)), 4)
        calmar = round(ann_ret / abs(max_dd), 4) if max_dd else 0.0

        beta = 1.0
        if spy_ret is not None:
            min_len = min(len(returns), len(spy_ret))
            if min_len > 30:
                cov = np.cov(returns[-min_len:], spy_ret[-min_len:])
                if cov[1, 1]:
                    beta = round(float(cov[0, 1] / cov[1, 1]), 4)

        # Sortino ratio (downside deviation)
        downside   = returns[returns < 0]
        down_std   = float(np.std(downside) * math.sqrt(252)) if len(downside) > 2 else ann_vol
        sortino    = round(ann_ret / down_std, 4) if down_std else 0.0

        # Win rate
        win_rate = round(float(np.sum(returns > 0) / n), 4) if n else 0.5

        results[sym] = {
            'annualized_return':    round(ann_ret, 4),
            'annualized_volatility': round(ann_vol, 4),
            'sharpe_ratio':          sharpe,
            'sortino_ratio':         sortino,
            'var_95_1day':           var_95,
            'var_99_1day':           var_99,
            'max_drawdown':          max_dd,
            'calmar_ratio':          calmar,
            'beta_vs_spy':           beta,
            'win_rate':              win_rate,
            'bars':                  n,
        }

    return jsonify({
        'symbols':     symbols,
        'period_days': period,
        'results':     results,
        'fetchedAt':   datetime.utcnow().isoformat() + 'Z',
    })


# ── /greeks ────────────────────────────────────────────────────────────────────

@app.route('/greeks')
def greeks():
    """Black-Scholes options Greeks. Uses historical vol as proxy for IV."""
    symbol      = request.args.get('symbol', '').upper().strip()
    option_type = request.args.get('option_type', 'call').lower()
    strike_str  = request.args.get('strike', '')
    expiry_str  = request.args.get('expiry', '')   # YYYY-MM-DD
    price_str   = request.args.get('price',  '')   # optional spot price override
    risk_free   = float(request.args.get('r', '0.05'))  # risk-free rate

    if not all([symbol, strike_str, expiry_str]):
        return jsonify({'error': 'symbol, strike, and expiry required'}), 400
    if option_type not in ('call', 'put'):
        return jsonify({'error': 'option_type must be call or put'}), 400
    if not FMP_KEY:
        return jsonify({'error': 'FMP_API_KEY not configured on sidecar'}), 503

    K = float(strike_str)
    try:
        expiry_date = datetime.strptime(expiry_str, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({'error': 'expiry must be YYYY-MM-DD'}), 400

    T = (expiry_date - date.today()).days / 365.0
    if T <= 0:
        return jsonify({'error': 'Option has expired (expiry date is in the past)'}), 400

    if price_str:
        S = float(price_str)
    else:
        closes = _get_prices(symbol, days=5)
        if closes is None:
            return jsonify({'error': f'Could not fetch spot price for {symbol}'}), 404
        S = float(closes[-1])

    # Historical volatility (90-day) as IV proxy
    hist_closes = _get_prices(symbol, days=120)
    if hist_closes is not None and len(hist_closes) >= 30:
        sigma = float(np.std(np.diff(np.log(hist_closes))) * math.sqrt(252))
    else:
        sigma = 0.30  # fallback 30%

    r = risk_free
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)

    if option_type == 'call':
        opt_price = S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)
        delta     = norm.cdf(d1)
        rho       = K * T * math.exp(-r * T) * norm.cdf(d2) / 100
    else:
        opt_price = K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)
        delta     = norm.cdf(d1) - 1
        rho       = -K * T * math.exp(-r * T) * norm.cdf(-d2) / 100

    gamma = norm.pdf(d1) / (S * sigma * math.sqrt(T))
    vega  = S * norm.pdf(d1) * math.sqrt(T) / 100   # per 1% change in vol
    theta = (-S * norm.pdf(d1) * sigma / (2 * math.sqrt(T))
             - r * K * math.exp(-r * T) * (norm.cdf(d2) if option_type == 'call' else norm.cdf(-d2))
             ) / 365

    return jsonify({
        'symbol':          symbol,
        'option_type':     option_type,
        'spot':            round(S, 4),
        'strike':          K,
        'expiry':          expiry_str,
        'days_to_expiry':  (expiry_date - date.today()).days,
        'risk_free_rate':  r,
        'implied_vol_proxy': round(sigma, 4),
        'option_price':    round(opt_price, 4),
        'greeks': {
            'delta': round(delta, 4),
            'gamma': round(gamma, 6),
            'theta': round(theta, 4),
            'vega':  round(vega,  4),
            'rho':   round(rho,   4),
        },
        'fetchedAt': datetime.utcnow().isoformat() + 'Z',
    })


# ── /ratios ────────────────────────────────────────────────────────────────────

@app.route('/ratios')
def ratios():
    symbol = request.args.get('symbol', '').upper().strip()
    if not symbol:
        return jsonify({'error': 'symbol required'}), 400
    if not FMP_KEY:
        return jsonify({'error': 'FMP_API_KEY not configured on sidecar'}), 503

    profile_data = _fmp(f'/profile/{symbol}')
    ratios_data  = _fmp(f'/ratios/{symbol}', {'limit': 1})
    metrics_data = _fmp(f'/key-metrics/{symbol}', {'limit': 1})
    growth_data  = _fmp(f'/financial-growth/{symbol}', {'limit': 1})

    profile  = (profile_data or [{}])[0]
    ratio    = (ratios_data  or [{}])[0]
    metrics  = (metrics_data or [{}])[0]
    growth   = (growth_data  or [{}])[0]

    def g(obj, *keys):
        for k in keys:
            v = obj.get(k)
            if v is not None:
                try: return round(float(v), 4)
                except: return v
        return None

    return jsonify({
        'symbol':   symbol,
        'name':     profile.get('companyName'),
        'sector':   profile.get('sector'),
        'industry': profile.get('industry'),
        'exchange': profile.get('exchangeShortName'),
        'valuation': {
            'pe_trailing':    g(ratio,   'priceEarningsRatio'),
            'pe_forward':     g(metrics, 'peRatio'),
            'price_to_book':  g(ratio,   'priceToBookRatio'),
            'price_to_sales': g(ratio,   'priceToSalesRatio'),
            'ev_to_ebitda':   g(metrics, 'evToEbitda', 'enterpriseValueOverEBITDA'),
            'ev_to_revenue':  g(metrics, 'evToSales',  'enterpriseValueOverRevenue'),
            'peg_ratio':      g(ratio,   'priceEarningsToGrowthRatio'),
        },
        'profitability': {
            'gross_margin':     g(ratio, 'grossProfitMargin'),
            'operating_margin': g(ratio, 'operatingProfitMargin'),
            'net_margin':       g(ratio, 'netProfitMargin'),
            'roe':              g(ratio, 'returnOnEquity'),
            'roa':              g(ratio, 'returnOnAssets'),
            'roic':             g(metrics, 'roic'),
        },
        'growth': {
            'revenue_growth':   g(growth, 'revenueGrowth'),
            'eps_growth':       g(growth, 'epsgrowth'),
            'net_income_growth': g(growth, 'netIncomeGrowth'),
            'fcf_growth':       g(growth, 'freeCashFlowGrowth'),
        },
        'financial_health': {
            'current_ratio':  g(ratio, 'currentRatio'),
            'quick_ratio':    g(ratio, 'quickRatio'),
            'debt_to_equity': g(ratio, 'debtEquityRatio'),
            'interest_coverage': g(ratio, 'interestCoverage'),
            'cash_per_share':    g(metrics, 'cashPerShare'),
        },
        'dividend': {
            'yield':        g(ratio, 'dividendYield'),
            'payout_ratio': g(ratio, 'payoutRatio'),
            'per_share':    g(metrics, 'dividendPerShare'),
        },
        'market': {
            'price':          g(profile, 'price'),
            'market_cap':     g(profile, 'mktCap'),
            'beta':           g(profile, 'beta'),
            'high_52w':       g(profile, '52WeekHigh'),
            'low_52w':        g(profile, '52WeekLow'),
            'avg_volume':     g(profile, 'volAvg'),
            'shares_outstanding': g(profile, 'sharesOutstanding'),
        },
        'fetchedAt': datetime.utcnow().isoformat() + 'Z',
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=PORT, debug=False)
