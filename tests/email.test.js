'use strict'

// lib/email.js: a weekday sends ~13 automated emails, so a transient Resend
// error (429 / 5xx / network) is retried under one idempotency key, a real
// rejection is thrown at once, and every message carries a plain-text part.

const email = require('../lib/email')

const res = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
})

let sleeps
beforeEach(() => {
  process.env.RESEND_API_KEY = 're_test'
  sleeps = []
  email._deps.sleep = async ms => { sleeps.push(ms) }
})
afterEach(() => { delete process.env.RESEND_API_KEY })

const msg = { to: 'me@finsurf.test', subject: 'S', html: '<p>Hello &amp; <a href="https://x.test/a">open</a></p>' }

test('sends html and a derived text part with an idempotency key', async () => {
  email._deps.fetch = jest.fn(async () => res(200, { id: 'e1' }))
  await expect(email.sendEmail(msg)).resolves.toBe(true)
  const [, opts] = email._deps.fetch.mock.calls[0]
  const body = JSON.parse(opts.body)
  expect(body.html).toBe(msg.html)
  expect(body.text).toBe('Hello & open (https://x.test/a)')
  expect(opts.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
})

test('429 and 5xx are retried with the same idempotency key, honouring Retry-After', async () => {
  email._deps.fetch = jest.fn()
    .mockResolvedValueOnce(res(429, { message: 'Too many requests' }, { 'retry-after': '2' }))
    .mockResolvedValueOnce(res(503, { message: 'unavailable' }))
    .mockResolvedValueOnce(res(200, { id: 'e1' }))
  await expect(email.sendEmail(msg)).resolves.toBe(true)
  const keys = email._deps.fetch.mock.calls.map(c => c[1].headers['Idempotency-Key'])
  expect(new Set(keys).size).toBe(1)
  expect(sleeps).toEqual([2000, 3000])
})

test('a network error is retried', async () => {
  email._deps.fetch = jest.fn()
    .mockRejectedValueOnce(new Error('socket hang up'))
    .mockResolvedValueOnce(res(200, {}))
  await expect(email.sendEmail(msg)).resolves.toBe(true)
  expect(email._deps.fetch).toHaveBeenCalledTimes(2)
})

test('a real rejection is thrown at once with the provider reason', async () => {
  email._deps.fetch = jest.fn(async () => res(403, { message: 'The finsurf.app domain is not verified' }))
  await expect(email.sendEmail(msg)).rejects.toThrow('The finsurf.app domain is not verified')
  expect(email._deps.fetch).toHaveBeenCalledTimes(1)
})

test('gives up after three attempts and says so', async () => {
  email._deps.fetch = jest.fn(async () => res(500, { message: 'internal' }))
  await expect(email.sendEmail(msg)).rejects.toThrow('internal (after 3 attempts)')
  expect(email._deps.fetch).toHaveBeenCalledTimes(3)
})

test('no provider configured: logged, reported as not delivered', async () => {
  delete process.env.RESEND_API_KEY
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  await expect(email.sendEmail(msg)).resolves.toBe(false)
  log.mockRestore()
})

describe('htmlToText', () => {
  test('drops head/style, one line per table row, decodes entities', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><h1>Brief</h1>'
      + '<table><tr><td>1</td><td>NVDA</td><td>$209.87</td></tr><tr><td>2</td><td>AMD &middot; 4&#37;</td></tr></table>'
      + '<p>Line<br>two</p><ul><li>a</li><li>b</li></ul></body></html>'
    expect(email.htmlToText(html)).toBe('Brief\n1 | NVDA | $209.87\n2 | AMD · 4%\n\nLine\ntwo\n- a\n- b')
  })
  test('a link whose text is its URL is not doubled', () => {
    expect(email.htmlToText('<a href="https://x.test">https://x.test</a>')).toBe('https://x.test')
  })
})
