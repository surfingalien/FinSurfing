'use strict'
/** Admin "Run now" for the Advisory persona study (routes/advisory-engine.js). */
const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

let release
const mockRun = jest.fn(() => new Promise(res => { release = res }))
jest.mock('../lib/persona-rule-study', () => ({ run: (...a) => mockRun(...a), readStudy: () => null }))
jest.mock('../lib/internal-api', () => ({ fetchDailyBars: async () => [] }))

process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'
const tok = role => jwt.sign({ sub: `u-${role}`, email: `${role}@t.dev`, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })

let app
beforeAll(() => { app = express(); app.use(express.json()); app.use('/api/advisory-engine', require('../routes/advisory-engine')) })

it('only an admin can start it; a second start while running is refused; status is visible', async () => {
  const post = role => request(app).post('/api/advisory-engine/persona-study/run').set('Authorization', `Bearer ${tok(role)}`)
  expect((await post('user')).status).toBe(403)
  expect(mockRun).not.toHaveBeenCalled()

  const first = await post('admin')
  expect(first.status).toBe(202)
  expect(first.body.run.running).toBe(true)
  expect((await post('admin')).status).toBe(409)
  expect(mockRun).toHaveBeenCalledTimes(1)

  let got = await request(app).get('/api/advisory-engine/persona-study').set('Authorization', `Bearer ${tok('user')}`)
  expect(got.body).toMatchObject({ pending: true, run: { running: true } })

  release({})
  await new Promise(r => setImmediate(r))
  got = await request(app).get('/api/advisory-engine/persona-study').set('Authorization', `Bearer ${tok('user')}`)
  expect(got.body.run).toMatchObject({ running: false, error: null })
  expect(got.body.run.finishedAt).toBeTruthy()
})
