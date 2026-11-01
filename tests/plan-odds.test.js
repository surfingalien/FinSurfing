'use strict'
const P = require('../lib/plan-odds')
const L = require('../lib/quant/linalg')

describe('first passage between a target and a stop', () => {
  test('with a long horizon a driftless PRICE reaches the target with probability (entry−stop)/(target−stop)', () => {
    // price is a martingale: P(target first) = (P−S)/(T−S) — here 100, 90, 120 → 1/3
    const fp = P.firstPassage(Math.log(1.2), -Math.log(0.9), 0.3 / Math.sqrt(252), 252 * 40)
    expect(fp.pTarget).toBeCloseTo(1 / 3, 2)
    expect(fp.pStop).toBeCloseTo(2 / 3, 2)
    expect(fp.pNeither).toBeLessThan(0.01)
  })
  test('matches a fine-step Monte Carlo over a finite horizon', () => {
    const sigma = 0.35 / Math.sqrt(252), T = 63, up = Math.log(1.15), down = -Math.log(0.92)
    const fp = P.firstPassage(up, down, sigma, T)
    const g = L.rng(7), sub = 20, dt = 1 / sub, n = 20000
    let hitU = 0, hitD = 0
    for (let p = 0; p < n; p++) {
      let x = 0
      for (let k = 0; k < T * sub; k++) {
        x += -0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * g.normal()
        if (x >= up) { hitU++; break }
        if (x <= -down) { hitD++; break }
      }
    }
    // discrete monitoring misses a few touches, so the simulation sits slightly below the continuous answer
    expect(Math.abs(fp.pTarget - hitU / n)).toBeLessThan(0.03)
    expect(Math.abs(fp.pStop - hitD / n)).toBeLessThan(0.03)
  })
  test('more time, more decided; wider target, fewer target hits', () => {
    const a = P.bracketOdds({ targetPct: 10, stopPct: 5, sessions: 20, vol: 0.3 })
    const b = P.bracketOdds({ targetPct: 10, stopPct: 5, sessions: 120, vol: 0.3 })
    const c = P.bracketOdds({ targetPct: 25, stopPct: 5, sessions: 120, vol: 0.3 })
    expect(b.pNeither).toBeLessThan(a.pNeither)
    expect(c.pTarget).toBeLessThan(b.pTarget)
    expect(a.pTarget + a.pStop + a.pNeither).toBeCloseTo(1, 3)
  })
  test('nonsense levels give no odds rather than a number', () => {
    expect(P.bracketOdds({ targetPct: -5, stopPct: 5, sessions: 20, vol: 0.3 })).toBeNull()
    expect(P.bracketOdds({ targetPct: 5, stopPct: 0, sessions: 20, vol: 0.3 })).toBeNull()
    expect(P.bracketOdds({ targetPct: 5, stopPct: 5, sessions: 20, vol: 0 })).toBeNull()
  })
})

describe('stop against the noise', () => {
  test('a stop inside one daily move is inside the noise; a wide one is clear', () => {
    // 40% a year → 2.52% a day
    expect(P.stopNoise({ stopPct: 2, vol: 0.4 }).level).toBe('inside-noise')
    expect(P.stopNoise({ stopPct: 5, vol: 0.4 }).level).toBe('tight')
    expect(P.stopNoise({ stopPct: 9, vol: 0.4 }).level).toBe('clear')
  })
  test('one ordinary bad day (95% VaR) reaching the stop is flagged however many sigmas it is', () => {
    const s = P.stopNoise({ stopPct: 4, vol: 0.2, var95: 0.045, price: 50 })
    expect(s.oneBadDay).toBe(true)
    expect(s.level).toBe('inside-noise')
    expect(s.volatilityStopPrice).toBeCloseTo(50 * (1 - s.volatilityStopPct / 100), 2)
  })
  test('calendar horizons convert to sessions', () => {
    expect(P.sessionsFromCalendarDays(91)).toBe(63)
    expect(P.sessionsFromCalendarDays(365)).toBe(252)
  })
})

describe('odds check against outcomes', () => {
  const rec = (pTarget, label, extra = {}) => ({ modelOdds: { pTarget }, barrier: { label, window: 91 }, horizonDays: 91, ...extra })
  test('picks reaching their target far more often than their odds are credited; too few decide nothing', () => {
    const rows = [...Array.from({ length: 30 }, () => rec(0.3, 'target')), ...Array.from({ length: 10 }, () => rec(0.3, 'stop'))]
    const c = P.oddsCheck(rows)
    expect(c.targetFirstRate).toBe(0.75)
    expect(c.verdict).toBe('beats-no-skill-odds')
    expect(P.oddsCheck(rows.slice(0, 10)).verdict).toBeUndefined()
  })
  test('labels from another window, unfilled picks and unstamped picks are left out', () => {
    const rows = [rec(0.4, 'target', { barrier: { label: 'target', window: 30 } }), rec(0.4, 'stop', { entered: false }), { barrier: { label: 'target', window: 91 }, horizonDays: 91 }, rec(0.4, 'time')]
    expect(P.oddsCheck(rows).n).toBe(1)
  })
  test('stop-first rate is split by where the stop sat against the noise', () => {
    const rows = [rec(0.3, 'stop', { stopNoise: 'inside-noise' }), rec(0.3, 'target', { stopNoise: 'clear' })]
    const c = P.oddsCheck(rows)
    expect(c.byStopNoise['inside-noise'].stopFirstRate).toBe(1)
    expect(c.byStopNoise.clear.stopFirstRate).toBe(0)
  })
})
