'use strict'
const fs = require('fs')
const S = require('../lib/vol-forecast-study')
const L = require('../lib/quant/linalg')

function bars(seed, n = 700) {
  const g = L.rng(seed); let p = 100, h = 1e-4; const out = []
  for (let i = 0; i < n; i++) {
    const e = Math.sqrt(h) * g.normal(), o = p
    p *= Math.exp(e)
    out.push({ t: Date.UTC(2021, 0, 4) + i * 86_400_000, o, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, v: 1e6 })
    h = 2e-6 + (0.03 + (e < 0 ? 0.15 : 0)) * e * e + 0.86 * h
  }
  return out
}

// Synthetic per-symbol rows: model 'garch' beats current by `edge` per date with noise.
function rowsFor(nDates, edge, seed) {
  const g = L.rng(seed), out = {}
  for (const s of ['A', 'B', 'C']) {
    out[s] = Array.from({ length: nDates }, (_, i) => {
      const cur = 0.3 + 0.1 * Math.abs(g.normal())
      return { date: `2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, rv: 0.04, current: cur, models: { garch: cur - edge + 0.05 * g.normal(), ewma: cur + 0.05 * g.normal() } }
    })
  }
  return out
}

describe('volatility forecast study', () => {
  beforeEach(() => { try { fs.unlinkSync(S.FILE) } catch { /* none */ } S._resetCache() })

  test('QLIKE is zero for an exact forecast and penalises under-forecasting more', () => {
    expect(S.qlike(0.04, 0.04)).toBeCloseTo(0, 12)
    expect(S.qlike(0.04, 0.02)).toBeGreaterThan(S.qlike(0.04, 0.08))
  })

  test('symbolLosses: one row per non-overlapping 21-session origin, every model scored', async () => {
    const rows = await S.symbolLosses(bars(1), { yieldFn: async () => {} })
    expect(rows.length).toBe(Math.floor((700 - S.WINDOW - S.HORIZON - 1) / S.HORIZON) + 1)
    for (const r of rows) { expect(r.current).toBeGreaterThanOrEqual(0); expect(Object.keys(r.models).length).toBeGreaterThanOrEqual(5) }
  }, 60_000)

  test('evaluate adopts a model that wins on most dates, and only that one', () => {
    let found = 0
    for (let seed = 1; seed <= 30; seed++) {
      const v = S.evaluate(rowsFor(40, 0.05, seed), { models: ['garch', 'ewma'] })
      if (v.adopted === 'garch') found++
      expect(v.adopted).not.toBe('ewma')
    }
    expect(found).toBeGreaterThanOrEqual(27)
  })

  test('on pure noise it adopts something in at most ~5% of histories (family-wise, both models)', () => {
    let adopted = 0
    for (let seed = 1; seed <= 200; seed++) if (S.evaluate(rowsFor(40, 0, seed), { models: ['garch', 'ewma'] }).adopted) adopted++
    expect(adopted).toBeLessThanOrEqual(16)        // 5% of 200 = 10, with room for sampling noise
  })

  test('evaluate adopts nothing with too few dates, however large the win', () => {
    const v = S.evaluate(rowsFor(10, 0.2, 3), { models: ['garch', 'ewma'] })
    expect(v.adopted).toBe(null)
    expect(v.reason).toMatch(/only 10 dates/)
  })

  test('runStudy persists; adoptedModel and the snapshot read it; too few symbols keeps the stored copy', async () => {
    const universe = ['A', 'B']
    await expect(S.runStudy({ universe, fetchBars: async () => [], save: true })).rejects.toThrow(/stored study kept/)
    expect(S.adoptedModel()).toBe(null)
    // Write an adoption directly and check the snapshot switches method.
    fs.mkdirSync(require('path').dirname(S.FILE), { recursive: true })
    fs.writeFileSync(S.FILE, JSON.stringify({ at: new Date().toISOString(), adopted: 'gjr', adoptedLabel: 'GJR-GARCH(1,1)', reason: 'x', results: [] }))
    S._resetCache()
    expect(S.adoptedModel()).toBe('gjr')
    const qs = require('../lib/quant-snapshot')
    const snap = qs.symbolSnapshot(bars(4, 400))
    expect(snap.vol.forecastMethod).toBe('GJR-GARCH(1,1)')
    expect(snap.vol.medianForecast21).toBeGreaterThan(0)
    expect(qs.stampOf(snap).volMethod).toBe('GJR-GARCH(1,1)')
    fs.unlinkSync(S.FILE); S._resetCache()
    const plain = qs.symbolSnapshot(bars(4, 400))
    expect(plain.vol.forecastMethod).toBe(qs.MEDIAN_METHOD)
    expect(qs.stampOf(plain).volMethod).toBe('median')
  }, 30_000)
})
