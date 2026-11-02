'use strict'
const ops = require('../lib/ops-alerts')

const now = new Date('2026-11-03T16:00:00Z')
test('risk limits, data feed, refusals, a quiet book and the desk each raise one keyed alert', () => {
  const alerts = ops.collectAlerts({
    now,
    paper: { enabled: true, protections: { global: { kind: 'daily-loss', reason: 'down 2.5% today', until: '2026-11-04T05:00:00Z' } }, performance: { openPositions: 1 }, unmanaged: ['OLD'] },
    trades: [
      { status: 'filled', side: 'buy', at: '2026-10-01T15:00:00Z', symbol: 'A' },
      ...['X', 'Y', 'Z'].map(symbol => ({ status: 'rejected', at: '2026-11-03T14:00:00Z', symbol, rejectReason: 'pre-trade: quote is 40 min old' })),
    ],
    dataFeed: { ok: false, detail: 'no SPY price' },
    desk: { enabled: true, budget: { exhausted: true, spentUsd: 5, capUsd: 5, month: '2026-11' }, proposals: [{ status: 'pending', title: 'v1.1' }], ledger: { verdict: 'does-not-cover', month: '2026-11', recommendation: 'scale down' } },
  })
  expect(alerts.map(a => a.key).sort()).toEqual(['data-feed', 'desk-budget:2026-11', 'desk-ledger:2026-11', 'desk-pending', 'paper-pause:daily-loss', 'paper-quiet', 'paper-rejections', 'paper-unmanaged'])
  expect(alerts.find(a => a.key === 'paper-pause:daily-loss').title).toMatch(/Daily loss limit/)
})

test('each alert is sent at most once a day', () => {
  const a = [{ key: 'data-feed' }, { key: 'desk-pending' }]
  expect(ops.newSince(a, { 'data-feed': '2026-11-03' }, now).map(x => x.key)).toEqual(['desk-pending'])
  expect(ops.newSince(a, { 'data-feed': '2026-11-02' }, now)).toHaveLength(2)
})

test('the hourly job emails new alerts once and remembers them', async () => {
  process.env.ADMIN_EMAIL = 'ops@test.dev'
  const jobs = require('../lib/scheduled-jobs')
  const realFetch = global.fetch
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ quoteResponse: { result: [{ symbol: 'SPY', regularMarketPrice: null }] } }) }))
  const sent = []
  const first = await jobs.opsAlerts({ sendEmail: async m => { sent.push(m); return true }, now })
  expect(first.keys).toContain('data-feed')
  expect(sent[0].subject).toMatch(/Market data feed is down/)
  const second = await jobs.opsAlerts({ sendEmail: async m => { sent.push(m); return true }, now })
  expect(second.sent).toBe(0)
  global.fetch = realFetch
  delete process.env.ADMIN_EMAIL
})
