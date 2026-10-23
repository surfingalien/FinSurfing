'use strict'

const sm = require('../lib/settled-memory')

const NOW = Date.UTC(2026, 9, 20)
const ago = d => new Date(NOW - d * 86_400_000).toISOString()

test('past calls are settled against today, direction-aware; HOLDs and same-day calls are not scored', () => {
  const out = sm.settleMemories([
    { signal: 'BUY',  price: 100, created_at: ago(10), confidence: 72 },
    { signal: 'SELL', price: 100, created_at: ago(20) },
    { signal: 'HOLD', price: 100, created_at: ago(5) },
    { signal: 'BUY',  price: 100, created_at: ago(0) },
  ], 90, NOW)
  expect(out.map(s => [s.signal, s.retPct, s.verdict])).toEqual([
    ['BUY', -10, 'wrong so far'], ['SELL', -10, 'right so far'], ['HOLD', -10, 'not scored'], ['BUY', -10, 'too recent'],
  ])
})

test('the prompt block states the outcomes, the tally, the Brain record, and asks what changed after a miss', () => {
  const settled = sm.settleMemories([
    { signal: 'BUY', price: 100, created_at: ago(10), summary: 'breakout above resistance' },
    { signal: 'BUY', price: 95, created_at: ago(30) },
  ], 90, NOW)
  const block = sm.memoryBlock('NVDA', settled, { n: 7, wins: 4, lo: 0.25, hi: 0.84 }, 90)
  expect(block).toMatch(/SETTLED IN CODE/)
  expect(block).toMatch(/BUY @ \$100 → \$90 now, -10% over 10d — wrong so far — "breakout above resistance"/)
  expect(block).toMatch(/0 of 2 right so far/)
  expect(block).toMatch(/AI Brain resolved record on NVDA: 4 of 7 picks up .*25–84%/)
  expect(block).toMatch(/say what is different now/)
})

test('nothing to say means no block at all', () => {
  expect(sm.memoryBlock('NVDA', [], null)).toBe('')
  expect(sm.settleMemories([{ signal: 'BUY', price: 100, created_at: ago(5) }], null, NOW)).toEqual([])
})
