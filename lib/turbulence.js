'use strict'
/**
 * lib/turbulence.js — market turbulence (Kritzman & Li, 2010; the idea FinRL
 * uses to step aside in a crash), written from scratch.
 *
 * The price regime (lib/price-regime.js) reads SPY alone: its trend and how
 * volatile it is. Turbulence asks a different question — is TODAY unusual for
 * how these markets normally move TOGETHER? A day when stocks, bonds and gold
 * all move in ways their usual correlations say they should not is turbulent
 * even if SPY's own move is ordinary. It is the Mahalanobis distance of the
 * day's returns across ASSETS from their trailing mean, using their trailing
 * covariance:
 *
 *     d_t = (r_t − μ)ᵀ Σ⁻¹ (r_t − μ) / k        μ, Σ from the WINDOW days BEFORE t
 *
 * divided by k so an ordinary day is about 1. It is smoothed over SMOOTH days
 * and ranked against its own past year: `turbulent` at or above the 90th
 * percentile, `elevated` from the 75th, else `calm`. Every value at day t reads
 * days ≤ t (pinned: appending later days never changes an earlier label).
 *
 * Recorded, never acted on: each AI Brain prediction is stamped
 * `turbulenceAtScan`, `computeStats().byTurbulence` and the edge report test
 * whether picks did differently, and forwardProfile shows what followed each
 * state. Nothing is gated on it until a walk-forward test says it should be.
 *
 * Tests: tests/turbulence.test.js
 */

const ASSETS = ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'XLK', 'XLF', 'XLV', 'XLE', 'XLU', 'XLP', 'XLI']
const WINDOW = 252
const SMOOTH = 5
const RANK_WINDOW = 252
const CACHE_MS = 3600_000

const dayKey = t => new Date(t).toISOString().slice(0, 10)
let _cache = null

/** Daily log returns on the days every asset shares. */
function alignReturns(barsBySymbol, assets = ASSETS) {
  const maps = assets.map(s => new Map((barsBySymbol[s] || []).filter(b => b.c > 0).map(b => [dayKey(b.t), b.c])))
  if (maps.some(m => m.size < 2)) return { days: [], R: [] }
  const days = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort()
  const R = []
  for (let i = 1; i < days.length; i++) R.push(maps.map(m => Math.log(m.get(days[i]) / m.get(days[i - 1]))))
  return { days: days.slice(1), R }
}

/** Raw turbulence per day (null during the first WINDOW days). Pure. */
function turbulenceSeries(R, window = WINDOW) {
  const { inverse } = require('./quant/linalg')
  const k = R[0]?.length || 0
  const out = new Array(R.length).fill(null)
  for (let t = window; t < R.length; t++) {
    const mu = new Array(k).fill(0)
    for (let i = t - window; i < t; i++) for (let a = 0; a < k; a++) mu[a] += R[i][a] / window
    const S = Array.from({ length: k }, () => new Array(k).fill(0))
    for (let i = t - window; i < t; i++) {
      for (let a = 0; a < k; a++) { const da = R[i][a] - mu[a]; for (let b = a; b < k; b++) S[a][b] += da * (R[i][b] - mu[b]) / (window - 1) }
    }
    let tr = 0
    for (let a = 0; a < k; a++) { for (let b = 0; b < a; b++) S[a][b] = S[b][a]; tr += S[a][a] }
    for (let a = 0; a < k; a++) S[a][a] += 1e-4 * tr / k          // a small ridge keeps a near-collinear set invertible
    let Si
    try { Si = inverse(S) } catch { continue }
    const d = R[t].map((v, a) => v - mu[a])
    let q = 0
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) q += d[a] * Si[a][b] * d[b]
    out[t] = q / k
  }
  return out
}

/** Smoothed value, its percentile in its own trailing year, and the state, per day. Pure. */
function states(raw, { smooth = SMOOTH, rankWindow = RANK_WINDOW } = {}) {
  const sm = raw.map((_, t) => {
    const w = raw.slice(Math.max(0, t - smooth + 1), t + 1).filter(v => v != null)
    return w.length === smooth ? w.reduce((a, b) => a + b, 0) / smooth : null
  })
  return sm.map((v, t) => {
    if (v == null) return null
    const past = sm.slice(Math.max(0, t - rankWindow), t).filter(x => x != null)
    if (past.length < 60) return { value: +v.toFixed(3), pct: null, state: null }
    const pct = past.filter(x => x <= v).length / past.length
    return { value: +v.toFixed(3), pct: +pct.toFixed(3), state: pct >= 0.9 ? 'turbulent' : pct >= 0.75 ? 'elevated' : 'calm' }
  })
}

/** What followed each state for SPY: non-overlapping `horizon`-day windows. Pure. */
function forwardProfile(days, st, spyCloseByDay, { horizon = 20 } = {}) {
  const by = {}
  for (let t = 0; t + horizon < days.length; t += horizon) {
    const s = st[t]?.state
    const a = spyCloseByDay.get(days[t]), b = spyCloseByDay.get(days[t + horizon])
    if (!s || !(a > 0 && b > 0)) continue
    const x = by[s] ||= { n: 0, up: 0, sum: 0, worst: 0 }
    const r = (b / a - 1) * 100
    x.n++; if (r > 0) x.up++; x.sum += r; x.worst = Math.min(x.worst, r)
  }
  return Object.fromEntries(Object.entries(by).map(([s, x]) => [s, { windows: x.n, meanReturnPct: +(x.sum / x.n).toFixed(2), upShare: +(x.up / x.n).toFixed(2), worstPct: +x.worst.toFixed(2) }]))
}

/** The whole picture from bars. Pure. */
function analyse(barsBySymbol, assets = ASSETS) {
  const { days, R } = alignReturns(barsBySymbol, assets)
  if (R.length < WINDOW + 60) return null
  const st = states(turbulenceSeries(R))
  const spy = new Map((barsBySymbol.SPY || []).map(b => [dayKey(b.t), b.c]))
  const last = st.length - 1
  return {
    asOf: days[last], assets, ...st[last],
    recent: st.slice(-60).map((s, i) => ({ date: days[days.length - 60 + i], value: s?.value ?? null, state: s?.state ?? null })),
    profile: forwardProfile(days, st, spy),
  }
}

/** Current turbulence (1h cache). Never throws; null when the assets cannot be read. */
async function getCurrentTurbulence({ fetchBars, now = Date.now(), force = false } = {}) {
  if (!force && _cache && now - _cache.at < CACHE_MS) return _cache.value
  try {
    const entries = await Promise.all(ASSETS.map(async s => [s, await fetchBars(s).catch(() => [])]))
    const value = analyse(Object.fromEntries(entries))
    if (value) _cache = { at: now, value }
    return value
  } catch { return null }
}
const cachedTurbulence = () => _cache?.value ?? null

/** A one-line, citable evidence description. */
function describe(t) {
  if (!t?.state) return null
  return `Cross-market turbulence ${t.state} (Mahalanobis distance of today's moves across ${t.assets.length} stock, bond, gold and sector markets from their usual relationships; ${t.value}× an ordinary day, ${Math.round(t.pct * 100)}th percentile of the past year, as of ${t.asOf})`
}

module.exports = {
  ASSETS, WINDOW, SMOOTH, alignReturns, turbulenceSeries, states, forwardProfile, analyse,
  getCurrentTurbulence, cachedTurbulence, describe, _resetForTests: () => { _cache = null },
}
