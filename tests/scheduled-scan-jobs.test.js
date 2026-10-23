'use strict'

// The pre-market and hourly scans call POST /api/ai-brain/analyze over
// loopback. Two ways they failed in production: a 120s cap that aborted every
// broad scan (they take 3–4 minutes), and a heartbeated `200 {error}` body that
// was cached and reported as a successful run.

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key'
const jobs = require('../lib/scheduled-jobs')

const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
let realFetch
beforeEach(() => { realFetch = global.fetch })
afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); jest.restoreAllMocks() })

test('a broad scan gets the same budget the background queue gives it, not 120s', async () => {
  const { JOB_KINDS } = require('../lib/ai-job-queue')
  expect(jobs.SCAN_TIMEOUT_MS).toBe(JOB_KINDS.scan.timeoutMs)
  expect(jobs.SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000)
})

test('pre-market: a scan result is cached and summarised', async () => {
  global.fetch = jest.fn(async () => json({ rankedStocks: [{ symbol: 'NVDA', agentVerdict: 'Buy', compositeScore: 71 }], marketRegime: 'Neutral' }))
  const out = await jobs._preMarketScanForTests()
  expect(out.signals).toEqual([expect.objectContaining({ symbol: 'NVDA', signal: 'Buy' })])
  expect(jobs.getCachedScan().broad.rankedStocks[0].symbol).toBe('NVDA')
})

test('pre-market: a 200 carrying an error is a failed run, and the cache keeps the last good scan', async () => {
  global.fetch = jest.fn(async () => json({ error: 'AI Brain analysis failed: upstream overloaded' }))
  await expect(jobs._preMarketScanForTests()).rejects.toThrow(/upstream overloaded/)
  expect(jobs.getCachedScan().broad.rankedStocks[0].symbol).toBe('NVDA')
})

test('hourly: a failed broad scan fails the run instead of reporting "done" with no picks', async () => {
  jest.useFakeTimers({ now: new Date('2026-10-21T15:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] }) // Wed 11:00 ET
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jobs.setServerWatchlist(['AAPL'])
  global.fetch = jest.fn(async url => String(url).includes('/api/ai-brain/analyze')
    ? json({ error: 'The operation was aborted due to timeout' })
    : json({ analysis: { signal: 'HOLD', confidence: 55 } }))
  await expect(jobs._hourlyAiScanForTests()).rejects.toThrow(/broad scan failed/)
  expect(jobs.getCachedScan().watchlist).toEqual([{ symbol: 'AAPL', signal: 'HOLD', confidence: 55 }])
})
