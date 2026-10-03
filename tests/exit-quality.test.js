'use strict'

const { measureExit, summarizeExitQuality, exitQualityLine, EXIT_VERSION } = require('../lib/exit-quality')

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 5)
// bars from [o,h,l,c] tuples, one per day starting at T0
const mk = rows => rows.map(([o, h, l, c], i) => ({ t: T0 + i * DAY, o, h, l, c }))
const base = { from: T0, to: T0 + 30 * DAY, entry: 100, target: 110, stop: 95 }

describe('measureExit', () => {
  test('a target exit: best point is the target, nothing given back', () => {
    const bars = mk([[100, 101, 99, 100], [100, 104, 98, 103], [103, 111, 102, 108]])
    const e = measureExit(bars, base)
    expect(e).toMatchObject({ filled: true, exitReason: 'target', realized: 10, mfe: 10, giveBack: 0, efficiency: 1, mae: -2 })
  })

  test('a round trip: reached +8%, exited flat at the horizon — 8 given back', () => {
    const bars = mk([[100, 100, 100, 100], [101, 108, 100, 107], [107, 107, 99, 100]])
    const e = measureExit(bars, base)
    expect(e).toMatchObject({ exitReason: 'time', mfe: 8, realized: 0, giveBack: 8, efficiency: 0 })
  })

  test('stop and target inside one bar resolve as the stop', () => {
    const bars = mk([[100, 100, 100, 100], [100, 112, 94, 100]])
    const e = measureExit(bars, base)
    expect(e.exitReason).toBe('stop')
    expect(e.realized).toBe(-5)
  })

  test('a gap through the stop fills at the open, not at the stop', () => {
    const bars = mk([[100, 100, 100, 100], [90, 92, 89, 91]])
    expect(measureExit(bars, base)).toMatchObject({ exitReason: 'stop', realized: -10, mae: -10 })
  })

  test("the fill bar's high does not count — it may have printed before the fill", () => {
    // Zone 99–101. Day 0 trades 99–120 (high could be before the fill), closes 100.
    const bars = mk([[105, 120, 99, 100], [100, 102, 99, 101]])
    const e = measureExit(bars, { ...base, target: 130, zoneLow: 99, zoneHigh: 101 })
    expect(e.mfe).toBe(2)               // from day 1, not the 120 on the fill day
  })

  test('the window starts at the fill, and an unfilled pick is no trade', () => {
    const bars = mk([[104, 106, 103, 105], [105, 106, 100, 101], [101, 109, 101, 108]])
    const e = measureExit(bars, { ...base, zoneLow: 99, zoneHigh: 101 })
    expect(e.fillAt).toBe(T0 + DAY)
    const never = mk([[104, 106, 103, 105], [105, 108, 104, 107]])
    expect(measureExit(never, { ...base, zoneLow: 99, zoneHigh: 101 })).toEqual({ filled: false })
  })

  test('a short is scored in its own direction', () => {
    const bars = mk([[100, 100, 100, 100], [99, 100, 92, 93], [93, 94, 89, 90]])
    const e = measureExit(bars, { ...base, target: 90, stop: 105, long: false })
    expect(e).toMatchObject({ exitReason: 'target', realized: 10, mae: 0 })
  })

  test('no bars, or levels that contradict each other, is unscoreable — not a zero', () => {
    expect(measureExit([], base)).toBeNull()
    expect(measureExit(mk([[100, 100, 100, 100]]), { ...base, target: 90 })).toBeNull()
  })
})

describe('summarizeExitQuality', () => {
  const rec = (exit, extra = {}) => ({ exitV: EXIT_VERSION, exit: { filled: true, ...exit }, ...extra })

  test('below the floor it reports only the count — no medians to over-read', () => {
    const out = summarizeExitQuality([rec({ mfe: 5, mae: -1, realized: 4, giveBack: 1, efficiency: 0.8, exitReason: 'time', targetPct: 10, stopPct: 5 })], { minN: 30 })
    expect(out).toMatchObject({ n: 1, ready: false })
    expect(out.medianMfe).toBeUndefined()
    expect(exitQualityLine(out)).toBe('')
  })

  test('diagnostics count the right populations, with intervals', () => {
    const rows = [
      // winner that first dipped 4.5% against a 5% stop → near-stop winner
      ...Array(10).fill(rec({ mfe: 10, mae: -4.5, realized: 10, giveBack: 0, efficiency: 1, exitReason: 'target', targetPct: 10, stopPct: 5 })),
      // stopped after reaching +6 of a +10 target → halfway, and a near-miss? (6 < 8) no
      ...Array(10).fill(rec({ mfe: 6, mae: -5, realized: -5, giveBack: 11, efficiency: -0.83, exitReason: 'stop', targetPct: 10, stopPct: 5 })),
      // time exit after reaching +9 of +10 → near-miss
      ...Array(10).fill(rec({ mfe: 9, mae: -1, realized: 2, giveBack: 7, efficiency: 0.22, exitReason: 'time', targetPct: 10, stopPct: 5 })),
    ]
    const out = summarizeExitQuality(rows, { minN: 30 })
    expect(out.ready).toBe(true)
    expect(out.exits).toEqual({ target: 10, stop: 10, time: 10 })
    expect(out.winnersNearStop).toMatchObject({ k: 10, n: 20 })          // 10 target winners near stop, 10 time winners not
    expect(out.targetNearMiss).toMatchObject({ k: 10, n: 20 })           // the time exits; stop-outs only reached 60%
    expect(out.stoppedAfterHalfway).toMatchObject({ k: 10, n: 10, rate: 1 })
    expect(out.winnersNearStop.lo).toBeGreaterThan(0)
    expect(exitQualityLine(out)).toMatch(/EXIT QUALITY \(30 filled picks/)
  })

  test('only the current version counts, and unfilled picks are reported apart', () => {
    const out = summarizeExitQuality([
      { exitV: EXIT_VERSION - 1, exit: { filled: true, mfe: 1 } },
      { exitV: EXIT_VERSION, exit: { filled: false } },
    ])
    expect(out).toMatchObject({ n: 0, unfilled: 1, ready: false })
  })
})
