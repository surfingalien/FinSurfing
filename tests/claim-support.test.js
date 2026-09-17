'use strict'
/**
 * Unit tests for lib/claim-support.js.
 *
 * The property under test: a citation stating a figure the evidence never
 * contained must not reach the user as evidence — and honest analysis layered
 * on a real figure must not be thrown away with it.
 */

const {
  extractNumbers, contentTokens, numberSupported,
  verifyCitation, auditSources, summarizeAudits,
  MIN_TOKEN_COVERAGE,
} = require('../lib/claim-support')

const EVIDENCE = `
LIVE PRICES (use these exact values for entryPrice — do not guess):
  NVDA: $209.87
ANALYST CONSENSUS (validate your picks — flag divergences in thesis):
  NVDA: target $243.00 (42×) | consensus 1.4/5 | fwdP/E 31.2
COMPUTED TECHNICALS: NVDA RSI 28.4 oversold, MACD bullish crossover, ATR 6.10
MACRO REGIME: Risk-On / Growth Favoured; 10Y yield 4.12%, VIX 14.3
SEC FILING NARRATIVE (latest 10-K/10-Q/8-K — tone, risk factors, red flags):
  NVDA: management tone confident; risk factors eased versus the prior year
`

describe('extractNumbers', () => {
  test('reads figures with their written precision', () => {
    expect(extractNumbers('target $243.00 and 14%')).toEqual([
      { value: 243, decimals: 2, raw: '243.00' },
      { value: 14, decimals: 0, raw: '14' },
    ])
  })

  test('handles thousands separators', () => {
    expect(extractNumbers('revenue $4,200 million')[0].value).toBe(4200)
  })

  test('keeps the sign — a drawdown is not a gain', () => {
    expect(extractNumbers('down -3.5% on the quarter')[0].value).toBe(-3.5)
  })

  // The trap: form names and periods carry digits but are not quantities.
  test('form names, quarters and fiscal years are NOT quantities', () => {
    expect(extractNumbers('10-K risk factors')).toEqual([])
    expect(extractNumbers('Q3 results')).toEqual([])
    expect(extractNumbers('FY26 guidance')).toEqual([])
    expect(extractNumbers('S-1 filed')).toEqual([])
  })

  test('empty and malformed input return no figures', () => {
    expect(extractNumbers('')).toEqual([])
    expect(extractNumbers(null)).toEqual([])
    expect(extractNumbers('no numbers at all')).toEqual([])
  })
})

describe('numberSupported — rounding is not fabrication', () => {
  const ev = extractNumbers('price $209.87, RSI 28.4, growth 14%')

  test('an evidence figure that rounds to the cited one at its precision passes', () => {
    expect(numberSupported({ value: 210, decimals: 0 }, ev)).toBe(true)   // 209.87 → 210
    expect(numberSupported({ value: 28, decimals: 0 }, ev)).toBe(true)    // 28.4 → 28
  })

  test('a nearby but different figure does NOT pass', () => {
    // A 1% tolerance would wave $212 through against $209.87. Rounding does not.
    expect(numberSupported({ value: 212, decimals: 0 }, ev)).toBe(false)
    expect(numberSupported({ value: 209.5, decimals: 1 }, ev)).toBe(false)
  })

  test('citing more precisely than the evidence still matches on exact value', () => {
    expect(numberSupported({ value: 14.0, decimals: 1 }, ev)).toBe(true)
  })

  test('sign matters', () => {
    expect(numberSupported({ value: -210, decimals: 0 }, ev)).toBe(false)
  })
})

describe('verifyCitation', () => {
  const v = (c) => verifyCitation(c, EVIDENCE)

  test('a figure present in the evidence is supported', () => {
    expect(v('entry $210 — at live price').verdict).toBe('supported')
    expect(v('analyst target $243 (42×)').ok).toBe(true)
    expect(v('RSI 28 — oversold').ok).toBe(true)
  })

  test('a figure the evidence never states is rejected, and named', () => {
    const r = v('analyst target $280 (42×)')
    expect(r.verdict).toBe('fabricated-number')
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('280')
    expect(r.reason).toMatch(/not present in the injected evidence/)
  })

  test('a plausible-but-wrong technical reading is rejected', () => {
    // The single most damaging case: the model states a number the reader
    // will trust, and the data we showed it said something else.
    expect(v('RSI 51 — neutral momentum').verdict).toBe('fabricated-number')
  })

  // ── numbers OR wording, never both ────────────────────────────────────────
  test('interpretation layered on a verified figure is KEPT', () => {
    // "below peers" appears nowhere in the evidence, and should not have to:
    // it is the model's reading of a number that does appear.
    expect(v('fwdP/E 31.2 below peers').ok).toBe(true)
    expect(v('VIX 14.3 signals complacency').ok).toBe(true)
  })

  test('a figure-free citation must have its wording grounded', () => {
    expect(v('10-K risk factors eased').ok).toBe(true)
    expect(v('management tone confident').ok).toBe(true)
  })

  test('a figure-free assertion with no basis in the evidence is rejected', () => {
    expect(v('insider cluster buying last quarter').verdict).toBe('unsupported')
    expect(v('durable moat and pricing power').verdict).toBe('unsupported')
  })

  test('the rejection reason quantifies the shortfall', () => {
    const r = v('durable moat and pricing power')
    expect(r.reason).toMatch(/wording appears in the evidence/)
    expect(r.reason).toMatch(new RegExp(`${Math.round(MIN_TOKEN_COVERAGE * 100)}%`))
  })

  test('an empty or contentless citation is rejected', () => {
    expect(verifyCitation('', EVIDENCE).ok).toBe(false)
    expect(verifyCitation(null, EVIDENCE).verdict).toBe('too-short')
    expect(verifyCitation('the of', EVIDENCE).verdict).toBe('too-short')
  })

  // ── the gate must stay inert when it knows nothing ────────────────────────
  test('no evidence block means unverifiable, not rejected', () => {
    // Firing hardest when it knows least is how a gate destroys a feature.
    const r = verifyCitation('analyst target $280', '')
    expect(r.verdict).toBe('unverifiable')
    expect(r.ok).toBe(true)
    expect(verifyCitation('anything', null).ok).toBe(true)
    expect(verifyCitation('anything', '   ').ok).toBe(true)
  })

  test('the coverage bar is configurable', () => {
    expect(verifyCitation('durable moat and pricing power', EVIDENCE, { minCoverage: 0 }).ok).toBe(true)
  })
})

describe('auditSources', () => {
  test('keeps the supported, drops the fabricated, and reports why', () => {
    const r = auditSources(
      ['entry $210 — live price', 'analyst target $280', 'RSI 28 — oversold', 'durable moat'],
      EVIDENCE,
    )
    expect(r.kept).toEqual(['entry $210 — live price', 'RSI 28 — oversold'])
    expect(r.rejected.map(x => x.verdict)).toEqual(['fabricated-number', 'unsupported'])
    expect(r.rejected[0].source).toBe('analyst target $280')
    expect(r.checked).toBe(4)
    expect(r.allRejected).toBe(false)
  })

  test('a pick whose every citation fails is flagged as ungrounded', () => {
    const r = auditSources(['analyst target $280', 'durable moat and pricing power'], EVIDENCE)
    expect(r.kept).toEqual([])
    expect(r.allRejected).toBe(true)
  })

  test('a pick that cited nothing is not "ungrounded" — it claimed nothing', () => {
    expect(auditSources([], EVIDENCE).allRejected).toBe(false)
    expect(auditSources(null, EVIDENCE).checked).toBe(0)
  })

  test('non-string entries are discarded before verification', () => {
    const r = auditSources(['RSI 28 — oversold', null, 42, '  ', {}], EVIDENCE)
    expect(r.checked).toBe(1)
    expect(r.kept).toHaveLength(1)
  })
})

describe('summarizeAudits', () => {
  test('rolls per-pick audits into one report', () => {
    const s = summarizeAudits([
      { symbol: 'NVDA', checked: 3, kept: ['a'], rejected: [{ source: 'x', verdict: 'fabricated-number', reason: 'r' }], allRejected: false },
      { symbol: 'AMD',  checked: 2, kept: [],    rejected: [{ source: 'y', verdict: 'unsupported', reason: 'r' }, { source: 'z', verdict: 'unsupported', reason: 'r' }], allRejected: true },
    ])
    expect(s).toMatchObject({ picksAudited: 2, citationsChecked: 5, citationsDropped: 3, ungroundedPicks: ['AMD'] })
    expect(s.rejected[0]).toMatchObject({ symbol: 'NVDA', verdict: 'fabricated-number' })
  })

  test('an empty report is well-formed', () => {
    expect(summarizeAudits([])).toMatchObject({ picksAudited: 0, citationsChecked: 0, citationsDropped: 0, ungroundedPicks: [] })
    expect(summarizeAudits(null).picksAudited).toBe(0)
  })
})
