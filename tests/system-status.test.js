'use strict'

const { evaluateStatus, recordFacts } = require('../lib/system-status')

const NOW = Date.UTC(2026, 9, 1, 12)
const healthy = {
  probeQuote: { symbol: 'SPY', price: 571.2 },
  ai: { claude: true, groq: true },
  keys: { fred: true, fmp: true },
  persistence: { enabled: true },
  symbolIndex: { loaded: true, counts: { equity: 20000, etf: 3000 } },
  lastScanAt: new Date(NOW - 2 * 3600000).toISOString(), lastScanSymbols: 18, lastScanDataAge: 'live',
  jobs: [{ id: 'brain-learning-cycle', name: 'Nightly learning', result: { lastRun: NOW - 5 * 3600000 } }],
  record: { logged: 40, resolved: 12, nextResolutionAt: NOW + 86400000 },
}

describe('evaluateStatus', () => {
  test('all healthy reads ok', () => {
    const s = evaluateStatus(healthy, NOW)
    expect(s.overall).toBe('ok')
    expect(s.checks.find(c => c.id === 'market-data').detail).toMatch(/SPY \$571.2/)
    expect(s.checks.find(c => c.id === 'record').detail).toMatch(/40 picks logged, 12 scored/)
  })

  test('no market data at all is a failure with a fix', () => {
    const s = evaluateStatus({ ...healthy, probeQuote: null, probeBars: null }, NOW)
    const md = s.checks.find(c => c.id === 'market-data')
    expect(md.status).toBe('fail')
    expect(md.fix).toMatch(/FINNHUB_API_KEY/)
    expect(s.overall).toBe('fail')
  })

  test('bars without a live quote is a warning, not a failure', () => {
    const s = evaluateStatus({ ...healthy, probeQuote: null, probeBars: { lastClose: 570, asOf: '2026-09-30' } }, NOW)
    expect(s.checks.find(c => c.id === 'market-data').status).toBe('warn')
  })

  test('persistence off fails loudly — the record resets on deploy', () => {
    const s = evaluateStatus({ ...healthy, persistence: { enabled: false, reason: 'no DATABASE_URL' } }, NOW)
    expect(s.checks.find(c => c.id === 'persistence')).toMatchObject({ status: 'fail' })
  })

  test('an FMP key that FMP refuses is a failure with the reason, not "Configured"', () => {
    const s = evaluateStatus({ ...healthy, keys: { ...healthy.keys, fmp: true }, fmpProbe: { ok: false, error: 'Legacy Endpoint : …' } }, NOW)
    const c = s.checks.find(x => x.id === 'fundamentals')
    expect(c.status).toBe('fail')
    expect(c.detail).toMatch(/Legacy Endpoint/)
    expect(c.fix).toBeTruthy()
  })

  test('an FMP key that answers the probe is ok', () => {
    const s = evaluateStatus({ ...healthy, keys: { ...healthy.keys, fmp: true }, fmpProbe: { ok: true } }, NOW)
    expect(s.checks.find(x => x.id === 'fundamentals').status).toBe('ok')
  })

  test('a failed scheduled job is reported with its error', () => {
    const s = evaluateStatus({ ...healthy, jobs: [{ id: 'x', name: 'Nightly learning', result: { status: 'error', error: 'boom', failedAt: NOW - 3600000 } }] }, NOW)
    expect(s.checks.find(c => c.id === 'job:x')).toMatchObject({ status: 'fail' })
    expect(s.checks.find(c => c.id === 'job:x').detail).toMatch(/boom/)
  })

  test('a scan older than a day is flagged', () => {
    const s = evaluateStatus({ ...healthy, lastScanAt: new Date(NOW - 3 * 86400000).toISOString() }, NOW)
    expect(s.checks.find(c => c.id === 'last-scan')).toMatchObject({ status: 'warn' })
  })

  test('Claude paused with Groq available is a warning', () => {
    const s = evaluateStatus({ ...healthy, ai: { claude: true, paused: true, pausedUntil: '2026-11-01', groq: true } }, NOW)
    expect(s.checks.find(c => c.id === 'ai')).toMatchObject({ status: 'warn' })
  })
})

describe('recordFacts', () => {
  test('counts logged and resolved picks and finds the next due outcome', () => {
    const r = recordFacts([
      { generatedAt: new Date(NOW - 10 * 86400000).toISOString(), price7d: 100 },
      { generatedAt: new Date(NOW - 2 * 86400000).toISOString() },
      { generatedAt: new Date(NOW - 1 * 86400000).toISOString() },
    ], NOW)
    expect(r).toMatchObject({ logged: 3, resolved: 1 })
    expect(r.nextResolutionAt).toBe(NOW - 2 * 86400000 + 7 * 86400000)
  })
})
