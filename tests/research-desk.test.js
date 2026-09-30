'use strict'

const {
  buildEvidence, evidenceText, buildThesisPrompt, parseThesis,
  auditClaims, judgeThesis, trackFor, thesisStatus, priceFacts,
} = require('../lib/research-desk')

const DAY = 86400000
const t0 = Date.UTC(2025, 0, 2)
// 300 bars drifting up from 100 to ~130 with a small wiggle.
const bars = Array.from({ length: 300 }, (_, i) => {
  const c = 100 + i * 0.1 + (i % 5) * 0.2
  return { t: t0 + i * DAY, o: c, h: c + 1, l: c - 1, c, v: 1e6 }
})

const fundamentals = {
  valuation: { pe_ttm: 24.3, ps_ttm: 6.1, ev_ebitda: 18.2, fcf_yield: 3.4, roe: 28.5, roic: 19.1 },
  yoy_rev_growth: 12.4,
  cashflow: { fcf_margin: 22.7 },
  ttm_revenue_fmt: '$81.2B',
  analyst_dist: { buy_pct: 70, hold_pct: 25, sell_pct: 5, total: 40 },
  eps_surprises: [{ surprise_pct: 4.1 }, { surprise_pct: -1.2 }],
}
const macro = { regime: { regime: 'Risk-On / Growth Favoured', signals: [{ text: 'VIX 14 — calm' }] }, playbook: { favor: ['technology'], avoid: ['utilities'] } }

function evidence(over = {}) {
  return buildEvidence({ symbol: 'ACME', bars, taLine: 'ACME RSI 58 MACD bullish, above EMA50', fundamentals, macro, strategies: [], exposure: [], track: null, ...over })
}

describe('buildEvidence', () => {
  test('numbers every item and marks third-party opinion as not measured', () => {
    const { items } = evidence()
    expect(items.map(i => i.id)).toEqual(items.map((_, k) => `E${k + 1}`))
    expect(items.find(i => i.kind === 'analysts').measured).toBe(false)
    expect(items.find(i => i.kind === 'valuation').text).toContain('P/E 24.3')
    expect(items.find(i => i.kind === 'factors').text).toMatch(/composite \d+/)
  })

  test('a missing source is reported as a gap, never silently absent', () => {
    const { items, gaps } = evidence({ fundamentals: { error: 'FMP_API_KEY required' }, macro: { error: 'FRED_API_KEY not set' } })
    expect(items.some(i => i.kind === 'valuation')).toBe(false)
    expect(gaps.join(' ')).toMatch(/fundamentals: FMP_API_KEY required/)
    expect(gaps.join(' ')).toMatch(/macro: FRED_API_KEY not set/)
  })

  test('strategies say plainly when none has forward evidence', () => {
    const { items } = evidence({ strategies: [{ strategy: 'sma_crossover', fitness: 60, forwardPasses: 0 }] })
    expect(items.find(i => i.kind === 'strategies').text).toMatch(/No rule-based strategy on ACME has yet passed a forward re-test/)
  })

  test('price facts come from the bars', () => {
    const f = priceFacts(bars)
    expect(f.last).toBe(bars.at(-1).c)
    expect(f.ret1m).toBeGreaterThan(0)
  })
})

describe('parseThesis', () => {
  test('normalises stance, stop sign, horizon and citation ids', () => {
    const t = parseThesis(JSON.stringify({
      stance: 'LONG', summary: 'x', bull: [{ claim: 'P/E 24.3', cites: ['e3', 'bogus'] }],
      bear: [], targetReturn: 12, stopLoss: -6, horizonDays: 45,
    }))
    expect(t.stance).toBe('long')
    expect(t.stopLoss).toBe(6)
    expect(t.horizonDays).toBe(30)
    expect(t.bull[0].cites).toEqual(['E3'])
  })
  test('unparseable output is null, and anything but "long" is avoid', () => {
    expect(parseThesis('not json')).toBeNull()
    expect(parseThesis('{"stance":"buy!!"}').stance).toBe('avoid')
  })
})

describe('auditClaims — each claim is checked against ONLY what it cites', () => {
  const { items } = evidence()
  const val = items.find(i => i.kind === 'valuation').id
  const price = items.find(i => i.kind === 'price').id

  test('a supported figure is kept', () => {
    const { kept } = auditClaims([{ claim: 'Trades at a P/E of 24.3 with ROIC of 19.1%', cites: [val] }], items)
    expect(kept).toHaveLength(1)
  })

  test('a real figure cited to the WRONG evidence is dropped', () => {
    // 24.3 exists in the valuation item, but the claim cites the price item.
    const { kept, dropped } = auditClaims([{ claim: 'P/E of 24.3 is reasonable', cites: [price] }], items)
    expect(kept).toHaveLength(0)
    expect(dropped[0].reason).toMatch(/24\.3/)
  })

  test('uncited claims and invented ids are dropped with a reason', () => {
    const { dropped } = auditClaims([
      { claim: 'Great management', cites: [] },
      { claim: 'Margins expanding', cites: ['E99'] },
    ], items)
    expect(dropped.map(d => d.reason)).toEqual(['cites no evidence', 'cites evidence that does not exist: E99'])
  })

  test('evidenceText joins only the requested items', () => {
    expect(evidenceText(items, [val])).toContain('P/E 24.3')
    expect(evidenceText(items, [val])).not.toContain('last close')
  })
})

describe('judgeThesis', () => {
  const { items, facts } = evidence()
  const val = items.find(i => i.kind === 'valuation').id
  const base = {
    stance: 'long', summary: 'Quality compounder at a fair multiple.',
    bull: [{ claim: 'ROIC of 19.1% on a P/E of 24.3', cites: [val] }],
    bear: [{ claim: 'P/S of 6.1 leaves little room for a miss', cites: [val] }],
    targetReturn: 15, stopLoss: 6, horizonDays: 30, invalidation: 'Revenue growth turns negative',
  }
  const judge = (thesis, p = 0.6, n = 100) => judgeThesis({ thesis, items, lastPrice: facts.last, assetType: 'stock', winProb: { p, n, source: 'test' } })

  test('a supported long that clears the EV gate is actionable, with levels derived from the price', () => {
    const j = judge(base)
    expect(j.verdict).toBe('actionable')
    expect(j.zones.target).toBeCloseTo(facts.last * 1.15, 3)
    expect(j.zones.stop).toBeCloseTo(facts.last * 0.94, 3)
    expect(j.sizing.suggestedPct).toBeGreaterThan(0)
    expect(j.bull).toHaveLength(1)
  })

  test('with no measured record it may pass the gate, but no size is suggested and it says why', () => {
    const j = judge(base, 0.5, 0)
    expect(j.verdict).toBe('actionable')
    expect(j.calibrated).toBe(false)
    expect(j.sizing).toMatchObject({ uncalibrated: true, suggestedPct: null })
    expect(j.reasons.join(' ')).toMatch(/assumed 50%/)
  })

  test('every outcome carries a trade plan: the thesis levels when valid, reference levels otherwise', () => {
    const levels = { atr: 2, support: facts.last - 1.5, resistance: facts.last + 4 }
    const yes = judgeThesis({ thesis: base, items, lastPrice: facts.last, assetType: 'stock', winProb: { p: 0.6, n: 100, source: 't' }, levels })
    expect(yes.tradePlan.basis).toBe('thesis')
    expect(yes.tradePlan.booking[1].price).toBeCloseTo(facts.last * 1.15, 2)
    expect(yes.tradePlan.booking[0].price).toBeCloseTo(facts.last * 1.075, 2)   // book part halfway
    const no = judgeThesis({ thesis: { ...base, stance: 'avoid' }, items, lastPrice: facts.last, assetType: 'stock', winProb: { p: 0.6, n: 100, source: 't' }, levels })
    expect(no.verdict).toBe('no-trade')
    expect(no.tradePlan.basis).toBe('technical')
    expect(no.tradePlan.entry.high).toBeCloseTo(facts.last, 2)
  })

  test('declining is a first-class answer', () => {
    const j = judge({ ...base, stance: 'avoid' })
    expect(j.verdict).toBe('no-trade')
    expect(j.reasons[0]).toMatch(/declined/)
  })

  test('a long whose every bull claim fails verification is not a trade', () => {
    const j = judge({ ...base, bull: [{ claim: 'Revenue grew 45% last quarter', cites: [val] }] })
    expect(j.verdict).toBe('no-trade')
    expect(j.droppedClaims[0]).toMatchObject({ side: 'bull' })
    expect(j.reasons[0]).toMatch(/no bull claim survived/)
  })

  test('an unrealistic stop is rejected, not repaired', () => {
    const j = judge({ ...base, stopLoss: 150 })
    expect(j.verdict).toBe('no-trade')
    expect(j.reasons[0]).toMatch(/levels rejected/)
  })

  test('the EV gate at a low calibrated win rate says no', () => {
    const j = judge(base, 0.25)
    expect(j.verdict).toBe('no-trade')
    expect(j.reasons[0]).toMatch(/expected-value gate/)
    expect(j.expectedValue.winProbSource).toBe('test')
  })

  test('a summary quoting a figure not in the evidence is removed', () => {
    const j = judge({ ...base, summary: 'Earnings will grow 38% next year.' })
    expect(j.summary).toBeNull()
    expect(j.summaryRemoved).toMatch(/38/)
  })

  test('the prompt carries every id and the gaps', () => {
    const p = buildThesisPrompt({ symbol: 'ACME', items, gaps: ['macro: FRED_API_KEY not set'] })
    for (const i of items) expect(p).toContain(`[${i.id}]`)
    expect(p).toContain('NOT AVAILABLE')
    expect(p).toContain('third-party opinion')
  })
})

describe('trackFor', () => {
  test('counts wins at one horizon with an interval, excluding never-entered picks', () => {
    const rec = (sym, up, extra = {}) => ({ symbol: sym, assetType: 'stock', basePrice: 100, price30d: up ? 110 : 90, ...extra })
    const t = trackFor([rec('ACME', true), rec('ACME', false), rec('ZZZ', true), rec('ACME', true, { entered: false })], { symbol: 'ACME', assetType: 'stock', horizon: 30 })
    expect(t.symbol).toMatchObject({ n: 2, wins: 1 })
    expect(t.symbol.lo).toBeLessThan(0.5)
    expect(t.assetClass).toMatchObject({ n: 3, wins: 2 })
  })
})

describe('thesisStatus — first touch, same rule as the Brain', () => {
  const at = new Date(t0).toISOString()
  const entry = {
    at, lastPrice: 100,
    judgement: { verdict: 'actionable', horizonDays: 30, zones: { target: 110, stop: 95, targetReturn: 10, stopLoss: 5 } },
  }
  const b = (d, l, h, c = (l + h) / 2) => ({ t: t0 + d * DAY, l, h, c })

  test('target touched first', () => {
    expect(thesisStatus(entry, [b(1, 99, 104), b(3, 105, 111), b(5, 90, 96)], { now: t0 + 40 * DAY }))
      .toMatchObject({ state: 'target-hit', days: 3, retPct: 10 })
  })
  test('both inside one bar resolves as the stop', () => {
    expect(thesisStatus(entry, [b(2, 94, 112)], { now: t0 + 40 * DAY })).toMatchObject({ state: 'stopped' })
  })
  test('still open inside the horizon, expired after it', () => {
    expect(thesisStatus(entry, [b(1, 99, 104)], { now: t0 + 10 * DAY })).toMatchObject({ state: 'open', daysLeft: 20 })
    expect(thesisStatus(entry, [b(1, 99, 104)], { now: t0 + 40 * DAY })).toMatchObject({ state: 'expired' })
  })
  test('a no-trade thesis has nothing to track', () => {
    expect(thesisStatus({ judgement: { verdict: 'no-trade' } }, [])).toEqual({ state: 'no-trade' })
  })
})
