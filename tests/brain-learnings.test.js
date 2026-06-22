'use strict'
/**
 * Unit tests for the AI Brain measurement engine (lib/brain-learnings.js).
 * Pure functions only — no HTTP, no Anthropic calls, no file I/O.
 */

const { computeStats, nearestClose, zoneTouched, benchmarkFor, checkEntryZones } = require('../lib/brain-learnings')

const DAY = 86400 * 1000

describe('nearestClose', () => {
  const t0 = Date.UTC(2026, 0, 5) // Mon Jan 5 2026
  const bars = [
    { t: t0,           c: 100 },
    { t: t0 + 1 * DAY, c: 102 },
    { t: t0 + 2 * DAY, c: 104 },
    { t: t0 + 7 * DAY, c: 110 }, // next Monday (weekend gap)
  ]

  test('exact match returns that bar close', () => {
    expect(nearestClose(bars, t0 + 1 * DAY)).toBe(102)
  })

  test('weekend target snaps to nearest trading day within tolerance', () => {
    // Saturday (+5d) → nearest bars are Wed (+2d, 3d away) and Mon (+7d, 2d away)
    expect(nearestClose(bars, t0 + 5 * DAY)).toBe(110)
  })

  test('target far outside data returns null', () => {
    expect(nearestClose(bars, t0 + 60 * DAY)).toBe(null)
  })

  test('empty bars returns null', () => {
    expect(nearestClose([], t0)).toBe(null)
    expect(nearestClose(null, t0)).toBe(null)
  })
})

describe('zoneTouched', () => {
  const t0 = Date.UTC(2026, 0, 5)
  const bars = [
    { t: t0,           l: 98,  h: 101, c: 100 },
    { t: t0 + 1 * DAY, l: 101, h: 105, c: 104 },
    { t: t0 + 2 * DAY, l: 104, h: 109, c: 108 },
  ]

  test('returns true when a bar range overlaps the zone', () => {
    expect(zoneTouched(bars, t0, t0 + 3 * DAY, 99, 100)).toBe(true)
  })

  test('returns false when price never traded in the zone', () => {
    expect(zoneTouched(bars, t0, t0 + 3 * DAY, 90, 95)).toBe(false)
  })

  test('returns null for undefined zone (legacy records)', () => {
    expect(zoneTouched(bars, t0, t0 + 3 * DAY, null, null)).toBe(null)
  })

  test('returns null when no bars fall in the window', () => {
    expect(zoneTouched(bars, t0 + 10 * DAY, t0 + 17 * DAY, 99, 101)).toBe(null)
  })
})

describe('benchmarkFor', () => {
  test('crypto symbols benchmark against BTC', () => {
    expect(benchmarkFor('ETH-USD')).toBe('BTC-USD')
    expect(benchmarkFor('SOL-USD')).toBe('BTC-USD')
  })

  test('equities and ETFs benchmark against SPY', () => {
    expect(benchmarkFor('NVDA')).toBe('SPY')
    expect(benchmarkFor('QQQ')).toBe('SPY')
  })
})

describe('computeStats', () => {
  const mkRecord = (over = {}) => ({
    symbol: 'NVDA',
    generatedAt: '2026-05-01T00:00:00.000Z',
    confidence: 'High',
    basePrice: 100,
    entryZoneMid: 100,
    targetZoneMid: 115,
    entered: true,
    price7d: 105,  benchRet7d: 1,
    price30d: 112, benchRet30d: 3,
    ...over,
  })

  test('empty input produces zero-count stats', () => {
    const s = computeStats([])
    expect(s.totalResolved).toBe(0)
    expect(s.h7).toBe(null)
    expect(s.h30).toBe(null)
  })

  test('win rate counts positive returns from base price', () => {
    const records = [
      mkRecord(),                              // +5% @7d → win
      mkRecord({ price7d: 95, benchRet7d: 1 }), // -5% @7d → loss
    ]
    const s = computeStats(records)
    expect(s.h7.n).toBe(2)
    expect(s.h7.winRate).toBe(0.5)
  })

  test('alpha win rate compares against the benchmark, not zero', () => {
    // +2% return vs +5% benchmark = raw win but alpha loss
    const records = [mkRecord({ price7d: 102, benchRet7d: 5, price30d: null, benchRet30d: null })]
    const s = computeStats(records)
    expect(s.h7.winRate).toBe(1)
    expect(s.h7.alphaWinRate).toBe(0)
  })

  test('predictions that never entered the zone are excluded from win rates', () => {
    const records = [
      mkRecord(),                       // entered, +5% win
      mkRecord({ entered: false, price7d: 200 }), // phantom +100% — never tradeable
    ]
    const s = computeStats(records)
    expect(s.h7.n).toBe(2)
    expect(s.h7.nTradeable).toBe(1)
    expect(s.h7.neverEntered).toBe(1)
    expect(s.h7.winRate).toBe(1)       // only the real fill counts
    expect(s.h7.avgReturn).toBe(5)     // phantom gain excluded
  })

  test('target hit rate uses the target zone mid', () => {
    const records = [
      mkRecord({ price30d: 116 }), // above 115 target → hit
      mkRecord({ price30d: 110 }), // below target → miss
    ]
    const s = computeStats(records)
    expect(s.h30.targetHitRate).toBe(0.5)
  })

  test('calibration buckets by stated confidence', () => {
    const records = [
      mkRecord({ confidence: 'High',  price30d: 120, benchRet30d: 2 }), // alpha win
      mkRecord({ confidence: 'High',  price30d: 90,  benchRet30d: 2 }), // alpha loss
      mkRecord({ confidence: 'Low',   price30d: 130, benchRet30d: 2 }), // alpha win
    ]
    const s = computeStats(records)
    expect(s.calibration.High.n).toBe(2)
    expect(s.calibration.High.alphaWinRate).toBe(0.5)
    expect(s.calibration.Low.n).toBe(1)
    expect(s.calibration.Low.alphaWinRate).toBe(1)
    expect(s.calibration.Medium).toBeUndefined()
  })

  test('legacy records without basePrice fall back to entryZoneMid', () => {
    const records = [mkRecord({ basePrice: undefined, priceAtPrediction: undefined })]
    const s = computeStats(records)
    expect(s.h7.winRate).toBe(1) // (105-100)/100 from entryZoneMid
  })

  test('ensemble split separates cross-model-confirmed picks from primary-only', () => {
    const records = [
      mkRecord({ ensembleConfirmed: true,  price30d: 120, benchRet30d: 2 }), // confirmed alpha win
      mkRecord({ ensembleConfirmed: true,  price30d: 95,  benchRet30d: 2 }), // confirmed alpha loss
      mkRecord({ ensembleConfirmed: false, price30d: 90,  benchRet30d: 2 }), // unconfirmed loss
    ]
    const s = computeStats(records)
    expect(s.ensemble.confirmed.n).toBe(2)
    expect(s.ensemble.confirmed.alphaWinRate).toBe(0.5)
    expect(s.ensemble.unconfirmed.n).toBe(1)
    expect(s.ensemble.unconfirmed.alphaWinRate).toBe(0)
  })

  test('ensemble split is null when no ensemble scans were recorded', () => {
    const s = computeStats([mkRecord()]) // ensembleConfirmed undefined → null
    expect(s.ensemble).toBe(null)
  })

  test('byPattern computes win rates for patterns appearing ≥5 times', () => {
    // 6 picks with strong_uptrend: 5 wins, 1 loss → winRate = 5/6
    const records = [
      ...Array.from({ length: 5 }, () => mkRecord({ taPatterns: ['strong_uptrend'], price30d: 120, benchRet30d: 2 })),
      mkRecord({ taPatterns: ['strong_uptrend'], price30d: 90, benchRet30d: 2 }),
    ]
    const s = computeStats(records)
    expect(s.byPattern).not.toBe(null)
    expect(s.byPattern.strong_uptrend.n).toBe(6)
    expect(s.byPattern.strong_uptrend.winRate).toBeCloseTo(5 / 6, 2)
  })

  test('byPattern omits patterns appearing fewer than 5 times', () => {
    const records = [
      mkRecord({ taPatterns: ['golden_cross'], price30d: 120 }), // only 1 occurrence
    ]
    const s = computeStats(records)
    expect(s.byPattern).toBe(null) // below threshold
  })

  test('byPattern is null when no records have taPatterns', () => {
    const records = [mkRecord(), mkRecord()]
    const s = computeStats(records)
    expect(s.byPattern).toBe(null)
  })

  test('byRsRank separates weak/mid/strong RS rank buckets', () => {
    const records = [
      mkRecord({ rsRankAtScan: 20, price30d: 90,  benchRet30d: 2 }), // weak, loss
      mkRecord({ rsRankAtScan: 50, price30d: 112, benchRet30d: 2 }), // mid, win
      mkRecord({ rsRankAtScan: 85, price30d: 120, benchRet30d: 2 }), // strong, win
      mkRecord({ rsRankAtScan: 90, price30d: 118, benchRet30d: 2 }), // strong, win
    ]
    const s = computeStats(records)
    expect(s.byRsRank.weak.n).toBe(1)
    expect(s.byRsRank.weak.alphaWinRate).toBe(0)
    expect(s.byRsRank.strong.n).toBe(2)
    expect(s.byRsRank.strong.alphaWinRate).toBe(1)
  })

  test('byRsRank is null when no records have rsRankAtScan', () => {
    const s = computeStats([mkRecord()])
    expect(s.byRsRank).toBe(null)
  })

  test('byVolumeSignal separates Confirming vs Weak picks', () => {
    const records = [
      mkRecord({ volumeSignal: 'Confirming', price30d: 120, benchRet30d: 2 }), // win
      mkRecord({ volumeSignal: 'Confirming', price30d: 90,  benchRet30d: 2 }), // loss
      mkRecord({ volumeSignal: 'Weak',       price30d: 90,  benchRet30d: 2 }), // loss
    ]
    const s = computeStats(records)
    expect(s.byVolumeSignal.Confirming.n).toBe(2)
    expect(s.byVolumeSignal.Confirming.alphaWinRate).toBe(0.5)
    expect(s.byVolumeSignal.Weak.n).toBe(1)
    expect(s.byVolumeSignal.Weak.alphaWinRate).toBe(0)
  })

  test('earningsWindowImpact separates imminent/upcoming/distant windows', () => {
    const records = [
      mkRecord({ daysToEarnings: 3,    price30d: 90,  benchRet30d: 2 }), // imminent, loss
      mkRecord({ daysToEarnings: 15,   price30d: 120, benchRet30d: 2 }), // upcoming, win
      mkRecord({ daysToEarnings: null, price30d: 120, benchRet30d: 2 }), // distant, win
    ]
    const s = computeStats(records)
    expect(s.earningsWindowImpact.imminent.alphaWinRate).toBe(0)
    expect(s.earningsWindowImpact.upcoming.alphaWinRate).toBe(1)
    expect(s.earningsWindowImpact.distant.alphaWinRate).toBe(1)
  })

  test('optionsFlowImpact separates bullish/neutral/bearish P/C buckets', () => {
    const records = [
      mkRecord({ optionsPcRatio: 0.50, price30d: 120, benchRet30d: 2 }), // bullish, win
      mkRecord({ optionsPcRatio: 0.90, price30d: 90,  benchRet30d: 2 }), // neutral, loss
      mkRecord({ optionsPcRatio: 1.50, price30d: 85,  benchRet30d: 2 }), // bearish, loss
    ]
    const s = computeStats(records)
    expect(s.optionsFlowImpact.bullish.n).toBe(1)
    expect(s.optionsFlowImpact.bullish.alphaWinRate).toBe(1)
    expect(s.optionsFlowImpact.bearish.alphaWinRate).toBe(0)
  })

  test('conflictImpact measures whether agent disagreement predicted worse outcomes', () => {
    const records = [
      mkRecord({ agentConflict: { exists: true  }, price30d: 90,  benchRet30d: 2 }), // conflict, loss
      mkRecord({ agentConflict: { exists: false }, price30d: 120, benchRet30d: 2 }), // no conflict, win
    ]
    const s = computeStats(records)
    expect(s.conflictImpact.conflict.alphaWinRate).toBe(0)
    expect(s.conflictImpact.noConflict.alphaWinRate).toBe(1)
  })


  test('h90 is computed when price90d is available', () => {
    const records = [
      mkRecord({ price7d: null, benchRet7d: null, price30d: null, benchRet30d: null, price90d: 130, benchRet90d: 5 }), // +30% vs +5% bench → alpha win
      mkRecord({ price7d: null, benchRet7d: null, price30d: null, benchRet30d: null, price90d: 95,  benchRet90d: 5 }), // -5% vs +5% bench → alpha loss
    ]
    const s = computeStats(records)
    expect(s.h90).not.toBe(null)
    expect(s.h90.n).toBe(2)
    expect(s.h90.winRate).toBe(0.5)
    expect(s.h90.alphaWinRate).toBe(0.5)
  })

  test('byCompositeScore separates low/mid/high/elite score buckets', () => {
    const records = [
      mkRecord({ compositeScore: 30, price30d: 90,  benchRet30d: 2 }), // low, alpha loss
      mkRecord({ compositeScore: 55, price30d: 112, benchRet30d: 2 }), // mid, alpha win
      mkRecord({ compositeScore: 75, price30d: 120, benchRet30d: 2 }), // high, alpha win
      mkRecord({ compositeScore: 85, price30d: 118, benchRet30d: 2 }), // elite, alpha win
    ]
    const s = computeStats(records)
    expect(s.byCompositeScore.low.n).toBe(1)
    expect(s.byCompositeScore.low.alphaWinRate).toBe(0)
    expect(s.byCompositeScore.mid.n).toBe(1)
    expect(s.byCompositeScore.elite.n).toBe(1)
    expect(s.byCompositeScore.elite.alphaWinRate).toBe(1)
  })

  test('byCompositeScore is null when no records have compositeScore', () => {
    const s = computeStats([mkRecord()])
    expect(s.byCompositeScore).toBe(null)
  })

  test('byHighConviction separates highConviction picks from standard picks', () => {
    const records = [
      mkRecord({ highConviction: true,  price30d: 120, benchRet30d: 2 }), // hc, alpha win
      mkRecord({ highConviction: true,  price30d: 95,  benchRet30d: 2 }), // hc, alpha loss
      mkRecord({ highConviction: false, price30d: 90,  benchRet30d: 2 }), // standard, loss
    ]
    const s = computeStats(records)
    expect(s.byHighConviction.true.n).toBe(2)
    expect(s.byHighConviction.true.alphaWinRate).toBe(0.5)
    expect(s.byHighConviction.false.n).toBe(1)
    expect(s.byHighConviction.false.alphaWinRate).toBe(0)
  })

  test('byHighConviction is null when no records have highConviction', () => {
    const s = computeStats([mkRecord()])
    expect(s.byHighConviction).toBe(null)
  })

  test('autoTunedThreshold is null when fewer than 5 benchmark-matched picks at any threshold', () => {
    // Only 4 records with compositeScore — always below the 5-pick minimum
    const records = Array.from({ length: 4 }, () =>
      mkRecord({ compositeScore: 60, price30d: 115, benchRet30d: 2 }))
    const s = computeStats(records)
    expect(s.autoTunedThreshold).toBe(null)
    expect(s.autoTunedThresholdAlphaWinRate).toBe(null)
  })

  test('autoTunedThreshold selects the cutoff that maximises alpha win rate', () => {
    // compositeScore=38 picks all lose to benchmark → drag alpha down when t≤35
    // compositeScore=60 picks all beat benchmark → t=40 sees only the winners
    // t=35: 10 picks, 5 alpha wins → 0.5; t=40..60: 5 picks, 5 wins → 1.0
    const records = [
      ...Array.from({ length: 5 }, () => mkRecord({ compositeScore: 38, price30d: 90,  benchRet30d: 2 })),
      ...Array.from({ length: 5 }, () => mkRecord({ compositeScore: 60, price30d: 115, benchRet30d: 2 })),
    ]
    const s = computeStats(records)
    expect(s.autoTunedThreshold).toBe(40)
    expect(s.autoTunedThresholdAlphaWinRate).toBe(1)
  })

  test('autoTunedThreshold prefers the lowest threshold when multiple thresholds tie', () => {
    // 5 picks at compositeScore=50: included at t=35..50, excluded at t=55+
    // All are alpha wins → alpha win rate is 1.0 at t=35,40,45,50
    // Strict > comparison means the first (lowest) threshold wins on ties
    const records = Array.from({ length: 5 }, () =>
      mkRecord({ compositeScore: 50, price30d: 115, benchRet30d: 2 }))
    const s = computeStats(records)
    expect(s.autoTunedThreshold).toBe(35)
    expect(s.autoTunedThresholdAlphaWinRate).toBe(1)
  })
})

describe('checkEntryZones', () => {
  const recent = () => new Date(Date.now() - 5 * DAY).toISOString()

  function mkPred(overrides) {
    return { symbol: 'AAPL', generatedAt: recent(), entryZoneLow: 100, entryZoneHigh: 110, verdict: 'Buy', compositeScore: 80, ...overrides }
  }

  test('returns hit when price is inside entry zone', () => {
    const hits = checkEntryZones({ AAPL: 105 }, [mkPred()])
    expect(hits).toHaveLength(1)
    expect(hits[0].symbol).toBe('AAPL')
    expect(hits[0].currentPrice).toBe(105)
  })

  test('returns empty when price is below entry zone', () => {
    expect(checkEntryZones({ AAPL: 95 }, [mkPred()])).toHaveLength(0)
  })

  test('returns empty when price is above entry zone', () => {
    expect(checkEntryZones({ AAPL: 115 }, [mkPred()])).toHaveLength(0)
  })

  test('skips already-alerted predictions', () => {
    const hits = checkEntryZones({ AAPL: 105 }, [mkPred({ entryAlertedAt: new Date().toISOString() })])
    expect(hits).toHaveLength(0)
  })

  test('skips predictions older than 90 days', () => {
    const old = new Date(Date.now() - 91 * DAY).toISOString()
    expect(checkEntryZones({ AAPL: 105 }, [mkPred({ generatedAt: old })])).toHaveLength(0)
  })

  test('skips predictions with no entry zone', () => {
    expect(checkEntryZones({ AAPL: 105 }, [mkPred({ entryZoneLow: null, entryZoneHigh: null })])).toHaveLength(0)
  })

  test('skips already-resolved predictions', () => {
    expect(checkEntryZones({ AAPL: 105 }, [mkPred({ price7d: 108, price30d: 115 })])).toHaveLength(0)
  })

  test('returns empty when priceMap is empty', () => {
    expect(checkEntryZones({}, [mkPred()])).toHaveLength(0)
  })
})
