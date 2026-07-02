'use strict'
/**
 * Unit tests for lib/risk-critique.js — deterministic risk-report builder
 * and LLM critique parsing.
 */

const { buildRiskReport, buildCritiquePrompt, parseCritique } = require('../lib/risk-critique')

const payload = {
  symbols: ['AAPL', 'NVDA', 'TSLA'],
  benchmark: 'SPY',
  portfolioBeta: 1.42,
  betas: { AAPL: 1.2, NVDA: 1.8, TSLA: 2.1 },
  sectors: [{ name: 'Technology', weight: 78.5 }, { name: 'Consumer Cyclical', weight: 21.5 }],
  correlations: [
    { a: 'AAPL', b: 'NVDA', r: 0.82 },
    { a: 'AAPL', b: 'TSLA', r: 0.41 },
    { a: 'NVDA', b: 'TSLA', r: -0.75 },
  ],
  riskMetrics: {
    portfolio: { sharpe: 0.9, sortino: 1.1, volatility: 32.4, maxDrawdown: 28.1, annualReturn: 24.2, var95: -3.1, cvar95: -4.8, weighting: 'value' },
    benchmark: { sharpe: 1.2, volatility: 14.8, maxDrawdown: 10.2, annualReturn: 18.9 },
    holdings: {
      AAPL: { sharpe: 1.1, maxDrawdown: 18.2, annualReturn: 21.0 },
      NVDA: { sharpe: 0.8, maxDrawdown: 35.6, annualReturn: 41.2 },
      TSLA: { sharpe: 0.3, maxDrawdown: 44.0, annualReturn: 12.1 },
    },
  },
}

describe('buildRiskReport', () => {
  test('renders all measured sections deterministically', () => {
    const r = buildRiskReport(payload)
    expect(r).toContain('PORTFOLIO RISK REPORT (3 holdings vs SPY')
    expect(r).toContain('Sharpe 0.9')
    expect(r).toContain('Beta 1.42')
    expect(r).toContain('Benchmark: Sharpe 1.2')
    expect(r).toContain('TSLA: Sharpe 0.3, MaxDD 44%')
    expect(r).toContain('Technology 78.5%')
    // only |r| ≥ 0.7 pairs appear, sorted by magnitude
    expect(r).toContain('AAPL/NVDA r=0.82')
    expect(r).toContain('NVDA/TSLA r=-0.75')
    expect(r).not.toContain('AAPL/TSLA')
    expect(buildRiskReport(payload)).toBe(r)
  })

  test('null when metrics are missing or no holdings', () => {
    expect(buildRiskReport({ symbols: [], riskMetrics: {} })).toBeNull()
    expect(buildRiskReport({ symbols: ['AAPL'], riskMetrics: {} })).toBeNull()
    expect(buildRiskReport(null)).toBeNull()
  })
})

describe('buildCritiquePrompt', () => {
  test('embeds the report and the grounding rules', () => {
    const p = buildCritiquePrompt(buildRiskReport(payload))
    expect(p).toContain('PORTFOLIO RISK REPORT')
    expect(p).toContain('ONLY figures present in the report')
    expect(p).toContain('riskReductions')
    expect(p).toContain('returnEnhancers')
  })
})

describe('parseCritique', () => {
  const good = JSON.stringify({
    assessment: 'Portfolio runs hotter than SPY on every risk axis.',
    riskReductions: [
      { action: 'Trim TSLA', evidence: 'Sharpe 0.3, MaxDD 44%' },
      { action: 'Diversify out of tech', evidence: 'Technology 78.5% weight' },
    ],
    returnEnhancers: [{ action: 'Rotate a slice from TSLA to AAPL', evidence: 'AAPL Sharpe 1.1 vs TSLA 0.3' }],
    watchItems: ['NVDA drawdown risk'],
  })

  test('accepts a valid critique and preserves fields', () => {
    const c = parseCritique(good)
    expect(c.riskReductions).toHaveLength(2)
    expect(c.riskReductions[0]).toEqual({ action: 'Trim TSLA', evidence: 'Sharpe 0.3, MaxDD 44%' })
    expect(c.watchItems).toEqual(['NVDA drawdown risk'])
  })

  test('parses markdown-fenced JSON', () => {
    expect(parseCritique('```json\n' + good + '\n```')).not.toBeNull()
  })

  test('caps list lengths and drops malformed items', () => {
    const c = parseCritique(JSON.stringify({
      assessment: 'ok',
      riskReductions: [
        { action: 'a', evidence: 'e' }, { action: 'b' }, { noAction: true },
        { action: 'c', evidence: 'e' }, { action: 'd', evidence: 'e' },
      ],
      returnEnhancers: [{ action: '1', evidence: '' }, { action: '2' }, { action: '3' }],
      watchItems: ['w1', 42, 'w2', 'w3', 'w4'],
    }))
    expect(c.riskReductions).toHaveLength(3)          // capped at 3, malformed dropped
    expect(c.returnEnhancers).toHaveLength(2)          // capped at 2
    expect(c.watchItems).toEqual(['w1', 'w2', 'w3'])   // non-strings dropped, capped at 3
  })

  test('null for non-JSON or empty critiques', () => {
    expect(parseCritique('I cannot provide financial advice.')).toBeNull()
    expect(parseCritique('{"assessment": "", "riskReductions": []}')).toBeNull()
    expect(parseCritique('')).toBeNull()
  })
})
