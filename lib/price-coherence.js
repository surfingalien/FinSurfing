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
 *   - a BUY whose targetReturn is ≤ 0 (is the target wrong, or the verdict?)
 *   - a stopLoss outside (0, 100)
 * Those picks are DROPPED and reported, the same contract as edgeGate.rejected
 * and citationAudit — a pick that expects a loss is not a pick.
 *
 * ── Why the verdict decides that ────────────────────────────────────────────
 * The scan schema used to offer only buy verdicts, so a model that disliked a
 * symbol had exactly one way to say so: a negative targetReturn on a "Buy".
 * This gate then dropped the row, and a single-symbol scan went to zero picks.
 * The fix is upstream (the schema now has an ABSTAIN verdict), but the rule
 * here is what makes it safe: `long` is derived from the VERDICT, so a pick
 * that declines to recommend is never judged against a long's arithmetic. It
 * carries no derived zones either — there is no trade to price.
 *
 * Pure: no I/O, no clock, no network. Tests: tests/price-coherence.test.js
 */

/**
 * Verdicts that decline to recommend a buy. A pick carrying one of these is
 * not a trade, so it is neither priced nor dropped — it is passed through as
 * non-actionable, with its reasoning intact for the user to read.
 */
const ABSTAIN_VERDICTS = new Set(['avoid', 'no trade', 'hold', 'neutral', 'sell', 'strong sell'])

/** Does this pick recommend going long? Falls back to true for a missing verdict. */
function isLongVerdict(pick) {
  const v = typeof pick?.agentVerdict === 'string' ? pick.agentVerdict.trim().toLowerCase() : ''
  return !ABSTAIN_VERDICTS.has(v)
}

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
 * Is `value` a percent or an absolute price? `side` is where a price must sit
 * relative to the entry: 'below' for a long's stop, 'above' for its target.
 *   - the model's own zone is centred on `value` (within the prompt's zone
 *     half-width) and `value` lies on the right side of the entry → 'price':
 *     the number and the zone agree, and only the price reading makes both true
 *   - a stop ≥ 100 that is below the entry has no percent reading → 'price'
 *   - otherwise 'percent' — the schema's unit, and the default
 */
function valueUnit(value, zoneMid, entry, side) {
  const v = num(value), z = num(zoneMid), e = num(entry)
  if (v == null || e == null || v <= 0 || e <= 0) return 'percent'
  const rightSide = side === 'below' ? v < e : v > e
  if (!rightSide) return 'percent'
  const band = side === 'below' ? STOP_BAND : TARGET_BAND
  if (z != null && Math.abs(z - v) / v <= band + UNIT_CONFUSION_TOLERANCE) return 'price'
  if (side === 'below' && v >= MAX_STOP_LOSS) return 'price'
  return 'percent'
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
function coherentZones(pick, { livePrice = null, long = null } = {}) {
  if (!pick || typeof pick !== 'object') return { pick, repairs: [], drop: 'not an object' }

  const repairs = []
  const out = { ...pick }

  // The caller may force a direction; otherwise the verdict decides.
  const isLong = long == null ? isLongVerdict(out) : long

  // A pick that declines to recommend carries no trade, so there is nothing to
  // derive and nothing to contradict. Returning it as non-actionable is the
  // whole point: "we looked and we would not buy this" is a real answer, and
  // dropping it would leave the user with a bare empty slate instead.
  if (!isLong) {
    return {
      pick: { ...out, actionable: false },
      repairs: [],
      drop: null,
    }
  }

  let targetReturn = num(out.targetReturn)
  let stopLoss     = num(out.stopLoss)

  // ── Unrepairable contradictions ────────────────────────────────────────────
  // Code cannot know whether the target or the verdict was the mistake, so it
  // refuses to guess. Reported like any other gate rejection.
  if (targetReturn == null || targetReturn === 0)
    return { pick: out, repairs, drop: `targetReturn is ${out.targetReturn}` }
  if (targetReturn < 0)
    return { pick: out, repairs, drop: `buy verdict with a negative targetReturn (${targetReturn}%)` }
  if (stopLoss == null || stopLoss <= 0)
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

  // ── Resolve units: is `stopLoss` / `targetReturn` a percent or a PRICE? ────
  // The schema wants percents, but a model that can see real prices often
  // writes the stop PRICE there (a live scan: BTC 74000, NVDA 210 — and, for
  // a $30 stock, 27). Reading 27 as "27%" invents a stop the model never
  // chose. The tell is the model's own stop zone: when it is centred on the
  // same number, two fields agree that number is a price. A value ≥ 100 below
  // the entry has no percent reading at all. Either way it becomes a percent
  // here, with the original kept and the conversion reported.
  const claimedStopMid   = midOf(out.stopZoneLow, out.stopZoneHigh)
  const claimedTargetMid = midOf(out.targetZoneLow, out.targetZoneHigh)

  const stopUnit = valueUnit(stopLoss, claimedStopMid, entryMid, 'below')
  if (stopUnit === 'price') {
    const pct = (entryMid - stopLoss) / entryMid * 100
    repairs.push(`stopLoss ${stopLoss} is a PRICE, not a percent — converted to ${pct.toFixed(2)}% below entry ${entryMid.toFixed(2)}`)
    out.stopLossPrice = stopLoss
    stopLoss = +pct.toFixed(4)
    out.stopLoss = stopLoss
  }
  if (stopLoss <= 0 || stopLoss >= MAX_STOP_LOSS)
    return { pick: out, repairs, drop: `stopLoss out of range (${out.stopLossPrice ?? out.stopLoss})` }

  const targetUnit = valueUnit(targetReturn, claimedTargetMid, entryMid, 'above')
  if (targetUnit === 'price') {
    const pct = (targetReturn - entryMid) / entryMid * 100
    repairs.push(`targetReturn ${targetReturn} is a PRICE, not a percent — converted to ${pct.toFixed(2)}% above entry ${entryMid.toFixed(2)}`)
    out.targetPrice = targetReturn
    targetReturn = +pct.toFixed(4)
    out.targetReturn = targetReturn
  }
  if (targetReturn <= 0 || targetReturn > MAX_TARGET_RETURN)
    return { pick: out, repairs, drop: `targetReturn out of range (${out.targetPrice ?? out.targetReturn})` }

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
  out.actionable = true

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
  const abstained = []

  for (const p of picks) {
    const live = num(priceMap?.[p?.symbol])
    const { pick, repairs, drop } = coherentZones(p, { livePrice: live })
    if (drop) { dropped.push({ symbol: p?.symbol ?? null, reason: drop }); continue }
    if (repairs.length) repaired.push({ symbol: pick.symbol ?? null, repairs })
    if (pick.actionable === false) abstained.push({ symbol: pick.symbol ?? null, verdict: pick.agentVerdict ?? null })
    kept.push(pick)
  }

  return {
    picks: kept,
    audit: {
      checked:        picks.length,
      kept:           kept.length,
      actionable:     kept.filter(p => p.actionable !== false).length,
      droppedPicks:   dropped,
      repairedPicks:  repaired,
      abstainedPicks: abstained,
      levelsRepaired: repaired.length,
    },
  }
}

function emptyAudit() {
  return { checked: 0, kept: 0, actionable: 0, droppedPicks: [], repairedPicks: [], abstainedPicks: [], levelsRepaired: 0 }
}

module.exports = {
  ABSTAIN_VERDICTS, isLongVerdict,
  ENTRY_BAND, TARGET_BAND, STOP_BAND, COMPOSITE_WEIGHTS,
  MAX_TARGET_RETURN, MAX_STOP_LOSS, ANCHOR_TOLERANCE,
  roundPrice, midOf, zone, looksLikePercentAsPrice, valueUnit, recomputeComposite,
  coherentZones, auditPicks,
}
