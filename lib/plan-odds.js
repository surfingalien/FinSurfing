'use strict'
/**
 * Plan odds — what the measured volatility says about a trade plan's levels.
 *
 * Every surface states a target and a stop. Whether the target is REACHABLE
 * before the stop within the horizon is not a matter of opinion: given how
 * much the stock actually moves (lib/quant-snapshot.js forecast), a target
 * three standard deviations away with a stop half a standard deviation away
 * is mostly a stop-out, however good the story. Two facts per plan:
 *
 *   bracketOdds — P(target first), P(stop first), P(neither) within the
 *     horizon for a stock with NO drift (expected price change zero; the log
 *     drift is −σ²/2 by Itô) and the measured volatility. Solved exactly on
 *     the strip between the two barriers (Crank–Nicolson on the backward
 *     equation, Rannacher start) — not simulated. This is the BASE RATE the
 *     plan's levels imply before any skill: a thesis worth taking must beat
 *     it, and the triple-barrier labels the resolver writes are what it is
 *     scored against (`modelOdds` on the prediction; Phase 3's contest decides
 *     whether a fitted model does better).
 *
 *   stopNoise — how far the stop sits in units of one day's measured move,
 *     and whether an ordinary bad day (one-day 95% VaR) reaches it. A stop
 *     inside the noise is hit by randomness, not by the thesis being wrong.
 *     Also a volatility stop (2.5 daily σ ≈ 2 ATR) for reference — shown,
 *     never substituted for the plan's own stop.
 *
 * Pure. Tests: tests/plan-odds.test.js
 */

const { thomas } = require('./quant/linalg')

const ANN = 252
const SESSIONS_PER_CAL_DAY = 252 / 365

/** Calendar days (the Brain's horizons) → trading sessions. */
const sessionsFromCalendarDays = d => Math.max(1, Math.round(Number(d) * SESSIONS_PER_CAL_DAY))

/**
 * Probability that a driftless-price diffusion starting at 0 (log space) hits
 * `up` before `-down` within `T` sessions, and the reverse.
 * @param {number} up    ln(target / entry) > 0
 * @param {number} down  −ln(stop / entry) > 0
 * @param {number} sigma daily log volatility
 * @param {number} T     sessions
 * @param {number} [mu]  daily log drift (default −σ²/2: zero expected price change)
 */
function firstPassage(up, down, sigma, T, mu = -0.5 * sigma * sigma, { nodes = 240 } = {}) {
  if (!(up > 0) || !(down > 0) || !(sigma > 0) || !(T > 0)) return null
  const L = up + down, M = nodes, h = L / M
  const x0 = down                     // grid runs from the stop (0) to the target (L); start at `down`
  // Crank–Nicolson is unconditionally stable; eight steps a session (200–2,000)
  // keeps the time error far below the model's own (pinned against Monte Carlo).
  const steps = Math.min(2000, Math.max(200, Math.ceil(T * 8)))
  const dt = T / steps
  const D = 0.5 * sigma * sigma, A = mu
  // interior operator: L u_i = D (u_{i+1} - 2u_i + u_{i-1})/h² + A (u_{i+1} - u_{i-1})/(2h)
  const lo = D / (h * h) - A / (2 * h), di = -2 * D / (h * h), hi = D / (h * h) + A / (2 * h)
  const solve = (uLow, uHigh) => {
    let u = new Array(M + 1).fill(0); u[0] = uLow; u[M] = uHigh
    const step = theta => {
      const n = M - 1, a = new Array(n), b = new Array(n), c = new Array(n), d = new Array(n)
      for (let k = 0; k < n; k++) {
        const i = k + 1
        a[k] = -theta * dt * lo; b[k] = 1 - theta * dt * di; c[k] = -theta * dt * hi
        const explicit = u[i] + (1 - theta) * dt * (lo * u[i - 1] + di * u[i] + hi * u[i + 1])
        d[k] = explicit
      }
      d[0] += theta * dt * lo * uLow; d[n - 1] += theta * dt * hi * uHigh
      a[0] = 0; c[n - 1] = 0
      const x = thomas(a, b, c, d)
      const next = new Array(M + 1); next[0] = uLow; next[M] = uHigh
      for (let k = 0; k < n; k++) next[k + 1] = x[k]
      u = next
    }
    for (let s = 0; s < steps; s++) step(s < 4 ? 1 : 0.5)          // Rannacher: four implicit steps damp the corner
    // linear interpolation at the start point
    const pos = x0 / h, i = Math.min(M - 1, Math.floor(pos)), w = pos - i
    return Math.min(1, Math.max(0, u[i] * (1 - w) + u[i + 1] * w))
  }
  const pTarget = solve(0, 1), pStop = solve(1, 0)
  return { pTarget, pStop, pNeither: Math.max(0, 1 - pTarget - pStop) }
}

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3))

/**
 * Odds of a long plan's levels.
 * @param {object} o
 * @param {number} o.targetPct    target return, PERCENT (8 = +8%)
 * @param {number} o.stopPct      stop distance, PERCENT (5 = −5%)
 * @param {number} o.sessions     horizon in trading sessions
 * @param {number} o.vol          annualised volatility (fraction, 0.3 = 30%)
 */
function bracketOdds({ targetPct, stopPct, sessions, vol }) {
  const t = Number(targetPct), s = Number(stopPct), T = Number(sessions), v = Number(vol)
  if (!(t > 0) || !(s > 0) || s >= 100 || !(T > 0) || !(v > 0)) return null
  const sigma = v / Math.sqrt(ANN)
  const fp = firstPassage(Math.log(1 + t / 100), -Math.log(1 - s / 100), sigma, T)
  if (!fp) return null
  const decided = fp.pTarget + fp.pStop
  return {
    pTarget: r3(fp.pTarget), pStop: r3(fp.pStop), pNeither: r3(fp.pNeither),
    // Of the plans that reach a level, the share that reach the target — the
    // number to set beside a break-even win rate.
    pTargetGivenDecided: decided > 1e-9 ? r3(fp.pTarget / decided) : null,
    sessions: T, vol: r3(v),
    model: 'no-drift diffusion at the measured volatility',
  }
}

/** Where the stop sits against the stock's measured daily move. */
function stopNoise({ stopPct, vol, var95 = null, price = null }) {
  const s = Number(stopPct), v = Number(vol)
  if (!(s > 0) || !(v > 0)) return null
  const dailySigmaPct = (v / Math.sqrt(ANN)) * 100
  const sigmas = s / dailySigmaPct
  const oneBadDay = var95 != null && Number.isFinite(var95) ? s <= var95 * 100 : null
  const level = oneBadDay || sigmas < 1.5 ? 'inside-noise' : sigmas < 2.5 ? 'tight' : 'clear'
  const volStopPct = +(2.5 * dailySigmaPct).toFixed(2)
  return {
    stopPct: +s.toFixed(2), dailySigmaPct: +dailySigmaPct.toFixed(2), sigmas: +sigmas.toFixed(2),
    oneBadDay, level,
    volatilityStopPct: volStopPct,
    volatilityStopPrice: price > 0 ? +(price * (1 - volStopPct / 100)).toFixed(price >= 1 ? 2 : 6) : null,
    text: level === 'inside-noise'
      ? `Stop ${s.toFixed(1)}% is ${sigmas.toFixed(1)} daily moves away${oneBadDay ? ' — one ordinary bad day (95% VaR) reaches it' : ''}: inside the noise.`
      : level === 'tight'
        ? `Stop ${s.toFixed(1)}% is ${sigmas.toFixed(1)} daily moves away: tight for this stock.`
        : `Stop ${s.toFixed(1)}% is ${sigmas.toFixed(1)} daily moves away: clear of ordinary noise.`,
  }
}

/** One plain sentence for a card or a prompt. */
function describeOdds(o) {
  if (!o) return null
  const pc = v => `${Math.round(v * 100)}%`
  return `At its measured volatility (${pc(o.vol)} a year) and no drift, the target comes first ${pc(o.pTarget)} of the time, the stop ${pc(o.pStop)}, neither within ${o.sessions} sessions ${pc(o.pNeither)}.`
}

/** Everything a surface attaches to a long plan, from a quant snapshot. */
function planFacts({ targetPct, stopPct, sessions, snap, price = null }) {
  const vol = snap?.vol?.forecast21
  if (!(vol > 0)) return null
  const odds = bracketOdds({ targetPct, stopPct, sessions, vol })
  const stop = stopNoise({ stopPct, vol, var95: snap?.tail?.var95 ?? null, price })
  if (!odds && !stop) return null
  return { odds, stop, text: describeOdds(odds) }
}

module.exports = { firstPassage, bracketOdds, stopNoise, describeOdds, planFacts, sessionsFromCalendarDays }

/**
 * Do picks reach their target more often than their own levels' no-skill odds?
 * Over resolved Brain predictions that logged `modelOdds` and carry a
 * triple-barrier label measured over the pick's OWN horizon (filled picks
 * only): the observed target-first rate against the mean predicted pTarget,
 * with a Wilson interval, plus Brier scores of the odds and of the base rate.
 * Skill shows up as target-first above the no-skill odds; a stop placed in the
 * noise shows up as the reverse. Below `minN` it reports and decides nothing.
 */
function oddsCheck(records, { minN = 30 } = {}) {
  const { wilson } = require('./calibration-stats')
  const rows = (records || []).filter(r =>
    r?.modelOdds?.pTarget != null && r.entered !== false && r.barrier?.label &&
    Number(r.horizonDays) > 0 && r.barrier.window === Number(r.horizonDays))
  const n = rows.length
  const out = { n, minN, ready: n >= minN }
  if (!n) return out
  const y = rows.map(r => (r.barrier.label === 'target' ? 1 : 0)), p = rows.map(r => Number(r.modelOdds.pTarget))
  const k = y.reduce((a, b) => a + b, 0), rate = k / n, meanP = p.reduce((a, b) => a + b, 0) / n
  const w = wilson(k, n)
  const brier = (q) => q.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / n
  Object.assign(out, {
    targetFirst: k, targetFirstRate: +rate.toFixed(3), targetFirstLo: w.lo, targetFirstHi: w.hi,
    meanPredicted: +meanP.toFixed(3),
    brierOdds: +brier(p).toFixed(4), brierBaseRate: +brier(p.map(() => rate)).toFixed(4),
    byStopNoise: Object.fromEntries(['inside-noise', 'tight', 'clear'].map(level => {
      const sel = rows.filter(r => r.stopNoise === level)
      if (!sel.length) return [level, null]
      const kk = sel.filter(r => r.barrier.label === 'stop').length, ww = wilson(kk, sel.length)
      return [level, { n: sel.length, stopFirst: kk, stopFirstRate: +(kk / sel.length).toFixed(3), lo: ww.lo, hi: ww.hi }]
    }).filter(([, v]) => v)),
  })
  if (out.ready) {
    out.verdict = w.lo > meanP ? 'beats-no-skill-odds' : w.hi < meanP ? 'below-no-skill-odds' : 'no-difference'
  }
  return out
}

module.exports.oddsCheck = oddsCheck
