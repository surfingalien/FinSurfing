'use strict'
/**
 * lib/quant-snapshot.js — ONE place that turns a symbol's daily bars into measured quant evidence, shared by the
 * AI Brain scan, the Research Desk dossier, AI Buy Signals (Advisory) and the Agent Hub pipeline.
 *
 * Everything here is computed in code from bars the caller already holds (no network, no model):
 *   vol        21-day volatility forecasts — GARCH(1,1) path average, EWMA, Yang–Zhang, trailing realised —
 *              and their median as the consensus `forecast21`
 *   character  does this symbol trend or mean-revert? Lo–MacKinlay variance ratio (robust z) decides; Hurst is shown
 *   tail       one-day 95% VaR and expected shortfall by filtered historical simulation (the method that passed
 *              coverage tests in the Quant Lab's VaR backtest)
 *   liquidity  20-day average dollar volume and the square-root impact cost of a reference order
 *   beta       against a benchmark's bars, when given
 *   state      2-state hidden Markov model: probability the symbol is in its high-volatility state
 *   relative   cross-section only (`crossSection`): each name's PCA-residual z against the other names given
 *
 * PHASE 1 RULE: this is EVIDENCE. It is shown to the model as context, stamped on every prediction/decision so the
 * track record can be sliced by it, and nothing here changes a decision until it is validated on picks it never saw.
 * Tests: tests/quant-snapshot.test.js
 */
const L  = require('./quant/linalg')
const V  = require('./quant/volatility')
const TS = require('./quant/timeseries')
const R  = require('./quant/risk')

const ANN = 252
const okBars = bars => (bars || []).filter(b => b && b.c > 0)
const round = (x, d = 4) => (Number.isFinite(x) ? +x.toFixed(d) : null)
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

function filteredHs(r, { level = 0.95, lambda = 0.94, window = 250 } = {}) {
  if (r.length < 60) return null
  let s2 = L.variance(r.slice(0, Math.min(20, r.length))), z = []
  for (let t = 0; t < r.length; t++) { if (t > 0) s2 = lambda * s2 + (1 - lambda) * r[t - 1] ** 2; z.push(r[t] / Math.sqrt(s2)) }
  const next = Math.sqrt(lambda * s2 + (1 - lambda) * r[r.length - 1] ** 2)
  const w = z.slice(-window).sort((a, b) => a - b), k = Math.max(1, Math.floor((1 - level) * w.length))
  const q = w[k - 1], es = L.mean(w.slice(0, k))
  return { var95: -q * next, es95: -es * next, method: 'filtered historical simulation (EWMA-scaled)' }
}

/** Measured evidence for one symbol. `bars`: [{t,o,h,l,c,v}] ascending, ideally ≥ 1 year. */
function symbolSnapshot(bars, { benchBars = null, notional = 100_000 } = {}) {
  const b = okBars(bars), c = b.map(x => x.c), lr = L.logReturnsOf(c)
  if (lr.length < 60) return { insufficient: true, observations: lr.length }
  const snap = { observations: lr.length, asOf: b[b.length - 1].t ? new Date(b[b.length - 1].t).toISOString().slice(0, 10) : null }

  // volatility forecasts for the next 21 sessions (annualised)
  const vol = { trailing21: Math.sqrt(ANN / 21 * lr.slice(-21).reduce((a, x) => a + x * x, 0)) }
  const ew = V.ewmaVol(lr); vol.ewma = ew[ew.length - 1]
  try { vol.yangZhang = V.yangZhang(b.slice(-64)) } catch { /* range data missing */ }
  if (lr.length >= 100) { try { const g = V.garch11(lr, { horizon: 21 }); vol.garch21 = Math.sqrt(L.mean(g.forecast.map(f => f * f))); vol.garchPersistence = g.persistence } catch { /* no fit */ } }
  vol.forecast21 = median([vol.garch21, vol.ewma, vol.yangZhang, vol.trailing21])
  vol.move21 = vol.forecast21 != null ? vol.forecast21 * Math.sqrt(21 / ANN) : null      // one-sigma 21-session move
  snap.vol = vol

  // character: trend vs mean reversion, decided by the robust variance-ratio test
  const lp = c.map(Math.log), character = {}
  try { const v5 = TS.varianceRatio(lp, 5); character.vr5 = v5.vr; character.vr5p = v5.pValueRobust } catch { /* too short */ }
  try { character.hurst = TS.hurst(lp).hurst } catch { /* too short */ }
  character.label = character.vr5p == null ? 'unknown' : character.vr5p < 0.05 ? (character.vr5 > 1 ? 'trending' : 'mean-reverting') : 'random walk'
  snap.character = character

  snap.tail = filteredHs(lr)

  // liquidity: average dollar volume and the cost of trading a reference order
  const vols = b.slice(-20).map(x => (Number(x.v) || 0) * x.c), adv = L.mean(vols)
  if (adv > 0) {
    const price = c[c.length - 1], dailyVol = L.stdev(lr.slice(-60))
    const im = R.marketImpact({ shares: notional / price, price, adv: adv / price, dailyVol: Math.max(dailyVol, 1e-4) })
    snap.liquidity = { advUsd: adv, referenceNotional: notional, impactBps: im.totalBps, participation: im.participation }
  }

  if (benchBars) {
    const bb = okBars(benchBars), day = t => new Date(t).toISOString().slice(0, 10), bm = new Map(bb.map(x => [day(x.t), x.c]))
    const pairs = []; for (let i = 1; i < b.length; i++) { const d0 = day(b[i - 1].t), d1 = day(b[i].t); if (bm.has(d0) && bm.has(d1)) pairs.push([b[i].c / b[i - 1].c - 1, bm.get(d1) / bm.get(d0) - 1]) }
    if (pairs.length >= 60) { const f = L.ols(pairs.map(p => [p[1]]), pairs.map(p => p[0])); snap.beta = { beta: f.beta[1], r2: f.r2, observations: pairs.length } }
  }

  if (lr.length >= 200) { try { const h = TS.hmm2(lr.slice(-500), { iters: 120 }); snap.state = { probStressed: h.currentProbStressed, label: h.currentState, calmVol: h.states[0].annualVol, stressedVol: h.states[1].annualVol } } catch { /* no fit */ } }
  return snap
}

/** PCA-residual z of each symbol against the others given (≥ 4 symbols with ≥ 120 overlapping days). */
// Factor count scales with the peer group: with only a handful of names a second principal component can BE one
// stock's own move, absorbing exactly the dislocation we are trying to measure.
function crossSection(barsBySymbol, { k = null, window = 120, holding = 5 } = {}) {
  const out = new Map(), n = Object.keys(barsBySymbol || {}).length
  try {
    const S = require('./quant/strategies'), res = S.statArbPca(barsBySymbol, { k: k ?? (n >= 12 ? 2 : 1), window, holding })
    for (const s of res.signals) out.set(s.symbol, { residualZ: s.residualZ, view: s.view, factorR2: s.factorR2, peers: Object.keys(barsBySymbol).length })
  } catch { /* too few symbols or too little overlap — relative view simply absent */ }
  return out
}

const pct = (x, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—')

/** One compact line for a model prompt. Facts only — the rules for using them live in the static system prompt. */
function snapshotLine(symbol, snap, rel = null) {
  if (!snap || snap.insufficient) return null
  const v = snap.vol || {}, parts = [`${symbol}:`, `vol21f=${pct(v.forecast21)}`, `(GARCH ${pct(v.garch21)} EWMA ${pct(v.ewma)} YZ ${pct(v.yangZhang)})`, `1σ21d=${pct(v.move21, 1)}`]
  const ch = snap.character || {}
  if (ch.label) parts.push(`char=${ch.label}${ch.vr5 != null ? `(VR5 ${ch.vr5.toFixed(2)} p=${ch.vr5p.toFixed(2)})` : ''}`)
  if (snap.tail) parts.push(`VaR95=${pct(snap.tail.var95, 1)} ES95=${pct(snap.tail.es95, 1)}`)
  if (snap.state) parts.push(`state=${snap.state.label}(P stressed ${snap.state.probStressed.toFixed(2)})`)
  if (snap.beta) parts.push(`beta=${snap.beta.beta.toFixed(2)}`)
  if (snap.liquidity) parts.push(`ADV=${snap.liquidity.advUsd >= 1e9 ? `$${(snap.liquidity.advUsd / 1e9).toFixed(1)}B` : `$${(snap.liquidity.advUsd / 1e6).toFixed(snap.liquidity.advUsd >= 1e8 ? 0 : 1)}M`} impact≈${snap.liquidity.impactBps.toFixed(0)}bp`)
  if (rel) parts.push(`resid=${rel.residualZ >= 0 ? '+' : ''}${rel.residualZ.toFixed(1)}z(${rel.view} in this list)`)
  return parts.join(' ')
}

/** Compact numeric stamp for the prediction log / learning store — the keys the track record can be sliced by. */
function stampOf(snap, rel = null) {
  if (!snap || snap.insufficient) return null
  return {
    vol21: round(snap.vol?.forecast21), character: snap.character?.label ?? null, vr5: round(snap.character?.vr5, 3), hurst: round(snap.character?.hurst, 3),
    var95: round(snap.tail?.var95), probStressed: round(snap.state?.probStressed, 3), beta: round(snap.beta?.beta, 3),
    advUsd: snap.liquidity ? Math.round(snap.liquidity.advUsd) : null, residualZ: rel ? round(rel.residualZ, 2) : null,
  }
}

/** Buckets used to slice the track record (fixed in advance, never tuned). */
const volBucket = v => (!Number.isFinite(v) ? null : v < 0.2 ? 'low (<20%)' : v < 0.4 ? 'medium (20–40%)' : 'high (≥40%)')
const residualBucket = z => (!Number.isFinite(z) ? null : z <= -1 ? 'lagging peers (≤−1z)' : z >= 1 ? 'ahead of peers (≥+1z)' : 'in line')

/** Research Desk evidence items: [{ id, title, text }]. */
function evidenceItems(snap, rel = null) {
  if (!snap || snap.insufficient) return []
  const out = [], v = snap.vol || {}
  out.push({ id: 'volatility', title: 'Volatility outlook (next 21 sessions)', text: `Forecast ${pct(v.forecast21)} annualised (GARCH ${pct(v.garch21)}, EWMA ${pct(v.ewma)}, Yang–Zhang ${pct(v.yangZhang)}, trailing ${pct(v.trailing21)}); a one-standard-deviation 21-session move is about ${pct(v.move21, 1)}.` })
  const ch = snap.character || {}
  if (ch.label && ch.label !== 'unknown') out.push({ id: 'character', title: 'Trend or mean reversion', text: `Variance ratio (5-day) ${ch.vr5?.toFixed(2)} with robust p = ${ch.vr5p?.toFixed(3)}: ${ch.label}${ch.hurst != null ? `; Hurst exponent ${ch.hurst.toFixed(2)}` : ''}.` })
  if (snap.tail) out.push({ id: 'tail-risk', title: 'Tail risk (one day)', text: `95% value at risk ${pct(snap.tail.var95, 1)}, expected shortfall ${pct(snap.tail.es95, 1)} (${snap.tail.method}). A stop closer than this is inside an ordinary bad day.` })
  const usd = v => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(1)}M`)
  if (snap.liquidity) out.push({ id: 'liquidity', title: 'Liquidity', text: `20-day average dollar volume ${usd(snap.liquidity.advUsd)}; trading $${(snap.liquidity.referenceNotional / 1e3).toFixed(0)}k costs about ${snap.liquidity.impactBps.toFixed(1)} bp (half-spread + square-root impact).` })
  if (snap.beta) out.push({ id: 'beta', title: 'Market sensitivity', text: `Beta ${snap.beta.beta.toFixed(2)} to SPY over ${snap.beta.observations} days (R² ${snap.beta.r2.toFixed(2)}).` })
  if (snap.state) out.push({ id: 'vol-state', title: 'Volatility state', text: `Hidden Markov model: ${snap.state.label} (probability of the stressed state ${snap.state.probStressed.toFixed(2)}); calm ${pct(snap.state.calmVol)} vs stressed ${pct(snap.state.stressedVol)} annualised.` })
  if (rel) out.push({ id: 'relative', title: 'Relative to peers', text: `PCA-residual ${rel.residualZ >= 0 ? '+' : ''}${rel.residualZ.toFixed(2)}σ over 5 sessions against ${rel.peers - 1} peers: ${rel.view}.` })
  return out
}

module.exports = { symbolSnapshot, crossSection, snapshotLine, stampOf, evidenceItems, volBucket, residualBucket, filteredHs }
