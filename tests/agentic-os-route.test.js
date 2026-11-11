'use strict'
/**
 * GET /api/agentic-os/overview against the REAL modules (no stubs): the scheduler,
 * Agent Desk, Strategy Brain, AI audit and breakers over an empty data dir — what
 * production looks like right after a deploy. Pins that the endpoint answers, that
 * the page's contract (verdict / attention / agents / spend / connections / feed)
 * is all there, that one failing source degrades instead of 500-ing, and that no
 * key ever leaves the process.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
process.env.ANTHROPIC_API_KEY = 'sk-ant-TESTSECRET-DO-NOT-LEAK'
process.env.FMP_API_KEY = 'fmp-TESTSECRET-DO-NOT-LEAK'
delete process.env.GROQ_API_KEY

const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

const token = jwt.sign({ sub: 'u1', email: 'u1@t.dev', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })

function appWith() {
  const app = express()
  app.use('/api/agentic-os', require('../routes/agentic-os'))
  return app
}
const get = (app, p) => request(app).get(p).set('Authorization', `Bearer ${token}`)

describe('GET /api/agentic-os/overview', () => {
  test('answers 200 with the whole page contract', async () => {
    const r = await get(appWith(), '/api/agentic-os/overview')
    expect(r.status).toBe(200)
    expect(r.body).toEqual(expect.objectContaining({
      generatedAt: expect.any(String), verdict: expect.any(Object), kpis: expect.any(Object),
      attention: expect.any(Array), agents: expect.any(Array), jobs: expect.any(Array),
      connections: expect.objectContaining({ groups: expect.any(Array), breakers: expect.any(Array) }), feed: expect.any(Array),
    }))
    expect(['ok', 'waiting', 'attention', 'critical']).toContain(r.body.verdict.level)
    expect(r.body.agents.map(a => a.id)).toEqual(expect.arrayContaining(['ai-brain', 'agent-desk', 'strategy-brain', 'paper']))
  })

  test('with no registered scheduler jobs every agent reads as waiting or off, never healthy', async () => {
    const r = await get(appWith(), '/api/agentic-os/overview')
    for (const a of r.body.agents) expect(['waiting', 'off', 'paused']).toContain(a.state)
  })

  test('reports configuration as booleans only: no key text in the response', async () => {
    const r = await get(appWith(), '/api/agentic-os/overview')
    expect(JSON.stringify(r.body)).not.toMatch(/TESTSECRET/)
    const items = Object.fromEntries(r.body.connections.groups.flatMap(g => g.items).map(i => [i.id, i.state]))
    expect(items).toMatchObject({ claude: 'set', groq: 'missing', fmp: 'set' })
  })

  test('a source that throws is listed as unavailable, not a 500', async () => {
    jest.resetModules()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.doMock('../lib/strategy-brain', () => ({ status() { throw new Error('boom') } }))
    const app = appWith()
    const r = await get(app, '/api/agentic-os/overview')
    jest.dontMock('../lib/strategy-brain')
    warn.mockRestore()
    expect(r.status).toBe(200)
    expect(r.body.unavailable).toContain('Strategy Brain')
    expect(r.body.agents.find(a => a.id === 'strategy-brain').state).toBe('waiting')
  })

  test('the stale hand-written endpoints are gone', async () => {
    const app = appWith()
    expect((await get(app, '/api/agentic-os/skills')).status).toBe(404)
    expect((await get(app, '/api/agentic-os/mcps')).status).toBe(404)
  })

  test('data-flow reports configuration honestly: set / missing / keyless, never a hard-wired "connected"', async () => {
    const r = await get(appWith(), '/api/agentic-os/data-flow')
    expect(r.status).toBe(200)
    const st = Object.fromEntries(r.body.nodes.filter(n => n.tier === 0).map(n => [n.id, n.status]))
    expect(st).toMatchObject({ anthropic: 'set', fmp: 'set', groq: 'missing', finnhub: 'missing', stooq: 'keyless', sec: 'keyless', fred: 'keyless' })
    expect(Object.values(st).every(v => ['set', 'missing', 'keyless'].includes(v))).toBe(true)
    expect(r.body.nodes.find(n => n.id === 'reddit')).toBeUndefined()   // Reddit's API 403s from cloud servers
    expect(JSON.stringify(r.body)).not.toMatch(/TESTSECRET/)
    // every edge joins two real nodes
    const ids = new Set(r.body.nodes.map(n => n.id))
    expect(r.body.edges.filter(e => !ids.has(e.source) || !ids.has(e.target))).toEqual([])
  })

  test('still needs a sign-in', async () => {
    expect((await request(appWith()).get('/api/agentic-os/overview')).status).toBe(401)
  })
})
