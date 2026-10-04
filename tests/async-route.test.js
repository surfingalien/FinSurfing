'use strict'

const express = require('express')
const request = require('supertest')
const { guardAsync } = require('../lib/async-route')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(() => console.error.mockRestore())

test('a throwing async handler answers 500 with an error body instead of crashing the process', async () => {
  const app = express()
  app.get('/x', guardAsync('x', async () => { const v = undefined; return v.replace('a', 'b') }))
  const res = await request(app).get('/x')
  expect(res.status).toBe(500)
  expect(res.body.error).toMatch(/x failed unexpectedly: .*replace/)
})

test('on a heartbeated route that already flushed its 200, the error still arrives in the body', async () => {
  const app = express()
  app.get('/hb', guardAsync('hb', async (req, res) => {
    startJsonHeartbeat(res, { intervalMs: 5 })
    await new Promise(r => setTimeout(r, 30))   // let a heartbeat byte flush the headers
    throw new Error('boom')
  }))
  const res = await request(app).get('/hb')
  expect(res.status).toBe(200)
  expect(JSON.parse(res.text).error).toMatch(/boom/)
})

test('a handler that succeeds is untouched', async () => {
  const app = express()
  app.get('/ok', guardAsync('ok', async (req, res) => res.json({ ok: true })))
  expect((await request(app).get('/ok')).body).toEqual({ ok: true })
})
