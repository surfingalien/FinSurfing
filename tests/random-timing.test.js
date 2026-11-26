'use strict'
const rt = require('../lib/random-timing')
const SE = require('../lib/strategy-evidence')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const walk = (n, seed, drift = () => 0) => { const r = rng(seed), c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * (1 + drift(i) + (r() - 0.5) * 0.02)); return c }

describe('randomTiming', () => {
  it('finds timing that really holds the rising windows', () => {
    const c = walk(1200, 3, i => ((i % 100) >= 20 && (i % 100) < 40 ? 0.004 : 0))
    const blocks = Array.from({ length: 12 }, (_, b) => [b * 100 + 20, b * 100 + 40])
    const r = rt.randomTiming({ closes: c, blocks })
    expect(r.verdict).toBe('beats-random')
    expect(r.p).toBeLessThanOrEqual(0.01)
    expect(r.exposure).toBeCloseTo(0.2, 1)
  })
  it('on a random walk, random blocks beat random timing about 5% of the time — no more', () => {
    let beats = 0, noBetter = 0
    for (let seed = 1; seed <= 60; seed++) {
      const c = walk(800, seed * 31)
      const g = rng(seed * 7), blocks = []
      let at = 1 + Math.floor(g() * 20)
      while (blocks.length < 10 && at < 760) { const len = 5 + Math.floor(g() * 20); blocks.push([at, at + len]); at += len + 5 + Math.floor(g() * 40) }
      const r = rt.randomTiming({ closes: c, blocks, seed })
      if (r.verdict === 'beats-random') beats++
      if (r.verdict === 'no-better') noBetter++
    }
    expect(beats).toBeLessThanOrEqual(8)
    expect(noBetter).toBeGreaterThan(15)
  })
  it('is seeded: the same input gives the same p', () => {
    const c = walk(600, 5), blocks = [[10, 30], [60, 80], [120, 150], [200, 230], [300, 320]]
    expect(rt.randomTiming({ closes: c, blocks, seed: 9 }).p).toBe(rt.randomTiming({ closes: c, blocks, seed: 9 }).p)
  })
  it('needs enough positions to place at random', () => {
    expect(rt.randomTiming({ closes: walk(300, 2), blocks: [[5, 20], [40, 60]] }).verdict).toBe('insufficient')
  })
  it('counts dividends and cash interest on both sides', () => {
    const c = walk(400, 8).map(() => 100)               // flat price
    const div = c.map((_, i) => (i % 63 === 0 && i ? 1 : 0))
    const blocks = Array.from({ length: 6 }, (_, b) => [b * 60 + 1, b * 60 + 31])
    const withDiv = rt.randomTiming({ closes: c, blocks, dividends: div })
    const without = rt.randomTiming({ closes: c, blocks })
    expect(withDiv.randomMedianPct).not.toBe(without.randomMedianPct)
  })
})

describe('blocksFromTrades', () => {
  it('turns simulator trades (incl. a half-booked bracket and an open position) into exposure blocks', () => {
    const ts = Array.from({ length: 30 }, (_, i) => Date.UTC(2024, 0, 1 + i) / 1000)
    const d = i => new Date(ts[i] * 1000).toISOString().slice(0, 10)
    const trades = [
      { type: 'buy', date: d(2), shares: 10 }, { type: 'sell', date: d(5), shares: 5 }, { type: 'sell', date: d(8), shares: 5 },
      { type: 'buy', date: d(20), shares: 4 }, { type: 'sell', date: d(29), shares: 4, open: true },
    ]
    expect(rt.blocksFromTrades(trades, ts)).toEqual([[3, 9], [21, 30]])
  })
})

describe('the admission rule', () => {
  it('refuses a strategy that random timing matched, and says so; others pass this check', () => {
    expect(SE.evidenceProblem({ timing: { verdict: 'no-better', p: 0.7, strategyReturnPct: 10, randomMedianPct: 15 } })).toMatch(/random timing/)
    expect(SE.evidenceProblem({ timing: { verdict: 'unclear', p: 0.2 } })).toBeNull()
    expect(SE.evidenceProblem({ timing: { verdict: 'insufficient' } })).toBeNull()
  })
  it('has a report card row', () => {
    const card = SE.reportCard({ timing: { verdict: 'beats-random', p: 0.01, draws: 1000, strategyReturnPct: 50, randomMedianPct: 20 } })
    expect(card.rows.find(r => r.key === 'timing').status).toBe('pass')
  })
  it('the Strategy Brain funnel counts it under evidence', () => {
    expect(require('../lib/strategy-brain').stageOf('random timing with the same exposure did as well (p 0.7)')).toBe('evidence')
  })
})
