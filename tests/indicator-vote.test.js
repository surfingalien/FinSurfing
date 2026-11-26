'use strict'
const iv = require('../lib/indicator-vote')
const bt = require('../lib/indicator-vote-backtest')

const DAY = 86_400_000
function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const gauss = r => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()) }
function walk(n, seed, drift = 0, vol = 0.015) {
  const r = rng(seed); let p = 100; const out = []
  for (let i = 0; i < n; i++) {
    const o = p; p *= Math.exp(drift + vol * gauss(r))
    const hi = Math.max(o, p) * (1 + Math.abs(gauss(r)) * vol / 3), lo = Math.min(o, p) * (1 - Math.abs(gauss(r)) * vol / 3)
    out.push({ t: Date.UTC(2020, 0, 1) + i * DAY, o, h: hi, l: lo, c: p })
  }
  return out
}

describe('the vote', () => {
  it('four votes; indicators without a view are counted as no opinion, not dropped', () => {
    const v = iv.indicatorVote(walk(300, 3, 0.004, 0.005))     // steady climb
    expect(v.total).toBe(4)
    expect(v.for + v.against + v.noOpinion).toBe(4)
    expect(v.votes[0].name).toBe('Trend')
    expect(v.votes[0].components.length).toBeGreaterThanOrEqual(4)
  })
  it('a steady uptrend is ONE trend vote, however many trend indicators agree', () => {
    const v = iv.indicatorVote(walk(300, 3, 0.004, 0.005))
    expect(v.votes[0].vote).toBe(1)
    expect(v.votes.filter(x => x.name === 'Trend')).toHaveLength(1)
  })
  it('BUY needs two more votes for than against, and carries the 2-ATR stop / 3-ATR target', () => {
    const S = iv.computeSeries(walk(600, 11, 0.002))
    let seen = 0
    for (let i = iv.MIN_BARS; i < S.bars.length; i++) {
      const v = iv.voteAt(S, i)
      if (v.verdict === 'BUY') {
        expect(v.for - v.against).toBeGreaterThanOrEqual(2)
        expect(v.stop).toBeCloseTo(v.price - 2 * v.atr, 1)
        expect(v.target).toBeCloseTo(v.price + 3 * v.atr, 1)
        seen++
      }
      if (v.verdict === 'HOLD') expect(Math.abs(v.for - v.against)).toBeLessThan(2)
    }
    expect(seen).toBeGreaterThan(0)
  })
  it('never reads later bars: appending history does not change an earlier vote', () => {
    const full = walk(500, 5)
    const a = iv.computeSeries(full.slice(0, 400)), b = iv.computeSeries(full)
    for (let i = iv.MIN_BARS; i < 400; i += 7) expect(iv.voteAt(b, i)).toEqual(iv.voteAt(a, i))
  })
  it('too little history is null', () => {
    expect(iv.indicatorVote(walk(50, 1))).toBeNull()
  })
  it('accepts the browser candle shape', () => {
    const c = walk(200, 2).map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }))
    expect(iv.indicatorVote(c).total).toBe(4)
  })
})

describe('the backtest', () => {
  it('a bar touching both the stop and the target exits at the stop; a gap exits at the open', () => {
    const S = { bars: [], close: [], atr: [] }
    const push = (o, h, l, c) => { S.bars.push({ o, h, l, c }); S.close.push(c); S.atr.push(1) }
    push(100, 100, 100, 100)          // signal bar: stop 98, target 103
    push(100, 104, 97, 100)           // touches both
    expect(bt.tradeFrom(S, 0, { maxHold: 5, cost: 0 }).kind).toBe('stop')
    S.bars.length = S.close.length = S.atr.length = 1
    push(100, 100, 100, 100); push(96, 96, 95, 95)   // entry 100, next bar opens below the stop
    const g = bt.tradeFrom(S, 0, { maxHold: 5, cost: 0 }); expect(g.kind).toBe('stop'); expect(g.ret).toBeCloseTo(-0.04, 10)
  })
  it('an unfinished last window is not an outcome', () => {
    const S = { bars: [{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 101, l: 99, c: 100 }], close: [100, 100], atr: [1, 1] }
    expect(bt.tradeFrom(S, 0, { maxHold: 5, cost: 0 })).toBeNull()
  })
  it('on random walks the rule rarely beats random timing', () => {
    let beats = 0, decided = 0
    for (let s = 1; s <= 12; s++) {
      const r = bt.backtestVote(walk(1260, s * 31), { draws: 200 })
      if (r.verdict !== 'insufficient') decided++
      if (r.verdict === 'beats-random') beats++
    }
    expect(decided).toBeGreaterThan(0)
    expect(beats).toBeLessThanOrEqual(2)
  })
  it('reports counts, the break-even hit rate, random-day comparison and the current vote', () => {
    const r = bt.backtestVote(walk(1260, 9), { draws: 100 })
    expect(r.targetFirst + r.stopFirst + r.timeExit).toBe(r.trades)
    expect(r.breakEvenRate).toBe(0.4)
    expect(r.random.draws).toBe(100)
    expect(r.current.total).toBe(4)
    expect(r.p).toBeGreaterThan(0)
  })
  it('the route is signed-in only', async () => {
    const express = require('express'), request = require('supertest')
    const app = express(); app.use('/api/indicator-vote', require('../routes/indicator-vote'))
    expect((await request(app).get('/api/indicator-vote/backtest/AAPL')).status).toBe(401)
  })
})
