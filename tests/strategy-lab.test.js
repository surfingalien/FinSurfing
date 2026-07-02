'use strict'
/**
 * Unit tests for lib/strategy-lab.js — the pure parts of the Strategy Lab:
 * prompt building, LLM proposal parsing/clamping, verdicts, and evaluation
 * against the real (deterministic) backtest engine.
 */

const {
  STRATEGY_CATALOG,
  MAX_PROPOSALS,
  buildProposalPrompt,
  parseProposals,
  verdictFor,
  evaluateProposals,
} = require('../lib/strategy-lab')

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Oscillating uptrend: enough swings for crossover/reversion strategies to trade.
function syntheticSeries(n = 300) {
  const t0 = 1_600_000_000
  const timestamps = [], closes = []
  for (let i = 0; i < n; i++) {
    timestamps.push(t0 + i * 86_400)
    closes.push(100 + 20 * Math.sin(i / 8) + i * 0.05)
  }
  return { timestamps, closes }
}

const validPayload = JSON.stringify({
  proposals: [
    { strategy: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 40 }, name: 'Swing cross', rationale: 'ADX shows trend', marketFit: 'trending' },
    { strategy: 'rsi_threshold', params: { period: 14, oversold: 30, overbought: 70 }, name: 'RSI swing', rationale: 'Oscillating RSI', marketFit: 'ranging' },
    { strategy: 'bb_reversion', params: { period: 20, mult: 2 }, name: 'Band fade', rationale: 'BB squeeze noted', marketFit: 'ranging' },
  ],
})

// ── buildProposalPrompt ───────────────────────────────────────────────────────

describe('buildProposalPrompt', () => {
  test('includes symbol, count, TA line, and every catalog strategy', () => {
    const p = buildProposalPrompt({ symbol: 'NVDA', range: '2y', taLine: 'NVDA: RSI=61 ADX=28(trend)', count: 3 })
    expect(p).toContain('NVDA')
    expect(p).toContain('exactly 3 DISTINCT')
    expect(p).toContain('RSI=61')
    for (const name of Object.keys(STRATEGY_CATALOG)) expect(p).toContain(name)
  })

  test('handles missing TA line and clamps count to catalog max', () => {
    const p = buildProposalPrompt({ symbol: 'XYZ', range: '1y', taLine: null, count: 99 })
    expect(p).toContain('no technical summary available')
    expect(p).toContain(`exactly ${MAX_PROPOSALS} DISTINCT`)
  })
})

// ── parseProposals ────────────────────────────────────────────────────────────

describe('parseProposals', () => {
  test('parses a clean JSON payload into catalog-valid proposals', () => {
    const out = parseProposals(validPayload)
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ strategy: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 40 } })
    expect(out[1].params).toEqual({ period: 14, oversold: 30, overbought: 70 })
  })

  test('parses JSON wrapped in markdown fences and prose', () => {
    const wrapped = 'Here you go:\n```json\n' + validPayload + '\n```\nHope this helps!'
    expect(parseProposals(wrapped)).toHaveLength(3)
  })

  test('clamps out-of-range params and fills missing ones with defaults', () => {
    const out = parseProposals(JSON.stringify({
      proposals: [{ strategy: 'rsi_threshold', params: { period: 999, overbought: 50 } }],
    }))
    expect(out).toHaveLength(1)
    // period clamped to max, overbought raised to its min, oversold defaulted
    expect(out[0].params).toEqual({ period: 50, oversold: 30, overbought: 55 })
  })

  test('rounds non-integer values for integer params', () => {
    const out = parseProposals(JSON.stringify({
      proposals: [{ strategy: 'bb_reversion', params: { period: 20.7, mult: 2.5 } }],
    }))
    expect(out[0].params).toEqual({ period: 21, mult: 2.5 })
  })

  test('swaps inverted fast/slow and drops degenerate equal pairs', () => {
    const out = parseProposals(JSON.stringify({
      proposals: [
        { strategy: 'sma_crossover', params: { fastPeriod: 50, slowPeriod: 20 } },
        { strategy: 'macd_signal', params: { fast: 26, slow: 26, signal: 9 } },
      ],
    }))
    expect(out).toHaveLength(1)
    expect(out[0].params).toMatchObject({ fastPeriod: 20, slowPeriod: 50 })
  })

  test('drops unknown strategies and dedupes identical configs', () => {
    const out = parseProposals(JSON.stringify({
      proposals: [
        { strategy: 'martingale_yolo', params: {} },
        { strategy: 'bb_reversion', params: { period: 20, mult: 2 } },
        { strategy: 'bb_reversion', params: { period: 20, mult: 2 } },
      ],
    }))
    expect(out).toHaveLength(1)
    expect(out[0].strategy).toBe('bb_reversion')
  })

  test('caps at maxCount and truncates long text fields', () => {
    const many = { proposals: Array.from({ length: 10 }, (_, i) => ({
      strategy: 'sma_crossover',
      params: { fastPeriod: 2 + i, slowPeriod: 100 },
      rationale: 'x'.repeat(1000),
    })) }
    const out = parseProposals(JSON.stringify(many), 4)
    expect(out).toHaveLength(4)
    expect(out[0].rationale.length).toBeLessThanOrEqual(400)
  })

  test('returns [] for non-JSON, empty, or shape-mismatched responses', () => {
    expect(parseProposals('I cannot help with that.')).toEqual([])
    expect(parseProposals('')).toEqual([])
    expect(parseProposals('{"picks": []}')).toEqual([])
  })
})

// ── verdictFor ────────────────────────────────────────────────────────────────

describe('verdictFor', () => {
  test('validated when it beats buy & hold with positive Sharpe', () => {
    expect(verdictFor({ totalTrades: 5, alpha: 3.2, sharpeRatio: 0.9 })).toBe('validated')
  })
  test('mixed when only one of alpha/Sharpe is positive', () => {
    expect(verdictFor({ totalTrades: 5, alpha: -2, sharpeRatio: 0.5 })).toBe('mixed')
    expect(verdictFor({ totalTrades: 5, alpha: 4, sharpeRatio: -0.1 })).toBe('mixed')
  })
  test('rejected when neither', () => {
    expect(verdictFor({ totalTrades: 5, alpha: -8, sharpeRatio: -0.4 })).toBe('rejected')
  })
  test('insufficient_trades for <2 closed trades or missing metrics', () => {
    expect(verdictFor({ totalTrades: 1, alpha: 50, sharpeRatio: 3 })).toBe('insufficient_trades')
    expect(verdictFor(null)).toBe('insufficient_trades')
  })
})

// ── evaluateProposals ─────────────────────────────────────────────────────────

describe('evaluateProposals', () => {
  const { timestamps, closes } = syntheticSeries(300)

  test('attaches real backtest metrics, recent window, and a verdict to each proposal', () => {
    const proposals = parseProposals(validPayload)
    const out = evaluateProposals(proposals, timestamps, closes, 10000)
    expect(out).toHaveLength(3)
    for (const p of out) {
      expect(p.metrics).toBeTruthy()
      expect(typeof p.metrics.totalReturn).toBe('number')
      expect(typeof p.metrics.sharpeRatio).toBe('number')
      expect(typeof p.metrics.buyHoldReturn).toBe('number')
      expect(['validated', 'mixed', 'rejected', 'insufficient_trades']).toContain(p.verdict)
      expect(p.recent).toBeTruthy() // 300 bars ≥ 100 → recent window runs
      expect(typeof p.recent.alpha).toBe('number')
    }
  })

  test('oscillating series actually generates trades for a reversion strategy', () => {
    const [p] = parseProposals(JSON.stringify({
      proposals: [{ strategy: 'rsi_threshold', params: { period: 14, oversold: 35, overbought: 65 } }],
    }))
    const [out] = evaluateProposals([p], timestamps, closes)
    expect(out.metrics.totalTrades).toBeGreaterThanOrEqual(2)
  })

  test('skips the recent window on short histories', () => {
    const short = syntheticSeries(80)
    const proposals = parseProposals(validPayload)
    const out = evaluateProposals(proposals, short.timestamps, short.closes)
    for (const p of out) expect(p.recent).toBeNull()
  })

  test('sorts best-first: verdict rank, then Sharpe', () => {
    const proposals = parseProposals(validPayload)
    const out = evaluateProposals(proposals, timestamps, closes)
    const order = { validated: 0, mixed: 1, insufficient_trades: 2, rejected: 3 }
    for (let i = 1; i < out.length; i++) {
      const prev = order[out[i - 1].verdict], cur = order[out[i].verdict]
      expect(prev).toBeLessThanOrEqual(cur)
      if (prev === cur) {
        expect(out[i - 1].metrics.sharpeRatio).toBeGreaterThanOrEqual(out[i].metrics.sharpeRatio)
      }
    }
  })
})
