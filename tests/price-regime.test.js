'use strict'

const pr = require('../lib/price-regime')

// Deterministic pseudo-random walk: drift and volatility per segment.
function walk(segments, seed = 7) {
  let s = seed, c = 100, t = Date.UTC(2022, 0, 3)
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5 }
  const bars = []
  for (const [n, drift, vol] of segments) {
    for (let i = 0; i < n; i++) {
      c *= 1 + drift + vol * rnd() * 3.4
      bars.push({ t, c })
      t += 86400000
    }
  }
  return bars
}

const calmUp = walk([[400, 0.001, 0.006]])
const crash  = walk([[400, 0.001, 0.006], [60, -0.006, 0.03]])

test('a steady advance with quiet days reads as up-calm; a fast decline in wild days reads as down-stressed', () => {
  expect(pr.regimeAt(calmUp)).toMatchObject({ trend: 'up', vol: 'calm', label: 'up-calm' })
  expect(pr.regimeAt(crash)).toMatchObject({ trend: 'down', vol: 'stressed', label: 'down-stressed' })
  expect(pr.regimeAt(crash).volPct).toBeGreaterThan(75)
})

test('no lookahead: appending future bars never changes a past label', () => {
  const full = pr.regimeSeries(crash)
  for (const i of [pr.MIN_INDEX, 300, 399, 420, crash.length - 1]) {
    expect(pr.regimeSeries(crash.slice(0, i + 1))[i]).toEqual(full[i])
  }
})

test('too little history gives no label rather than a guess', () => {
  expect(pr.regimeAt(calmUp.slice(0, pr.MIN_INDEX))).toBeNull()
  expect(pr.regimeAt([])).toBeNull()
})

test('the forward profile uses non-overlapping windows and separates the states it saw', () => {
  const bars = walk([[400, 0.001, 0.006], [80, -0.006, 0.03], [200, 0.0015, 0.007]])
  const prof = pr.forwardProfile(bars, { horizon: 20 })
  const total = Object.values(prof).reduce((a, b) => a + b.n, 0)
  expect(total).toBeLessThanOrEqual(Math.ceil((bars.length - pr.MIN_INDEX) / 20))
  for (const p of Object.values(prof)) expect(p).toEqual(expect.objectContaining({ n: expect.any(Number), meanFwdRet: expect.any(Number) }))
})

test('current regimes: SPY for stocks, BTC for crypto, cached for an hour, a failed fetch is null not a crash', async () => {
  pr._resetForTests()
  const fetchBars = jest.fn(async sym => (sym === 'SPY' ? calmUp : Promise.reject(new Error('down'))))
  const r = await pr.getCurrentRegimes({ fetchBars, now: 1_000 })
  expect(r.equity).toMatchObject({ symbol: 'SPY', label: 'up-calm' })
  expect(r.crypto).toBeNull()
  expect(pr.labelFor('stock', r)).toBe('up-calm')
  expect(pr.labelFor('crypto', r)).toBeNull()
  await pr.getCurrentRegimes({ fetchBars, now: 1_000 + 60_000 })
  expect(fetchBars).toHaveBeenCalledTimes(2)
  expect(pr.cachedRegimes()).toBe(r)
  expect(pr.describe(r.equity, 'SPY')).toMatch(/^SPY: uptrend, calm volatility \(20-day vol [\d.]+%, \d+(st|nd|rd|th) percentile/)
  expect([1, 2, 3, 4, 11, 12, 13, 21, 82, 100].map(pr.ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '82nd', '100th'])
})
