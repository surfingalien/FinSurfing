'use strict'

/**
 * lib/trade-levels.js — entry, stop and profit-booking levels, computed in code.
 *
 * Every research card should answer three questions: where to buy, where the
 * idea is wrong, and where to take money off the table. Two cases:
 *
 *   THESIS    — the pick is actionable and states a targetReturn/stopLoss. The
 *               levels follow from those percentages and the entry (the same
 *               arithmetic lib/price-coherence.js enforces), plus a first
 *               profit-booking level halfway to the target so a position can
 *               be scaled out of instead of all-or-nothing.
 *   TECHNICAL — no actionable thesis (the Brain declined, or the Research Desk
 *               judged "no trade"). The card used to show NOTHING, which reads
 *               as a broken feature. Instead it gets reference levels from the
 *               bars alone: entry near support within one ATR of price, a stop
 *               below both, and profit-booking at 1.5R and 3R. They are labelled
 *               as reference levels, not a recommendation, and are never logged
 *               as a prediction.
 *
 * Volatility sanity checks ride along on both: a stop inside one day's normal
 * range (ATR) is flagged, because normal noise will hit it.
 *
 * Pure. Tests: tests/trade-levels.test.js
 */

const round = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(v >= 100 ? 2 : v >= 1 ? 3 : 5))
const band  = (mid, pct) => ({ low: round(mid * (1 - pct)), high: round(mid * (1 + pct)) })

/** Wilder's ATR over daily bars [{h,l,c}] ascending. Null when too short. */
function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const tr = []
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h ?? bars[i].c, l = bars[i].l ?? bars[i].c, pc = bars[i - 1].c
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  let a = tr.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period
  return a
}

/** Everything tradeLevels() needs, from bars. Pure. */
function levelInputs(bars, { lookback = 20 } = {}) {
  if (!Array.isArray(bars) || bars.length < 30) return null
  const recent = bars.slice(-lookback)
  const last = bars.at(-1)
  return {
    price:      last.c,
    asOf:       new Date(last.t).toISOString().slice(0, 10),
    atr:        atr(bars),
    support:    Math.min(...recent.map(b => b.l ?? b.c)),
    resistance: Math.max(...recent.map(b => b.h ?? b.c)),
  }
}

/**
 * @param {object} o
 * @param {number} o.price          current price (the live quote when known)
 * @param {number} [o.atr]
 * @param {number} [o.support]      recent swing low
 * @param {number} [o.resistance]   recent swing high
 * @param {number} [o.targetReturn] percent, thesis mode
 * @param {number} [o.stopLoss]     percent, thesis mode
 * @param {number} [o.entryMid]     thesis entry anchor (defaults to price)
 * @returns {object|null}
 */
function tradeLevels({ price, atr: a = null, support = null, resistance = null, targetReturn = null, stopLoss = null, entryMid = null }) {
  if (!(price > 0)) return null
  const tr = Number(targetReturn), sl = Number(stopLoss)
  const thesis = tr > 0 && sl > 0 && sl < 100
  const notes = []
  let eLow, eHigh, mid, stop, t1, t2, basis

  if (thesis) {
    basis = 'thesis'
    mid   = entryMid > 0 ? entryMid : price
    ;({ low: eLow, high: eHigh } = band(mid, 0.02))
    stop  = mid * (1 - sl / 100)
    t2    = mid * (1 + tr / 100)
    t1    = mid + (t2 - mid) / 2
  } else {
    if (!(a > 0)) return null   // no volatility measure → no honest reference levels
    basis = 'technical'
    eHigh = price
    // Buy the pullback toward support, but never more than one ATR away.
    eLow  = support > 0 && support < price && support > price - a ? support : price - a
    mid   = (eLow + eHigh) / 2
    stop  = Math.min(eLow - a, support > 0 && support < eLow ? support - 0.5 * a : Infinity)
    const r = mid - stop
    t1 = mid + 1.5 * r
    t2 = mid + 3 * r
    if (resistance > mid && resistance < t1) notes.push(`recent high $${round(resistance)} sits below the first profit-booking level and may cap it`)
  }

  if (!(stop > 0) || !(t2 > mid)) return null
  const risk = mid - stop
  if (a > 0 && risk < a) notes.push(`stop is ${(risk / a).toFixed(1)}× the average daily range (ATR $${round(a)}) — normal day-to-day noise can hit it`)

  return {
    basis,
    price:  round(price),
    entry:  { low: round(eLow), high: round(eHigh), mid: round(mid) },
    stop:   { price: round(stop), ...band(stop, 0.015) },
    booking: [
      { label: 'T1 — book partial profit', price: round(t1), ...band(t1, 0.015), pct: +(((t1 - mid) / mid) * 100).toFixed(1), r: +((t1 - mid) / risk).toFixed(1) },
      { label: 'T2 — target',              price: round(t2), ...band(t2, 0.02),  pct: +(((t2 - mid) / mid) * 100).toFixed(1), r: +((t2 - mid) / risk).toFixed(1) },
    ],
    riskPct: +((risk / mid) * 100).toFixed(1),
    atr:     round(a),
    atrPct:  a > 0 ? +((a / price) * 100).toFixed(2) : null,
    support: round(support), resistance: round(resistance),
    notes,
  }
}

module.exports = { atr, levelInputs, tradeLevels }
