'use strict'
const request = require('supertest')
const { createApp } = require('./helpers/app')

let app
beforeAll(() => { app = createApp() })

const password = 'StrongPass123!'

async function registerAndLogin(prefix) {
  const email = `${prefix}_${Date.now()}@example.com`
  const reg   = await request(app).post('/api/auth/register').send({ email, password })
  await request(app).post('/api/auth/verify-email').send({ email, code: reg.body.demoCode })
  const login = await request(app).post('/api/auth/login').send({ email, password })
  return { email, token: login.body.accessToken }
}

describe('Portfolio cross-user isolation (in-memory mode)', () => {
  let tokenA, tokenB

  beforeAll(async () => {
    const userA = await registerAndLogin('user_a')
    const userB = await registerAndLogin('user_b')
    tokenA = userA.token
    tokenB = userB.token
  })

  test('user A can fetch their own portfolios', async () => {
    const res = await request(app)
      .get('/api/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
  })

  test('user B can fetch their own portfolios', async () => {
    const res = await request(app)
      .get('/api/portfolios')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
  })

  test("user A's portfolio list does not contain user B's portfolio", async () => {
    const resA = await request(app)
      .get('/api/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
    const resB = await request(app)
      .get('/api/portfolios')
      .set('Authorization', `Bearer ${tokenB}`)

    const idsA = (resA.body.portfolios || resA.body || []).map(p => p.id)
    const idsB = (resB.body.portfolios || resB.body || []).map(p => p.id)

    const overlap = idsA.filter(id => idsB.includes(id))
    expect(overlap).toHaveLength(0)
  })

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/portfolios')
    expect(res.status).toBe(401)
  })
})
