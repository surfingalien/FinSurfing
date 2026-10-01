'use strict'
/**
 * When the email provider rejects a message (unverified sender domain, bad
 * key, quota), registration must still answer 201 so the user can request a
 * new code. It used to throw after the user row was inserted: a 500, then
 * "already exists" on retry, and an account that could never be verified.
 */
jest.mock('../lib/email', () => ({
  sendEmail: jest.fn(async () => { throw new Error('The finsurf.app domain is not verified') }),
  emailConfig: () => ({ provider: 'resend', from: 'FinSurf <noreply@finsurf.app>', fromDefault: true }),
}))

const request = require('supertest')
const { createApp } = require('./helpers/app')

let app, errSpy
beforeAll(() => { app = createApp(); errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}) })
afterAll(() => errSpy.mockRestore())

test('a provider rejection does not fail registration, and the reason is logged', async () => {
  const res = await request(app).post('/api/auth/register')
    .send({ email: `bounce_${Date.now()}@example.com`, password: 'StrongPass123!' })
  expect(res.status).toBe(201)
  expect(res.body.requiresVerification).toBe(true)
  expect(errSpy.mock.calls.flat().join(' ')).toMatch(/\[EMAIL\] send failed .*not verified/)
})

test('forgot-password still answers with the neutral message', async () => {
  const email = `reset_${Date.now()}@example.com`
  await request(app).post('/api/auth/register').send({ email, password: 'StrongPass123!' })
  const res = await request(app).post('/api/auth/forgot-password').send({ email })
  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
})
