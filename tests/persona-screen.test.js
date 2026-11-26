'use strict'
const ps = require('../lib/persona-screen')

const DAY = 86_400_000
const bars = (n, start = 100, drift = 0.001) => Array.from({ length: n }, (_, i) => ({ t: Date.UTC(2025, 0, 1) + i * DAY, c: start * Math.exp(drift * i + 0.01 * Math.sin(i)) }))
const stock = (o) => ({ assetClass: 'Stock', sector: 'Information Technology', price: 100, ret63: 5, ret252: 10, vol: 25, ...o })

describe('measures', () => {
  it('bar measures need 20 closes; returns over 63/252 sessions only when that history exists', () => {
    expect(ps.barMeasures(bars(10))).toBeNull()
    const m = ps.barMeasures(bars(100))
    expect(m.price).toBeGreaterThan(0)
    expect(m.ret63).not.toBeNull()
    expect(m.ret252).toBeNull()
    expect(ps.barMeasures(bars(300)).vol).toBeGreaterThan(0)
  })
  it('PEG proxy only from a positive P/E and positive growth', () => {
    expect(ps.factMeasures({ pe: 20, revenueGrowthYoY: 10 }).peg).toBe(2)
    expect(ps.factMeasures({ pe: 20, revenueGrowthYoY: -5 }).peg).toBeNull()
    expect(ps.factMeasures({ pe: null, revenueGrowthYoY: 10 }).peg).toBeNull()
  })
})

describe('A. the screen', () => {
  const measures = {
    GOOD:  stock({ pe: 20, roe: 25, fcfYield: 4, debtToEquity: 0.4 }),
    DEAR:  stock({ pe: 60, roe: 25, fcfYield: 1, debtToEquity: 0.4 }),
    NOFCF: stock({ pe: 20, roe: 25, fcfYield: -1, debtToEquity: 0.4 }),
    BLANK: stock({ pe: 20, roe: null, fcfYield: 4, debtToEquity: 0.4 }),
    SPY:   { assetClass: 'ETF', price: 500 },
    'BTC-USD': { assetClass: 'Crypto', price: 90000 },
    DEAD:  stock({ price: null }),
  }
  it('Buffett keeps only stocks meeting every rule; an unknown figure is not a pass', () => {
    const sc = ps.screen('buffett', measures)
    expect(sc.stocks.map(s => s.symbol)).toEqual(['GOOD'])
    expect(sc.screenedOut).toMatchObject({ failed: 2, unknown: 1, unpriced: 1 })
    expect(sc.etfs).toEqual([])
    expect(sc.crypto).toEqual([])
    expect(sc.stocks[0].passed).toContain('P/E ≤ 35')
  })
  it('the default persona has no stock rules and takes ETFs and crypto', () => {
    const sc = ps.screen('default', measures)
    expect(sc.stocks.length).toBe(4)
    expect(sc.etfs.map(s => s.symbol)).toEqual(['SPY'])
    expect(sc.crypto.map(s => s.symbol)).toEqual(['BTC-USD'])
  })
  it('Greenblatt excludes financials and ranks by earnings yield + ROE ranks', () => {
    const m = {
      BANK: stock({ sector: 'Financials', earningsYield: 15, roe: 40 }),
      A: stock({ earningsYield: 10, roe: 10 }),
      B: stock({ earningsYield: 8, roe: 30 }),
      C: stock({ earningsYield: 2, roe: 5 }),
    }
    const sc = ps.screen('greenblatt', m)
    expect(sc.stocks.map(s => s.symbol)).toEqual(['A', 'B', 'C'])
    expect(sc.stocks.map(s => s.symbol)).not.toContain('BANK')
    expect(sc.screenedOut.sector).toBe(1)
  })
  it('Wood requires an innovation sector and 20% growth', () => {
    const sc = ps.screen('wood', { X: stock({ revenueGrowthYoY: 40 }), Y: stock({ revenueGrowthYoY: 40, sector: 'Utilities' }), Z: stock({ revenueGrowthYoY: 5 }) })
    expect(sc.stocks.map(s => s.symbol)).toEqual(['X'])
  })
  it('Marks drops the top fifth by 12-month return', () => {
    const m = {}
    for (let i = 0; i < 10; i++) m[`S${i}`] = stock({ pe: 15, debtToEquity: 0.5, vol: 20, ret252: i * 10 })
    const syms = ps.screen('marks', m).stocks.map(s => s.symbol)
    expect(syms).not.toContain('S9')
    expect(syms).not.toContain('S8')
    expect(syms).toContain('S7')
  })
  it('funds only when asked for', () => {
    const m = { FXAIX: { assetClass: 'Fund', price: 200 } }
    expect(ps.screen('default', m).funds).toEqual([])
    expect(ps.screen('default', m, { includeFunds: true }).funds.length).toBe(1)
  })
})

describe('B. the slate', () => {
  it('maximums from the persona, capped by what survived, and its horizons', () => {
    const sc = ps.screen('buffett', { A: stock({ pe: 20, roe: 25, fcfYield: 4, debtToEquity: 0.4 }) })
    const txt = ps.slateInstructions(sc)
    expect(txt).toMatch(/up to 1 Stocks/)
    expect(txt).toMatch(/"6m" only/)
    expect(txt).toMatch(/no ETFs, no Cryptocurrencies|no ETFs, no crypto/)
    expect(txt).toMatch(/MAXIMUMS/)
    expect(txt).not.toMatch(/exactly/)
  })
  it('the candidate block lists measured figures only', () => {
    const sc = ps.screen('buffett', { A: stock({ pe: 20, roe: 25, fcfYield: 4, debtToEquity: 0.4 }) })
    const b = ps.candidateBlock(sc)
    expect(b).toMatch(/A \[Information Technology\]: \$100 \| 3m \+5% \| 12m \+10% \| vol 25%\/yr \| P\/E 20 \| ROE 25% \| FCF yield 4% \| D\/E 0\.4/)
  })
})

describe('C. the check', () => {
  const sc = ps.screen('buffett', { A: stock({ pe: 20, roe: 25, fcfYield: 4, debtToEquity: 0.4 }), B: stock({ pe: 25, roe: 20, fcfYield: 3, debtToEquity: 0.2 }) })
  const p = (symbol, o = {}) => ({ symbol, type: 'Stock', period: '6m', ...o })
  it('drops off-list names, wrong horizons and banned asset classes, with reasons', () => {
    const { picks, check } = ps.checkPicks([p('A'), p('ZZZ'), p('B', { period: '3m' }), p('BTC-USD', { type: 'Crypto' })], sc)
    expect(picks.map(x => x.symbol)).toEqual(['A'])
    expect(check.dropped.map(d => d.symbol)).toEqual(['ZZZ', 'B', 'BTC-USD'])
    expect(check.dropped[1].reason).toMatch(/holding period 3m/)
    expect(picks[0].screen.facts.pe).toBe(20)
  })
  it('caps each class at the slate and repairs a mislabelled type from the screen', () => {
    const sc2 = ps.screen('dalio', { SPY: { assetClass: 'ETF', price: 1 }, TLT: { assetClass: 'ETF', price: 1 }, 'BTC-USD': { assetClass: 'Crypto', price: 1 }, 'ETH-USD': { assetClass: 'Crypto', price: 1 } })
    const { picks, check } = ps.checkPicks([p('SPY', { type: 'Stock', period: '3m' }), p('BTC-USD', { type: 'Crypto' })], sc2)
    expect(picks.map(x => x.type)).toEqual(['ETF', 'Crypto'])
    expect(check.repaired).toEqual([{ symbol: 'SPY', from: 'Stock', to: 'ETF' }])
    expect(sc2.crypto.map(c => c.symbol)).toEqual(['BTC-USD'])   // Dalio's crypto list is BTC only
  })
  it('focus mode keeps every pick and says which rules it meets', () => {
    const measures = { A: stock({ pe: 50, roe: 25, fcfYield: null, debtToEquity: 0.4 }) }
    const { picks, check } = ps.checkPicks([p('A'), p('Q')], sc, { focus: true, measures, rules: ps.SCREENS.buffett.stock.rules })
    expect(check.mode).toBe('focus')
    expect(picks).toHaveLength(2)
    expect(picks[0].personaFit).toEqual({ passed: ['ROE ≥ 15%', 'debt/equity ≤ 1'], failed: ['P/E ≤ 35'], unknown: ['free cash flow positive'] })
    expect(picks[1].personaFit).toBeNull()
  })
})

describe('buildMeasures', () => {
  beforeEach(() => ps._resetForTests())
  it('prices every name, adds SEC figures to stocks, lists what could not be priced', async () => {
    const { measures, failed } = await ps.buildMeasures([['AAA', 'Stock'], ['SPY', 'ETF'], ['NOPE', 'Stock']], {
      fetchBars: async s => (s === 'NOPE' ? [] : bars(300)),
      fetchFacts: async () => ({ pe: 18, roe: 22 }),
    })
    expect(failed).toEqual(['NOPE'])
    expect(measures.AAA).toMatchObject({ assetClass: 'Stock', pe: 18, roe: 22 })
    expect(measures.SPY.pe).toBeUndefined()
  })
  it('a facts failure leaves the figures unknown, not zero', async () => {
    const { measures } = await ps.buildMeasures([['AAA', 'Stock']], { fetchBars: async () => bars(300), fetchFacts: async () => { throw new Error('sec down') } })
    expect(measures.AAA.pe).toBeUndefined()
    expect(ps.screen('buffett', measures).screenedOut.unknown).toBe(1)
  })
  it('classifies focus symbols', () => {
    expect(ps.classOf('BTC-USD')).toBe('Crypto')
    expect(ps.classOf('TLT')).toBe('ETF')
    expect(ps.classOf('FXAIX')).toBe('Fund')
  })
})
