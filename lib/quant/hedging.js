'use strict'
/**
 * lib/quant/hedging.js — what delta hedging really earns, measured over many simulated paths.
 *
 * The Gamma Scalping playbook in one module:
 *   - hedge at the IMPLIED or the REALISED vol (Ahmad & Wilmott 2005): hedging at realised locks the P&L at
 *     V(σ_r) − V(σ_i) but with a noisy path; hedging at implied gives a smooth path whose total is random
 *   - discrete hedging error (Derman & Kamal 1999): with N re-hedges the P&L standard deviation is about
 *     √(π/4) · vega · σ / √N — continuous hedging is fiction, and halving the noise costs 4× the trades
 *   - the no-trade band (Whalley & Wilmott 1997): with proportional costs, re-hedge only when delta leaves a band of
 *     half-width H = (3/2 · e^{−r(T−t)} · λ · S · Γ² / γ)^{1/3}, and only back to the band's edge
 * Long one option bought at the implied vol, held to expiry, self-financing share/cash account, proportional
 * costs on every share traded. Seeded and deterministic. Tests: tests/quant-hedging.test.js
 */
const L = require('./linalg')
const O = require('./options')

function pct(sorted, p) { const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1)))); return sorted[i] }

/**
 * Simulate `paths` hedged positions. strategy: 'time' (re-hedge every `rehedgesPerDay`) or 'band' (Whalley–Wilmott,
 * checked `checksPerDay` times a day). hedgeVol: 'implied' | 'realized' | a number.
 */
function simulateHedging({ S = 100, K = 100, r = 0, q = 0, T = 0.25, sigmaImplied = 0.2, sigmaRealized = 0.25, type = 'call',
  strategy = 'time', hedgeVol = 'implied', rehedgesPerDay = 1, checksPerDay = 8, rehedges = null, costBps = 0, riskAversion = 1, paths = 2000, seed = 1, keepPath = 0 }) {
  if (!(T > 0 && S > 0 && K > 0 && sigmaImplied > 0 && sigmaRealized > 0)) throw new Error('S, K, T and both vols must be positive')
  if (paths > 20000) throw new Error('at most 20000 paths')
  const sH = hedgeVol === 'implied' ? sigmaImplied : hedgeVol === 'realized' ? sigmaRealized : Number(hedgeVol)
  if (!(sH > 0)) throw new Error('hedgeVol must be implied, realized or a positive number')
  const days = Math.max(1, Math.round(T * 252)), perDay = strategy === 'band' ? checksPerDay : rehedgesPerDay
  const steps = rehedges && strategy === 'time' ? Math.max(1, Math.round(rehedges)) : days * perDay, dt = T / steps, lam = costBps / 1e4
  const markEvery = Math.max(1, Math.round(steps / days))
  const g = L.rng(seed), premium = O.blackScholes({ S, K, r, q, sigma: sigmaImplied, T, type })
  const pnls = new Float64Array(paths), trades = new Float64Array(paths), costs = new Float64Array(paths), sample = []
  const drift = (r - q - 0.5 * sigmaRealized ** 2) * dt, vol = sigmaRealized * Math.sqrt(dt)
  for (let p = 0; p < paths; p++) {
    let s = S, tte = T
    let target = O.greeks({ S: s, K, r, q, sigma: sH, T: tte, type }).delta
    let shares = -target, c = Math.abs(shares) * s * lam, cash = -premium - shares * s - c, nTrades = 1, totalCost = c
    const track = p < keepPath ? [{ t: 0, pnl: 0, hedge: -shares, delta: target }] : null
    for (let k = 1; k <= steps; k++) {
      s *= Math.exp(drift + vol * g.normal()); tte = Math.max(T - k * dt, 0); cash *= Math.exp(r * dt); cash += shares * s * (Math.exp(q * dt) - 1)
      if (k === steps) break
      const gr = O.greeks({ S: s, K, r, q, sigma: sH, T: tte, type }), want = -gr.delta
      let next = shares
      if (strategy === 'band') {
        const H = lam > 0 ? Math.cbrt(1.5 * Math.exp(-r * tte) * lam * s * gr.gamma * gr.gamma / riskAversion) : 0
        if (shares > want + H) next = want + H; else if (shares < want - H) next = want - H
      } else next = want
      if (next !== shares) { const cc = Math.abs(next - shares) * s * lam; cash -= (next - shares) * s + cc; totalCost += cc; shares = next; nTrades++ }
      if (track && k % markEvery === 0) track.push({ t: +(k * T / steps * 252).toFixed(2), pnl: O.blackScholes({ S: s, K, r, q, sigma: sigmaImplied, T: tte, type }) + shares * s + cash, hedge: -shares, delta: gr.delta })
    }
    const payoff = type === 'call' ? Math.max(s - K, 0) : Math.max(K - s, 0)
    cash -= Math.abs(shares) * s * lam; totalCost += Math.abs(shares) * s * lam                      // unwind the hedge at expiry
    pnls[p] = payoff + shares * s + cash; trades[p] = nTrades; costs[p] = totalCost
    if (track) sample.push(track)
  }
  const sorted = Array.from(pnls).sort((a, b) => a - b), m = L.mean(sorted)
  const locked = O.blackScholes({ S, K, r, q, sigma: sigmaRealized, T, type }) - premium
  return {
    strategy, hedgeVol: hedgeVol === 'implied' || hedgeVol === 'realized' ? hedgeVol : sH, paths,
    meanPnl: m, stdPnl: L.stdev(sorted), p5: pct(sorted, 0.05), p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), probLoss: sorted.filter(x => x < 0).length / paths,
    avgTrades: L.mean(Array.from(trades)), avgCost: L.mean(Array.from(costs)), theoreticalEdge: locked, premium,
    samplePaths: sample,
  }
}

/** Run the standard comparison: implied-vol vs realised-vol daily hedging, Whalley–Wilmott band, unhedged. */
function compareHedging(args) {
  const base = { paths: 1500, ...args }
  const rows = [
    { label: 'Daily, hedged at implied vol', ...simulateHedging({ ...base, strategy: 'time', hedgeVol: 'implied', rehedgesPerDay: 1, keepPath: 1 }) },
    { label: 'Daily, hedged at realised vol', ...simulateHedging({ ...base, strategy: 'time', hedgeVol: 'realized', rehedgesPerDay: 1, keepPath: 1 }) },
    { label: 'Whalley–Wilmott band (implied vol)', ...simulateHedging({ ...base, strategy: 'band', hedgeVol: 'implied', keepPath: 1 }) },
    { label: 'Hourly, hedged at implied vol', ...simulateHedging({ ...base, strategy: 'time', hedgeVol: 'implied', rehedgesPerDay: 7 }) },
  ]
  const best = rows.reduce((a, b) => (b.meanPnl / (b.stdPnl || 1) > a.meanPnl / (a.stdPnl || 1) ? b : a))
  return {
    rows: rows.map(({ samplePaths, ...rest }) => rest), samplePaths: Object.fromEntries(rows.filter(r => r.samplePaths.length).map(r => [r.label, r.samplePaths[0]])),
    lockedEdge: rows[0].theoreticalEdge, bestRiskAdjusted: best.label,
    note: 'Hedging at realised vol locks the edge V(σr) − V(σi) with a bumpy path; hedging at implied vol smooths the path but leaves the total to how the gamma was distributed. With costs, the band trades far less for nearly the same risk.',
  }
}

/** P&L standard deviation as the number of re-hedges grows, against Derman–Kamal √(π/4)·vega·σ/√N. No costs, σ_r = σ_i. */
function discreteHedgingError({ S = 100, K = 100, r = 0, T = 0.25, sigma = 0.2, type = 'call', counts = [4, 16, 64, 256], paths = 2000, seed = 2 }) {
  const vega = O.greeks({ S, K, r, sigma, T, type }).vega, out = []
  for (const N of counts) {
    const sim = simulateHedging({ S, K, r, T, sigmaImplied: sigma, sigmaRealized: sigma, type, strategy: 'time', hedgeVol: 'implied', rehedges: N, paths, seed })
    out.push({ rehedges: N, stdPnl: sim.stdPnl, theory: Math.sqrt(Math.PI / 4) * vega * sigma / Math.sqrt(N), meanPnl: sim.meanPnl })
  }
  const slope = L.ols(out.map(o => [Math.log(o.rehedges)]), out.map(o => Math.log(o.stdPnl))).beta[1]
  return { points: out, slope, note: `Noise falls like N^${slope.toFixed(2)} (theory −0.50): four times the trades buys half the noise.`, vega }
}

module.exports = { simulateHedging, compareHedging, discreteHedgingError }
