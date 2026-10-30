'use strict'

// The Agent Hub pipeline's numbers. It fetched 6 months of bars (so SMA200
// was always N/A and the "52-week" range was 6 months), took ATR as the
// average high−low (ignoring gaps), filtered highs and lows separately (so a
// missing value paired one day's high with another day's low), turned a
// failed quote into a $0 price, and spent a model call echoing levels code had
// already computed.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
const request = require('supertest')
const express = require('express')
const agents = require('../routes/agents')
const { barsFromChart, pipelineFacts, verdictOf } = agents._test

const DAY = 86400
const chart = rows => ({ chart: { result: [{
  timestamp: rows.map((_, i) => 1_700_000_000 + i * DAY),
  indicators: { quote: [{ high: rows.map(r => r[0]), low: rows.map(r => r[1]), close: rows.map(r => r[2]) }] },
}] } })

test('a session missing its high or low is dropped whole, not shifted against another day', () => {
  const bars = barsFromChart(chart([[11, 9, 10], [null, 9, 10], [13, 11, 12]]))
  expect(bars.map(b => [b.h, b.l, b.c])).toEqual([[11, 9, 10], [13, 11, 12]])
})

test('a year of bars gives SMA200 and a real 52-week range', () => {
  const rows = Array.from({ length: 252 }, (_, i) => [101 + i * 0.1, 99 + i * 0.1, 100 + i * 0.1])
  const f = pipelineFacts(barsFromChart(chart(rows)), null)
  expect(f.sma200).not.toBeNull()
  expect(f.rangeLabel).toBe('52-week')
  expect(f.trend).toBe('UPTREND')
  expect(f.price).toBeCloseTo(125.1, 1)          // no quote → last close
})

test('six months of bars is labelled as such, not as 52 weeks', () => {
  const rows = Array.from({ length: 126 }, () => [101, 99, 100])
  expect(pipelineFacts(barsFromChart(chart(rows)), 100).rangeLabel).toBe('126-session')
})

test('ATR counts the overnight gap that a high−low average missed', () => {
  // Alternating gaps: each bar's own range is 2, but it opens 10 away from the last close
  const rows = Array.from({ length: 40 }, (_, i) => (i % 2 ? [111, 109, 110] : [101, 99, 100]))
  const f = pipelineFacts(barsFromChart(chart(rows)), 100)
  expect(f.atr14).toBeGreaterThan(9)
  expect(f.levels.stop_loss).toBeLessThan(100 - 1.5 * 9)
})

test('long levels sit stop < entry < targets, from ATR', () => {
  const rows = Array.from({ length: 60 }, () => [102, 98, 100])
  const f = pipelineFacts(barsFromChart(chart(rows)), 100)
  expect(f.levels.stop_loss).toBeLessThan(100)
  expect(f.levels.target_1).toBeGreaterThan(100)
  expect(f.levels.target_2).toBeGreaterThan(f.levels.target_1)
  expect(f.levels.risk_reward).toBeCloseTo(2.5 / 1.5, 1)
})

test('no bars and no quote is no price — never $0', () => {
  expect(pipelineFacts([], null)).toMatchObject({ price: null, levels: null })
})

test("the strategist's verdict is read from its Verdict section", () => {
  expect(verdictOf('## Verdict — BEARISH\nPrice below SMA200')).toBe('BEARISH')
  expect(verdictOf('## Verdict\nBULLISH — trend intact')).toBe('BULLISH')
  expect(verdictOf('no call')).toBeNull()
})

test('both routes need a signed-in user (they pay for model calls)', async () => {
  const app = express(); app.use(express.json()); app.use('/api/agents', agents)
  expect((await request(app).post('/api/agents/research').send({ symbol: 'AAPL' })).status).toBe(401)
  expect((await request(app).post('/api/agents/pipeline').send({ symbol: 'AAPL' })).status).toBe(401)
})
