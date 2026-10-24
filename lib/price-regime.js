'use strict'

/**
 * lib/price-regime.js — the market regime read from PRICES, next to the FRED
 * macro regime.
 *
 * The macro regime (routes/macro.js) moves monthly and says nothing about the
 * tape: a "late-cycle" label covered both the 2018 Q4 drawdown and the 2019
 * rally. This reads trend and volatility from the benchmark's own daily bars —
 * SPY for stocks/ETFs/funds, BTC-USD for crypto:
 *
 *   trend  up     close above its 200-day average AND the 50-day average
 *                 higher than 20 days ago
 *          down   close below the 200-day AND the 50-day falling
 *          range  anything else (the two disagree)
 *   vol    stressed  20-day realized volatility above the 75th percentile of
 *                    its own past year
 *          calm      otherwise
 *
 * Label = `${trend}-${vol}`, six states. Rules rather than a fitted HMM on
 * purpose: a fitted model refits its states as data arrives, so "regime 2"
 * last month and "regime 2" today need not be the same market, and a
 * calibration segment keyed on it would pool different things.
 *
 * WALK-FORWARD BY CONSTRUCTION: the label at bar i reads bars 0…i only —
 * averages, the volatility and the percentile it is ranked against all end at
 * i. Appending future bars can never change a past label; tests pin it. The
 * percentile is the stock's OWN past year, so "stressed" means elevated for
 * that market, not above a fixed number that suits SPY and never fires on BTC.
 *
 * `forwardProfile` says what followed each state historically, sampled every
 * `horizon` bars so the windows do not overlap (overlapping 20-day windows
 * would count one move twenty times).
 *
 * Pure except `getCurrentRegimes` (fetches, 1h cache). Tests: tests/price-regime.test.js
 */

const VOL_WIN      = 20
const VOL_LOOKBACK = 252
const STRESS_PCT   = 0.75
const SLOPE_BARS   = 20
// First index with a full year of volatility history: vol needs VOL_WIN
// returns, and its percentile needs VOL_LOOKBACK of those.
const MIN_INDEX    = VOL_WIN + VOL_LOOKBACK - 1
const CACHE_MS     = 60 * 60 * 1000

function rollingMean(xs, n) {
  const out = new Array(xs.length).fill(null)
  let s = 0
  for (let i = 0; i < xs.length; i++) {
    s += xs[i]
    if (i >= n) s -= xs[i - n]
    if (i >= n - 1) out[i] = s / n
  }
  return out
}

/** Annualized 20-day realized vol (percent) at every bar, from returns ending there. */
function volSeries(closes) {
  const out = new Array(closes.length).fill(null)
  for (let i = VOL_WIN; i < closes.length; i++) {
    const r = []
    for (let k = i - VOL_WIN + 1; k <= i; k++) if (closes[k - 1] > 0 && closes[k] > 0) r.push(Math.log(closes[k] / closes[k - 1]))
    if (r.length < VOL_WIN * 0.8) continue
    const m = r.reduce((a, b) => a + b, 0) / r.length
    out[i] = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100
  }
  return out
}

/**
 * The regime at every bar (null before MIN_INDEX). Each entry uses bars ≤ i.
 * @param {Array<{t,c}>} bars ascending daily bars
 */
function regimeSeries(bars) {
  const closes = (bars || []).map(b => b.c)
  const sma200 = rollingMean(closes, 200)
  const sma50  = rollingMean(closes, 50)
  const vol    = volSeries(closes)
  return closes.map((c, i) => {
    if (i < MIN_INDEX || sma200[i] == null || sma50[i - SLOPE_BARS] == null || vol[i] == null) return null
    const rising = sma50[i] > sma50[i - SLOPE_BARS]
    const trend = c > sma200[i] && rising ? 'up' : c < sma200[i] && !rising ? 'down' : 'range'
    const past = vol.slice(i - VOL_LOOKBACK + 1, i + 1).filter(v => v != null)
    const volPct = past.filter(v => v <= vol[i]).length / past.length
    const state = volPct > STRESS_PCT ? 'stressed' : 'calm'
    return {
      label: `${trend}-${state}`, trend, vol: state,
      vol20: +vol[i].toFixed(1), volPct: Math.round(volPct * 100),
      vsSma200: +((c / sma200[i] - 1) * 100).toFixed(1),
      asOf: bars[i].t != null ? new Date(bars[i].t).toISOString().slice(0, 10) : null,
    }
  })
}

/** The regime at the last bar, or null with too little history. */
function regimeAt(bars) {
  const s = regimeSeries(bars)
  return s.at(-1) ?? null
}

/**
 * What followed each state: forward `horizon`-bar return and realized vol,
 * from non-overlapping windows (every `horizon`th bar). Descriptive — it says
 * whether the states separate markets at all, not that a strategy works.
 */
function forwardProfile(bars, { horizon = 20 } = {}) {
  const series = regimeSeries(bars)
  const closes = bars.map(b => b.c)
  const vol = volSeries(closes)
  const by = {}
  for (let i = MIN_INDEX; i + horizon < closes.length; i += horizon) {
    const r = series[i]
    if (!r) continue
    const fwd = (closes[i + horizon] / closes[i] - 1) * 100
    const fv = vol[i + horizon]
    const b = by[r.label] ||= { n: 0, up: 0, sumRet: 0, sumVol: 0, nVol: 0 }
    b.n++; if (fwd > 0) b.up++; b.sumRet += fwd
    if (fv != null) { b.sumVol += fv; b.nVol++ }
  }
  return Object.fromEntries(Object.entries(by).map(([label, b]) => [label, {
    n: b.n,
    meanFwdRet: +(b.sumRet / b.n).toFixed(2),
    upShare: +(b.up / b.n).toFixed(2),
    meanFwdVol: b.nVol ? +(b.sumVol / b.nVol).toFixed(1) : null,
  }]))
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st … */
function ordinal(n) {
  const k = Math.abs(n) % 100
  return `${n}${k >= 11 && k <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th')}`
}

/** One sentence for prompts/evidence. Pure. */
function describe(r, symbol) {
  if (!r) return null
  const trend = { up: 'uptrend', down: 'downtrend', range: 'no clear trend' }[r.trend]
  return `${symbol}: ${trend}, ${r.vol} volatility (20-day vol ${r.vol20}%, ${ordinal(r.volPct)} percentile of its past year; ${r.vsSma200 >= 0 ? '+' : ''}${r.vsSma200}% vs its 200-day average, as of ${r.asOf}).`
}

const BENCH = { equity: 'SPY', crypto: 'BTC-USD' }
let _cache = null

/**
 * Current regimes for stocks (SPY) and crypto (BTC-USD), with each one's
 * forward profile. `fetchBars(symbol)` → ascending daily bars (≥2y wanted).
 */
async function getCurrentRegimes({ fetchBars, now = Date.now(), force = false } = {}) {
  if (!force && _cache && now - _cache.at < CACHE_MS) return _cache.value
  const entries = await Promise.all(Object.entries(BENCH).map(async ([cls, sym]) => {
    try {
      const bars = await fetchBars(sym)
      const r = regimeAt(bars)
      return [cls, r && { symbol: sym, ...r, profile: forwardProfile(bars) }]
    } catch { return [cls, null] }
  }))
  const value = Object.fromEntries(entries)
  if (value.equity || value.crypto) _cache = { at: now, value }
  return value
}

/** Last fetched regimes without a network call (null before the first fetch). */
function cachedRegimes() { return _cache?.value ?? null }

/** The label that applies to an asset class ('crypto' → BTC, everything else → SPY). */
function labelFor(assetType, regimes) {
  const r = assetType === 'crypto' ? regimes?.crypto : regimes?.equity
  return r?.label ?? null
}

function _resetForTests() { _cache = null }

module.exports = {
  MIN_INDEX, STRESS_PCT, BENCH,
  regimeSeries, regimeAt, forwardProfile, describe, ordinal,
  getCurrentRegimes, cachedRegimes, labelFor, _resetForTests,
}
