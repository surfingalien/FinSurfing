'use strict'
const inc = require('../lib/income')
const { simulateWithSignals } = require('../utils/backtest')
const sg = require('../lib/split-guard')

const DAY = 86_400_000
const T0 = Date.UTC(2024, 0, 2)
// Weekdays only, so a weekend ex-date has to move to Monday.
const bizDays = n => { const out = []; for (let t = T0; out.length < n; t += DAY) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) out.push(t) } return out }

describe('alignIncome', () => {
  const ts = bizDays(10), closes = ts.map(() => 100)
  it('puts an ex-date on its bar, a weekend ex-date on the next session, and ignores dates outside', () => {
    const sat = new Date(ts[4] + DAY).getUTCDay() === 6 ? ts[4] + DAY : ts[3] + DAY
    const a = inc.alignIncome(ts, closes, { dividends: [
      { date: new Date(ts[2]).toISOString().slice(0, 10), amount: 0.5 },
      { date: new Date(sat).toISOString().slice(0, 10), amount: 0.25 },
      { date: '2023-01-01', amount: 9 },
    ] })
    expect(a.dividends[2]).toBe(0.5)
    expect(a.dividends.reduce((x, y) => x + y, 0)).toBe(0.75)
    expect(a.dividends[0]).toBe(0)
  })
  it('drops an as-paid (Nasdaq) dividend too large for the adjusted price — a pre-split row', () => {
    const a = inc.alignIncome(ts, closes, { adjusted: false, dividends: [{ date: new Date(ts[3]).toISOString().slice(0, 10), amount: 8 }] })
    expect(a.dividends[3]).toBe(0)
    expect(a.droppedDividends).toBe(1)
  })
  it('uses the cash rate known on or before each bar — never a later one', () => {
    const d = i => new Date(ts[i]).toISOString().slice(0, 10)
    const a = inc.alignIncome(ts, closes, { rates: [{ date: d(0), rate: 5 }, { date: d(5), rate: 4 }] })
    expect(a.cashRates.slice(0, 5)).toEqual([5, 5, 5, 5, 5])
    expect(a.cashRates[5]).toBe(4)
    expect(inc.alignIncome(ts, closes, { rates: [] }).cashRates).toBeUndefined()
  })
  it('parses FRED csv and skips missing values', () => {
    expect(inc.parseFredCsv('observation_date,DTB3\n2026-01-02,4.1\n2026-01-05,.\n2026-01-06,4.2')).toEqual([{ date: '2026-01-02', rate: 4.1 }, { date: '2026-01-06', rate: 4.2 }])
  })
})

describe('dividendHistory', () => {
  beforeEach(() => inc._clearCache())
  it('tries sources in order and says which failed; unknown is not zero', async () => {
    const h = await inc.dividendHistory('ZZZ', { impl: {
      yahoo: async () => { throw new Error('HTTP 429') },
      fmp: async () => { throw new Error('no FMP key') },
      nasdaq: async () => { throw new Error('no dividend rows') },
    } })
    expect(h.source).toBeNull()
    expect(h.failed.map(f => f.source)).toEqual(['yahoo', 'fmp', 'nasdaq'])
  })
  it('uses the first that answers', async () => {
    const h = await inc.dividendHistory('ABC', { impl: {
      yahoo: async () => { throw new Error('down') },
      fmp: async () => ({ source: 'fmp', adjusted: true, dividends: [{ date: '2024-01-03', amount: 1 }], splits: [] }),
    } })
    expect(h.source).toBe('fmp')
    expect(h.failed).toHaveLength(1)
  })
  it('crypto pays nothing, and that is known, not unknown', async () => {
    expect((await inc.dividendHistory('BTC-USD')).source).toBe('none-paid')
  })
})

describe('attachIncome', () => {
  beforeEach(() => inc._clearCache())
  it('adds div and rf to the bars and notes the sources; never throws', async () => {
    const ts = bizDays(5)
    const bars = ts.map(t => ({ t, c: 100 }))
    const fetchImpl = async () => ({ ok: true, text: async () => `observation_date,DTB3\n${new Date(ts[0]).toISOString().slice(0, 10)},5` })
    const out = await inc.attachIncome(bars, 'ABC', { fetchImpl, impl: { yahoo: async () => ({ source: 'yahoo', adjusted: true, dividends: [{ date: new Date(ts[2]).toISOString().slice(0, 10), amount: 1 }], splits: [] }) } })
    expect(out[2].div).toBe(1)
    expect(out[3].rf).toBe(5)
    expect(out.income).toMatchObject({ dividends: 'yahoo', cashRate: 'FRED DTB3' })
    expect(await inc.attachIncome([], 'X')).toEqual([])
  })
})

describe('the backtest engine with income', () => {
  const n = 60, ts = bizDays(n).map(t => t / 1000), closes = ts.map(() => 100)
  it('with no income it scores exactly as before', () => {
    const sig = closes.map((_, i) => (i === 0 ? 1 : 0))
    const a = simulateWithSignals(ts, closes, sig, 10000, { costBps: 0 })
    expect(a.metrics.returnBasis).toEqual({ dividends: false, cashInterest: false })
    expect(a.metrics.totalReturn).toBe(0)
  })
  it('a holder at the prior close gets the dividend; buy & hold gets it too', () => {
    const div = closes.map((_, i) => (i === 10 ? 2 : 0))
    const sig = closes.map((_, i) => (i === 0 ? 1 : 0))         // buy at bar 1's open, hold to the end
    const r = simulateWithSignals(ts, closes, sig, 10000, { costBps: 0, dividends: div, opens: closes })
    expect(r.metrics.dividendsReceived).toBe(200)               // 100 shares × $2
    expect(r.metrics.totalReturn).toBe(2)
    expect(r.metrics.buyHoldReturn).toBe(2)
    expect(r.metrics.alpha).toBeCloseTo(0)
  })
  it('a buy that fills on the ex-date is not entitled; a sale at the ex-date open still is', () => {
    const div = closes.map((_, i) => (i === 10 ? 2 : 0))
    const late = simulateWithSignals(ts, closes, closes.map((_, i) => (i === 9 ? 1 : 0)), 10000, { costBps: 0, dividends: div, opens: closes })
    expect(late.metrics.dividendsReceived).toBe(0)
    const sell = simulateWithSignals(ts, closes, closes.map((_, i) => (i === 0 ? 1 : i === 9 ? -1 : 0)), 10000, { costBps: 0, dividends: div, opens: closes })
    expect(sell.metrics.dividendsReceived).toBe(200)
  })
  it('idle cash earns the T-bill rate; a fully invested position does not', () => {
    const rf = closes.map(() => 5)
    const flat = simulateWithSignals(ts, closes, closes.map(() => 0), 10000, { costBps: 0, cashRates: rf })
    expect(flat.metrics.interestEarned).toBeGreaterThan(0)
    expect(flat.metrics.totalReturn).toBeGreaterThan(0.5)
    expect(flat.metrics.returnBasis.cashInterest).toBe(true)
  })
  it('income arrays of the wrong length are ignored, not misaligned', () => {
    const r = simulateWithSignals(ts, closes, closes.map(() => 0), 10000, { costBps: 0, cashRates: [5, 5] })
    expect(r.metrics.returnBasis.cashInterest).toBe(false)
  })
})

describe('split guard', () => {
  const ts = bizDays(6).map(t => t / 1000)
  const d = i => new Date(ts[i] * 1000).toISOString().slice(0, 10)
  it('applies a 10-for-1 split to everything before it', () => {
    const closes = [1000, 1010, 1020, 102, 103, 104], vols = [1, 1, 1, 10, 10, 10]
    const a = sg.applySplits({ timestamps: ts, closes, opens: closes, highs: closes, lows: closes, volumes: vols }, [{ date: d(3), ratio: 10 }])
    expect(a.closes).toEqual([100, 101, 102, 102, 103, 104])
    expect(a.volumes).toEqual([10, 10, 10, 10, 10, 10])
    expect(a.applied).toBe(1)
  })
  it('flags split-sized one-day moves (forward and reverse) and not ordinary ones', () => {
    expect(sg.suspectJumps(ts, [1000, 1010, 1020, 102, 103, 104])).toEqual([{ date: d(3), ratio: 10 }])
    expect(sg.suspectJumps(ts, [10, 10, 10, 50, 50, 50])[0].ratio).toBeCloseTo(0.2)
    expect(sg.suspectJumps(ts, [100, 97, 103, 90, 95, 99])).toEqual([])
  })
})
