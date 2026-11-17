'use strict'
const ME = require('../lib/morning-emails')

const NOW = new Date('2026-11-17T12:20:00Z')            // a Tuesday, 7:20 AM ET
const since = ME.shortlistSince(NOW)

const card = { overall: 'pass', rows: [{ key: 'oos', status: 'pass' }, { key: 'luck', status: 'pass' }, { key: 'walkforward', status: 'review' }] }
const library = [
  { id: 'a', symbol: 'AAPL', strategy: 'sma_crossover', name: 'SMA on AAPL', status: 'active', fitness: 70, discoveredAt: '2026-11-17T08:41:00Z', origin: { by: 'strategy-brain', arm: 'catalog-sweep' }, admission: { dsr: 0.81, nTrials: 154, card }, hypothesis: { worksIn: 'uptrend', verdict: 'supported' } },
  { id: 'b', symbol: 'MSFT', strategy: 'rsi', name: '<b>RSI</b>', status: 'active', fitness: 90, discoveredAt: '2026-11-16T22:00:00Z' },
  { id: 'old', symbol: 'XOM', strategy: 'rsi', status: 'active', fitness: 99, discoveredAt: '2026-10-01T00:00:00Z' },
  { id: 'r', symbol: 'JPM', strategy: 'macd', status: 'retired', lastValidatedAt: '2026-11-17T07:00:00Z' },
]
const runs = [
  { at: '2026-11-17T08:40:00Z', experiments: [{ arm: 'ml:logistic', tried: 4, admitted: 0 }, { arm: 'catalog-sweep', sweep: 'sma_crossover', tried: 154, admitted: 1 }, { arm: 'x', skipped: true, tried: 9 }] },
  { at: '2026-11-10T08:40:00Z', experiments: [{ arm: 'old', tried: 500, admitted: 3 }] },
]
const paper = {
  counts: { running: 5 },
  running: [{ symbol: 'NVDA', name: 'n', sessions: 17, of: 20, returnPct: 1.2 }, { symbol: 'AMD', name: 'm', sessions: 3, of: 20, returnPct: 0 }],
  decided: [
    { symbol: 'SPY', name: 'g', status: 'graduated', decidedAt: '2026-11-16', result: { returnPct: 2.1, holdReturnPct: 1.0 } },
    { symbol: 'QQQ', name: 'f', status: 'failed', decidedAt: '2026-11-16', result: { returnPct: -0.8 } },
    { symbol: 'IWM', name: 'z', status: 'no-trades', decidedAt: '2026-11-16' },
    { symbol: 'DIA', name: 'old', status: 'graduated', decidedAt: '2026-11-01' },
  ],
}

describe('shortlistSince', () => {
  it('covers one day on Tuesday–Friday and the weekend on Monday', () => {
    expect(NOW.getTime() - since.getTime()).toBe(86_400_000)
    const mon = new Date('2026-11-16T12:20:00Z')
    expect(mon.getTime() - ME.shortlistSince(mon).getTime()).toBe(3 * 86_400_000)
  })
})

describe('strategyShortlist', () => {
  const list = ME.strategyShortlist({ runs, library, paper, since })
  it('counts only runs in the window and skips skipped experiments', () => {
    expect(list.runs).toBe(1)
    expect(list.tested).toBe(158)
    expect(list.sweeps).toBe(1)
  })
  it('lists admissions in the window, any finder, by fitness, and none older', () => {
    expect(list.admitted.map(a => a.symbol)).toEqual(['MSFT', 'AAPL'])
    const a = list.admitted[1]
    expect(a.by).toBe('Strategy Brain · catalog-sweep')
    expect(a.checks).toEqual({ passed: 2, review: 1, of: 3 })
    expect(a.dsr).toBe(0.81)
    expect(list.admitted[0].by).toBe('nightly evolution')
  })
  it('reports retirements and paper verdicts in the window only', () => {
    expect(list.retired.map(r => r.symbol)).toEqual(['JPM'])
    expect(list.graduated.map(p => p.symbol)).toEqual(['SPY'])
    expect(list.failed.map(p => p.symbol)).toEqual(['QQQ'])
    expect(list.noTrades).toHaveLength(1)
    expect(list.nearlyDone.map(p => p.symbol)).toEqual(['NVDA'])
    expect(list.empty).toBe(false)
  })
  it('is empty when nothing happened', () => {
    expect(ME.strategyShortlist({ runs: [], library: [library[2]], paper: { counts: { running: 2 }, running: [], decided: [] }, since }).empty).toBe(true)
  })
})

describe('buildStrategyShortlistHtml', () => {
  const list = ME.strategyShortlist({ runs, library, paper, since })
  const html = ME.buildStrategyShortlistHtml({ list, dateStr: 'Tue, Nov 17', appUrl: 'https://x.app/' })
  it('escapes stored text and links to the page', () => {
    expect(html).toContain('&lt;b&gt;RSI&lt;/b&gt;')
    expect(html).not.toContain('<b>RSI</b>')
    expect(html).toContain('https://x.app/#/quant-lab/brain')
  })
  it('shows the counts, verdicts with signs and says no order was placed', () => {
    expect(html).toContain('<b>158</b> settings tested')
    expect(html).toContain('+2.10%')
    expect(html).toContain('−0.80%')
    expect(html).toContain('Nothing here placed an order')
    expect(html).toContain('deflated Sharpe 0.81 (best of 154)')
    expect(html).toContain('2 of 3 checks pass, 1 to judge forward')
  })
  it('says when the Strategy Brain did not run', () => {
    const l = ME.strategyShortlist({ runs: [], library, paper, since })
    expect(ME.buildStrategyShortlistHtml({ list: l, dateStr: 'x' })).toContain('did not run in this window')
  })
})

describe('strategyShortlistEmail job', () => {
  const OLD = process.env.MORNING_BRIEF_EMAIL
  afterAll(() => { if (OLD == null) delete process.env.MORNING_BRIEF_EMAIL; else process.env.MORNING_BRIEF_EMAIL = OLD })
  const { strategyShortlistEmail } = require('../lib/scheduled-jobs')

  it('sends one email with the counts in the subject', async () => {
    process.env.MORNING_BRIEF_EMAIL = 'owner@example.com'
    const sent = []
    const r = await strategyShortlistEmail({ now: NOW, send: async m => { sent.push(m); return true }, deps: { runs: () => runs, library: () => library, paper: () => paper } })
    expect(r.sent).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('owner@example.com')
    expect(sent[0].subject).toMatch(/2 admitted, 1 graduated/)
  })
  it('sends nothing when nothing happened', async () => {
    process.env.MORNING_BRIEF_EMAIL = 'owner@example.com'
    const send = jest.fn()
    const r = await strategyShortlistEmail({ now: NOW, send, deps: { runs: () => [], library: () => [], paper: () => null } })
    expect(r.skipped).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})
