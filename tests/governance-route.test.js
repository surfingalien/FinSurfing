'use strict'
// The governance routes were public: anyone could read the AI call log and
// reset the circuit breakers that stop calls to a failing provider.

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'
const sign = role => jwt.sign({ sub: 'u', email: 'u@test.dev', role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })

let app
beforeAll(() => { app = express(); app.use(express.json()); app.use('/api/governance', require('../routes/governance')) })

test('status and audit need a signed-in user', async () => {
  expect((await request(app).get('/api/governance/status')).status).toBe(401)
  expect((await request(app).get('/api/governance/audit')).status).toBe(401)
  const r = await request(app).get('/api/governance/status').set('Authorization', `Bearer ${sign('user')}`)
  expect(r.status).toBe(200)
  expect(r.body).toHaveProperty('circuitBreakers')
})

test('resetting a circuit breaker is admin-only', async () => {
  expect((await request(app).post('/api/governance/circuit-reset/x')).status).toBe(401)
  expect((await request(app).post('/api/governance/circuit-reset/x').set('Authorization', `Bearer ${sign('user')}`)).status).toBe(403)
  expect((await request(app).post('/api/governance/circuit-reset/x').set('Authorization', `Bearer ${sign('admin')}`)).body).toMatchObject({ ok: true })
})
