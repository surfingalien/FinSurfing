'use strict'
/** routes/sentiment-adanos.js — a rejected key must say so, not show a bare "Adanos HTTP 401". */
const request = require('supertest')
const express = require('express')

const realFetch = global.fetch
let app
beforeEach(() => {
  jest.resetModules()
  process.env.ADANOS_API_KEY = 'test-key'
  app = express(); app.use('/api/sentiment/adanos', require('../routes/sentiment-adanos'))
})
afterAll(() => { global.fetch = realFetch; delete process.env.ADANOS_API_KEY })

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

test('a rejected key names the problem and the fix, using Adanos\'s own reason (`detail`)', async () => {
  global.fetch = jest.fn(async () => reply(401, { detail: 'Invalid API key.' }))
  const r = await request(app).get('/api/sentiment/adanos?symbols=AAPL&source=reddit&days=1')
  expect(r.status).toBe(502)
  expect(r.body.error).toMatch(/rejected the API key/)
  expect(r.body.error).toMatch(/Invalid API key/)
  expect(r.body.error).toMatch(/ADANOS_API_KEY/)
  expect(global.fetch.mock.calls[0][1].headers['X-API-Key']).toBe('test-key')
})

test('other errors pass Adanos\'s reason through', async () => {
  global.fetch = jest.fn(async () => reply(429, { detail: 'Rate limit exceeded' }))
  const r = await request(app).get('/api/sentiment/adanos?symbols=AAPL')
  expect(r.body.error).toBe('Adanos: Rate limit exceeded')
})

test('no key configured is reported, not an error', async () => {
  delete process.env.ADANOS_API_KEY
  const r = await request(app).get('/api/sentiment/adanos?symbols=AAPL')
  expect(r.body.enabled).toBe(false)
})
