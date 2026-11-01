'use strict'
/**
 * Long trade setups — pure, shared by the browser (via Vite) and Jest:
 *   - the AI Advisory "Trade Setup by Time Horizon" cards (Intraday / Swing /
 *     Long-Term; src/services/aiEngine.js, tests/horizon-setups.test.js)
 *   - the Quantitative Advisory Engine's bullish setup
 *     (src/services/research.js:generateAdvisory → advisoryLongSetup at the
 *     bottom of this file; tests/advisory-long-setup.test.js)
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

/* ── Quantitative Advisory Engine — bullish trade setup ──────────────────
 * src/services/research.js:generateAdvisory, Bullish stance. Entry zone from
 * just above the nearest support (never more than 3% under the price) to 0.5%
 * over the price (a breakout fill); stop under that support and 1.5×ATR; TP1 at
 * 1.5R and TP2 at 2.5R.
 *
 * It used to measure R from the BOTTOM of the entry zone and cap TP1 at the
 * nearest resistance × 0.995 whatever its side of the price. A resistance in
 * (price, price / 0.995] put TP1 at or under the price — below the top of the
 * zone, so a fill there had its target under its entry — and with a support a
 * few percent down and a low ATR the 1.5R target landed under the price too.
 * Now:
 *   - R is measured from the TOP of the entry zone, the worst fill, so the R
 *     multiples hold for every fill in the zone; `riskReward` is the R/R of
 *     that fill and `riskRewardBest` the R/R of a fill at the bottom.
 *   - Resistance caps TP1 only through targetUnderResistance with the top of
 *     the zone as the floor (the same rule as the swing card, with every entry
 *     in place of the single price).
 *   - Support anchors the zone and the stop only from below the price.
 *     findKeyLevels keeps swing lows up to 2% above it, and one of those lifted
 *     the bottom of the zone over its top.
 *   - The rounded levels go through longSetupProblem. A setup that fails comes
 *     back `valid: false` with a `reason` and no stop or targets.
 * Percents are measured from the price, like the horizon cards.
 */
const ADVISORY_ENTRY_FLOOR       = 0.97   // zone bottom never more than 3% under the price
const ADVISORY_ENTRY_CAP         = 1.005  // zone top: 0.5% over the price
const ADVISORY_SUPPORT_ENTRY     = 0.998
const ADVISORY_SUPPORT_STOP      = 0.985
const ADVISORY_ATR_STOP          = 1.5
const ADVISORY_TP1_R             = 1.5
const ADVISORY_TP2_R             = 2.5
const ADVISORY_RESISTANCE_BUFFER = 0.995

function advisoryLongSetup({ price, atr, support, resistance }) {
  const p = Number(price)
  const a = Number(atr)
  const ok   = Number.isFinite(p) && p > 0 && Number.isFinite(a) && a > 0
  const pv   = Number.isFinite(p) && p > 0 ? p : NaN
  const atrv = ok ? a : NaN

  // Nearest support strictly below the price (findKeyLevels lists them
  // nearest first, but sort anyway: callers may pass any order).
  const sup = toLevels(support).filter(s => s < pv).sort((x, y) => y - x)[0] ?? null

  const atrStop    = pv - atrv * ADVISORY_ATR_STOP
  const entryLow   = sup != null ? Math.max(sup * ADVISORY_SUPPORT_ENTRY, pv * ADVISORY_ENTRY_FLOOR) : pv * ADVISORY_ENTRY_FLOOR
  const entryHigh  = pv * ADVISORY_ENTRY_CAP
  const supStop    = sup != null ? sup * ADVISORY_SUPPORT_STOP : null
  const stopSource = supStop != null && supStop < atrStop ? 'support' : 'atr'
  const stop       = stopSource === 'support' ? supStop : atrStop
  const risk       = entryHigh - stop
  const target     = targetUnderResistance({
    price: pv, floor: entryHigh, target: entryHigh + risk * ADVISORY_TP1_R,
    resistance, buffer: ADVISORY_RESISTANCE_BUFFER,
  })

  const lv = {
    entryLow:  roundPrice(entryLow),
    entryHigh: roundPrice(entryHigh),
    stop:      roundPrice(stop),
    tp1:       roundPrice(target.tp1),
    tp2:       roundPrice(entryHigh + risk * ADVISORY_TP2_R),
  }
  const reason = longSetupProblem({ entry: pv, ...lv })
  const base = {
    entry: pv, entryLow: lv.entryLow, entryHigh: lv.entryHigh, support: sup,
    bypassed: target.bypassed,
  }
  if (reason) {
    return {
      ...base, valid: false, reason,
      stop: null, tp1: null, tp2: null, riskPerShare: null,
      riskReward: null, riskRewardBest: null,
      stopPct: null, tp1Pct: null, tp2Pct: null,
      stopSource: null, targetSource: null, targetLevel: null,
    }
  }
  const rrAt = e => round2((lv.tp1 - e) / (e - lv.stop))
  const pct  = x => round2(((x - pv) / pv) * 100)
  return {
    ...base, valid: true, reason: null,
    stop: lv.stop, tp1: lv.tp1, tp2: lv.tp2,
    riskPerShare:   round2(lv.entryHigh - lv.stop),  // at the worst fill, for sizing
    riskReward:     rrAt(lv.entryHigh),              // fill at the top of the zone
    riskRewardBest: rrAt(lv.entryLow),               // fill at the bottom
    stopPct: round2(((pv - lv.stop) / pv) * 100),
    tp1Pct:  pct(lv.tp1),
    tp2Pct:  pct(lv.tp2),
    stopSource,
    targetSource: target.source === 'resistance' ? 'resistance' : 'r-multiple',
    targetLevel:  target.source === 'resistance' ? target.level : null,
  }
}

module.exports = {
  generateHorizonSetups,
  advisoryLongSetup,
  longSetupProblem,
  targetUnderResistance,
  swingTarget,
  roundPrice,
  SWING_ATR_TARGET,
  RESISTANCE_BUFFER,
  ADVISORY_RESISTANCE_BUFFER,
}
