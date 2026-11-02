'use strict'

const sv = require('../lib/strategy-versions')
const { rng } = require('../lib/quant/linalg')

// Daily bars. `planted`: every 50 days a 10-day spell of a sharp rally then a
// sharper reversal — a trend follower buys the rally and eats the reversal,
// so skipping entries when the move is stretched is a real fix. Otherwise a
// random walk with a small drift, where no fix is real.
function series(seed, planted) {
  const r = rng(seed); let p = 100; const bars = []
  for (let i = 0; i < 1260; i++) {
    const k = i % 50
    let ret = 0.0006 + 0.01 * r.normal(), hl = 0.01
    if (planted && k >= 40) { ret = (k < 44 ? 0.02 : -0.03) + 0.005 * r.normal(); hl = 0.04 }
    p *= Math.exp(ret)
    bars.push({ t: Date.UTC(2021, 0, 1) / 1000 + i * 86400, o: p, h: p * (1 + hl / 2), l: p * (1 - hl / 2), c: p, v: 1e6 })
  }
  return { timestamps: bars.map(b => b.t), opens: bars.map(b => b.o), highs: bars.map(b => b.h), lows: bars.map(b => b.l), closes: bars.map(b => b.c), volumes: bars.map(b => b.v) }
}
const PARENT = { id: 'p1', symbol: 'TEST', strategy: 'sma_crossover', params: { fastPeriod: 3, slowPeriod: 10 }, name: 'sma_crossover on TEST' }

test('a fix that is not real is never kept: 0 of 20 random walks', () => {
  const kept = Array.from({ length: 20 }, (_, s) => sv.improve(PARENT, series(s + 1, false))).filter(o => o.status === 'promoted')
  expect(kept).toHaveLength(0)
})

test('a planted flaw is diagnosed and fixed in some histories, with every check recorded', () => {
  const runs = Array.from({ length: 20 }, (_, s) => sv.improve(PARENT, series(s + 1, true)))
  const kept = runs.filter(o => o.status === 'promoted')
  expect(kept.length).toBeGreaterThanOrEqual(3)
  const o = kept[0]
  expect(o.version).toBe('v1.1')
  expect(o.checks.map(c => c.check)).toEqual(['validation', 'final test', 'regimes', 'still trades'])
  expect(o.checks.every(c => c.pass)).toBe(true)
  expect(o.windows.dev.bars + o.windows.val.bars + o.windows.test.bars).toBe(1260)
  expect(o.candidate.val.totalReturn).toBeGreaterThan(o.parent.val.totalReturn)
  expect(o.candidate.test.totalReturn).toBeGreaterThan(o.parent.test.totalReturn)
})

test('the diagnosis tags trades by the state at entry and reads thresholds from the development window only', () => {
  const s = series(4, true)
  const W = sv.windows(s.closes.length)
  const d = sv.diagnose(s, sv.signalsFor(PARENT, s), W.dev, 10)
  expect(d.trades).toBeGreaterThan(10)
  for (const f of d.findings) {
    expect(f.avgPnlPct).toBeLessThan(0)
    expect(f.avgPnlPct).toBeLessThan(f.othersAvgPnlPct)
    expect(f.trades).toBeGreaterThanOrEqual(4)
  }
  // Appending the validation/test windows must not change a development-window threshold.
  const cut = { ...s, ...Object.fromEntries(['timestamps', 'opens', 'highs', 'lows', 'closes', 'volumes'].map(k => [k, s[k].slice(0, W.dev[1])])) }
  const atr = defs => defs.find(x => x.key === 'high-volatility').filter.right.const
  const dsl = require('../lib/strategy-dsl')
  expect(atr(sv.stateDefinitions(dsl.featureContext(s), W.dev))).toBe(atr(sv.stateDefinitions(dsl.featureContext(cut), W.dev)))
})

test('a filter only removes entries; exits are never touched', () => {
  const base = [0, 1, 0, -1, 1, 0, -1]
  expect(sv.filteredSignals(base, [true, false, true, false, true, true, false])).toEqual([0, 0, 0, -1, 1, 0, -1])
})

test("model proposals pass the DSL allow-list or are dropped with a reason; at most two", () => {
  const out = sv.parseFilterProposals([
    { feature: 'atrPct', op: '<', value: 2.5, hypothesis: 'skip violent days' },
    { feature: 'process.exit', op: '<', value: 1 },
    { feature: 'rsi14', op: '==', value: 50 },
  ])
  expect(out.ok).toHaveLength(1)
  expect(out.ok[0]).toMatchObject({ filter: { op: '<', left: { feature: 'atrPct' }, right: { const: 2.5 } }, source: 'model' })
  expect(out.rejected).toHaveLength(1)                     // the third is past the cap of two
  expect(out.rejected[0].reason).toMatch(/not offered/)
})

test('more candidates need more proof; versions count up; a promoted version becomes a library entry with lineage', () => {
  expect(sv.tThreshold(1)).toBeCloseTo(1.2816, 3)
  expect(sv.tThreshold(5)).toBeGreaterThan(sv.tThreshold(1))
  expect(sv.bumpVersion('v1.0')).toBe('v1.1')
  expect(sv.bumpVersion('v1.9')).toBe('v2.0')
  const e = sv.versionEntry({ ...PARENT, id: 'abc' }, { version: 'v1.1', parentVersion: 'v1.0', change: 'skip entries when ATR% > 2', hypothesis: 'h', filter: { op: '<=', left: { feature: 'atrPct' }, right: { const: 2 } } }, { at: '2026-11-02T00:00:00Z' })
  expect(e).toMatchObject({ params: { fastPeriod: 3, slowPeriod: 10, filter: { op: '<=' } }, name: 'sma_crossover on TEST v1.1', lineage: { parentId: 'abc', rootId: 'abc', version: 'v1.1' } })
  // signalsFor honours the filter, and refuses one off the allow-list
  const s = series(2, false)
  expect(sv.signalsFor(e, s).filter(x => x === 1).length).toBeLessThanOrEqual(sv.signalsFor(PARENT, s).filter(x => x === 1).length)
  expect(() => sv.signalsFor({ ...e, params: { ...e.params, filter: { op: '<', left: { feature: 'eval' }, right: { const: 1 } } } }, s)).toThrow()
})
