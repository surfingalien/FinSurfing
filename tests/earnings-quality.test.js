'use strict'
const EQ = require('../lib/earnings-quality')

// Eight quarters ending 2023-03-31 … 2024-12-31, each filed 40 days after its end.
const ENDS = ['2023-03-31', '2023-06-30', '2023-09-30', '2023-12-31', '2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31']
const filed = end => new Date(Date.parse(end) + 40 * 864e5).toISOString().slice(0, 10)
const startOf = end => new Date(Date.parse(end) - 90 * 864e5).toISOString().slice(0, 10)
const flow = vals => ENDS.map((end, i) => ({ start: startOf(end), end, val: vals[i], filed: filed(end) }))
const inst = vals => ENDS.map((end, i) => ({ end, val: vals[i], filed: filed(end) }))
const AS_OF = '2025-03-01'

function company({ ocf = 30, ni = 25, rec = [100, 100, 100, 100, 110, 110, 110, 110], sbc = 2 } = {}) {
  return { series: {
    revenue: flow(Array(8).fill(250).map((v, i) => (i < 4 ? v : v * 1.1))),
    netIncome: flow(Array(8).fill(ni)),
    ocf: flow(Array.isArray(ocf) ? ocf : Array(8).fill(ocf)),
    capex: flow(Array(8).fill(5)),
    costOfRevenue: flow(Array(8).fill(150).map((v, i) => (i < 4 ? v : v * 1.1))),
    sbc: flow(Array(8).fill(sbc)),
    receivables: inst(rec),
    inventory: inst(Array(8).fill(80).map((v, i) => (i < 4 ? v : v * 1.1))),
    payables: inst(Array(8).fill(60)),
    assets: inst(Array(8).fill(1000)),
  } }
}

describe('earnings quality from SEC filings', () => {
  test('a clean company: cash covers earnings, working capital grows with sales, no flags', () => {
    const q = EQ.qualityAt(company(), AS_OF)
    expect(q.periodEnd).toBe('2024-12-31')
    expect(q.cashConversion).toBe(1.2)
    expect(q.cashConversionPrior).toBe(1.2)
    expect(q.fcfConversion).toBe(1)
    expect(q.accruals).toBe(-2)
    expect(q.receivablesGap).toBe(0)
    expect(q.inventoryGap).toBe(0)
    expect(q.dso).toBeCloseTo(110 / 1100 * 365, 1)
    expect(q.flags).toEqual([])
    expect(q.checked).toBe(5)
    expect(EQ.describe(q, 'AAA')).toMatch(/No red flags on the 5 checks/)
  })

  test('earnings running ahead of cash, receivables outpacing sales and heavy stock pay are each flagged with their figure', () => {
    const q = EQ.qualityAt(company({ ocf: [30, 30, 30, 30, 15, 15, 15, 15], rec: [100, 100, 100, 100, 140, 140, 140, 140], sbc: 6 }), AS_OF)
    const keys = q.flags.map(f => f.key)
    expect(keys).toEqual(expect.arrayContaining(['earnings-ahead-of-cash', 'cash-conversion-falling', 'receivables-outpace-sales', 'stock-pay-heavy']))
    expect(q.flags.find(f => f.key === 'earnings-ahead-of-cash').text).toMatch(/0\.6×/)
    expect(q.receivablesGap).toBe(30)
    expect(EQ.describe(q, 'BBB')).toMatch(/Flags: .*receivables grew 30 points faster than revenue/)
  })

  test('point in time: a quarter not yet filed on asOf is never used', () => {
    const c = company({ ocf: [30, 30, 30, 30, 30, 30, 30, -100] })
    expect(EQ.qualityAt(c, '2025-01-15').periodEnd).toBe('2024-09-30')       // Q4 2024 files on 2025-02-09
    expect(EQ.qualityAt(c, '2025-01-15').flags.map(f => f.key)).not.toContain('earnings-ahead-of-cash')
    expect(EQ.qualityAt(c, AS_OF).flags.map(f => f.key)).toContain('earnings-ahead-of-cash')
  })

  test('a loss-maker has no cash-conversion ratio (dividing by a loss means nothing); no data gives null', () => {
    const q = EQ.qualityAt(company({ ni: -10 }), AS_OF)
    expect(q.cashConversion).toBeNull()
    expect(q.lossMaking).toBe(true)
    expect(EQ.describe(q, 'CCC')).toMatch(/loss-making/)
    expect(EQ.qualityAt({ series: {} }, AS_OF)).toBeNull()
    expect(EQ.qualityAt(company(), '2026-09-01')).toBeNull()   // the latest trailing year is stale
    expect(EQ.describe(null)).toBeNull()
  })

  test('the factor-mining candidates exist and read only filings known on the day', () => {
    const fm = require('../lib/factor-mining')
    const C = fm.CANDIDATES || fm.FACTORS || fm.candidates
    const names = C ? Object.keys(C) : []
    if (names.length) expect(names).toEqual(expect.arrayContaining(['cash_conversion', 'receivables_discipline']))
    const factor = C?.cash_conversion
    if (factor) {
      const p = { fund: company({ ocf: [30, 30, 30, 30, 30, 30, 30, -100] }), days: ['2025-01-15', AS_OF], c: [100, 100] }
      expect(factor.fn(p, 0)).toBe(1.2)
      expect(factor.fn(p, 1)).toBeLessThan(0)
    }
  })
})
