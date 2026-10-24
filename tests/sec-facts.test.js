'use strict'

const sf = require('../lib/sec-facts')

// One fiscal year reported the way filers actually do it: revenue as discrete
// quarters (+ FY), cash flow ONLY as year-to-date totals, and a restatement of
// Q1 filed a year later.
const row = (start, end, val, filed, form = '10-Q') => ({ start, end, val, filed, form })
const raw = {
  cik: 123, entityName: 'Acme Corp',
  facts: {
    'us-gaap': {
      Revenues: { units: { USD: [
        row('2025-01-01', '2025-03-31', 100, '2025-04-30'),
        row('2025-04-01', '2025-06-30', 110, '2025-07-30'),
        row('2025-07-01', '2025-09-30', 120, '2025-10-30'),
        row('2025-01-01', '2025-12-31', 460, '2026-02-15', '10-K'),
        row('2025-01-01', '2025-03-31', 999, '2026-04-30'),          // restated later — not known in 2025
        row('2024-01-01', '2024-03-31', 80, '2024-04-30'),
        row('2024-04-01', '2024-06-30', 85, '2024-07-30'),
        row('2024-07-01', '2024-09-30', 90, '2024-10-30'),
        row('2024-01-01', '2024-12-31', 350, '2025-02-15', '10-K'),
      ] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [
        row('2025-01-01', '2025-03-31', 30, '2025-04-30'),
        row('2025-01-01', '2025-06-30', 70, '2025-07-30'),
        row('2025-01-01', '2025-09-30', 100, '2025-10-30'),
        row('2025-01-01', '2025-12-31', 150, '2026-02-15', '10-K'),
      ] } },
      EarningsPerShareDiluted: { units: { 'USD/shares': [
        row('2025-01-01', '2025-03-31', 1.0, '2025-04-30'),
        row('2025-04-01', '2025-06-30', 1.1, '2025-07-30'),
        row('2025-07-01', '2025-09-30', 1.2, '2025-10-30'),
        row('2025-01-01', '2025-12-31', 4.6, '2026-02-15', '10-K'),
      ] } },
      StockholdersEquity: { units: { USD: [{ end: '2025-12-31', val: 1000, filed: '2026-02-15', form: '10-K' }] } },
    },
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2026-02-01', val: 100, filed: '2026-02-15', form: '10-K' }] } } },
  },
}

test('quarters are rebuilt: Q4 = FY − 9M for revenue, and cash flow from year-to-date totals', () => {
  const c = sf.compactFacts(raw)
  expect(c.series.revenue.filter(q => q.end.startsWith('2025')).map(q => q.val)).toEqual([100, 110, 120, 130])
  expect(c.series.revenue.at(-1)).toMatchObject({ end: '2025-12-31', derived: true, filed: '2026-02-15' })
  expect(c.series.ocf.map(q => q.val)).toEqual([30, 40, 30, 50])
})

test('point in time: the first filing wins, and nothing filed after asOf is visible', () => {
  const c = sf.compactFacts(raw)
  expect(c.series.revenue.find(q => q.end === '2025-03-31').val).toBe(100)   // not the 2026 restatement
  expect(sf.snapshotAt(c, '2025-11-01')).toMatchObject({ revenueTtm: 100 + 110 + 120 + (350 - 255), periodEnd: '2025-09-30' })
  // As of 2025-08-01: 2024 Q3, 2024 Q4 (= FY − 9M, filed 2025-02-15), 2025 Q1, 2025 Q2.
  expect(sf.snapshotAt(c, '2025-08-01').revenueTtm).toBe(90 + 95 + 100 + 110)
})

test('a full snapshot: growth, margins, EPS and valuation at a price', () => {
  const s = sf.snapshotAt(sf.compactFacts(raw), '2026-03-01', { price: 92 })
  expect(s).toMatchObject({ revenueTtm: 460, revenueGrowthYoY: 31.4, epsTtm: 4.6, ocfTtm: 150, equity: 1000, pe: 20, earningsYield: 5, shares: 100 })
  expect(sf.snapshotAt(sf.compactFacts({ facts: {} }), '2026-03-01')).toBeNull()
})

test('fetches by CIK with the SEC User-Agent, caches, and treats 404 as no data', async () => {
  sf._resetForTests()
  const filings = require('../lib/filings')
  jest.spyOn(filings, 'resolveCik').mockResolvedValue(123)
  const fetchImpl = jest.fn(async url => ({ ok: true, status: 200, json: async () => raw, url }))
  const c = await sf.getCompanyFacts('acme', { fetchImpl })
  expect(fetchImpl.mock.calls[0][0]).toBe('https://data.sec.gov/api/xbrl/companyfacts/CIK0000000123.json')
  expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe(filings.EDGAR_UA)
  expect(c.name).toBe('Acme Corp')
  await sf.getCompanyFacts('ACME', { fetchImpl })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  sf._resetForTests()
  expect(await sf.getCompanyFacts('ACME', { fetchImpl: async () => ({ ok: false, status: 404 }) })).toBeNull()
  filings.resolveCik.mockRestore()
})
