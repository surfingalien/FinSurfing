'use strict'
const fs = require('fs'), os = require('os'), path = require('path')
const sh = require('../lib/persona-shadow')

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 5)
const screen = { stocks: ['A', 'B', 'C', 'D', 'E', 'F'].map((s, i) => ({ symbol: s, price: 10 + i })), etfs: [{ symbol: 'SPY', price: 500 }], crypto: [], funds: [] }

describe('drawing shadows', () => {
  it('as many as the AI picked per asset class, from the names it did not pick, reproducibly', () => {
    const rows = sh.rowsForRun({ runId: 'r1', persona: 'buffett', at: new Date(T0).toISOString(), picks: [{ symbol: 'A', type: 'Stock' }, { symbol: 'B', type: 'Stock' }], screen })
    const shadows = rows.filter(r => r.role === 'shadow')
    expect(shadows).toHaveLength(2)
    expect(shadows.every(r => !['A', 'B'].includes(r.symbol))).toBe(true)
    expect(shadows.every(r => r.price > 0)).toBe(true)
    expect(sh.rowsForRun({ runId: 'r1', persona: 'buffett', at: new Date(T0).toISOString(), picks: [{ symbol: 'A', type: 'Stock' }, { symbol: 'B', type: 'Stock' }], screen })).toEqual(rows)
  })
  it('no comparison when the AI took the whole list', () => {
    expect(sh.rowsForRun({ runId: 'r', persona: 'x', at: 'x', picks: [{ symbol: 'SPY', type: 'ETF' }], screen })).toEqual([])
  })
})

describe('resolving and comparing', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-')), 'persona-shadow.jsonl')
  it('resolves 30 days on, then compares one run per non-overlapping window', async () => {
    // 20 runs 10 days apart: picks gain 5%, shadows 1% → independent runs are every 3rd.
    for (let k = 0; k < 20; k++) {
      sh.logRun({ runId: `r${k}`, persona: 'buffett', at: new Date(T0 + k * 10 * DAY).toISOString(), picks: [{ symbol: 'A', type: 'Stock' }], screen }, tmp)
    }
    const rows = sh.readRows(tmp)
    const pickSyms = new Set(rows.filter(r => r.role === 'pick').map(r => r.symbol))
    const nearestClose = () => null
    expect((await sh.resolve({ fetchBars: async () => [], nearestClose, now: T0 + 5 * DAY }, tmp)).resolved).toBe(0)
    // Every name: price × 1.05 for picks, × 1.01 for shadows.
    const priceOf = Object.fromEntries(screen.stocks.map(s => [s.symbol, s.price]))
    const res = await sh.resolve({
      fetchBars: async s => s,
      nearestClose: s => priceOf[s] * (pickSyms.has(s) ? 1.05 : 1.01),
      now: T0 + 250 * DAY,
    }, tmp)
    expect(res.resolved).toBe(40)
    const c = sh.compare(sh.readRows(tmp))
    expect(c.byPersona.buffett.runs).toBe(20)
    expect(c.byPersona.buffett.independentRuns).toBe(7)
    expect(c.byPersona.buffett.meanDiff).toBeCloseTo(4, 1)
  })
  it('verdicts: beats / below / no difference / insufficient', () => {
    const mk = (n, diff, noise = 0) => {
      const rows = []
      for (let k = 0; k < n; k++) {
        const at = new Date(T0 + k * 31 * DAY).toISOString()
        const e = noise * (k % 2 ? 1 : -1)
        rows.push({ runId: `x${k}`, persona: 'p', at, role: 'pick', ret: diff + e }, { runId: `x${k}`, persona: 'p', at, role: 'shadow', ret: 0 })
      }
      return sh.compare(rows).byPersona.p
    }
    expect(mk(10, 2, 1).verdict).toBe('beats-random')
    expect(mk(10, -2, 1).verdict).toBe('below-random')
    expect(mk(10, 0.1, 3).verdict).toBe('no-difference')
    expect(mk(5, 2, 1).verdict).toBe('insufficient')
  })
  it('a run with an unresolved row waits', () => {
    const at = new Date(T0).toISOString()
    const c = sh.compare([{ runId: 'a', persona: 'p', at, role: 'pick', ret: 3 }, { runId: 'a', persona: 'p', at, role: 'shadow', ret: null }]).byPersona.p
    expect(c).toMatchObject({ resolvedRuns: 0, pending: 1 })
  })
})

describe('wiring', () => {
  it('is mirrored by durable-files and gitignored', () => {
    expect(require('../lib/durable-files').FILES?.map(f => f.name) ?? []).toContain('persona-shadow.jsonl')
    expect(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8')).toMatch(/data\/persona-shadow\.jsonl/)
  })
})
