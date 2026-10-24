'use strict'

const dsl = require('../lib/factor-dsl')
const fm = require('../lib/factor-mining')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const gauss = r => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
function universe({ n = 30, days = 1260, seed = 11, drift = () => 0 }) {
  const r = rng(seed), t0 = Date.UTC(2021, 0, 4), out = {}
  for (let k = 0; k < n; k++) {
    let c = 50 + k
    out[`S${k}`] = Array.from({ length: days }, (_, i) => { c *= 1 + drift(k) + 0.015 * gauss(r); return { t: t0 + i * 86400000, c, h: c * 1.01, l: c * 0.99, v: 1e6 } })
  }
  return out
}

const ratio = { op: 'div', left: { feature: 'close' }, right: { feature: 'sma200' } }

test('the allow-list gate: unknown names, oversized trees and look-ahead windows are refused', () => {
  expect(dsl.parseExpr(ratio).ok).toBe(true)
  expect(dsl.parseExpr(JSON.stringify(ratio)).ok).toBe(true)
  expect(dsl.parseExpr({ feature: 'secret_sauce' }).reason).toMatch(/unknown feature/)
  expect(dsl.parseExpr({ op: 'exec', operand: { feature: 'close' } }).reason).toMatch(/unknown op/)
  expect(dsl.parseExpr({ op: 'lag', operand: { feature: 'close' }, n: -5 }).reason).toMatch(/integer n from 1 to 252/)
  expect(dsl.parseExpr({ const: 3 }).reason).toMatch(/uses no feature/)
  let deep = { feature: 'close' }
  for (let i = 0; i < 13; i++) deep = { op: 'neg', operand: deep }
  expect(dsl.parseExpr(deep).ok).toBe(false)
  expect(dsl.parseExpr('{not json').reason).toMatch(/not valid JSON/)
})

test('every operation is causal: changing future bars never changes a past value', () => {
  const expr = { op: 'div', left: { op: 'std', operand: { feature: 'roc5' }, n: 20 }, right: { op: 'lag', operand: { feature: 'atrPct' }, n: 3 } }
  const bars = universe({ n: 1, days: 400 }).S0
  const ctx = b => require('../lib/strategy-dsl').featureContext({ closes: b.map(x => x.c), opens: b.map(x => x.c), highs: b.map(x => x.h), lows: b.map(x => x.l), volumes: b.map(x => x.v) })
  const full = dsl.evalExpr(expr, ctx(bars))
  const altered = bars.map((b, i) => (i > 300 ? { ...b, c: b.c * 2, h: b.h * 2, l: b.l * 2 } : b))
  const cut = dsl.evalExpr(expr, ctx(altered))
  for (let i = 0; i <= 300; i++) expect(Number.isNaN(cut[i]) ? NaN : cut[i]).toEqual(Number.isNaN(full[i]) ? NaN : full[i])
  expect(dsl.describeExpr(expr)).toBe('(std(roc5, 20) ÷ lag(atrPct, 3))')
})

test('a proposal that ranks stocks like an existing factor is rejected as a duplicate; a new one is tested', async () => {
  const u = universe({})
  const propose = async () => [
    { name: 'llm_trend_ratio', hypothesis: 'trend', expression: ratio, status: 'ok' },
    { name: 'llm_month_return', hypothesis: 'same as reversal', expression: { op: 'neg', operand: { feature: 'roc20' } }, status: 'ok' },
    { name: 'llm_bad', hypothesis: 'x', expression: null, status: 'invalid', reason: 'unknown feature' },
  ]
  const out = await fm.proposedFactors({ propose, previous: null, panel: fm.toPanel(u), base: fm.FACTORS })
  const by = Object.fromEntries(out.proposals.map(p => [p.name, p]))
  expect(by.llm_month_return).toMatchObject({ status: 'duplicate' })
  expect(by.llm_month_return.reason).toMatch(/ranks stocks like rev_1m/)
  expect(by.llm_bad.status).toBe('invalid')
  // trend_200 is also close ÷ a 200-day average, so this one is a duplicate too
  expect(by.llm_trend_ratio.status).toBe('duplicate')
})

test('accepted proposals are mined as ordinary candidates and counted as trials', async () => {
  const u = universe({ n: 25 })
  const expr = { op: 'div', left: { op: 'std', operand: { feature: 'roc5' }, n: 60 }, right: { op: 'mean', operand: { feature: 'atrPct' }, n: 10 } }
  const lib = await fm.runMining({
    fetchBars: async s => u[s], universe: Object.keys(u), minUniverse: 10, save: false,
    propose: async () => [{ name: 'llm_vol_of_momentum', hypothesis: 'h', expression: expr, status: 'ok' }],
  })
  const row = lib.factors.find(f => f.name === 'llm_vol_of_momentum')
  expect(row).toMatchObject({ source: 'llm', hypothesis: 'h', expression: expr })
  expect(lib.tested).toBe(Object.keys(fm.FACTORS).length + 1)
  for (const f of lib.factors.filter(x => x.deflated)) expect(f.deflated.nTrials).toBe(2 * lib.tested)
  expect(fm.factorsOf(lib).llm_vol_of_momentum).toBeDefined()
})
