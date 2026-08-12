'use strict'
/**
 * Unit tests for lib/ai-job-routes.js — the shared background-job endpoints.
 *
 * These run against a real express app with a fake auth middleware, so they
 * exercise the thing that actually broke in hand-written copies: route ORDER
 * (`/job/latest` must not be swallowed by `/job/:id`), owner scoping, and the
 * userId stamp that a per-surface buildParams would eventually forget.
 *
 * The queue's worker is not exercised — enqueued jobs try to POST over loopback
 * and fail fast, which is fine here; we only assert on the routing layer.
 */

const express = require('express')
const request = require('supertest')

const queue = require('../lib/ai-job-queue')
const { mountJobRoutes } = require('../lib/ai-job-routes')

// Stand-in for middleware/auth's requireAuth: trusts an x-user header.
const fakeAuth = (req, res, next) => {
  const id = req.headers['x-user']
  if (!id) return res.status(401).json({ error: 'Missing access token' })
  req.user = { userId: id }
  next()
}

function makeApp(opts = {}) {
  const app = express()
  app.use(express.json())
  const router = express.Router()
  mountJobRoutes(router, {
    kind: 'scan',
    requireAuth: fakeAuth,
    buildParams: (req) => {
      if (req.body?.bad) return { error: 'bad request' }
      return { scanMode: req.body?.scanMode || 'broad', horizon: '6m', holdings: [] }
    },
    ...opts,
  })
  app.use('/api/thing', router)
  return app
}

beforeEach(() => queue._resetForTests())

describe('mounting', () => {
  test('refuses to mount an unknown kind rather than failing at request time', () => {
    expect(() => mountJobRoutes(express.Router(), { kind: 'nope', requireAuth: fakeAuth }))
      .toThrow(/unknown kind/i)
  })
})

describe('POST <base> — enqueue', () => {
  test('returns 202 with a job id', async () => {
    const res = await request(makeApp()).post('/api/thing/job').set('x-user', 'u1').send({})
    expect(res.status).toBe(202)
    expect(res.body.jobId).toMatch(/^scan-/)
    expect(res.body.status).toBe('running')   // position 1 starts immediately
  })

  test('requires auth', async () => {
    const res = await request(makeApp()).post('/api/thing/job').send({})
    expect(res.status).toBe(401)
  })

  test('a buildParams rejection is a 400 and never reaches the queue', async () => {
    const res = await request(makeApp()).post('/api/thing/job').set('x-user', 'u1').send({ bad: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad request')
    expect(queue.getQueue().pending).toBe(0)
  })

  test('the kill switch 503s when its env var is exactly "true"', async () => {
    const app = makeApp({ disabledEnv: 'TEST_KILL_SWITCH' })
    process.env.TEST_KILL_SWITCH = 'true'
    try {
      const res = await request(app).post('/api/thing/job').set('x-user', 'u1').send({})
      expect(res.status).toBe(503)
      expect(res.body.killSwitch).toBe(true)
    } finally {
      delete process.env.TEST_KILL_SWITCH
    }
  })

  test('stamps the owner into params so a queued run keeps its user history', async () => {
    const res = await request(makeApp()).post('/api/thing/job').set('x-user', 'u1').send({})
    const job = queue.getJob(res.body.jobId, 'u1')
    // The worker POSTs params as the body; the route reads it back via
    // effectiveUserId(). Without this the run would be attributed to nobody.
    expect(job.params.userId).toBe('u1')
  })
})

describe('GET <base>/latest — route order', () => {
  test('"latest" is not swallowed by the /:id route', async () => {
    const res = await request(makeApp()).get('/api/thing/job/latest').set('x-user', 'u1')
    expect(res.status).toBe(200)          // a /:id match would 404 on id "latest"
    expect(res.body).toHaveProperty('job')
  })
})

describe('GET <base>/:id — ownership', () => {
  test('the owner can read their job', async () => {
    const app = makeApp()
    const { body } = await request(app).post('/api/thing/job').set('x-user', 'u1').send({})
    const res = await request(app).get(`/api/thing/job/${body.jobId}`).set('x-user', 'u1')
    expect(res.status).toBe(200)
    expect(res.body.job.id).toBe(body.jobId)
  })

  test("another user gets a 404, indistinguishable from a missing id", async () => {
    const app = makeApp()
    const { body } = await request(app).post('/api/thing/job').set('x-user', 'u1').send({})
    expect((await request(app).get(`/api/thing/job/${body.jobId}`).set('x-user', 'u2')).status).toBe(404)
    expect((await request(app).get('/api/thing/job/scan-nope').set('x-user', 'u2')).status).toBe(404)
  })

  test('a job belonging to a different KIND is not readable through this surface', async () => {
    const app = makeApp()
    const { id } = queue.enqueue({ userId: 'u1', kind: 'recommendations', params: {} })
    const res = await request(app).get(`/api/thing/job/${id}`).set('x-user', 'u1')
    expect(res.status).toBe(404)
  })

  test('the response never leaks the owner id', async () => {
    const app = makeApp()
    const { body } = await request(app).post('/api/thing/job').set('x-user', 'u1').send({})
    const res = await request(app).get(`/api/thing/job/${body.jobId}`).set('x-user', 'u1')
    expect(res.body.job).not.toHaveProperty('userId')
  })
})

describe('DELETE <base>/:id', () => {
  test('another user cannot cancel it', async () => {
    const app = makeApp()
    await request(app).post('/api/thing/job').set('x-user', 'u1').send({})   // occupies slot 1
    const { body } = await request(app).post('/api/thing/job').set('x-user', 'u1').send({})
    expect((await request(app).delete(`/api/thing/job/${body.jobId}`).set('x-user', 'u2')).status).toBe(404)
  })
})

describe('GET <listPath>', () => {
  test('lists only this user, and only this kind', async () => {
    const app = makeApp()
    await request(app).post('/api/thing/job').set('x-user', 'u1').send({})
    await request(app).post('/api/thing/job').set('x-user', 'u2').send({})
    queue.enqueue({ userId: 'u1', kind: 'recommendations', params: {} })

    const res = await request(app).get('/api/thing/jobs').set('x-user', 'u1')
    expect(res.status).toBe(200)
    expect(res.body.jobs).toHaveLength(1)
    expect(res.body.jobs[0].kind).toBe('scan')
  })
})
