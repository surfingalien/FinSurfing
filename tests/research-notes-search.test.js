'use strict'
/**
 * HTTP tests for Second Brain lexical search + related notes
 * (GET /api/research-notes/search, GET /api/research-notes/:id/related).
 * Runs against the in-memory store — no Postgres, no LLM calls.
 */

const request = require('supertest')
const { createApp } = require('./helpers/app')

let app, token
const password = 'StrongPass123!'

const mkNote = (body) =>
  request(app)
    .post('/api/research-notes')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

beforeAll(async () => {
  app = createApp()
  const email = `notes_${Date.now()}@example.com`
  const reg = await request(app).post('/api/auth/register').send({ email, password })
  await request(app).post('/api/auth/verify-email').send({ email, code: reg.body.demoCode })
  const login = await request(app).post('/api/auth/login').send({ email, password })
  token = login.body.accessToken
})

describe('GET /api/research-notes/search', () => {
  let nvdaThesisId

  beforeAll(async () => {
    const r1 = await mkNote({
      title: 'NVDA bull thesis',
      symbol: 'NVDA',
      note_type: 'thesis',
      content: 'AI capex supercycle: hyperscalers raising datacenter budgets through 2027.',
      tags: ['ai', 'semis'],
    })
    nvdaThesisId = r1.body.id
    await mkNote({
      title: 'NVDA margin risk',
      symbol: 'NVDA',
      note_type: 'note',
      content: 'Competition from custom silicon could compress margins.',
    })
    await mkNote({
      title: 'Grocery REIT screening',
      symbol: 'O',
      note_type: 'note',
      content: 'Triple-net lease stability, dividend aristocrat list.',
    })
  })

  test('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/research-notes/search?q=capex')
    expect(res.status).toBe(401)
  })

  test('requires a query string', async () => {
    const res = await request(app)
      .get('/api/research-notes/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/q is required/i)
  })

  test('finds notes by content terms and ranks them', async () => {
    const res = await request(app)
      .get('/api/research-notes/search?q=capex datacenter')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.results.length).toBeGreaterThanOrEqual(1)
    expect(res.body.results[0].title).toBe('NVDA bull thesis')
    expect(res.body.results[0].rank).toBeGreaterThan(0)
  })

  test('symbol queries match all notes on that ticker', async () => {
    const res = await request(app)
      .get('/api/research-notes/search?q=NVDA')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const titles = res.body.results.map(n => n.title)
    expect(titles).toContain('NVDA bull thesis')
    expect(titles).toContain('NVDA margin risk')
    expect(titles).not.toContain('Grocery REIT screening')
  })

  test('irrelevant queries return empty results, not errors', async () => {
    const res = await request(app)
      .get('/api/research-notes/search?q=zzzunmatchable')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([])
  })

  test('related notes surface same-symbol siblings, excluding the note itself', async () => {
    const res = await request(app)
      .get(`/api/research-notes/${nvdaThesisId}/related`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const titles = res.body.related.map(n => n.title)
    expect(titles).toContain('NVDA margin risk')
    expect(titles).not.toContain('NVDA bull thesis') // self excluded
  })

  test('related on unknown note id returns 404', async () => {
    const res = await request(app)
      .get('/api/research-notes/00000000-0000-0000-0000-000000000000/related')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  test('search is scoped per user', async () => {
    // Second user sees none of the first user's notes
    const email = `notes2_${Date.now()}@example.com`
    const reg = await request(app).post('/api/auth/register').send({ email, password })
    await request(app).post('/api/auth/verify-email').send({ email, code: reg.body.demoCode })
    const login = await request(app).post('/api/auth/login').send({ email, password })
    const res = await request(app)
      .get('/api/research-notes/search?q=NVDA')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([])
  })
})
