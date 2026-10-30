'use strict'

// The AI Agent and QuantMind paid for Claude calls with no sign-in: anyone
// who found the address could spend the account's credit, and the agent could
// be told to use any model. Both need a user now; the agent takes only the
// models its page offers.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

const app = express()
app.use(express.json())
app.use('/api/agent', require('../routes/agent'))
app.use('/api/quantmind', require('../routes/quantmind'))
const token = jwt.sign({ sub: 'u1', email: 'u1@finsurf.test' }, process.env.JWT_SECRET, { algorithm: 'HS256' })

test('the AI Agent needs a signed-in user', async () => {
  const r = await request(app).post('/api/agent/analyze').send({ prompt: 'hi' })
  expect(r.status).toBe(401)
})

test('a model the page does not offer is refused before anything is spent', async () => {
  const r = await request(app).post('/api/agent/analyze').set('Authorization', `Bearer ${token}`)
    .send({ prompt: 'hi', model: 'claude-some-expensive-model' })
  expect(r.status).toBe(400)
  expect(r.body.error).toMatch(/Unsupported model/)
})

test('every QuantMind route needs a signed-in user', async () => {
  expect((await request(app).post('/api/quantmind/ask').send({ question: 'q', arxiv_ids: ['1'] })).status).toBe(401)
  expect((await request(app).get('/api/quantmind/memory')).status).toBe(401)
  expect((await request(app).delete('/api/quantmind/memory/1234.5678')).status).toBe(401)
})

test('the health check stays public (the page reads it before sign-in)', async () => {
  const r = await request(app).get('/api/agent/health')
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(true)
})
