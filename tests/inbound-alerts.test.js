'use strict'
/** lib/inbound-alerts.js and routes/inbound-alerts.js — alerts sent in by the user's own TradingView. */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
const fs = require('fs')
const os = require('os')
const path = require('path')
const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')
const IA = require('../lib/inbound-alerts')

describe('parseAlert', () => {
  test('JSON with TradingView placeholders filled in', () => {
    expect(IA.parseAlert({ ticker: 'NASDAQ:AAPL', price: '231.4', message: 'broke out', action: 'buy' }))
      .toEqual({ symbol: 'AAPL', message: 'broke out', price: 231.4, action: 'buy' })
    expect(IA.parseAlert('{"symbol":"btcusd","close":68000}')).toEqual({ symbol: 'BTCUSD', message: '', price: 68000, action: null })
  })
  test('plain text: a leading ticker is read only when written like one', () => {
    expect(IA.parseAlert('AAPL broke above the 200-day').symbol).toBe('AAPL')
    expect(IA.parseAlert('NYSE:JPM, crossing 250').symbol).toBe('JPM')
    expect(IA.parseAlert('price crossed the average')).toEqual({ symbol: null, message: 'price crossed the average', price: null, action: null })
  })
  test('nothing usable is an error, never an empty row', () => {
    expect(IA.parseAlert('').error).toBeDefined()
    expect(IA.parseAlert({}).error).toMatch(/neither/)
    expect(IA.parseAlert([1, 2]).error).toBeDefined()
  })
  test('the message is capped and stripped of control characters; a bad price is null, not zero', () => {
    const p = IA.parseAlert({ ticker: 'X', message: `a\u0000b\n${'z'.repeat(1000)}`, price: -3 })
    expect(p.message.length).toBe(IA.MAX_MESSAGE)
    expect(p.message.startsWith('a b z')).toBe(true)
    expect(p.price).toBeNull()
  })
  test('a symbol that is not a ticker is dropped, never stored as typed', () => {
    expect(IA.normSymbol('<script>')).toBe('SCRIPT')
    expect(IA.normSymbol('../../etc/passwd')).toBeNull()
    expect(IA.normSymbol(42)).toBeNull()
  })
})

describe('store', () => {
  let file
  beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ia-')), 'inbound.json') })

  test('the key is returned once and only its hash is stored; rotating kills the old one', () => {
    const { key } = IA.rotateKey('u1', { file })
    expect(fs.readFileSync(file, 'utf8')).not.toContain(key)
    expect(IA.userForKey(key, { file })).toBe('u1')
    const second = IA.rotateKey('u1', { file })
    expect(IA.userForKey(key, { file })).toBeNull()
    expect(IA.userForKey(second.key, { file })).toBe('u1')
    expect(IA.revokeKey('u1', { file })).toBe(true)
    expect(IA.userForKey(second.key, { file })).toBeNull()
    for (const bad of ['', 'short', null, 'x'.repeat(500)]) expect(IA.userForKey(bad, { file })).toBeNull()
  })

  test('alerts are per user, newest first, capped, and deletable only by their owner', () => {
    for (let i = 0; i < IA.MAX_PER_USER + 5; i++) IA.record('u1', { symbol: 'AAPL', message: `m${i}` }, { file, now: 1e12 + i * 1000 })
    const other = IA.record('u2', { symbol: 'MSFT', message: 'theirs' }, { file })
    const mine = IA.list('u1', { file, limit: 1000 })
    expect(mine).toHaveLength(IA.MAX_PER_USER)
    expect(mine[0].message).toBe(`m${IA.MAX_PER_USER + 4}`)
    expect(mine[0].userId).toBeUndefined()
    expect(IA.list('u2', { file })).toHaveLength(1)          // the cap on u1 never touched u2
    expect(IA.remove('u1', other.id, { file })).toBe(false)
    expect(IA.remove('u2', other.id, { file })).toBe(true)
    expect(IA.keyStatus('u1', { file })).toEqual(expect.objectContaining({ exists: false, received: IA.MAX_PER_USER }))
  })

  test('recentBySymbol: only the last days, the newest message, alerts with no symbol left out', () => {
    const now = Date.UTC(2026, 10, 17)
    const at = d => new Date(now - d * 86400000).toISOString()
    const r = IA.recentBySymbol([
      { symbol: 'AAPL', at: at(1), message: 'older' }, { symbol: 'AAPL', at: at(0.5), message: 'newer' },
      { symbol: 'MSFT', at: at(10), message: 'stale' }, { symbol: null, at: at(0.1), message: 'no ticker' },
    ], { now })
    expect(r).toEqual({ AAPL: { count: 2, lastAt: at(0.5), message: 'newer' } })
  })
})

describe('routes', () => {
  const routes = require('../routes/inbound-alerts')
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '256kb' }))
  app.use('/api/hooks/tradingview', routes.hook)
  app.use('/api/inbound-alerts', routes.manage)
  const tokenFor = sub => jwt.sign({ sub, email: `${sub}@t.dev`, role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
  const as = (sub, method, url) => request(app)[method](url).set('Authorization', `Bearer ${tokenFor(sub)}`)

  test('management needs a sign-in; the hook needs a real key', async () => {
    expect((await request(app).get('/api/inbound-alerts')).status).toBe(401)
    expect((await request(app).post('/api/inbound-alerts/key')).status).toBe(401)
    const r = await request(app).post('/api/hooks/tradingview/not-a-real-key-not-a-real-key-xx').send({ ticker: 'AAPL' })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Not found' })
  })

  test('create an address, receive JSON and plain text, list them, rotate, delete', async () => {
    const made = await as('alice', 'post', '/api/inbound-alerts/key')
    expect(made.body.url).toMatch(/\/api\/hooks\/tradingview\/[\w-]{40,}$/)
    const hookPath = new URL(made.body.url).pathname

    const a = await request(app).post(hookPath).send({ ticker: 'NASDAQ:NVDA', price: 190.5, message: 'RSI under 30' })
    expect(a.body).toEqual(expect.objectContaining({ ok: true, symbol: 'NVDA' }))
    const b = await request(app).post(hookPath).set('Content-Type', 'text/plain').send('AAPL crossing 350')
    expect(b.body.symbol).toBe('AAPL')
    expect((await request(app).post(hookPath).set('Content-Type', 'text/plain').send('')).status).toBe(400)
    expect((await request(app).post(hookPath).set('Content-Type', 'text/plain').send('x'.repeat(IA.MAX_BODY + 50))).status).toBe(413)

    const mine = await as('alice', 'get', '/api/inbound-alerts')
    expect(mine.body.status).toEqual(expect.objectContaining({ exists: true, received: 2 }))
    expect(mine.body.alerts.map(x => x.symbol)).toEqual(['AAPL', 'NVDA'])
    expect(JSON.stringify(mine.body)).not.toContain(hookPath.split('/').pop())     // the key is never read back
    expect((await as('bob', 'get', '/api/inbound-alerts')).body.alerts).toEqual([])  // another user sees nothing

    expect((await as('bob', 'delete', `/api/inbound-alerts/${mine.body.alerts[0].id}`)).status).toBe(404)
    expect((await as('alice', 'delete', `/api/inbound-alerts/${mine.body.alerts[0].id}`)).status).toBe(200)
    expect((await as('alice', 'delete', '/api/inbound-alerts/zzz')).status).toBe(400)

    await as('alice', 'post', '/api/inbound-alerts/key')                             // rotate
    expect((await request(app).post(hookPath).send({ ticker: 'NVDA' })).status).toBe(404)
    expect((await as('alice', 'delete', '/api/inbound-alerts/key')).body.ok).toBe(true)
  })
})
