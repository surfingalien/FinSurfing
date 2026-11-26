'use strict'
const cc = require('../lib/chart-coverage')

const answer = (n, { nullCloses = false } = {}) => ({ chart: { result: [{
  meta: { symbol: 'AAPL' },
  timestamp: Array.from({ length: n }, (_, i) => 1.7e9 + i * 86400),
  indicators: { quote: [{ close: Array.from({ length: n }, (_, i) => (nullCloses ? null : 100 + i)) }] },
}] } })

describe('chart coverage', () => {
  it('counts only bars with a real close', () => {
    expect(cc.coverage(answer(130), '6mo')).toMatchObject({ valid: 130, expected: 126, full: true })
    expect(cc.coverage(answer(130, { nullCloses: true }), '6mo')).toMatchObject({ valid: 0, full: false })
    expect(cc.coverage({ chart: { result: [{ timestamp: [] }] } }, '1y').full).toBe(false)
  })
  it('a few days for a five-year request is not a full answer; intraday needs only two bars', () => {
    expect(cc.coverage(answer(20), '5y').full).toBe(false)
    expect(cc.coverage(answer(700), '5y').full).toBe(true)
    expect(cc.coverage(answer(5), '1d', '5m').full).toBe(true)
  })
  it('the cascade skips unusable answers and keeps the longest short one as a last resort', () => {
    const c = cc.cascade('2y', '1d')
    expect(c.accept(answer(300, { nullCloses: true }), 'AISA')).toBe(false)
    expect(c.accept(answer(40), 'Finnhub')).toBe(false)
    expect(c.accept(null, 'FMP')).toBe(false)
    expect(c.best.provider).toBe('Finnhub')
    expect(c.rejected).toEqual(['AISA: 0 usable bars of ~504', 'Finnhub: 40 usable bars of ~504'])
    expect(c.accept(answer(500), 'Nasdaq')).toBe(true)
  })
})

describe('GET /api/chart uses it at every provider', () => {
  it('every provider step in the route goes through the coverage check', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8')
    const route = src.slice(src.indexOf("app.get('/api/chart'"), src.indexOf('// Name the providers that could not even be asked'))
    expect(route).not.toMatch(/if \((\w+)\) return res\.json\(saveChart/)
    expect((route.match(/cov\.accept\(/g) || []).length).toBeGreaterThanOrEqual(10)
  })
})
