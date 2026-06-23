'use strict'
/**
 * Unit tests for lib/finnhub-keys.js — the round-robin Finnhub key pool.
 * State is module-level, so each test reloads from a controlled env.
 */

const pool = require('../lib/finnhub-keys')

const ORIG = { FINNHUB_API_KEYS: process.env.FINNHUB_API_KEYS, FINNHUB_API_KEY: process.env.FINNHUB_API_KEY }

function setEnv({ keys, key } = {}) {
  if (keys === undefined) delete process.env.FINNHUB_API_KEYS; else process.env.FINNHUB_API_KEYS = keys
  if (key === undefined) delete process.env.FINNHUB_API_KEY; else process.env.FINNHUB_API_KEY = key
  pool.reload()
}

afterAll(() => {
  if (ORIG.FINNHUB_API_KEYS === undefined) delete process.env.FINNHUB_API_KEYS; else process.env.FINNHUB_API_KEYS = ORIG.FINNHUB_API_KEYS
  if (ORIG.FINNHUB_API_KEY === undefined) delete process.env.FINNHUB_API_KEY; else process.env.FINNHUB_API_KEY = ORIG.FINNHUB_API_KEY
  pool.reload()
})

describe('configuration', () => {
  test('no keys → has() false, next() null', () => {
    setEnv({})
    expect(pool.has()).toBe(false)
    expect(pool.next()).toBeNull()
  })

  test('single FINNHUB_API_KEY behaves exactly as before (always returns it)', () => {
    setEnv({ key: 'solo' })
    expect(pool.has()).toBe(true)
    expect(pool.next()).toBe('solo')
    expect(pool.next()).toBe('solo')
  })

  test('FINNHUB_API_KEYS folds in FINNHUB_API_KEY and de-dupes', () => {
    setEnv({ keys: 'a,b', key: 'b' })   // b appears in both
    expect(pool.keys()).toEqual(['a', 'b'])
  })

  test('whitespace and empties are trimmed/ignored', () => {
    setEnv({ keys: ' a , , b ,' })
    expect(pool.keys()).toEqual(['a', 'b'])
  })
})

describe('round-robin', () => {
  test('cycles through keys in order', () => {
    setEnv({ keys: 'a,b,c' })
    expect([pool.next(), pool.next(), pool.next(), pool.next()]).toEqual(['a', 'b', 'c', 'a'])
  })
})

describe('cooldown', () => {
  test('penalize routes traffic away from a cooling key', () => {
    setEnv({ keys: 'a,b' })
    expect(pool.next()).toBe('a')
    pool.penalize('b', 60_000)   // b is now cooling
    // subsequent calls should skip b and keep returning a
    expect(pool.next()).toBe('a')
    expect(pool.next()).toBe('a')
  })

  test('expired cooldown lets a key return again', () => {
    setEnv({ keys: 'a,b' })
    pool.penalize('b', -1)       // already expired
    expect([pool.next(), pool.next()]).toEqual(expect.arrayContaining(['a', 'b']))
  })

  test('penalize ignores keys not in the pool (e.g. a browser key)', () => {
    setEnv({ keys: 'a,b' })
    expect(pool.penalize('user-browser-key')).toBe(false)
  })

  test('all keys cooling → returns the soonest-to-recover, never null', () => {
    setEnv({ keys: 'a,b' })
    pool.penalize('a', 100_000)
    pool.penalize('b', 5_000)    // b recovers sooner
    expect(pool.next()).toBe('b')
  })
})

describe('isRateLimitError', () => {
  test('matches 429 and 403 messages, not others', () => {
    expect(pool.isRateLimitError(new Error('HTTP 429'))).toBe(true)
    expect(pool.isRateLimitError(new Error('HTTP 403'))).toBe(true)
    expect(pool.isRateLimitError(new Error('HTTP 500'))).toBe(false)
    expect(pool.isRateLimitError(undefined)).toBe(false)
  })
})
