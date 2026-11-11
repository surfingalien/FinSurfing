'use strict'
/**
 * GET /api/research-desk/compare and /peers/:symbol — the parts that need no
 * network: sign-in, input validation, and that unpriceable symbols are an
 * explained 422 rather than an empty table. (Live data is exercised by hand;
 * the maths is pinned in tests/research-compare.test.js.)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

jest.mock('../lib/internal-api', () => ({ ...jest.requireActual('../lib/internal-api'), fetchDailyBars: jest.fn(async () => []) }))

const token = jwt.sign({ sub: 'u1', email: 'u1@t.dev', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
const app = express()
app.use('/api/research-desk', require('../routes/research-desk'))
const get = p => request(app).get(p).set('Authorization', `Bearer ${token}`)

test('compare and peers need a sign-in', async () => {
  expect((await request(app).get('/api/research-desk/compare?symbols=AAPL,MSFT')).status).toBe(401)
  expect((await request(app).get('/api/research-desk/peers/AAPL')).status).toBe(401)
})

test('fewer than two valid symbols is a 400 with a usable message', async () => {
  for (const q of ['', 'AAPL', '<script>,../x']) {
    const r = await get(`/api/research-desk/compare?symbols=${encodeURIComponent(q)}`)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/at least two symbols/)
  }
})

test('symbols that cannot be priced are an explained 422, never an empty comparison', async () => {
  const r = await get('/api/research-desk/compare?symbols=AAAQ,BBBQ')
  expect(r.status).toBe(422)
  expect(r.body.error).toMatch(/AAAQ \(no price history\); BBBQ \(no price history\)/)
})

test('/compare is not swallowed by the /:symbol routes, and peers answers with a list', async () => {
  const r = await get('/api/research-desk/peers/AAPL')
  expect(r.status).toBe(200)
  expect(r.body).toEqual(expect.objectContaining({ symbol: 'AAPL', peers: expect.any(Array) }))
  expect((await get('/api/research-desk/peers/%3Cscript%3E')).status).toBe(400)
})
