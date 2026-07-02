'use strict'
/**
 * Unit tests for lib/macro-playbook.js — the deterministic macro-regime →
 * strategy-tilt mapping appended to the macroSummary prompt injection.
 */

const { buildRegimePlaybook } = require('../lib/macro-playbook')

const ind = pairs => Object.entries(pairs).map(([id, value]) => ({ id, value }))

describe('buildRegimePlaybook', () => {
  test('risk-off regime: defensive tilts, avoid leverage, mean-reversion bias', () => {
    const p = buildRegimePlaybook(ind({
      T10Y2Y: -0.8, CPIAUCSL: 6.1, FEDFUNDS: 5.0, VIXCLS: 35, BAMLH0A0HYM2: 7.2, UNRATE: 6.0,
    }))
    expect(p.favor.join(' ')).toMatch(/defensive sectors/)
    expect(p.favor.join(' ')).toMatch(/investment-grade quality/)
    expect(p.avoid.join(' ')).toMatch(/breakout chasing/)
    expect(p.avoid.join(' ')).toMatch(/consumer discretionary/)
    expect(p.strategyBias).toMatch(/^mean-reversion/)
    expect(p.text).toContain('REGIME PLAYBOOK')
    expect(p.text).toContain('Favor:')
    expect(p.text).toContain('Avoid:')
    expect(p.text).toContain('Strategy bias:')
  })

  test('risk-on regime: cyclical/growth tilts, trend-following bias, no avoids', () => {
    const p = buildRegimePlaybook(ind({
      T10Y2Y: 2.0, CPIAUCSL: 2.2, FEDFUNDS: 1.5, VIXCLS: 12, BAMLH0A0HYM2: 2.5, UNRATE: 3.6,
    }))
    expect(p.favor.join(' ')).toMatch(/cyclicals & financials/)
    expect(p.favor.join(' ')).toMatch(/trend-continuation/)
    expect(p.avoid).toHaveLength(0)
    expect(p.strategyBias).toMatch(/^trend-following/)
    expect(p.text).not.toContain('Avoid:')
  })

  test('mid-range VIX with no other signals: bias-only playbook, balanced', () => {
    const p = buildRegimePlaybook(ind({ VIXCLS: 20 }))
    expect(p.favor).toHaveLength(0)
    expect(p.avoid).toHaveLength(0)
    expect(p.strategyBias).toMatch(/^balanced/)
    expect(p.text).toContain('Strategy bias:')
    expect(p.text).not.toContain('Favor:')
  })

  test('no usable indicators: empty text so macroSummary is unchanged', () => {
    expect(buildRegimePlaybook([]).text).toBe('')
    expect(buildRegimePlaybook(undefined).text).toBe('')
    expect(buildRegimePlaybook(ind({ VIXCLS: null, CPIAUCSL: null })).text).toBe('')
  })

  test('thresholds mirror assessRegime boundaries (no tilt inside neutral bands)', () => {
    const p = buildRegimePlaybook(ind({
      T10Y2Y: 0.5, CPIAUCSL: 2.0, FEDFUNDS: 3.0, VIXCLS: 20, BAMLH0A0HYM2: 4.0, UNRATE: 4.5,
    }))
    // CPI 2.0 is the lone in-band positive ("near target") in assessRegime but
    // produces no tilt here — only actionable extremes generate tilts.
    expect(p.favor).toHaveLength(0)
    expect(p.avoid).toHaveLength(0)
  })

  test('favor list is capped at 6 tilts', () => {
    const p = buildRegimePlaybook(ind({
      T10Y2Y: 2.0,        // +2 favor
      CPIAUCSL: 6.0,      // +1 favor
      FEDFUNDS: 1.0,      // +1 favor
      VIXCLS: 10,         // +1 favor
      BAMLH0A0HYM2: 2.0,  // +1 favor
      UNRATE: 3.5,        // +1 favor → 7 raw
    }))
    expect(p.favor).toHaveLength(6)
  })

  test('deterministic: same inputs give identical output', () => {
    const args = ind({ T10Y2Y: -0.8, VIXCLS: 35, CPIAUCSL: 6.1 })
    expect(buildRegimePlaybook(args)).toEqual(buildRegimePlaybook(args))
  })
})
