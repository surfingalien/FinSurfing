'use strict'
/**
 * lib/quant/strategies.js — price-only strategies that can be tested honestly on daily bars.
 *
 *   testPair / screenPairs   pairs trading: hedge ratio and cointegration fitted on a FORMATION window,
 *                            then traded out of sample on a z-score of the spread using only past data
 *   statArbPca               PCA-residual statistical arbitrage: how far each name sits from what the top
 *                            common factors imply (signals only — it is a cross-section, not one backtest)
 *   shortTermReversal        buy a one-day drop beyond k·σ, hold h days (daily-bar proxy for intraday reversal)
 * Every backtest pays costBps round trip per leg and reports its result against the null that the
 * spread is noise: screening many pairs finds "cointegrated" ones by luck, so the screen reports how many
 * false positives to expect. Tests: tests/quant-strategies.test.js
 */
const L = require('./linalg')
const TS = require('./timeseries')
const R = require('./risk')

const ANN = 252
const day = t => new Date(t).toISOString().slice(0, 10)

/** Align two bar arrays on common dates → { dates, y, x } of closes. */
function alignPair(barsY, barsX) {
  const mx = new Map(barsX.filter(b => b.c > 0).map(b => [day(b.t), b.c])), dates = [], y = [], x = []
  for (const b of barsY) { const d = day(b.t); if (b.c > 0 && mx.has(d)) { dates.push(d); y.push(b.c); x.push(mx.get(d)) } }
  return { dates, y, x }
}

function stats(rets, trades) {
  const m = L.mean(rets) * ANN, v = L.stdev(rets) * Math.sqrt(ANN)
  return { annualReturn: m, annualVol: v, sharpe: v > 0 ? m / v : 0, maxDrawdown: R.maxDrawdown(rets), trades, totalReturn: rets.reduce((a, r) => a * (1 + r), 1) - 1 }
}

/**
 * Trade one pair. Formation = first `formationShare` of the history (hedge ratio, cointegration test, half-life);
 * trading = the rest, entering at |z| ≥ entryZ (z of the log spread vs its trailing `lookback` mean/std),
 * exiting at |z| ≤ exitZ or stopping at |z| ≥ stopZ. Position is dollar-neutral per $1 of Y: +1 = long Y, short β of X.
 */
function testPair(barsY, barsX, { formationShare = 0.5, lookback = 40, entryZ = 2, exitZ = 0.5, stopZ = 4, costBps = 10, kalman = false } = {}) {
  const { dates, y, x } = alignPair(barsY, barsX)
  if (y.length < 200) throw new Error(`only ${y.length} overlapping days; a pair test needs at least 200`)
  const ly = y.map(Math.log), lx = x.map(Math.log), cut = Math.floor(y.length * formationShare)
  const eg = TS.engleGranger(ly.slice(0, cut), lx.slice(0, cut))
  const beta = eg.hedgeRatio, alpha = eg.intercept
  let kb = null; if (kalman) kb = TS.kalmanRegression(ly, lx, { delta: 1e-4 })
  const spread = ly.map((v, i) => v - (kb ? kb.alpha[i] + kb.beta[i] * lx[i] : alpha + beta * lx[i]))
  const rets = [], marks = []; let pos = 0, trades = 0
  for (let i = cut; i < y.length; i++) {
    // return of yesterday's position over today's move
    if (i > cut) { const bet = kb ? kb.beta[i - 1] : beta; const ry = y[i] / y[i - 1] - 1, rx = x[i] / x[i - 1] - 1; rets.push(pos * (ry - bet * rx)) } else rets.push(0)
    const w = spread.slice(Math.max(0, i - lookback), i + 1), sd = L.stdev(w), z = sd > 0 ? (spread[i] - L.mean(w)) / sd : 0
    let next = pos
    if (pos === 0) { if (z <= -entryZ) next = 1; else if (z >= entryZ) next = -1 }
    else if (Math.abs(z) <= exitZ || Math.abs(z) >= stopZ || (pos === 1 && z >= 0) || (pos === -1 && z <= 0)) next = 0
    if (next !== pos) { const legs = 1 + Math.abs(kb ? kb.beta[i] : beta); rets[rets.length - 1] -= Math.abs(next - pos) * legs * costBps / 1e4 / 2; if (next !== 0) trades++; marks.push({ date: dates[i], action: next === 0 ? 'exit' : next > 0 ? 'long spread' : 'short spread', z: +z.toFixed(2) }) }
    pos = next
  }
  const w = spread.slice(-lookback - 1), sd = L.stdev(w)
  return {
    formation: { days: cut, cointegrated5pct: eg.cointegrated5pct, adfStat: eg.adfStat, hedgeRatio: beta, halfLifeDays: eg.ou.halfLife, r2: eg.r2 },
    trading: { days: y.length - cut, ...stats(rets, trades) },
    currentZ: sd > 0 ? (spread[spread.length - 1] - L.mean(w)) / sd : 0, signals: marks.slice(-10),
    tradeable: eg.cointegrated5pct && eg.ou.halfLife != null && eg.ou.halfLife > 1 && eg.ou.halfLife < 90,
    note: 'Hedge ratio and the cointegration test use only the formation window; every trade after it uses past data only.',
  }
}

/** Test every pair in a basket. `expectedFalsePositives` = pairs × 5%: with many pairs, some look cointegrated by luck. */
function screenPairs(barsBySymbol, opts = {}) {
  const syms = Object.keys(barsBySymbol), out = []
  for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
    try {
      const r = testPair(barsBySymbol[syms[i]], barsBySymbol[syms[j]], opts)
      out.push({ y: syms[i], x: syms[j], cointegrated: r.formation.cointegrated5pct, adfStat: r.formation.adfStat, halfLife: r.formation.halfLifeDays, hedgeRatio: r.formation.hedgeRatio, oosSharpe: r.trading.sharpe, oosReturn: r.trading.totalReturn, trades: r.trading.trades, currentZ: r.currentZ, tradeable: r.tradeable })
    } catch (e) { /* too little overlap — skip this pair */ }
  }
  out.sort((a, b) => a.adfStat - b.adfStat)
  return { pairsTested: out.length, expectedFalsePositives: +(out.length * 0.05).toFixed(1), cointegrated: out.filter(p => p.cointegrated).length, pairs: out, note: 'A pair that tests cointegrated in formation but loses out of sample was probably luck — trust the out-of-sample Sharpe, not the ADF statistic.' }
}

/**
 * PCA-residual statistical arbitrage signals. Each name's return is regressed on the top-k principal-component
 * factor returns over the trailing window; the cumulative residual over the last `holding` days, in units of its
 * own volatility, is the signal (very negative = cheap vs. its peers, very positive = rich).
 */
function statArbPca(barsBySymbol, { k = 3, window = 120, holding = 5 } = {}) {
  const hrp = require('../hrp'), { symbols, returns } = hrp.alignReturns(barsBySymbol)
  if (symbols.length < 4) throw new Error('need at least 4 symbols')
  if (returns.length < window) throw new Error(`need at least ${window} overlapping days`)
  const win = returns.slice(-window), p = R.pca(win, { components: Math.min(k, symbols.length - 1) })
  const F = p.scores, out = []
  symbols.forEach((s, j) => {
    const y = win.map(r => r[j]), f = L.ols(F, y), res = f.resid, sd = L.stdev(res)
    const recent = L.sum(res.slice(-holding)), z = sd > 0 ? recent / (sd * Math.sqrt(holding)) : 0
    out.push({ symbol: s, residualZ: z, factorR2: f.r2, view: z <= -1.5 ? 'cheap vs peers' : z >= 1.5 ? 'rich vs peers' : 'in line' })
  })
  out.sort((a, b) => a.residualZ - b.residualZ)
  return { factors: p.explained.length, explained: p.cumulative[p.cumulative.length - 1], window, holding, signals: out, note: 'Signals only. Test the rule on history before trading it — residual reversion is not guaranteed.' }
}

/** Buy after a one-day return below −k·σ (trailing σ), hold `hold` days; optional short side. Daily-bar proxy for intraday reversal. */
function shortTermReversal(bars, { k = 1.5, hold = 1, lookback = 60, costBps = 10, both = false } = {}) {
  const c = bars.map(b => b.c).filter(v => v > 0); if (c.length < lookback + 50) throw new Error('not enough history')
  const r = L.returnsOf(c), rets = new Array(r.length).fill(0); let trades = 0, wins = 0, i = lookback
  while (i < r.length - hold - 1) {
    const sd = L.stdev(r.slice(i - lookback, i)), z = sd > 0 ? r[i] / sd : 0
    const dir = z <= -k ? 1 : (both && z >= k ? -1 : 0)
    if (dir) {
      let g = 1; for (let h = 1; h <= hold; h++) { rets[i + h] += dir * r[i + h] ; g *= 1 + dir * r[i + h] }
      const cost = costBps / 1e4; rets[i + hold] -= cost; trades++; if (g - cost > 1) wins++
      i += hold + 1
    } else i++
  }
  const bh = r.slice(lookback)
  return { ...stats(rets.slice(lookback), trades), winRate: trades ? wins / trades : null, buyAndHoldReturn: bh.reduce((a, v) => a * (1 + v), 1) - 1, note: 'Exposure is only the holding days; compare the Sharpe, not just the return, with buy-and-hold.' }
}

module.exports = { alignPair, testPair, screenPairs, statArbPca, shortTermReversal }
