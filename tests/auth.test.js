'use strict'
const request = require('supertest')
const { createApp } = require('./helpers/app')

let app
beforeAll(() => { app = createApp() })

const email = `testuser_${Date.now()}@example.com`
const password = 'StrongPass123!'

describe('POST /api/auth/register', () => {
  test('valid registration returns 201 + requiresVerification', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password })
    expect(res.status).toBe(201)
    expect(res.body.requiresVerification).toBe(true)
    expect(res.body.email).toBe(email.toLowerCase())
  })

  test('duplicate email returns 409', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password })
    expect(res.status).toBe(409)
  })

  test('demoCode NOT returned in production mode', async () => {
    process.env.NODE_ENV = 'production'
    const unique = `prod_${Date.now()}@example.com`
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: unique, password })
    expect(res.body.demoCode).toBeUndefined()
    process.env.NODE_ENV = 'test'
  })

  test('demoCode IS returned in non-production mode', async () => {
    const unique = `dev_${Date.now()}@example.com`
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: unique, password })
    // In-memory mode with no email service → demoCode present in test/dev
    expect(res.body.demoCode).toBeDefined()
    expect(typeof res.body.demoCode).toBe('string')
    expect(res.body.demoCode).toHaveLength(6)
  })
})

describe('POST /api/auth/verify-email + login flow', () => {
  let verifiedEmail
  let otp

  beforeAll(async () => {
    verifiedEmail = `verified_${Date.now()}@example.com`
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: verifiedEmail, password })
    otp = reg.body.demoCode
  })

  test('wrong OTP returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: verifiedEmail, code: '000000' })
    expect(res.status).toBe(400)
  })

  test('OTP expired after 10 minutes returns 400', async () => {
    const expiredEmail = `expired_${Date.now()}@example.com`
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: expiredEmail, password })
    const code = reg.body.demoCode
    expect(code).toBeDefined()

    // Advance Date.now() by 11 minutes so the OTP's expiresAt is in the past
    const realNow = Date.now
    Date.now = () => realNow() + 11 * 60 * 1000
    try {
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ email: expiredEmail, code })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/expired/i)
    } finally {
      Date.now = realNow
    }
  })

  test('correct OTP verifies account and returns tokens', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email: verifiedEmail, code: otp })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()
  })

  test('login with correct password returns access token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: verifiedEmail, password })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()
  })

  test('login with wrong password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: verifiedEmail, password: 'WrongPassword!' })
    expect(res.status).toBe(401)
  })

  test('5 failed logins lock the account (429 on 6th attempt)', async () => {
    const locked = `locktest_${Date.now()}@example.com`
    // Register + verify
    const reg = await request(app).post('/api/auth/register').send({ email: locked, password })
    await request(app).post('/api/auth/verify-email').send({ email: locked, code: reg.body.demoCode })

    // 5 wrong-password attempts
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ email: locked, password: 'wrong' })
    }
    // 6th should be locked
    const res = await request(app).post('/api/auth/login').send({ email: locked, password: 'wrong' })
    expect(res.status).toBe(429)
  })

  test('unverified user cannot login (403)', async () => {
    const unverified = `unverified_${Date.now()}@example.com`
    await request(app).post('/api/auth/register').send({ email: unverified, password })
    const res = await request(app).post('/api/auth/login').send({ email: unverified, password })
    expect(res.status).toBe(403)
    expect(res.body.requiresVerification).toBe(true)
  })
})

describe('Token refresh rotation', () => {
  let accessToken, refreshCookie

  beforeAll(async () => {
    const userEmail = `refresh_${Date.now()}@example.com`
    const reg = await request(app).post('/api/auth/register').send({ email: userEmail, password })
    await request(app).post('/api/auth/verify-email').send({ email: userEmail, code: reg.body.demoCode })
    const login = await request(app).post('/api/auth/login').send({ email: userEmail, password })
    accessToken = login.body.accessToken
    refreshCookie = login.headers['set-cookie']
  })

  test('refresh endpoint issues a new access token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie)
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()
    expect(typeof res.body.accessToken).toBe('string')
  })

  test('second use of the same refresh token is rejected (rotation)', async () => {
    // Use the original refresh cookie a second time
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/auth/me', () => {
  test('no token returns 401', async () => {
    const res = await request(app).get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  test('valid token returns user info', async () => {
    const userEmail = `me_${Date.now()}@example.com`
    const reg = await request(app).post('/api/auth/register').send({ email: userEmail, password })
    await request(app).post('/api/auth/verify-email').send({ email: userEmail, code: reg.body.demoCode })
    const login = await request(app).post('/api/auth/login').send({ email: userEmail, password })
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
    expect(res.status).toBe(200)
    expect(res.body.email).toBe(userEmail.toLowerCase())
  })
})
