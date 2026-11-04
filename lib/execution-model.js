'use strict'
/**
 * lib/execution-model.js — how a backtest order actually fills: slippage beyond
 * the flat round-trip cost, a cap on how much of a day's volume one order may
 * take, and bracket exits (stop / partial target / target / trailing stop /
 * time limit) checked bar by bar.
 *
 * Ported in spirit from QuantJourney Backtester (Apache-2.0,
 * github.com/QuantJourneyOrg/quantjourney-bt — execution/slippage.py,
 * fill_engine.py); written fresh for this engine's conventions.
 *
 * Two rules hold throughout, both pinned by tests:
 *   - NO LOOK-AHEAD: slippage and the volume cap at a fill on bar i read bars
 *     < i only (the previous completed bar's range, a trailing window of
 *     returns and volume). The fill bar's own high, low and volume are
 *     unknown when the order is sent at its open.
 *   - AMBIGUITY COSTS: daily bars do not say whether the high or the low came
 *     first, so a bar that touches both the stop and a target exits at the
 *     stop; a bar that OPENS past a level fills at the open (a gap is never
 *     filled at the better level). Same rule as the paper broker
 *     (lib/paper-broker.js bracketExits) and the Brain's triple-barrier label.
 *
 * Slippage models (`slippage.model`):
 *   'none'   (default)  — only the flat round-trip cost the caller charges.
 *   'range'             — rangeK × the previous bar's (high − low) / close, per
 *                         side. Wide-range days cost more to trade into.
 *   'impact'            — square-root law, as lib/quant/risk.js:marketImpact:
 *                         coef × σ_daily × √(shares / ADV), σ and ADV over the
 *                         `lookback` bars before the fill.
 * `slippage.maxParticipation` caps an order at that share of ADV; the rest of
 * an exit carries to the next bar, the rest of an entry stays in cash.
 *
 * Bracket exits (`exits`), percents of the entry price (5 = 5%) or ATR
 * multiples (ATR(14) of the bars before the fill):
 *   stopPct | stopAtr      — sell all at the stop
 *   targetPct | targetAtr  — sell all at the target
 *   t1Pct | t1Atr          — sell HALF at T1 and move the stop to breakeven
 *   trailPct               — stop ratchets to (highest high since entry) × (1 − trail)
 *   maxHoldBars            — sell at the close after that many bars
 *
 * Tests: tests/execution-model.test.js
 */

const LOOKBACK = 20

const finite = v => Number.isFinite(v)

/** Per-side slippage FRACTION for an order of `qty` filling on bar i. Reads bars < i only. */
function slipFraction(i, qty, bars, slippage) {
  const model = slippage?.model || 'none'
  if (model === 'none' || i <= 0) return 0
  const { closes, highs, lows, volumes } = bars
  if (model === 'range') {
    const h = highs?.[i - 1], l = lows?.[i - 1], c = closes[i - 1]
    if (!(finite(h) && finite(l) && c > 0) || h < l) return 0
    return (slippage.rangeK ?? 0.1) * (h - l) / c
  }
  if (model === 'impact') {
    const lb = slippage.lookback ?? LOOKBACK
    const adv = advAt(i, volumes, lb), vol = dailyVolAt(i, closes, lb)
    if (!(adv > 0 && vol > 0 && qty > 0)) return 0
    return (slippage.coef ?? 1) * vol * Math.sqrt(qty / adv)
  }
  return 0
}

/** Mean volume of the `lb` bars before bar i (null when unavailable). */
function advAt(i, volumes, lb = LOOKBACK) {
  if (!Array.isArray(volumes)) return null
  const w = volumes.slice(Math.max(0, i - lb), i).filter(v => finite(v) && v > 0)
  return w.length >= Math.min(5, lb) ? w.reduce((a, v) => a + v, 0) / w.length : null
}

/** Standard deviation of daily log returns over the `lb` bars before bar i. */
function dailyVolAt(i, closes, lb = LOOKBACK) {
  const r = []
  for (let j = Math.max(1, i - lb); j < i; j++) if (closes[j - 1] > 0 && closes[j] > 0) r.push(Math.log(closes[j] / closes[j - 1]))
  if (r.length < 5) return null
  const m = r.reduce((a, v) => a + v, 0) / r.length
  return Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1))
}

/** Largest order on bar i under the volume cap (Infinity when no cap; null when the cap cannot be evaluated). */
function participationCap(i, bars, slippage) {
  const p = slippage?.maxParticipation
  if (!(p > 0)) return Infinity
  const adv = advAt(i, bars.volumes, slippage.lookback ?? LOOKBACK)
  return adv > 0 ? Math.floor(p * adv) : null
}

/** ATR(14) from the bars before bar i (true range; closes stand in for missing highs/lows). */
function atrAt(i, bars, n = 14) {
  const { closes, highs, lows } = bars
  const tr = []
  for (let j = Math.max(1, i - n); j < i; j++) {
    const h = finite(highs?.[j]) ? highs[j] : closes[j], l = finite(lows?.[j]) ? lows[j] : closes[j], pc = closes[j - 1]
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  return tr.length ? tr.reduce((a, v) => a + v, 0) / tr.length : null
}

/** Bracket levels for an entry filled at `entry` on bar i, or null when `exits` sets none. */
function bracketFor(entry, i, bars, exits) {
  if (!exits) return null
  const atr = (exits.stopAtr || exits.targetAtr || exits.t1Atr) ? atrAt(i, bars) : null
  const below = (pct, k) => (pct > 0 ? entry * (1 - pct / 100) : k > 0 && atr > 0 ? entry - k * atr : null)
  const above = (pct, k) => (pct > 0 ? entry * (1 + pct / 100) : k > 0 && atr > 0 ? entry + k * atr : null)
  const b = {
    entry,
    stop:   below(exits.stopPct, exits.stopAtr),
    target: above(exits.targetPct, exits.targetAtr),
    t1:     above(exits.t1Pct, exits.t1Atr),
    trail:  exits.trailPct > 0 ? exits.trailPct / 100 : null,
    maxHoldBars: exits.maxHoldBars > 0 ? Math.floor(exits.maxHoldBars) : null,
    peak:   entry,
    t1Done: false,
    since:  i,
  }
  if (b.stop != null && !(b.stop > 0 && b.stop < entry)) b.stop = null
  if (b.t1 != null && b.target != null && !(b.t1 < b.target)) b.t1 = null
  if (b.stop == null && b.target == null && b.t1 == null && b.trail == null && b.maxHoldBars == null) return null
  return b
}

/**
 * What the bracket does on bar j (a bar AFTER the entry bar). Returns
 * { kind, price, fraction } — fraction 1 sells everything, 0.5 is the T1
 * partial — or null. Mutates `b` (trailing stop, peak, breakeven after T1).
 */
function bracketStep(b, j, bars) {
  const { closes, opens, highs, lows } = bars
  const c = closes[j]
  const o = finite(opens?.[j]) && opens[j] > 0 ? opens[j] : c
  const h = finite(highs?.[j]) ? highs[j] : Math.max(o, c)
  const l = finite(lows?.[j]) ? lows[j] : Math.min(o, c)
  // Ratchet the trailing stop from the highs of bars BEFORE this one.
  if (b.trail != null) {
    const t = b.peak * (1 - b.trail)
    if (b.stop == null || t > b.stop) { b.stop = t; b.stopKind = 'trailing-stop' }
  }
  let out = null
  if (b.stop != null && o <= b.stop) out = { kind: b.stopKind || 'stop', price: o, fraction: 1 }
  else if (b.stop != null && l <= b.stop) out = { kind: b.stopKind || 'stop', price: b.stop, fraction: 1 }
  else if (b.target != null && o >= b.target) out = { kind: 'target', price: o, fraction: 1 }
  else if (b.target != null && h >= b.target) out = { kind: 'target', price: b.target, fraction: 1 }
  else if (b.t1 != null && !b.t1Done && (o >= b.t1 || h >= b.t1)) {
    out = { kind: 't1', price: o >= b.t1 ? o : b.t1, fraction: 0.5 }
    b.t1Done = true
    if (b.stop == null || b.entry > b.stop) { b.stop = b.entry; b.stopKind = 'breakeven-stop' }
  } else if (b.maxHoldBars != null && j - b.since >= b.maxHoldBars) out = { kind: 'time', price: c, fraction: 1 }
  if (h > b.peak) b.peak = h
  return out
}

/**
 * The simulateWithSignals options for a stored execution model (`params.exec` on a library
 * strategy: { slippage, exits }) over bars [from, to) of a series. {} when there is none, so a
 * strategy admitted without one is re-tested exactly as before.
 */
function execOptions(exec, series, from = 0, to = series?.closes?.length ?? 0) {
  if (!exec || (!exec.slippage && !exec.exits)) return {}
  const sl = a => (Array.isArray(a) ? a.slice(from, to) : undefined)
  return { highs: sl(series.highs), lows: sl(series.lows), volumes: sl(series.volumes), ...(exec.slippage ? { slippage: exec.slippage } : {}), ...(exec.exits ? { exits: exec.exits } : {}) }
}

/**
 * Brackets in the paper broker's shape (lib/paper-broker.js bracketExits): a stop, half booked
 * at T1 with the stop moved to breakeven, the rest at T2, and a time limit. ATR multiples, so a
 * volatile stock gets wider levels. Used by the Strategy Brain's bracket arm.
 */
const BRACKET_PRESETS = [
  { id: 'atr-2-3-6', exits: { stopAtr: 2, t1Atr: 3, targetAtr: 6, maxHoldBars: 63 } },
  { id: 'atr-1.5-2-4', exits: { stopAtr: 1.5, t1Atr: 2, targetAtr: 4, maxHoldBars: 42 } },
  { id: 'atr-3-trail', exits: { stopAtr: 3, trailPct: 8, maxHoldBars: 126 } },
]
// The research default for bracket strategies: 10% of the previous day's range per side, as QuantJourney's VolatilitySlippage.
const RESEARCH_SLIPPAGE = { model: 'range', rangeK: 0.1 }

module.exports = { execOptions, BRACKET_PRESETS, RESEARCH_SLIPPAGE, LOOKBACK, slipFraction, advAt, dailyVolAt, participationCap, atrAt, bracketFor, bracketStep }
