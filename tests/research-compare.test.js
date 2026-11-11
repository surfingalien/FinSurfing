'use strict'
/**
 * lib/research-compare.js + research-desk.reviewOf — pure, no server.
 * Pinned: a missing value is never a zero and never ranked; best/worst need two
 * differing values and a direction; returns use sessions, not calendar guesses;
 * correlation uses only the days every symbol shares; there is no overall score.
 */
const C = require('../lib/research-compare')
const desk = require('../lib/research-desk')

const DAY = 86_400_000
/** n daily bars from a seeded walk; `drift` per day, `vol` daily. */
function series(n, { start = 100, drift = 0.0005, vol = 0.01, seed = 1, t0 = Date.UTC(2025, 0, 1) } = {}) {
  let s = seed, p = start
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 - 0.5 }
  return Array.from({ length: n }, (_, i) => { p *= 1 + drift + vol * rnd() * 2; return { t: t0 + i * DAY, o: p, h: p * 1.005, l: p * 0.995, c: p, v: 1_000_000 } })
}

describe('parseSymbols', () => {
  test('upper-cases, de-duplicates, caps at six and reports what it left out', () => {
    const r = C.parseSymbols('aapl, MSFT;nvda aapl a b c d')
    expect(r.symbols).toEqual(['AAPL', 'MSFT', 'NVDA', 'A', 'B', 'C'])
    expect(r.dropped).toEqual(['D'])
    expect(C.parseSymbols('BTC-USD brk.b <script> ../x').symbols).toEqual(['BTC-USD', 'BRK.B'])
    expect(C.parseSymbols('<script>').invalid).toEqual(['<SCRIPT>'])
    expect(C.parseSymbols(undefined).symbols).toEqual([])
  })
})

describe('sessionReturn', () => {
  test('uses the bar n sessions back; null when the history is shorter', () => {
    const closes = [100, 110, 121]
    expect(C.sessionReturn(closes, 2)).toBe(21)
    expect(C.sessionReturn(closes, 1)).toBe(10)
    expect(C.sessionReturn(closes, 3)).toBeNull()
  })
})

describe('rowFor', () => {
  test('too little history is reported, not guessed', () => {
    expect(C.rowFor({ symbol: 'X', bars: series(30) })).toMatchObject({ ok: false, reason: 'only 30 daily bars (need 60)' })
    expect(C.rowFor({ symbol: 'X', bars: [] })).toMatchObject({ ok: false, reason: 'no price history' })
  })
  test('price and risk rows come from the bars; fundamentals from the SEC snapshot', () => {
    const bars = series(400, { seed: 3 })
    const r = C.rowFor({ symbol: 'AAA', bars, benchBars: series(400, { seed: 9 }), sec: { pe: 21.5, earningsYield: 4.65, fcfYield: 3.1, revenueGrowthYoY: 12.4, netMargin: 22, roe: 30, debtToEquity: 0.4, accruals: -1.2, lastFiled: '2026-10-30' } })
    expect(r.ok).toBe(true)
    expect(r.values.ret1y).toBe(+((bars.at(-1).c / bars.at(-253).c - 1) * 100).toFixed(1))
    expect(r.values.vol21).toBeGreaterThan(0)
    expect(r.values.var95).toBeGreaterThan(0)
    expect(typeof r.values.beta).toBe('number')
    expect(r.values).toMatchObject({ pe: 21.5, salesGrowth: 12.4, netMargin: 22, debtToEquity: 0.4 })
    expect(r.values.fromHigh).toBeLessThanOrEqual(0)
    expect(r.filedAsOf).toBe('2026-10-30')
    expect(r.gaps).toEqual([])
  })
  test('no SEC figures → those values are null (never 0) and the gap is named', () => {
    const r = C.rowFor({ symbol: 'ETF', bars: series(100), sec: null })
    expect(r.values.pe).toBeNull()
    expect(r.values.roe).toBeNull()
    expect(r.values.ret1y).toBeNull()                       // 100 bars < 252 sessions
    expect(r.gaps.join(' ')).toMatch(/no SEC-filed figures/)
    expect(r.gaps.join(' ')).toMatch(/less than a year/)
  })
})

describe('buildComparison', () => {
  const row = (symbol, values, extra = {}) => ({ symbol, ok: true, last: 1, asOf: '2026-11-11', filedAsOf: '2026-10-01', gaps: [], values, ...extra })
  const metric = (cmp, key) => cmp.metrics.find(m => m.key === key)

  test('best and worst follow each metric’s own direction', () => {
    const cmp = C.buildComparison([row('A', { ret1y: 30, vol21: 40, pe: 35 }), row('B', { ret1y: 10, vol21: 20, pe: 15 })])
    expect(metric(cmp, 'ret1y')).toMatchObject({ best: 'A', worst: 'B' })      // higher is better
    expect(metric(cmp, 'vol21')).toMatchObject({ best: 'B', worst: 'A' })      // lower is better
    expect(metric(cmp, 'pe')).toMatchObject({ best: 'B', worst: 'A' })
  })
  test('a missing value is never ranked, and one value alone has no best', () => {
    const cmp = C.buildComparison([row('A', { roe: 20 }), row('B', { roe: null }), row('C', {})])
    expect(metric(cmp, 'roe')).toMatchObject({ best: null, worst: null, available: 1 })
    expect(metric(cmp, 'roe').values).toEqual([{ symbol: 'A', value: 20 }, { symbol: 'B', value: null }, { symbol: 'C', value: null }])
  })
  test('ties, directionless metrics and text never get a best', () => {
    const cmp = C.buildComparison([row('A', { ret1m: 5, beta: 1.8, character: 'trending' }), row('B', { ret1m: 5, beta: 0.6, character: 'random walk' })])
    expect(metric(cmp, 'ret1m')).toMatchObject({ best: null, worst: null })
    expect(metric(cmp, 'beta')).toMatchObject({ best: null, worst: null })
    expect(metric(cmp, 'character').best).toBeNull()
  })
  test('there is no overall score or ranking of symbols', () => {
    const cmp = C.buildComparison([row('A', { ret1y: 30 }), row('B', { ret1y: 10 })])
    expect(Object.keys(cmp)).not.toEqual(expect.arrayContaining(['score', 'ranking', 'winner']))
    expect(cmp.symbols.map(s => s.symbol)).toEqual(['A', 'B'])                 // input order kept
    expect(cmp.method).toMatch(/no overall score/)
  })
  test('failed symbols are listed; notes name pairs that move together and symbols without filings', () => {
    const cmp = C.buildComparison(
      [row('A', {}), row('B', {}, { filedAsOf: null }), { symbol: 'ZZZ', ok: false, reason: 'no price history', values: {} }],
      { correlation: { observations: 250, pairs: [{ a: 'A', b: 'B', rho: 0.91, movesTogether: true }] } })
    expect(cmp.failed).toEqual([{ symbol: 'ZZZ', reason: 'no price history' }])
    expect(cmp.notes[0]).toMatch(/A and B \(0\.91\) moved together over the last 250 shared sessions/)
    expect(cmp.notes[1]).toMatch(/^B has no SEC-filed figures/)
  })
})

describe('correlations', () => {
  test('identical series correlate at 1, independent ones near 0, and only shared days count', () => {
    const a = series(300, { seed: 5 })
    const same = a.map(b => ({ ...b, c: b.c * 2 }))
    const other = series(300, { seed: 77 })
    const r = C.correlations({ A: a, SAME: same, OTHER: other })
    const pair = (x, y) => r.pairs.find(p => (p.a === x && p.b === y) || (p.a === y && p.b === x))
    expect(pair('A', 'SAME')).toMatchObject({ rho: 1, movesTogether: true })
    expect(Math.abs(pair('A', 'OTHER').rho)).toBeLessThan(0.3)
    expect(r.observations).toBe(250)
    // a short series limits every pair to the shared window
    expect(C.correlations({ A: a, SHORT: a.slice(-80) }).observations).toBe(79)
    expect(C.correlations({ A: a, TINY: a.slice(-30) }).pairs).toEqual([])
    expect(C.correlations({ A: a })).toEqual({ observations: 0, pairs: [] })
  })
})

describe('reviewOf — when a thesis said it could be checked', () => {
  const NOW = Date.parse('2026-11-11T12:00:00Z')
  const thesis = (variant) => ({ judgement: { variant } })
  const v = (checkBy, extra = {}) => ({ status: 'stated', checkBy, wrongIf: 'Q4 revenue growth below 10%', view: 'Margins hold', differsOn: 'fundamentals', ...extra })
  test('due, soon and later by the stated date', () => {
    expect(desk.reviewOf(thesis(v('2026-11-10')), { now: NOW })).toMatchObject({ state: 'due', wrongIf: 'Q4 revenue growth below 10%' })
    expect(desk.reviewOf(thesis(v('2026-11-11')), { now: NOW }).state).toBe('due')
    expect(desk.reviewOf(thesis(v('2026-11-15')), { now: NOW })).toMatchObject({ state: 'soon', daysToCheck: 4 })
    expect(desk.reviewOf(thesis(v('2027-01-15')), { now: NOW }).state).toBe('later')
  })
  test('only a STATED view with a falsifier is reviewable', () => {
    expect(desk.reviewOf(thesis(v('2026-11-10', { status: 'agrees' })), { now: NOW })).toBeNull()
    expect(desk.reviewOf(thesis(v('2026-11-10', { status: 'unsupported' })), { now: NOW })).toBeNull()
    expect(desk.reviewOf(thesis(v('2026-11-10', { wrongIf: '' })), { now: NOW })).toBeNull()
    expect(desk.reviewOf(thesis(null), { now: NOW })).toBeNull()
    expect(desk.reviewOf({}, { now: NOW })).toBeNull()
    expect(desk.reviewOf(thesis(v('not-a-date')), { now: NOW })).toBeNull()
  })
})

describe('research queue', () => {
  const row = (symbol, ret1m, extra = {}) => ({ symbol, ok: true, values: { ret1m }, flags: [], thesis: null, ...extra })
  test('flags are fixed-threshold facts, each with its wording', () => {
    expect(C.queueFlags({ fromHigh: -1.5, ret1m: 3, vol21: 20 }).map(f => f.id)).toEqual(['nearHigh'])
    expect(C.queueFlags({ fromHigh: -25, ret1m: -15, vol21: 60 }).map(f => f.id)).toEqual(['drawdown', 'bigMove', 'highVol'])
    expect(C.queueFlags({ fromHigh: -10, ret1m: 14.9, vol21: 59.9 })).toEqual([])
    expect(C.queueFlags({ fromHigh: null, ret1m: null, vol21: null })).toEqual([])   // unknown is not a flag
    expect(C.queueFlags({ fromHigh: -2 })[0].label).toBe('Within 2% of its 52-week high')
  })
  test('day change needs two closes', () => {
    expect(C.dayChange([{ c: 100 }, { c: 103 }])).toBe(3)
    expect(C.dayChange([{ c: 100 }])).toBeNull()
  })
  test('order: review due, resolved thesis, review soon, flagged, quiet, unpriced — then the larger monthly move', () => {
    const rows = [
      row('QUIET', 1),
      row('FLAG', 2, { flags: [{ id: 'bigMove' }] }),
      row('SOON', 0, { thesis: { state: 'open', review: { state: 'soon' } } }),
      row('HIT', 0, { thesis: { state: 'target-hit', review: null } }),
      row('DUE', 0, { thesis: { state: 'open', review: { state: 'due' } } }),
      { symbol: 'BAD', ok: false, reason: 'no price history' },
      row('QUIET2', -9),
    ]
    expect(C.orderQueue(rows).map(r => r.symbol)).toEqual(['DUE', 'HIT', 'SOON', 'FLAG', 'QUIET2', 'QUIET', 'BAD'])
    expect(rows[0].symbol).toBe('QUIET')                       // input not mutated
  })
  test('queueRow carries the day change, flags and the thesis; an unpriced symbol keeps its thesis and says why', () => {
    const bars = series(300, { seed: 4 })
    const r = C.queueRow({ symbol: 'AAA', bars, name: 'Triple A', thesis: { verdict: 'actionable' } })
    expect(r).toMatchObject({ ok: true, name: 'Triple A', thesis: { verdict: 'actionable' } })
    expect(r.values.ret1d).toBe(+((bars.at(-1).c / bars.at(-2).c - 1) * 100).toFixed(2))
    expect(Array.isArray(r.flags)).toBe(true)
    expect(C.queueRow({ symbol: 'ZZZ', bars: [], thesis: { verdict: 'no-trade' } })).toMatchObject({ ok: false, reason: 'no price history', thesis: { verdict: 'no-trade' } })
  })
})
