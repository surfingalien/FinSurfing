'use strict'
/**
 * lib/price-coherence.js
 *
 * The AI Brain prompt asks the model for percentages (targetReturn, stopLoss)
 * AND, separately, for six absolute dollar bounds (entry/target/stop zones).
 * Nothing checked that the two agreed, so they routinely did not. A real scan
 * card carried:
 *
 *     Entry  $29.67–$30.87   Target $24.50–$26.00   Stop $27.09–$27.91
 *     targetReturn −15%      stopLoss 27.5%
 *
 * Rebuilding "±1.5% around stop" from the NUMBER 27.5 reproduces $27.09–$27.91
 * exactly: the model had used the stop-loss PERCENTAGE as a dollar PRICE. A
 * genuine 27.5% stop under that entry is $21.95. The target zone disagreed with
 * its own stated return by 1.9%, the target sat BELOW the stop on a "Moderate
 * Buy", and the composite score was not the weighted average the prompt defines
 * it to be.
 *
 * None of that is a judgement call — every one of those numbers is derivable
 * from inputs we already hold, so this module derives them, in the same
 * division of labour as the rest of the repo (strategy-dsl's validateRule,
 * exposure-map's verifyFinding, expected-value's gate): the LLM proposes, and
 * deterministic code judges. The model's absolute price levels are never
 * trusted; they are RECOMPUTED from the entry anchor and the percentages.
 *
 * Two things are deliberately NOT repaired, because code cannot know which side
 * of the contradiction was meant:
 *   - a buy whose targetReturn is ≤ 0 (is the target wrong, or the verdict?)
 *   - a stopLoss outside (0, 100)
 * Those picks are DROPPED and reported, the same contract as edgeGate.rejected
 * and citationAudit — a pick that expects a loss is not a pick.
 *
 * Pure: no I/O, no clock, no network. Tests: tests/price-coherence.test.js
 */

/** Zone half-widths the AI Brain prompt itself specifies (routes/ai-brain.js). */
const ENTRY_BAND  = 0.02
const TARGET_BAND = 0.03
const STOP_BAND   = 0.015

/** compositeScore weights, exactly as the prompt defines them. */
const COMPOSITE_WEIGHTS = {
  fundamentalScore: 0.25,
  technicalScore:   0.20,
  sentimentScore:   0.15,
  macroScore:       0.20,
  riskScore:        0.20,
}

const MAX_TARGET_RETURN = 500   // matches validateRecommendations
const MAX_STOP_LOSS     = 100   // a stop below zero is not a price
/** Re-anchor entry to the live quote once it drifts past this. */
const ANCHOR_TOLERANCE  = 0.03
/** How close a stop zone must sit to the stopLoss NUMBER to call it unit confusion. */
const UNIT_CONFUSION_TOLERANCE = 0.005

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The repo's existing price-rounding convention (routes/recommendations.js). */
function roundPrice(v) {
  return +v.toFixed(v >= 100 ? 2 : 4)
}

function midOf(low, high) {
  const l = num(low), h = num(high)
  if (l != null && h != null) return (l + h) / 2
  return l ?? h ?? null
}

/** A symmetric zone of half-width `band` around `mid`. */
function zone(mid, band) {
  return { low: roundPrice(mid * (1 - band)), high: roundPrice(mid * (1 + band)) }
}

/**
 * The percent-as-price tell: a stop zone centred on the stop-loss PERCENTAGE
 * rather than on a price derived from it. Reported rather than silently fixed,
 * because it says the model misread the schema — worth seeing in the logs.
 */
function looksLikePercentAsPrice(zoneMid, pct) {
  const m = num(zoneMid), p = num(pct)
  if (m == null || p == null || p === 0) return false
  return Math.abs(m - p) / Math.abs(p) <= UNIT_CONFUSION_TOLERANCE
}

/**
 * Recompute compositeScore from its five components using the prompt's own
 * weights. Returns null unless every component is a usable number — a partial
 * average would be a different statistic wearing the same name.
 */
function recomputeComposite(pick) {
  let total = 0
  for (const [field, weight] of Object.entries(COMPOSITE_WEIGHTS)) {
    const v = num(pick?.[field])
    if (v == null) return null
    total += v * weight
  }
  return Math.round(total)
}

/**
 * Judge and repair one ranked pick.
 *
 * @param {object} pick                      a rankedStocks entry
 * @param {object} [opts]
 * @param {number} [opts.livePrice]          live quote, used to anchor entry
 * @param {boolean} [opts.long=true]         AI Brain picks are all implicit buys
 * @returns {{pick: object, repairs: string[], drop: string|null}}
 *          `drop` is a human-readable reason, or null to keep the pick.
 */
function coherentZones(pick, { livePrice = null, long = true } = {}) {
  if (!pick || typeof pick !== 'object') return { pick, repairs: [], drop: 'not an object' }

  const repairs = []
  const out = { ...pick }

  const targetReturn = num(out.targetReturn)
  const stopLoss     = num(out.stopLoss)

  // ── Unrepairable contradictions ────────────────────────────────────────────
  // Code cannot know whether the target or the verdict was the mistake, so it
  // refuses to guess. Reported like any other gate rejection.
  if (targetReturn == null || targetReturn === 0)
    return { pick: out, repairs, drop: `targetReturn is ${out.targetReturn}` }
  if (long && targetReturn < 0)
    return { pick: out, repairs, drop: `buy verdict with a negative targetReturn (${targetReturn}%)` }
  if (targetReturn > MAX_TARGET_RETURN)
    return { pick: out, repairs, drop: `targetReturn out of range (${targetReturn}%)` }
  if (stopLoss == null || stopLoss <= 0 || stopLoss >= MAX_STOP_LOSS)
    return { pick: out, repairs, drop: `stopLoss out of range (${out.stopLoss})` }

  // ── Anchor the entry ───────────────────────────────────────────────────────
  // The entry is the one level the model is entitled to an opinion about (it
  // may deliberately want a pullback fill), so it is only overridden when it
  // has drifted far enough from the live quote to be stale rather than chosen.
  let entryMid = midOf(out.entryZoneLow, out.entryZoneHigh) ?? num(out.currentPrice)
  const live = num(livePrice)

  if (live != null && live > 0) {
    if (entryMid == null || entryMid <= 0) {
      entryMid = live
      repairs.push('entry anchored to live price (none supplied)')
    } else if (Math.abs(live - entryMid) / entryMid > ANCHOR_TOLERANCE) {
      repairs.push(`entry re-anchored ${entryMid.toFixed(2)} → ${live.toFixed(2)} (live)`)
      entryMid = live
    }
    if (num(out.currentPrice) == null || out.currentPrice <= 0) out.currentPrice = roundPrice(live)
  }

  if (entryMid == null || entryMid <= 0)
    return { pick: out, repairs, drop: 'no usable entry price or live quote' }

  // ── Flag the unit confusion before overwriting the evidence of it ──────────
  const claimedStopMid = midOf(out.stopZoneLow, out.stopZoneHigh)
  if (looksLikePercentAsPrice(claimedStopMid, stopLoss))
    repairs.push(`stop zone was centred on the stopLoss PERCENTAGE (${stopLoss}) as if it were a price`)

  const claimedTargetMid = midOf(out.targetZoneLow, out.targetZoneHigh)
  if (looksLikePercentAsPrice(claimedTargetMid, targetReturn))
    repairs.push(`target zone was centred on the targetReturn PERCENTAGE (${targetReturn}) as if it were a price`)

  // ── Derive every level from the anchor and the percentages ─────────────────
  const targetMid = entryMid * (1 + targetReturn / 100)
  const stopMid   = entryMid * (1 - stopLoss / 100)

  const drift = (claimed, derived) =>
    claimed != null && derived > 0 && Math.abs(claimed - derived) / derived > 0.005

  if (drift(claimedTargetMid, targetMid))
    repairs.push(`target zone recomputed ${claimedTargetMid.toFixed(2)} → ${targetMid.toFixed(2)} (entry × ${(1 + targetReturn / 100).toFixed(4)})`)
  if (drift(claimedStopMid, stopMid))
    repairs.push(`stop zone recomputed ${claimedStopMid.toFixed(2)} → ${stopMid.toFixed(2)} (entry × ${(1 - stopLoss / 100).toFixed(4)})`)

  const e = zone(entryMid,  ENTRY_BAND)
  const t = zone(targetMid, TARGET_BAND)
  const s = zone(stopMid,   STOP_BAND)

  out.entryZoneLow   = e.low;  out.entryZoneHigh  = e.high
  out.targetZoneLow  = t.low;  out.targetZoneHigh = t.high
  out.stopZoneLow    = s.low;  out.stopZoneHigh   = s.high

  // ── compositeScore must be the weighted average it claims to be ────────────
  const composite = recomputeComposite(out)
  if (composite != null && composite !== num(out.compositeScore)) {
    repairs.push(`compositeScore recomputed ${out.compositeScore} → ${composite}`)
    out.compositeScoreClaimed = num(out.compositeScore)
    out.compositeScore = composite
  }

  if (repairs.length) out.coherenceRepairs = repairs.slice()

  return { pick: out, repairs, drop: null }
}

/**
 * Apply the gate across a ranked slate.
 *
 * @param {object[]} picks
 * @param {object}   [priceMap]  symbol → live price
 * @returns {{picks: object[], audit: object}}
 */
function auditPicks(picks, priceMap = {}) {
  if (!Array.isArray(picks)) return { picks: [], audit: emptyAudit() }

  const kept = []
  const dropped = []
  const repaired = []

  for (const p of picks) {
    const live = num(priceMap?.[p?.symbol])
    const { pick, repairs, drop } = coherentZones(p, { livePrice: live })
    if (drop) { dropped.push({ symbol: p?.symbol ?? null, reason: drop }); continue }
    if (repairs.length) repaired.push({ symbol: pick.symbol ?? null, repairs })
    kept.push(pick)
  }

  return {
    picks: kept,
    audit: {
      checked:        picks.length,
      kept:           kept.length,
      droppedPicks:   dropped,
      repairedPicks:  repaired,
      levelsRepaired: repaired.length,
    },
  }
}

function emptyAudit() {
  return { checked: 0, kept: 0, droppedPicks: [], repairedPicks: [], levelsRepaired: 0 }
}

module.exports = {
  ENTRY_BAND, TARGET_BAND, STOP_BAND, COMPOSITE_WEIGHTS,
  MAX_TARGET_RETURN, MAX_STOP_LOSS, ANCHOR_TOLERANCE,
  roundPrice, midOf, zone, looksLikePercentAsPrice, recomputeComposite,
  coherentZones, auditPicks,
}
