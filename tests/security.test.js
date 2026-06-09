'use strict'
const request = require('supertest')
const jwt     = require('jsonwebtoken')
const { createApp } = require('./helpers/app')

let app
beforeAll(() => { app = createApp() })

const password = 'StrongPass123!'

async function registerAndLogin(emailBase) {
  const email = `${emailBase}_${Date.now()}@example.com`
  const reg = await request(app).post('/api/auth/register').send({ email, password })
  await request(app).post('/api/auth/verify-email').send({ email, code: reg.body.demoCode })
  const login = await request(app).post('/api/auth/login').send({ email, password })
  return { email, accessToken: login.body.accessToken }
}

describe('Scheduler trigger authentication', () => {
  test('POST /api/scheduler/jobs/:id/trigger → 401 without token', async () => {
    const res = await request(app).post('/api/scheduler/jobs/macro-pulse/trigger')
    expect(res.status).toBe(401)
  })

  test('POST /api/scheduler/jobs/:id/trigger → 403 for regular user (non-admin)', async () => {
    const { accessToken } = await registerAndLogin('scheduser')
    const res = await request(app)
      .post('/api/scheduler/jobs/macro-pulse/trigger')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(403)
  })

  test('PATCH /api/scheduler/jobs/:id → 401 without token', async () => {
    const res = await request(app)
      .patch('/api/scheduler/jobs/macro-pulse')
      .send({ enabled: false })
    expect(res.status).toBe(401)
  })
})

describe('JWT signed with wrong secret is rejected', () => {
  test('token signed with a different secret returns 401', async () => {
    const forged = jwt.sign(
      { sub: 'fake-user-id', email: 'attacker@evil.com', role: 'admin' },
      'wrong-secret-that-is-not-the-real-one',
      { algorithm: 'HS256', expiresIn: '1h' }
    )
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`)
    expect(res.status).toBe(401)
  })

  test('token with tampered payload returns 401', async () => {
    // Build a valid token, then swap the payload
    const { accessToken } = await registerAndLogin('tampereduser')
    const [header, , sig] = accessToken.split('.')
    const fakePayload = Buffer.from(JSON.stringify({ sub: 'admin', role: 'admin' })).toString('base64url')
    const tampered = `${header}.${fakePayload}.${sig}`
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tampered}`)
    expect(res.status).toBe(401)
  })
})

describe('Portfolio access control', () => {
  test('GET /api/portfolios → 401 without token', async () => {
    const res = await request(app).get('/api/portfolios')
    expect(res.status).toBe(401)
  })

  test('GET /api/portfolios → 200 with valid token', async () => {
    const { accessToken } = await registerAndLogin('portfoliouser')
    const res = await request(app)
      .get('/api/portfolios')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(200)
  })
})
