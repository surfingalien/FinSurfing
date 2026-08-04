'use strict'
/**
 * Unit tests for lib/http-heartbeat.js — the keep-alive that stops long AI
 * scans from surfacing as a bare "Load failed" on mobile.
 *
 * Run against a REAL http server and a REAL fetch, because the whole point is
 * byte-level behaviour on the wire (does whitespace actually reach the client,
 * does JSON.parse still accept it, what happens to the status code once headers
 * are flushed). A mocked res would prove none of that.
 */

const http = require('http')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')

const INTERVAL = 60 // fast heartbeat so tests stay quick

// Minimal express-like res.json/res.status so the patching logic is exercised
// the same way Express would exercise it.
function shim(res) {
  res.json = (payload) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(payload))
    return res
  }
  res.status = (c) => { res.statusCode = c; return res }
  return res
}

function serve(handler) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => handler(shim(res)))
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}
const url = srv => `http://127.0.0.1:${srv.address().port}/`
const wait = ms => new Promise(r => setTimeout(r, ms))

describe('startJsonHeartbeat', () => {
  let srv
  afterEach(() => { if (srv) { srv.close(); srv = null } })

  test('a slow response emits heartbeat bytes that JSON.parse still accepts', async () => {
    srv = await serve(async (res) => {
      startJsonHeartbeat(res, { intervalMs: INTERVAL })
      await wait(INTERVAL * 4.5)
      res.json({ rankedStocks: [{ symbol: 'NVDA' }] })
    })
    const r   = await fetch(url(srv))
    const raw = await r.text()

    expect(raw.startsWith(' ')).toBe(true)                    // bytes did flow
    expect(raw.length - raw.trimStart().length).toBeGreaterThanOrEqual(3)
    expect(JSON.parse(raw).rankedStocks[0].symbol).toBe('NVDA')
    expect(r.status).toBe(200)
  })

  test("the client's res.json() parses a heartbeated payload unchanged", async () => {
    srv = await serve(async (res) => {
      startJsonHeartbeat(res, { intervalMs: INTERVAL })
      await wait(INTERVAL * 3.5)
      res.json({ ok: true, nested: { a: [1, 2] } })
    })
    await expect((await fetch(url(srv))).json()).resolves.toEqual({ ok: true, nested: { a: [1, 2] } })
  })

  test('a failure BEFORE the first heartbeat keeps its real status code', async () => {
    srv = await serve((res) => {
      startJsonHeartbeat(res, { intervalMs: INTERVAL })
      res.status(503).json({ error: 'kill switch active' })
    })
    const r = await fetch(url(srv))
    expect(r.status).toBe(503)
    expect((await r.json()).error).toBe('kill switch active')
  })

  test('a failure AFTER a heartbeat is pinned to 200 but keeps `error` in the body', async () => {
    // This is the documented trade-off: once headers are flushed the status
    // can no longer change, which is exactly why callers must also check the body.
    srv = await serve(async (res) => {
      startJsonHeartbeat(res, { intervalMs: INTERVAL })
      await wait(INTERVAL * 3.5)
      res.status(500).json({ error: 'AI Brain analysis failed: upstream timeout' })
    })
    const r    = await fetch(url(srv))
    const body = await r.json()

    expect(r.status).toBe(200)
    expect(body.error).toMatch(/AI Brain analysis failed/)
    // The rule the client implements: (!res.ok || data.error)
    expect(!r.ok || Boolean(body.error)).toBe(true)
  })

  test('a fast response is not padded at all', async () => {
    srv = await serve((res) => {
      startJsonHeartbeat(res, { intervalMs: INTERVAL })
      res.json({ quick: true })
    })
    const raw = await (await fetch(url(srv))).text()
    expect(raw.startsWith('{')).toBe(true)
  })

  test('double-arming is a no-op (no duplicate timers or double patching)', async () => {
    srv = await serve(async (res) => {
      startJsonHeartbeat(res, { intervalMs: INTERVAL })
      startJsonHeartbeat(res, { intervalMs: INTERVAL })
      await wait(INTERVAL * 2.5)
      res.json({ ok: true })
    })
    await expect((await fetch(url(srv))).json()).resolves.toEqual({ ok: true })
  })

  test('tolerates a non-writable target instead of throwing', () => {
    expect(() => startJsonHeartbeat(null)).not.toThrow()
    expect(typeof startJsonHeartbeat({})).toBe('function')
  })
})
