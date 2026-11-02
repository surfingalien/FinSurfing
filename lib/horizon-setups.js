'use strict'
/**
 * Long trade setups — pure, shared by the browser (via Vite) and Jest: the AI
 * Advisory "Trade Setup by Time Horizon" cards (Intraday / Swing / Long-Term;
 * src/services/aiEngine.js, tests/horizon-setups.test.js). The Quantitative
 * Advisory Engine's separate bullish setup (advisoryLongSetup) was removed with
 * its page, which had not been reachable in the app since the auth rework.
 *
 * Why this lives here: the swing target used to be
 *   min(resistance × 0.99, price + 2.5 × ATR)
 * with `resistance` = the nearest level from findKeyLevels, which keeps swing
 * highs down to 98% of the price. For AAPL at $344.63 the nearest "resistance"
 * was $346.02, so the target came out at $342.56 — BELOW the entry — and the
 * card showed R/R −0.19:1. Nothing checked the levels against each other.
 *
 * Two rules now hold:
 *   1. A target is taken from a resistance level only when the level's
 *      buffered target (level × 0.99) is ABOVE the price. Otherwise the nearest
 *      level that does clear it is used; failing that, the ATR target.
 *   2. Every setup is checked after rounding: a long needs
 *      0 < stop < every entry < TP1 ≤ TP2. A setup that fails is emitted as
 *      `valid: false` with a `reason` and NO levels, so a card can never show
 *      a target below its entry or a stop above it.
 *
 * Percent fields (`stopPct`, `tp1Pct`, `tp2Pct`) are measured from the
 * reference entry (the current price) and are percents (3.2 = 3.2%).
 */

const SWING_ATR_TARGET = 2.5   // swing TP1 = price + 2.5 × ATR when no resistance caps it
const SWING_ATR_STOP   = 1.5
const RESISTANCE_BUFFER = 0.99 // aim just under the level, not at it
const SUPPORT_BUFFER    = 0.985

// Prices ≥ $1 keep the cents the cards always showed; sub-dollar prices keep
// four significant figures so rounding cannot collapse a target onto its entry.
function roundPrice(x) {
  if (!Number.isFinite(x)) return x
  return Math.abs(x) >= 1 ? +x.toFixed(2) : +x.toPrecision(4)
}

const round2 = x => +x.toFixed(2)
const money  = x => {
  const m = Math.abs(x)
  return `${x < 0 ? '-' : ''}$${m >= 1 ? m.toFixed(2) : String(roundPrice(m))}`
}

// Accepts a single level, an array of levels (nearest first, as findKeyLevels
// returns them) or nothing; drops anything that is not a positive number.
function toLevels(levels) {
  const arr = Array.isArray(levels) ? levels : [levels]
  return arr.filter(v => Number.isFinite(v) && v > 0)
}

/**
 * Why a long setup is not coherent, or null when it is. Checks the levels as
 * they will be shown — call it on rounded values. "Every entry" is the
 * reference entry AND both ends of the entry range, so a range that sits above
 * or below the price cannot slip a stop or a target past one of them.
 */
function longSetupProblem({ entry, entryLow = entry, entryHigh = entry, stop, tp1, tp2 }) {
  if (![entry, entryLow, entryHigh, stop, tp1].every(Number.isFinite)) {
    return 'Levels could not be computed (missing price or ATR)'
  }
  if (entry <= 0) return 'No valid price'
  if (entryLow > entryHigh) return `Entry range ${money(entryLow)}–${money(entryHigh)} is inverted`
  const lowest  = Math.min(entry, entryLow)
  const highest = Math.max(entry, entryHigh)
  if (stop <= 0) return `Stop ${money(stop)} is not a positive price — volatility is too high for this horizon`
  if (stop >= lowest) {
    return lowest < entry
      ? `Stop ${money(stop)} sits inside the entry range (${money(entryLow)}–${money(entryHigh)})`
      : `Stop ${money(stop)} is not below entry ${money(entry)}`
  }
  if (tp1 <= highest) {
    return highest > entry
      ? `Target ${money(tp1)} is not above the entry range (${money(entryLow)}–${money(entryHigh)})`
      : `Target ${money(tp1)} is not above entry ${money(entry)}`
  }
  if (tp2 != null && !(Number.isFinite(tp2) && tp2 >= tp1)) return `TP2 ${money(tp2)} is below TP1 ${money(tp1)}`
  return null
}

/**
 * A long target capped just under resistance — the rule every long setup here
 * follows. A level caps the target only when its buffered level
 * (level × buffer) is above `floor`: the price, or the top of the entry range
 * when entries run above the price. The nearest level that clears it is used;
 * when none does, or the nearest one sits beyond `target`, the computed target
 * stands. findKeyLevels keeps swing highs down to 98% of the price, so taking
 * the nearest level as-is put targets at or below the entry.
 *
 * Levels above the price whose buffered level does not clear the floor are
 * returned in `bypassed`: any target above them assumes the price breaks
 * through them first.
 *
 * Returns { tp1, source: 'resistance' | 'computed', level, bypassed }, where
 * `level` is the nearest usable level even when the computed target is lower.
 */
function targetUnderResistance({ price, target, resistance, floor = price, buffer = RESISTANCE_BUFFER }) {
  const above    = toLevels(resistance).filter(r => r > price).sort((a, b) => a - b)
  const clears   = r => r * buffer > floor
  const usable   = above.filter(clears)
  const bypassed = above.filter(r => !clears(r))
  const level    = usable[0] ?? null
  if (level != null && level * buffer < target) {
    return { tp1: level * buffer, source: 'resistance', level, bypassed }
  }
  return { tp1: target, source: 'computed', level, bypassed }
}

/**
 * Swing TP1. Uses the nearest resistance whose buffered target clears the
 * price, capped by the ATR target. Levels the price is already through, or
 * pressed against (within 1%), are skipped and reported in `bypassed`, since
 * any target above them assumes the price breaks through.
 */
function swingTarget(price, atr, resistance) {
  const t = targetUnderResistance({ price, target: price + atr * SWING_ATR_TARGET, resistance })
  return { ...t, source: t.source === 'computed' ? 'atr' : t.source }
}

function swingNote(target, stopSource, support) {
  let t
  const pressed = target.bypassed[0]
  if (target.source === 'resistance') {
    t = `Target just under resistance ${money(target.level)}`
    if (pressed != null) t += ` — assumes a break above ${money(pressed)} first`
  } else if (pressed != null) {
    t = `Target ${SWING_ATR_TARGET}×ATR — price is within 1% of resistance ${money(pressed)}, so it assumes a break above it`
  } else if (target.level != null) {
    t = `Target ${SWING_ATR_TARGET}×ATR, below resistance ${money(target.level)}`
  } else {
    t = `Target ${SWING_ATR_TARGET}×ATR (no resistance above the price)`
  }
  const s = stopSource === 'support'
    ? `stop under support ${money(support)}`
    : `stop ${SWING_ATR_STOP}×ATR below entry`
  return `${t}; ${s}`
}

// Assemble one horizon: round, validate, and either emit the levels with
// their percents or emit `valid: false` with the reason and no levels.
function buildSetup({ label, horizon, price, entryLow = null, entryHigh = null, stop, tp1, tp2, note, targetSource = null }) {
  const lv = { stop: roundPrice(stop), tp1: roundPrice(tp1), tp2: roundPrice(tp2) }
  const lo = entryLow  != null ? roundPrice(entryLow)  : null
  const hi = entryHigh != null ? roundPrice(entryHigh) : null
  const reason = longSetupProblem({
    entry: price, entryLow: lo ?? price, entryHigh: hi ?? price, ...lv,
  })
  const base = { label, horizon, entry: price, entryLow: lo, entryHigh: hi }
  if (reason) {
    return {
      ...base, valid: false, reason,
      stop: null, tp1: null, tp2: null, rr: null,
      stopPct: null, tp1Pct: null, tp2Pct: null, targetSource: null,
      note: null,
    }
  }
  const pct = x => round2(((x - price) / price) * 100)
  return {
    ...base, valid: true, reason: null, ...lv,
    rr:      round2((lv.tp1 - price) / (price - lv.stop)),
    stopPct: round2(((price - lv.stop) / price) * 100),
    tp1Pct:  pct(lv.tp1),
    tp2Pct:  pct(lv.tp2),
    targetSource,
    note,
  }
}

/**
 * The three horizon setups for a long position at `price`.
 * `support` / `resistance` may be a single level or a nearest-first array.
 */
function generateHorizonSetups(price, atr, support, resistance) {
  const p = Number(price)
  const a = Number(atr)
  const ok = Number.isFinite(p) && p > 0 && Number.isFinite(a) && a > 0
  // A non-positive or missing ATR gives stop = entry = target: every setup
  // fails validation with the "could not be computed" reason.
  const atrv = ok ? a : NaN

  // Intraday — tight, ATR-based
  const intraday = buildSetup({
    label: 'Intraday', horizon: 'Same day / overnight', price: p,
    stop: p - atrv * 0.8, tp1: p + atrv * 1.2, tp2: p + atrv * 2.0,
    targetSource: 'atr',
    note: 'Tight ATR-based levels for short-term momentum play',
  })

  // Swing — 1–3 weeks
  const sup        = toLevels(support)[0] ?? null
  const atrStop    = p - atrv * SWING_ATR_STOP
  const supStop    = sup != null ? sup * SUPPORT_BUFFER : null
  const stopSource = supStop != null && supStop < atrStop ? 'support' : 'atr'
  const swStop     = stopSource === 'support' ? supStop : atrStop
  const target     = swingTarget(p, atrv, resistance)
  const swing = buildSetup({
    label: 'Swing Trade', horizon: '1–3 weeks', price: p,
    stop: swStop, tp1: target.tp1, tp2: p + (target.tp1 - p) * 1.8,
    targetSource: target.source,
    note: swingNote(target, stopSource, sup),
  })

  // Long-term — 3–12 months, scale in across a range
  const longTerm = buildSetup({
    label: 'Long-Term Investment', horizon: '3–12 months', price: p,
    entryLow: p * 0.97, entryHigh: p * 1.01,
    stop: p - atrv * 4, tp1: p * 1.15, tp2: p * 1.30,
    targetSource: 'fixed',
    note: 'Scale in on dips; fundamental thesis must remain intact',
  })

  return [intraday, swing, longTerm]
}

module.exports = {
  generateHorizonSetups,
  longSetupProblem,
  targetUnderResistance,
  swingTarget,
  roundPrice,
  SWING_ATR_TARGET,
  RESISTANCE_BUFFER,
}
