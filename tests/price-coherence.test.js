'use strict'
/**
 * Unit tests for lib/price-coherence.js.
 *
 * The property under test: the absolute price levels shown on a card must
 * follow from the percentages shown beside them. The model is allowed an
 * opinion about the entry; it is not allowed one about the arithmetic.
 */

const {
  roundPrice, midOf, zone, valueUnit, looksLikePercentAsPrice, recomputeComposite,
  coherentZones, auditPicks,
  ENTRY_BAND, TARGET_BAND, STOP_BAND, ANCHOR_TOLERANCE,
} = require('../lib/price-coherence')

/**
 * The real scan card that surfaced this bug: DXYZ, ranked #1, "Moderate Buy".
 * Every number below is exactly as it rendered.
 */
const DXYZ = {
  symbol: 'DXYZ', name: 'Destiny Tech100 Inc', type: 'Stock',
  agentVerdict: 'Moderate Buy', confidence: 'Low',
  currentPrice: 30.27,
  targetReturn: -15, stopLoss: 27.5,
  entryZoneLow: 29.67, entryZoneHigh: 30.87,
  targetZoneLow: 24.50, targetZoneHigh: 26.00,
  stopZoneLow: 27.09, stopZoneHigh: 27.91,
  compositeScore: 22,
  fundamentalScore: 18, technicalScore: 12, sentimentScore: 35,
  macroScore: 42, riskScore: 28,
}

/** A well-formed pick: everything already agrees. */
const GOOD = {
  symbol: 'NVDA', agentVerdict: 'Buy', currentPrice: 100,
  targetReturn: 20, stopLoss: 10,
  entryZoneLow: 98, entryZoneHigh: 102,
  targetZoneLow: 116.4, targetZoneHigh: 123.6,
  stopZoneLow: 88.65, stopZoneHigh: 91.35,
  compositeScore: 70,
  fundamentalScore: 70, technicalScore: 70, sentimentScore: 70,
  macroScore: 70, riskScore: 70,
}

describe('helpers', () => {
  test('roundPrice follows the repo convention — 2dp at/above $100, 4dp below', () => {
    expect(roundPrice(209.8712)).toBe(209.87)
    expect(roundPrice(0.084213)).toBe(0.0842)
    expect(roundPrice(100)).toBe(100)
  })

  test('midOf tolerates a one-sided zone and returns null for neither', () => {
    expect(midOf(10, 20)).toBe(15)
    expect(midOf(10, null)).toBe(10)
    expect(midOf(null, 20)).toBe(20)
    expect(midOf(null, null)).toBeNull()
  })

  test('zone is symmetric around the mid', () => {
    expect(zone(100, 0.02)).toEqual({ low: 98, high: 102 })
  })

  test('recomputeComposite needs every component — a partial average is a different statistic', () => {
    expect(recomputeComposite(DXYZ)).toBe(26)   // 18·.25 + 12·.20 + 35·.15 + 42·.20 + 28·.20
    expect(recomputeComposite({ ...DXYZ, riskScore: null })).toBeNull()
    expect(recomputeComposite({})).toBeNull()
  })
})

describe('looksLikePercentAsPrice — the unit-confusion tell', () => {
  test('a stop zone centred on the stop-loss percentage is detected', () => {
    expect(looksLikePercentAsPrice(27.50, 27.5)).toBe(true)
  })

  test('a genuine stop price at a similar magnitude is NOT flagged', () => {
    // A $27.50 stop under a $30 entry is a legitimate 8.3% stop. It must only
    // trip when the number MATCHES the percentage it was supposedly derived from.
    expect(looksLikePercentAsPrice(27.50, 8.3)).toBe(false)
  })

  test('zero and missing inputs never trip it', () => {
    expect(looksLikePercentAsPrice(null, 27.5)).toBe(false)
    expect(looksLikePercentAsPrice(27.5, null)).toBe(false)
    expect(looksLikePercentAsPrice(0, 0)).toBe(false)
  })
})

/**
 * The regression case. This card reached a user, and every one of its levels
 * was wrong in a different way.
 */
describe('the DXYZ card', () => {
  test('a buy verdict with a negative targetReturn is DROPPED, not repaired', () => {
    // Code cannot know whether the target or the verdict was the mistake, and
    // guessing either way manufactures a thesis nobody wrote.
    const { drop } = coherentZones(DXYZ)
    expect(drop).toMatch(/negative targetReturn \(-15%\)/)
  })

  test('the stop zone is ±1.5% around the number 27.5 — the stop field holds a PRICE', () => {
    // ±1.5% around the number 27.5 gives exactly the zone that was displayed
    // (the card renders at 2dp; the stored values carry the sub-$100 precision).
    // This was first read as "27.5% used as a price". A live scan settled it the
    // other way: the model writes the stop PRICE into stopLoss (BTC 74000,
    // NVDA 210), and the zone it gives agrees with that price.
    const s = zone(27.5, STOP_BAND)
    expect(s).toEqual({ low: 27.0875, high: 27.9125 })
    expect([s.low.toFixed(2), s.high.toFixed(2)]).toEqual(['27.09', '27.91'])
    // A real 27.5% stop under the $30.27 entry is nowhere near it.
    expect(roundPrice(30.27 * (1 - 0.275))).toBeCloseTo(21.95, 2)
  })

  test('with the sign corrected, the $27.50 stop PRICE is kept and expressed as a percent', () => {
    const { pick, repairs, drop } = coherentZones({ ...DXYZ, targetReturn: 15 })
    expect(drop).toBeNull()

    // Entry mid 30.27 → target 34.8105; the stop stays at the model's $27.50,
    // which is 9.151% below entry — not a 27.5% stop at $21.95.
    expect(pick.targetZoneLow).toBe(33.7662)    // 34.8105 × 0.97
    expect(pick.targetZoneHigh).toBe(35.8548)   // 34.8105 × 1.03
    expect(pick.stopLoss).toBeCloseTo(9.151, 3)
    expect(pick.stopLossPrice).toBe(27.5)
    expect(pick.stopZoneLow).toBeCloseTo(27.0875, 3)
    expect(pick.stopZoneHigh).toBeCloseTo(27.9125, 3)

    expect(repairs.join(' | ')).toMatch(/stopLoss 27\.5 is a PRICE/)
    expect(repairs.join(' | ')).toMatch(/compositeScore recomputed 22 → 26/)
  })

  test('the ordering that made the card nonsense cannot recur', () => {
    const { pick } = coherentZones({ ...DXYZ, targetReturn: 15 })
    const entry = midOf(pick.entryZoneLow, pick.entryZoneHigh)
    const target = midOf(pick.targetZoneLow, pick.targetZoneHigh)
    const stop = midOf(pick.stopZoneLow, pick.stopZoneHigh)
    expect(target).toBeGreaterThan(entry)
    expect(stop).toBeLessThan(entry)
  })
})

describe('stopLoss / targetReturn units — a price in a percent field', () => {
  // Shapes taken from a live broad scan, where 11 of 20 picks carried a stop PRICE.
  const pick = (over) => ({ ...GOOD, ...over })

  test('a stop price ≥ 100 below the entry is converted, not dropped', () => {
    const { pick: p, drop, repairs } = coherentZones(pick({
      symbol: 'NVDA', currentPrice: 228, entryZoneLow: 223.44, entryZoneHigh: 232.56,
      targetReturn: 15, targetZoneLow: 254.3, targetZoneHigh: 270.0,
      stopLoss: 210, stopZoneLow: 206.85, stopZoneHigh: 213.15,
    }), { livePrice: 228 })
    expect(drop).toBeNull()
    expect(p.stopLoss).toBeCloseTo((228 - 210) / 228 * 100, 3)    // 7.89%
    expect(p.stopLossPrice).toBe(210)
    expect(midOf(p.stopZoneLow, p.stopZoneHigh)).toBeCloseTo(210, 1)
    expect(repairs.join(' ')).toMatch(/stopLoss 210 is a PRICE/)
  })

  test('a stop price under 100 that its zone agrees with is a price — ARKK $82, not an 82% stop', () => {
    const { pick: p, drop } = coherentZones(pick({
      currentPrice: 89.1, entryZoneLow: 87.32, entryZoneHigh: 90.88,
      targetReturn: 12, targetZoneLow: 96.8, targetZoneHigh: 102.8,
      stopLoss: 82, stopZoneLow: 80.77, stopZoneHigh: 83.23,
    }), { livePrice: 89.1 })
    expect(drop).toBeNull()
    expect(p.stopLoss).toBeCloseTo((89.1 - 82) / 89.1 * 100, 3)     // 7.97%, not 82%
    expect(midOf(p.stopZoneLow, p.stopZoneHigh)).toBeCloseTo(82, 1)
  })

  test('a real percent stays a percent (zone sits at the derived price)', () => {
    const { pick: p, repairs } = coherentZones(GOOD, { livePrice: 100 })
    expect(p.stopLoss).toBe(10)
    expect(p.stopLossPrice).toBeUndefined()
    expect(repairs.join(' ')).not.toMatch(/PRICE/)
  })

  test('a small percent with no zone stays a percent', () => {
    const { pick: p } = coherentZones(pick({ stopZoneLow: null, stopZoneHigh: null, stopLoss: 8 }), { livePrice: 100 })
    expect(p.stopLoss).toBe(8)
  })

  test('a "stop" above the entry has no price reading and ≥100 is still dropped', () => {
    expect(coherentZones(pick({ stopLoss: 120, stopZoneLow: 118.2, stopZoneHigh: 121.8 }), { livePrice: 100 }).drop)
      .toMatch(/stopLoss out of range/)
  })

  test('a target PRICE in targetReturn is converted when its zone agrees', () => {
    const { pick: p, drop } = coherentZones(pick({ targetReturn: 250, targetZoneLow: 242.5, targetZoneHigh: 257.5,
      currentPrice: 200, entryZoneLow: 196, entryZoneHigh: 204, stopLoss: 8, stopZoneLow: 181.2, stopZoneHigh: 186.8 }), { livePrice: 200 })
    expect(drop).toBeNull()
    expect(p.targetReturn).toBeCloseTo(25, 3)                       // not 250%
    expect(p.targetPrice).toBe(250)
  })

  test('valueUnit decides from the evidence', () => {
    expect(valueUnit(74000, 74000, 76000, 'below')).toBe('price')
    expect(valueUnit(210, null, 228, 'below')).toBe('price')         // ≥100 below entry: no percent reading
    expect(valueUnit(27, 27.01, 30.95, 'below')).toBe('price')       // zone agrees
    expect(valueUnit(8, 92, 100, 'below')).toBe('percent')           // zone at the derived price
    expect(valueUnit(8, null, 100, 'below')).toBe('percent')
    expect(valueUnit(20, 120, 100, 'above')).toBe('percent')
  })
})

describe('coherentZones — what it repairs', () => {
  test('an already-consistent pick is left alone', () => {
    const { pick, repairs, drop } = coherentZones(GOOD, { livePrice: 100 })
    expect(drop).toBeNull()
    expect(repairs).toEqual([])
    expect(pick.coherenceRepairs).toBeUndefined()
    expect(pick.targetZoneLow).toBe(116.4)
    expect(pick.stopZoneHigh).toBe(91.35)
  })

  test('levels are rebuilt even when the entry is fine', () => {
    // The old Advisory code only rebuilt derived prices when the ENTRY moved,
    // so a target that disagreed with its own percentage sailed through.
    const { pick, repairs } = coherentZones(
      { ...GOOD, targetZoneLow: 200, targetZoneHigh: 210 }, { livePrice: 100 })
    expect(pick.targetZoneLow).toBe(116.4)
    expect(repairs.join(' ')).toMatch(/target zone recomputed 205\.00 → 120\.00/)
  })

  test('a live price inside the tolerance does not move the entry', () => {
    // The model may deliberately want a pullback fill; a 1% drift is not staleness.
    const { pick, repairs } = coherentZones(GOOD, { livePrice: 101 })
    expect(pick.entryZoneLow).toBe(98)
    expect(repairs).toEqual([])
  })

  test('a live price beyond the tolerance re-anchors everything', () => {
    const { pick, repairs } = coherentZones(GOOD, { livePrice: 120 })
    expect(repairs.join(' ')).toMatch(/entry re-anchored 100\.00 → 120\.00/)
    expect(pick.entryZoneLow).toBe(117.6)       // 120 ± 2%
    expect(pick.targetZoneLow).toBeCloseTo(139.68, 2)  // 120 × 1.20 ± 3%
    expect(pick.stopZoneHigh).toBeCloseTo(109.62, 2)   // 120 × 0.90 ± 1.5%
  })

  test('the zone half-widths are the ones the prompt specifies', () => {
    const { pick } = coherentZones(GOOD, { livePrice: 100 })
    const w = (lo, hi) => (hi - lo) / (lo + hi)
    expect(w(pick.entryZoneLow, pick.entryZoneHigh)).toBeCloseTo(ENTRY_BAND, 4)
    expect(w(pick.targetZoneLow, pick.targetZoneHigh)).toBeCloseTo(TARGET_BAND, 4)
    expect(w(pick.stopZoneLow, pick.stopZoneHigh)).toBeCloseTo(STOP_BAND, 4)
  })

  test('the claimed composite is kept for forensics when it is overwritten', () => {
    const { pick } = coherentZones({ ...GOOD, compositeScore: 95 }, { livePrice: 100 })
    expect(pick.compositeScore).toBe(70)
    expect(pick.compositeScoreClaimed).toBe(95)
  })

  test('an entry with no zone falls back to currentPrice, then to the live quote', () => {
    const bare = { ...GOOD, entryZoneLow: null, entryZoneHigh: null }
    expect(coherentZones(bare).pick.entryZoneLow).toBe(98)          // from currentPrice 100
    const noPrice = { ...bare, currentPrice: null }
    const { pick, repairs } = coherentZones(noPrice, { livePrice: 50 })
    expect(pick.entryZoneLow).toBe(49)
    expect(repairs.join(' ')).toMatch(/anchored to live price/)
  })
})

describe('coherentZones — what it refuses to repair', () => {
  const dropped = (patch) => coherentZones({ ...GOOD, ...patch }).drop

  test('a percentage that is missing, zero or absurd', () => {
    expect(dropped({ targetReturn: null })).toMatch(/targetReturn is null/)
    expect(dropped({ targetReturn: 0 })).toMatch(/targetReturn is 0/)
    expect(dropped({ targetReturn: 900 })).toMatch(/out of range/)
  })

  test('a stop-loss outside (0, 100) — a stop below zero is not a price', () => {
    expect(dropped({ stopLoss: 0 })).toMatch(/stopLoss out of range/)
    expect(dropped({ stopLoss: -10 })).toMatch(/stopLoss out of range/)
    expect(dropped({ stopLoss: 150 })).toMatch(/stopLoss out of range/)
    expect(dropped({ stopLoss: null })).toMatch(/stopLoss out of range/)
  })

  test('nothing to anchor to at all', () => {
    expect(coherentZones({ ...GOOD, entryZoneLow: null, entryZoneHigh: null, currentPrice: null }).drop)
      .toMatch(/no usable entry price/)
  })

  test('a non-object is refused rather than thrown on', () => {
    expect(coherentZones(null).drop).toBe('not an object')
    expect(coherentZones('NVDA').drop).toBe('not an object')
  })

  test('a short is allowed a negative target when long is false', () => {
    // The gate encodes AI Brain's contract (every ranked pick is an implicit
    // buy), not an opinion that negative targets are always wrong.
    expect(coherentZones({ ...GOOD, targetReturn: -15 }, { long: false }).drop).toBeNull()
  })
})

describe('auditPicks', () => {
  test('keeps the repairable, drops the contradictory, and reports both', () => {
    const r = auditPicks(
      [GOOD, DXYZ, { ...GOOD, symbol: 'AMD', targetZoneLow: 500, targetZoneHigh: 510 }],
      { NVDA: 100, DXYZ: 30.27, AMD: 100 })

    expect(r.picks.map(p => p.symbol)).toEqual(['NVDA', 'AMD'])
    expect(r.audit).toMatchObject({ checked: 3, kept: 2, levelsRepaired: 1 })
    expect(r.audit.droppedPicks).toEqual([
      { symbol: 'DXYZ', reason: expect.stringMatching(/negative targetReturn/) },
    ])
    expect(r.audit.repairedPicks[0].symbol).toBe('AMD')
  })

  test('a missing live price is not a reason to drop a pick', () => {
    const r = auditPicks([GOOD], {})
    expect(r.picks).toHaveLength(1)
    expect(r.audit.levelsRepaired).toBe(0)
  })

  test('a non-array is well-formed, not a crash', () => {
    expect(auditPicks(null).picks).toEqual([])
    expect(auditPicks(null).audit.checked).toBe(0)
  })

  test('repairs ride along on the pick so the UI can surface them', () => {
    const r = auditPicks([{ ...GOOD, compositeScore: 95 }], { NVDA: 100 })
    expect(r.picks[0].coherenceRepairs).toEqual([expect.stringMatching(/compositeScore recomputed/)])
  })
})

/**
 * The AVAX regression: a single-symbol scan returned a red
 * "no internally consistent picks — try again" error.
 *
 * Root cause was upstream of this module — the scan schema offered only buy
 * verdicts, so a model that disliked the symbol could only say so with a
 * negative targetReturn on a "Buy", which this gate correctly refused to
 * trust. With one symbol that emptied the slate. The gate's half of the fix
 * is reading the VERDICT instead of assuming every pick is a long.
 */
describe('abstain verdicts — declining to recommend is not a contradiction', () => {
  const AVOID = { symbol: 'AVAX', agentVerdict: 'Avoid', targetReturn: -12, stopLoss: 20 }

  test('an Avoid pick survives with a negative target instead of being dropped', () => {
    const { pick, drop } = coherentZones(AVOID)
    expect(drop).toBeNull()
    expect(pick.actionable).toBe(false)
  })

  test('…and carries no derived zones, because there is no trade to price', () => {
    const { pick } = coherentZones({ ...AVOID, entryZoneLow: 10, entryZoneHigh: 11 }, { livePrice: 10.5 })
    expect(pick.targetZoneLow).toBeUndefined()
    expect(pick.stopZoneLow).toBeUndefined()
  })

  test('the same numbers under a BUY verdict are still dropped', () => {
    // The gate did not get laxer — the verdict is what changed the question.
    expect(coherentZones({ ...AVOID, agentVerdict: 'Moderate Buy' }).drop)
      .toMatch(/negative targetReturn/)
  })

  test('every abstain verdict is recognised, case and spacing insensitively', () => {
    for (const v of ['Avoid', 'avoid', ' SELL ', 'No Trade', 'Hold', 'Neutral']) {
      expect(coherentZones({ ...AVOID, agentVerdict: v }).drop).toBeNull()
    }
  })

  test('a missing verdict still defaults to long, so the gate never weakens by omission', () => {
    expect(coherentZones({ symbol: 'X', targetReturn: -5, stopLoss: 10 }).drop)
      .toMatch(/negative targetReturn/)
  })

  test('an explicit long override still beats the verdict', () => {
    expect(coherentZones(AVOID, { long: true }).drop).toMatch(/negative targetReturn/)
  })

  test('a buy pick is marked actionable', () => {
    expect(coherentZones(GOOD, { livePrice: 100 }).pick.actionable).toBe(true)
  })

  test('auditPicks separates abstains from drops and counts what is tradeable', () => {
    const r = auditPicks([GOOD, AVOID, DXYZ], { NVDA: 100 })
    expect(r.audit).toMatchObject({ checked: 3, kept: 2, actionable: 1 })
    expect(r.audit.abstainedPicks).toEqual([{ symbol: 'AVAX', verdict: 'Avoid' }])
    expect(r.audit.droppedPicks.map(d => d.symbol)).toEqual(['DXYZ'])
  })

  test('a slate of nothing but abstains is not empty — it is the answer', () => {
    // This is the case that used to 500.
    const r = auditPicks([AVOID], {})
    expect(r.picks).toHaveLength(1)
    expect(r.audit.actionable).toBe(0)
  })
})
