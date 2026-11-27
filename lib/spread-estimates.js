'use strict'
/**
 * lib/spread-estimates.js — what it costs to trade THIS symbol, beyond the flat figure every check charges.
 *
 * Every backtest, paper fill and expected-value check charges one flat round trip per asset class
 * (expected-value.ROUND_TRIP_BPS: 10 bps a stock, 60 bps crypto). That is fair for a liquid name and far too low
 * for a thin one.
 *
 * THE FLAG (`sizeCost`, `strategySizeCost`) — the square-root law, I = Y·σ·√(Q/V) with Y = 1 (lib/quant/risk.js:
 * marketImpact), from the symbol's own daily volatility (60 sessions) and dollar volume (20 sessions) at the size
 * actually traded. The flat cost is taken to cover the spread; impact is paid on top, on the way in and out.
 * `understated` when that extra is at least the flat cost AND at least FLAG_MIN_GAP_BPS.
 *
 * THE ESTIMATORS (`estimate`) — evidence only, never the flag:
 *   roll           Roll (1984): bid-ask bounce gives Cov(Δp_t, Δp_t−1) = −s²/4, so s = 2√(−Cov), on log closes over
 *                  ROLL_WINDOW sessions; undefined when the autocovariance is positive (said, never a zero).
 *   corwinSchultz  Corwin & Schultz (2012) high-low estimator, overnight gaps adjusted, negative two-day estimates
 *                  set to zero, averaged over CS_WINDOW pairs.
 *   amihud         Amihud (2002) illiquidity, mean |return| per dollar traded, shown as the linear impact of a
 *                  reference order.
 * Measured before this was built (2y of daily bars): SPY reads 18–54 bps and AAPL 35–53 bps against real quoted
 * spreads near 1 bp — on today's liquid stocks daily-bar spread estimators mostly measure volatility. So the Quant
 * Lab shows them beside SPY's own reading, whose real spread is under a basis point, and nothing decides on them.
 *
 * Tests: tests/spread-estimates.test.js
 */

const L = require('./quant/linalg')
const R = require('./quant/risk')

const ROLL_WINDOW = 252
const CS_WINDOW = 63
const AMIHUD_WINDOW = 63
const MIN_OBS = 40
const FLAG_MIN_GAP_BPS = 15
const K = 3 - 2 * Math.SQRT2

const ok = b => b && b.c > 0
const bps = x => (Number.isFinite(x) ? +(x * 1e4).toFixed(1) : null)
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** Roll's estimator on log closes. { spread (fraction), cov, n } or { spread: null, reason }. */
function roll(bars, { window = ROLL_WINDOW } = {}) {
  const c = (bars || []).filter(ok).map(b => b.c).slice(-(window + 1))
  const d = []
  for (let i = 1; i < c.length; i++) d.push(Math.log(c[i] / c[i - 1]))
  if (d.length < MIN_OBS) return { spread: null, n: d.length, reason: `${d.length} price changes — ${MIN_OBS} needed` }
  const m = d.reduce((a, x) => a + x, 0) / d.length
  let cov = 0
  for (let i = 1; i < d.length; i++) cov += (d[i] - m) * (d[i - 1] - m)
  cov /= d.length - 1
  if (!(cov < 0)) return { spread: null, cov, n: d.length, reason: 'successive daily changes are positively correlated, so the bounce cannot be separated — no estimate' }
  return { spread: 2 * Math.sqrt(-cov), cov, n: d.length }
}

/** Corwin–Schultz high-low estimator. Bars need h ≥ l > 0; a pair with a bar of no range (h = l) is skipped. */
function corwinSchultz(bars, { window = CS_WINDOW } = {}) {
  const b = (bars || []).filter(x => ok(x) && x.h > 0 && x.l > 0 && x.h >= x.l).slice(-(window + 1))
  const est = []
  let zeros = 0, skipped = 0
  for (let i = 1; i < b.length; i++) {
    const p = b[i - 1], q = { ...b[i] }
    if (!(p.h > p.l && q.h > q.l)) { skipped++; continue }
    // Overnight adjustment: move day 2's range so a gap is not read as spread.
    if (q.l > p.c) { const g = q.l - p.c; q.h -= g; q.l -= g } else if (q.h < p.c) { const g = p.c - q.h; q.h += g; q.l += g }
    const beta = Math.log(p.h / p.l) ** 2 + Math.log(q.h / q.l) ** 2
    const gamma = Math.log(Math.max(p.h, q.h) / Math.min(p.l, q.l)) ** 2
    const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / K - Math.sqrt(gamma / K)
    let s = 2 * (Math.exp(alpha) - 1) / (1 + Math.exp(alpha))
    if (!(s > 0)) { s = 0; zeros++ }
    est.push(s)
  }
  if (est.length < MIN_OBS / 2) return { spread: null, n: est.length, reason: `${est.length} usable two-day ranges — ${MIN_OBS / 2} needed (the data may carry no intraday high/low)` }
  return { spread: est.reduce((a, x) => a + x, 0) / est.length, n: est.length, zeroed: zeros, skipped }
}

/** Amihud illiquidity: mean |r| / dollar volume, and the linear impact of `notional` dollars. */
function amihud(bars, { window = AMIHUD_WINDOW, notional = 100_000 } = {}) {
  const b = (bars || []).filter(ok).slice(-(window + 1))
  const xs = []
  for (let i = 1; i < b.length; i++) {
    const dv = (Number(b[i].v) || 0) * b[i].c
    if (dv > 0) xs.push(Math.abs(b[i].c / b[i - 1].c - 1) / dv)
  }
  if (xs.length < MIN_OBS / 2) return { illiq: null, n: xs.length, reason: 'too few days with volume' }
  const illiq = xs.reduce((a, x) => a + x, 0) / xs.length
  return { illiq, perMillionPct: +(illiq * 1e6 * 100).toFixed(4), notional, impactBps: bps(illiq * notional), n: xs.length }
}

/** All three estimators, plus the median of the two spread estimators that exist (bps, round trip). Evidence only. */
function estimate(bars, opts = {}) {
  const r = roll(bars, opts.roll), cs = corwinSchultz(bars, opts.cs), am = amihud(bars, opts.amihud)
  const spreads = [r.spread, cs.spread].filter(Number.isFinite)
  return {
    roundTripBps: spreads.length ? bps(median(spreads)) : null,
    estimators: spreads.length,
    roll: { bps: bps(r.spread), n: r.n, reason: r.reason || null },
    corwinSchultz: { bps: bps(cs.spread), n: cs.n, reason: cs.reason || null },
    amihud: { perMillionPct: am.perMillionPct ?? null, impactBps: am.impactBps ?? null, notional: am.notional ?? null, n: am.n, reason: am.reason || null },
  }
}

/** Daily volatility (last 60 log returns) and average dollar volume (last 20 sessions) from bars ending at `end`. */
function liquidityAt(bars, end = bars.length - 1) {
  const b = bars.slice(Math.max(0, end - 60), end + 1).filter(ok)
  if (b.length < 21) return null
  const lr = []
  for (let i = 1; i < b.length; i++) lr.push(Math.log(b[i].c / b[i - 1].c))
  const advUsd = L.mean(b.slice(-20).map(x => (Number(x.v) || 0) * x.c)), dailyVol = L.stdev(lr)
  if (!(advUsd > 0) || !(dailyVol > 0)) return null
  return { advUsd, advShares: L.mean(b.slice(-20).map(x => Number(x.v) || 0)), dailyVol, price: b[b.length - 1].c }
}

/** Round-trip square-root impact of `notional` dollars, in bps (both sides; no spread — the flat cost covers that). */
function impactRoundTrip(notional, liq) {
  if (!liq || !(notional > 0)) return null
  const im = R.marketImpact({ shares: notional / liq.price, price: liq.price, adv: liq.advUsd / liq.price, dailyVol: Math.max(liq.dailyVol, 1e-4), spreadBps: 0 })
  return { bps: 2 * im.impactBps, participation: im.participation }
}

function verdictOf(extraBps, flatBps) {
  if (!Number.isFinite(extraBps) || !Number.isFinite(flatBps)) return 'unknown'
  return extraBps >= flatBps && extraBps >= FLAG_MIN_GAP_BPS ? 'understated' : 'in-line'
}

const money = n => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`)

/** The symbol's cost at a reference size against the flat figure. */
function sizeCost(bars, { notional = 100_000, flatBps }) {
  const liq = liquidityAt((bars || []).filter(ok))
  if (!liq) return { verdict: 'unknown', flatBps, notional, note: 'no volume in these bars — the cost at size cannot be estimated' }
  const im = impactRoundTrip(notional, liq)
  const extra = +im.bps.toFixed(1), verdict = verdictOf(extra, flatBps)
  return {
    verdict, flatBps, notional, extraBps: extra, estimatedBps: +(flatBps + extra).toFixed(1), participation: +im.participation.toFixed(5),
    note: verdict === 'understated'
      ? `a ${money(notional)} order is ${(im.participation * 100).toFixed(2)}% of a day's dollar volume: about ${extra} bps of impact in and out on top of the ${flatBps} bps every check here charges — backtests and edge checks on this symbol understate its cost`
      : `a ${money(notional)} order adds about ${extra} bps of impact in and out; the ${flatBps} bps charged covers it`,
  }
}

/**
 * The same check over a backtest's own trades: each entry's notional at the liquidity of the sessions BEFORE it,
 * then the mean extra cost per position and what it leaves of the mean return per position (meanPct, % per position).
 */
function strategySizeCost({ trades = [], timestamps = [], closes = [], volumes, flatBps, meanPct = null }) {
  if (!Array.isArray(volumes) || !volumes.some(v => v > 0)) return null
  const idx = new Map(timestamps.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), i]))
  const bars = closes.map((c, i) => ({ c, v: volumes[i] }))
  const extras = []
  for (const t of trades) {
    if (t.type !== 'buy') continue
    const i = idx.get(t.date)
    if (i == null || i < 1) continue
    const im = impactRoundTrip(t.shares * t.price, liquidityAt(bars, i - 1))
    if (im) extras.push(im.bps)
  }
  if (!extras.length) return null
  const extra = +(extras.reduce((a, x) => a + x, 0) / extras.length).toFixed(1)
  const meanAfterPct = Number.isFinite(meanPct) ? +(meanPct - extra / 100).toFixed(3) : null
  return { verdict: verdictOf(extra, flatBps), flatBps, extraBps: extra, entries: extras.length, maxExtraBps: +Math.max(...extras).toFixed(1), meanPct, meanAfterPct }
}

module.exports = { ROLL_WINDOW, CS_WINDOW, AMIHUD_WINDOW, MIN_OBS, FLAG_MIN_GAP_BPS, roll, corwinSchultz, amihud, estimate, liquidityAt, sizeCost, strategySizeCost }
