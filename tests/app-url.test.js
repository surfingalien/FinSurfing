'use strict'

const { appUrl, resetLink } = require('../lib/app-url')

test('a trailing slash on APP_URL never doubles into "//reset-password"', () => {
  const env = { APP_URL: 'https://finsurfing-production.up.railway.app/' }
  expect(resetLink('abc123', env)).toBe('https://finsurfing-production.up.railway.app/reset-password?token=abc123')
  expect(appUrl({ APP_URL: 'https://x.app///' })).toBe('https://x.app')
  expect(appUrl({ APP_URL: '  https://x.app  ' })).toBe('https://x.app')
})

test('unset or blank APP_URL falls back to the local dev address', () => {
  expect(appUrl({})).toBe('http://localhost:5173')
  expect(appUrl({ APP_URL: '   ' })).toBe('http://localhost:5173')
})
