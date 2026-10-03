'use strict'
/**
 * Has the last bar closed? During the US session the final daily bar is
 * today's, and its volume is volume SO FAR — 0.3x the average at 11:00 is a
 * normal day. Volume measures must use the last completed bar.
 */
const { isBarForming, isLastBarForming, usSessionElapsed, usSessionOpen } = require('../lib/bar-session')
const { volumeAnalysis, detectPatterns, compactTaLine } = require('../lib/technical-indicators')

// Wed 2026-09-30. 15:00 UTC = 11:00 New York (EDT); 21:00 UTC = 17:00 New York.
const MID_SESSION = Date.UTC(2026, 8, 30, 15, 0)
const AFTER_CLOSE = Date.UTC(2026, 8, 30, 21, 0)
const TODAY_0000  = Date.UTC(2026, 8, 30, 0, 0)      // provider stamps 00:00 UTC
const TODAY_1330  = Date.UTC(2026, 8, 30, 13, 30)    // or the 09:30 ET open
const YESTERDAY   = Date.UTC(2026, 8, 29, 0, 0)

describe('isBarForming', () => {
  test("today's daily bar is forming during the session, whichever way the provider stamps it", () => {
    expect(isBarForming(TODAY_0000, { now: MID_SESSION })).toBe(true)
    expect(isBarForming(TODAY_1330, { now: MID_SESSION })).toBe(true)
    expect(isBarForming('2026-09-30', { now: MID_SESSION })).toBe(true)
    expect(isBarForming(Math.floor(TODAY_0000 / 1000), { now: MID_SESSION })).toBe(true)   // seconds
  })
  test("after the close today's bar is complete, and yesterday's always is", () => {
    expect(isBarForming(TODAY_0000, { now: AFTER_CLOSE })).toBe(false)
    expect(isBarForming(YESTERDAY, { now: MID_SESSION })).toBe(false)
  })
  test('crypto daily bars run on UTC days', () => {
    expect(isBarForming(TODAY_0000, { isCrypto: true, now: AFTER_CLOSE })).toBe(true)
    expect(isBarForming(YESTERDAY, { isCrypto: true, now: AFTER_CLOSE })).toBe(false)
  })
  test('intraday bars are forming until start + interval', () => {
    const t = Date.UTC(2026, 8, 30, 14, 45)
    expect(isLastBarForming([{ t }], { interval: '15m', now: t + 10 * 60e3 })).toBe(true)
    expect(isLastBarForming([{ t }], { interval: '15m', now: t + 16 * 60e3 })).toBe(false)
  })
  test('an unknown bar time is treated as complete (the old behaviour)', () => {
    expect(isBarForming(undefined, { now: MID_SESSION })).toBe(false)
  })
})

test('session clock', () => {
  expect(usSessionOpen(MID_SESSION)).toBe(true)
  expect(usSessionOpen(AFTER_CLOSE)).toBe(false)
  expect(usSessionOpen(Date.UTC(2026, 9, 3, 15, 0))).toBe(false)        // Saturday
  expect(usSessionElapsed(MID_SESSION)).toBeCloseTo(90 / 390, 5)       // 09:30 → 11:00
})

describe('volume measures skip a forming bar', () => {
  // 21 normal days of 1,000,000, then today so far: 300,000 by 11:00.
  const vols = [...Array(21).fill(1_000_000), 300_000]
  test('the ratio is measured on the last full day, not the partial one', () => {
    expect(volumeAnalysis(vols).ratio).toBe(0.3)                              // the old reading
    const v = volumeAnalysis(vols, { lastBarForming: true })
    expect(v.ratio).toBe(1)
    expect(v.basis).toBe('last full bar')
  })
  test("yesterday's real spike is visible before today's close", () => {
    const spiky = [...Array(21).fill(1_000_000), 3_500_000, 200_000]
    const closes = spiky.map((_, i) => 100 + i), opens = closes.map(c => c - 1)
    expect(detectPatterns(opens, closes, closes, closes, spiky)).not.toContain('volume_spike')
    expect(detectPatterns(opens, closes, closes, closes, spiky, { lastBarForming: true })).toEqual(
      expect.arrayContaining(['volume_spike', 'high_vol_bull']))
  })
  test('the TA line says which day the volume describes', () => {
    const n = 60
    const c = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 2)
    const v = [...Array(n - 1).fill(1_000_000), 250_000]
    const line = compactTaLine('X', c, c.map(x => x + 1), c.map(x => x - 1), c, v, { lastBarForming: true })
    expect(line).toMatch(/Vol=1x\/\w+\(prev full day\)/)
  })
})
