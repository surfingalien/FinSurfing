'use strict'
// The AI call log survives a restart (it was in-memory only, reset by every deploy).

const fs = require('fs')
const audit = require('../lib/ai-audit')

const call = (o = {}) => audit.logCall({
  route: 'copilot', model: 'claude-sonnet-4-6', llm: 'claude', success: true,
  tokensIn: 1000, tokensOut: 100, cacheRead: 3000, cacheWrite: 0, durationMs: 500, ...o,
})

beforeEach(() => { try { fs.unlinkSync(audit.LOG_FILE) } catch {} ; audit._reset() })

test('a restarted process reads back the log, ids continue, cost and stats survive', () => {
  call(); call({ route: 'ai-brain', cacheRead: 0, cacheWrite: 4000 }); call({ success: false, error: 'boom', tokensIn: null, tokensOut: null })
  const before = audit.getStats()
  audit._reset()                              // a new process
  const after = audit.getStats()
  expect(after.total).toBe(3)
  expect(after.totalCostUsd).toBe(before.totalCostUsd)
  expect(after.totalCostUsd).toBeGreaterThan(0)
  expect(after.failures).toBe(1)
  expect(audit.getLog(1)[0].error).toBe('boom')   // newest first
  call()
  expect(audit.getLog(1)[0].id).toBe(4)
  expect(after.since).toBe(audit.getLog(10).at(-1).ts)
})

test('per-route and per-day summaries carry calls, cost and the cache hit rate', () => {
  call(); call(); call({ route: 'ai-brain', cacheRead: 0, cacheWrite: 4000 })
  const s = audit.getStats()
  expect(s.routes.copilot.calls).toBe(2)
  expect(s.routes.copilot.cacheHitRate).toBe(0.75)        // 3000 / (3000 + 1000)
  expect(s.routes['ai-brain'].cacheHitRate).toBe(0)
  expect(s.byDay).toHaveLength(1)
  expect(s.byDay[0]).toMatchObject({ date: new Date().toISOString().slice(0, 10), calls: 3 })
  expect(s.byDay[0].costUsd).toBeCloseTo(s.totalCostUsd, 4)
})

test('the file is compacted to the newest entries instead of growing forever', () => {
  for (let i = 0; i < 2 * audit.MAX_ENTRIES + 1; i++) call({ symbols: [`S${i}`] })
  const lines = fs.readFileSync(audit.LOG_FILE, 'utf8').trim().split('\n')
  expect(lines.length).toBe(audit.MAX_ENTRIES)
  expect(JSON.parse(lines.at(-1)).symbols).toEqual([`S${2 * audit.MAX_ENTRIES}`])
  audit._reset()
  expect(audit.getStats().total).toBe(audit.MAX_ENTRIES)
})

test('an unreadable log is never overwritten', () => {
  fs.mkdirSync(require('path').dirname(audit.LOG_FILE), { recursive: true })
  fs.mkdirSync(audit.LOG_FILE)                  // a directory: exists, cannot be read as a file
  const err = jest.spyOn(console, 'error').mockImplementation(() => {})
  call()
  expect(audit.getStats().total).toBe(1)        // still logs in memory
  expect(fs.statSync(audit.LOG_FILE).isDirectory()).toBe(true)
  err.mockRestore()
  fs.rmdirSync(audit.LOG_FILE)
})
