'use strict'
/**
 * Unit tests for lib/ai-pause.js — the time-bounded Claude pause switch.
 */

const pause = require('../lib/ai-pause')

const ORIG = process.env.CLAUDE_PAUSE_UNTIL
function setUntil(v) {
  if (v === undefined) delete process.env.CLAUDE_PAUSE_UNTIL
  else process.env.CLAUDE_PAUSE_UNTIL = v
}
afterAll(() => setUntil(ORIG))

describe('claudePaused', () => {
  test('not paused when env is unset', () => {
    setUntil(undefined)
    expect(pause.claudePaused()).toBe(false)
  })

  test('not paused when env is blank or invalid', () => {
    setUntil('   ')
    expect(pause.claudePaused()).toBe(false)
    setUntil('not-a-date')
    expect(pause.claudePaused()).toBe(false)
  })

  test('paused while now is before the date', () => {
    setUntil('2026-07-01')
    const before = Date.parse('2026-06-15T00:00:00Z')
    expect(pause.claudePaused(before)).toBe(true)
  })

  test('auto-resumes once the date passes', () => {
    setUntil('2026-07-01')
    const after = Date.parse('2026-07-01T00:00:01Z')
    expect(pause.claudePaused(after)).toBe(false)
  })
})

describe('pausedError', () => {
  test('carries a 503 status and the claudePaused flag', () => {
    setUntil('2026-07-01')
    const e = pause.pausedError()
    expect(e.status).toBe(503)
    expect(e.claudePaused).toBe(true)
    expect(e.message).toMatch(/2026-07-01/)
  })
})
