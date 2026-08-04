'use strict'
/**
 * Unit tests for lib/scan-queue.js — the background scan queue.
 *
 * Covers enqueue/limits, per-user isolation (one user must never see or cancel
 * another's scan), status transitions, and the "what do I show on a cold page
 * load" lookups. The worker's network call is not exercised here; these are the
 * pure queue mechanics.
 */

const queue = require('../lib/scan-queue')

beforeEach(() => queue._resetForTests())

const params = { scanMode: 'broad', horizon: '6m', holdings: [] }

describe('enqueue', () => {
  test('returns an id and a queue position', () => {
    const a = queue.enqueue({ userId: 'u1', params })
    expect(a.id).toMatch(/^scan-/)
    expect(a.position).toBe(1)
  })

  test('a second job for another user queues behind the first', () => {
    queue.enqueue({ userId: 'u1', params })
    expect(queue.enqueue({ userId: 'u2', params }).position).toBe(2)
  })

  test('caps how many scans one user can have waiting', () => {
    for (let i = 0; i < queue.MAX_PER_USER; i++) queue.enqueue({ userId: 'u1', params })
    expect(() => queue.enqueue({ userId: 'u1', params })).toThrow(/already have/i)
  })

  test("one user's cap does not block a different user", () => {
    for (let i = 0; i < queue.MAX_PER_USER; i++) queue.enqueue({ userId: 'u1', params })
    expect(() => queue.enqueue({ userId: 'u2', params })).not.toThrow()
  })

  test('rejects once the whole queue is full', () => {
    // Spread across users so the per-user cap isn't what trips first
    for (let i = 0; i < queue.MAX_QUEUE; i++) queue.enqueue({ userId: `u${i}`, params })
    expect(() => queue.enqueue({ userId: 'zz', params })).toThrow(/queue is full/i)
  })
})

describe('getJob — ownership isolation', () => {
  test('the owner can read their queued job', () => {
    const { id } = queue.enqueue({ userId: 'u1', params })
    const job = queue.getJob(id, 'u1')
    expect(job.id).toBe(id)
    expect(['queued', 'running']).toContain(job.status)
  })

  test("another user gets null — indistinguishable from a missing id", () => {
    const { id } = queue.enqueue({ userId: 'u1', params })
    expect(queue.getJob(id, 'u2')).toBeNull()
    expect(queue.getJob('scan-does-not-exist', 'u2')).toBeNull()
  })

  test('the public view never leaks userId', () => {
    const { id } = queue.enqueue({ userId: 'u1', params })
    expect(queue.getJob(id, 'u1')).not.toHaveProperty('userId')
  })
})

describe('cancel', () => {
  test('the owner can cancel their own pending job', () => {
    queue.enqueue({ userId: 'u1', params })            // occupies slot 1
    const { id } = queue.enqueue({ userId: 'u1', params })
    expect(queue.cancel(id, 'u1')).toBe(true)
    expect(queue.getJob(id, 'u1')).toBeNull()
  })

  test('another user cannot cancel it', () => {
    queue.enqueue({ userId: 'u1', params })
    const { id } = queue.enqueue({ userId: 'u1', params })
    expect(queue.cancel(id, 'u2')).toBe(false)
    expect(queue.getJob(id, 'u1')).not.toBeNull()
  })

  test('cancelling an unknown id is false, not an error', () => {
    expect(queue.cancel('nope', 'u1')).toBe(false)
  })
})

describe('getUserJobs', () => {
  test('returns only the calling user’s jobs', () => {
    queue.enqueue({ userId: 'u1', params })
    queue.enqueue({ userId: 'u2', params })
    queue.enqueue({ userId: 'u1', params })
    expect(queue.getUserJobs('u1')).toHaveLength(2)
    expect(queue.getUserJobs('u2')).toHaveLength(1)
  })

  test('respects the limit', () => {
    for (let i = 0; i < 3; i++) queue.enqueue({ userId: 'u1', params })
    expect(queue.getUserJobs('u1', 2)).toHaveLength(2)
  })

  test('a user with no scans gets an empty list, not an error', () => {
    expect(queue.getUserJobs('nobody')).toEqual([])
  })
})

describe('getLatestResult', () => {
  test('null when the user has never completed a scan', () => {
    queue.enqueue({ userId: 'u1', params })   // queued, not completed
    expect(queue.getLatestResult('u1')).toBeNull()
  })
})

describe('getQueue', () => {
  test('reports pending depth', () => {
    queue.enqueue({ userId: 'u1', params })
    queue.enqueue({ userId: 'u2', params })
    const q = queue.getQueue()
    expect(q.pending + (q.running ? 1 : 0)).toBeGreaterThanOrEqual(1)
    expect(typeof q.completed).toBe('number')
  })
})
