'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const sb = require('../lib/shadow-baseline')
const { nearestClose, benchmarkFor } = require('../lib/brain-learnings')

const DAY = 86_400_000
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-')), 'shadow.jsonl')

describe('drawShadows', () => {
  const universe = ['NVDA', 'AMD', 'AVGO', 'INTC', 'MU', 'QCOM', 'TXN', 'ARM', 'SMCI', 'ANET']

  test('draws only names the model did not pick, as many as it picked, reproducibly', () => {
    const a = sb.drawShadows(universe, ['NVDA', 'AMD'], 2, '2026-10-01T13:00:00Z')
    expect(a).toHaveLength(2)
    expect(a).not.toContain('NVDA')
    expect(a).not.toContain('AMD')
    expect(sb.drawShadows(universe, ['NVDA', 'AMD'], 2, '2026-10-01T13:00:00Z')).toEqual(a)
    expect(sb.drawShadows(universe, ['NVDA', 'AMD'], 2, '2026-10-02T13:00:00Z')).not.toEqual(a)
  })

  test('is capped, and never draws more than the list has left', () => {
    expect(sb.drawShadows(universe, [], 20, 's')).toHaveLength(sb.MAX_SHADOWS)
    expect(sb.drawShadows(['A', 'B', 'C'], ['A', 'B'], 5, 's')).toEqual(['C'])
    expect(sb.drawShadows(['A'], ['A'], 3, 's')).toEqual([])
  })
})

test('shadows are logged to their own file, never the prediction log, and survive deploys', () => {
  const { PREDICTION_LOG } = require('../lib/prediction-log-path')
  expect(sb.SHADOW_LOG).not.toBe(PREDICTION_LOG)
  const durable = fs.readFileSync(require.resolve('../lib/durable-files'), 'utf8')
  expect(durable).toMatch(/ai-brain-shadow\.jsonl/)

  const file = tmp()
  const n = sb.logShadows({ universe: ['NVDA', 'AMD', 'MU', 'BTC-USD'], picked: ['NVDA'], actionableCount: 3, prices: { AMD: 150, MU: 120 }, generatedAt: '2026-10-01T13:00:00Z' }, file)
  const rows = sb.readShadows(file)
  expect(n).toBe(rows.length)
  expect(rows.every(r => r.shadow === true && r.priceAtPrediction > 0 && r.symbol !== 'NVDA')).toBe(true)   // unpriced BTC-USD is skipped
})

test('resolveShadows scores +7/+30d against the bar and the same benchmark as real picks', async () => {
  const file = tmp()
  const gen = Date.UTC(2026, 7, 1)
  fs.writeFileSync(file, JSON.stringify({ symbol: 'AMD', generatedAt: new Date(gen).toISOString(), priceAtPrediction: 100, shadow: true }) + '\n')
  const bars = start => Array.from({ length: 60 }, (_, i) => ({ t: gen + i * DAY, c: start + i }))
  const out = await sb.resolveShadows({ fetchBars: async s => (s === 'SPY' ? bars(400) : bars(100)), nearestClose, benchmarkFor, now: gen + 40 * DAY }, file)
  expect(out.resolved).toBe(2)
  const [r] = sb.readShadows(file)
  expect(r).toMatchObject({ basePrice: 100, price7d: 107, price30d: 130, benchRet7d: 1.75, benchRet30d: 7.5 })
})

describe('compareToShadows', () => {
  const at = i => new Date(Date.UTC(2026, 6, 1) + (i % 10) * DAY).toISOString()
  const rec = (i, win, extra = {}) => ({ symbol: `S${i}`, generatedAt: at(i), basePrice: 100, price7d: win ? 106 : 96, benchRet7d: 1, ...extra })

  test('picks that beat random names from their own list are called out — with the test that decided it', () => {
    const ai = Array.from({ length: 60 }, (_, i) => rec(i, i % 10 < 7))       // 70%
    const shadows = Array.from({ length: 60 }, (_, i) => rec(i, i % 10 < 4))  // 40%
    const out = sb.compareToShadows(ai, shadows)
    expect(out).toMatchObject({ horizon: 7, metric: 'alphaWinRate', verdict: 'beats-random' })
    expect(out.ai.alphaWinRate).toBe(0.7)
    expect(out.shadow.alphaWinRate).toBe(0.4)
    expect(out.p).toBeLessThan(0.05)
  })

  test('the same rate as random is "no-difference" — beating SPY alone is not credited', () => {
    const both = Array.from({ length: 60 }, (_, i) => rec(i, i % 10 < 6))
    expect(sb.compareToShadows(both, both).verdict).toBe('no-difference')
  })

  test('too few outcomes is "insufficient"; picks from scans with no shadows are left out', () => {
    expect(sb.compareToShadows([rec(1, true)], [rec(1, false)]).verdict).toBe('insufficient')
    const shadows = Array.from({ length: 30 }, (_, i) => rec(i, false))
    const ai = [...Array.from({ length: 30 }, (_, i) => rec(i, true)), rec(99, true, { generatedAt: '2025-01-01T00:00:00Z' })]
    expect(sb.compareToShadows(ai, shadows).ai.n).toBe(30)
  })
})
