'use strict'
const macro = require('../routes/macro')
const { parseFredCsv, yoyChange, FRED_SERIES, reset } = macro._test

const csv = rows => `observation_date,X\n${rows.map(([d, v]) => `${d},${v}`).join('\n')}\n`

describe('FRED data handling', () => {
  test('keyless CSV: newest first, blank and "." observations dropped', () => {
    const obs = parseFredCsv(csv([['2025-09-01', '324.245'], ['2025-10-01', ''], ['2025-11-01', '.'], ['2025-12-01', '326.031']]))
    expect(obs).toEqual([{ date: '2025-12-01', value: '326.031' }, { date: '2025-09-01', value: '324.245' }])
  })

  test('year-over-year is found by DATE: a missing month (Oct 2025, never published) no longer shifts the base', () => {
    // Real CPIAUCSL. The old obs[12] landed on Aug 2025 and showed 4.02%; the true Sep-to-Sep change is 3.72%.
    const rows = [['2025-08-01', '323.291'], ['2025-09-01', '324.245'], ['2025-10-01', ''], ['2025-11-01', '325.063'], ['2025-12-01', '326.031'],
      ['2026-01-01', '326.588'], ['2026-02-01', '327.460'], ['2026-03-01', '330.293'], ['2026-04-01', '332.407'], ['2026-05-01', '333.979'],
      ['2026-06-01', '332.568'], ['2026-07-01', '332.813'], ['2026-08-01', '334.131'], ['2026-09-01', '336.298']]
    expect(yoyChange(parseFredCsv(csv(rows)))).toBe(3.72)
  })

  test('quarterly data compares with four quarters back, not twelve observations back', () => {
    const q = ['2023-07-01', '2023-10-01', '2024-01-01', '2024-04-01', '2024-07-01', '2024-10-01', '2025-01-01', '2025-04-01', '2025-07-01']
    const obs = parseFredCsv(csv(q.map((d, i) => [d, String(100 + i)])))
    expect(yoyChange(obs)).toBe(+((108 / 104 - 1) * 100).toFixed(2))
    expect(yoyChange(obs.slice(0, 3))).toBeNull()   // no observation a year back → no number, not a wrong one
  })

  test('GDP growth is the real QoQ-annualised series, used as published', () => {
    const gdp = FRED_SERIES.find(s => s.category === 'growth' && /GDP/.test(s.label))
    expect(gdp.id).toBe('A191RL1Q225SBEA')
    expect(gdp.yoyDerived).toBeFalsy()
  })
})

describe('getIndicators', () => {
  const realKey = process.env.FRED_API_KEY
  beforeEach(() => { reset(); delete process.env.FRED_API_KEY })
  afterAll(() => { if (realKey) process.env.FRED_API_KEY = realKey })

  const okCsv = () => async url => ({ ok: true, status: 200, text: async () => csv([['2025-01-01', '1'], ['2025-07-01', '2'], ['2026-01-01', '3'], ['2026-02-01', '4']]) })

  test('works with no FRED_API_KEY through the keyless CSV', async () => {
    const d = await macro.getIndicators({ fetchImpl: okCsv() })
    expect(d.error).toBeUndefined()
    expect(d.via).toMatch(/keyless CSV/)
    expect(d.indicators.every(i => i.source === 'csv')).toBe(true)
    expect(d.failed).toEqual([])
  })

  test('a failed series is reported (not a silent dash) and is retried after minutes, not an hour', async () => {
    let calls = 0
    const flaky = async url => { calls++; if (/VIXCLS/.test(url)) return { ok: false, status: 503 }; return okCsv()(url) }
    const d = await macro.getIndicators({ fetchImpl: flaky })
    expect(d.failed.map(f => f.id)).toEqual(['VIXCLS'])
    expect(d.failed[0].error).toMatch(/503/)
    const before = calls
    await macro.getIndicators({ fetchImpl: flaky })
    expect(calls).toBe(before)   // cached for now…
  })

  test('nothing loaded → an error, never an empty "Neutral" regime', async () => {
    const d = await macro.getIndicators({ fetchImpl: async () => ({ ok: false, status: 503 }) })
    expect(d.error).toMatch(/did not answer/)
  })

  test('with a key, a series the API refuses falls back to the CSV', async () => {
    process.env.FRED_API_KEY = 'k'
    const f = async url => (/api\.stlouisfed/.test(url) ? { ok: false, status: 429 } : okCsv()(url))
    const d = await macro.getIndicators({ fetchImpl: f })
    expect(d.failed).toEqual([])
    expect(d.indicators[0].source).toBe('csv')
  })

  test('with a key, slow series (quarterly GDP, monthly sentiment) still load and monthly series keep their change', async () => {
    // Production failure: the API was asked for the last 30 days only, so GDP (latest ~4 months old) and
    // Consumer Sentiment (~2 months old) came back empty and Fed Funds had no previous value for its arrow.
    process.env.FRED_API_KEY = 'k'
    const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
    const history = id => /A191RL1Q225SBEA/.test(id)
      ? [[day(400), '1.5'], [day(310), '2.0'], [day(220), '2.5'], [day(130), '3.4']]
      : Array.from({ length: 14 }, (_, i) => [day(60 + 30 * (13 - i)), String(100 + i)])
    const api = async url => {
      const u = new URL(url), id = u.searchParams.get('series_id'), start = u.searchParams.get('observation_start')
      const observations = history(id).filter(([d]) => d >= start).reverse().map(([date, value]) => ({ date, value }))
      return { ok: true, status: 200, json: async () => ({ observations }) }
    }
    const d = await macro.getIndicators({ fetchImpl: api })
    expect(d.failed).toEqual([])
    const gdp = d.indicators.find(i => i.id === 'A191RL1Q225SBEA')
    expect(gdp).toMatchObject({ value: 3.4, source: 'api' })
    expect(d.indicators.find(i => i.id === 'FEDFUNDS').delta).toBe(1)
  })

  test('an empty answer from the API falls back to the CSV instead of showing nothing', async () => {
    process.env.FRED_API_KEY = 'k'
    const f = async url => (/api\.stlouisfed/.test(url) ? { ok: true, status: 200, json: async () => ({ observations: [] }) } : okCsv()(url))
    const d = await macro.getIndicators({ fetchImpl: f })
    expect(d.failed).toEqual([])
    expect(d.indicators.every(i => i.source === 'csv')).toBe(true)
  })
})
