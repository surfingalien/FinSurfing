'use strict'
/**
 * Unit tests for lib/canonical-json.js.
 *
 * This function's output is baked into hashes already written to disk (the
 * rec-journal tamper-evident chain and strategy-library ids), so these tests
 * are a CONTRACT: a change that breaks them invalidates existing chains and
 * strategy identities. Includes pinned literal outputs for exactly that reason.
 */

const { canonicalJson } = require('../lib/canonical-json')
const recJournal = require('../lib/rec-journal')
const { strategyId, strategyKey } = require('../lib/strategy-library')

describe('canonicalJson — determinism', () => {
  test('key order does not affect output', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  test('nested key order does not affect output', () => {
    const x = { outer: { z: 1, a: { n: 2, m: 3 } } }
    const y = { outer: { a: { m: 3, n: 2 }, z: 1 } }
    expect(canonicalJson(x)).toBe(canonicalJson(y))
  })

  test('array ORDER is preserved — order is meaningful in a list', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  test('distinct values never collide', () => {
    const seen = new Set()
    for (const v of [{ a: 1 }, { a: 2 }, { b: 1 }, [1], [1, 1], 'a', 1, null, true]) {
      const s = canonicalJson(v)
      expect(seen.has(s)).toBe(false)
      seen.add(s)
    }
  })
})

describe('canonicalJson — pinned output contract', () => {
  // These literals are load-bearing: existing on-disk hashes depend on them.
  test('primitives', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(1)).toBe('1')
    expect(canonicalJson('s')).toBe('"s"')
    expect(canonicalJson(true)).toBe('true')
  })

  test('objects sort keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  test('arrays and nesting', () => {
    expect(canonicalJson([1, { b: 2, a: 1 }])).toBe('[1,{"a":1,"b":2}]')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
  })
})

describe('consumers still behave correctly', () => {
  test('rec-journal re-exports the shared helper', () => {
    expect(recJournal.canonicalJson).toBe(canonicalJson)
  })

  test('rec-journal chain hashing is key-order independent', () => {
    const a = { id: 'x', at: 't', picks: [{ symbol: 'A', entryPrice: 1 }] }
    const b = { picks: [{ entryPrice: 1, symbol: 'A' }], at: 't', id: 'x' }
    expect(recJournal.chainHash('prev', a)).toBe(recJournal.chainHash('prev', b))
  })

  test('strategy ids distinguish distinct NESTED rule trees', () => {
    const mk = threshold => ({
      symbol: 'AAPL',
      strategy: 'composed_rule',
      params: { rule: { entry: { op: '<', left: { feature: 'rsi14' }, right: { const: threshold } } } },
    })
    // The regression this guards: interpolating a nested object yields
    // "[object Object]" for BOTH, collapsing them into one identity.
    expect(strategyId(mk(30))).not.toBe(strategyId(mk(40)))
    expect(strategyKey(mk(30))).toContain('rsi14')
    expect(strategyKey(mk(30))).not.toContain('[object Object]')
  })

  test('strategy ids are stable across key order and symbol case', () => {
    const rule = { entry: { op: '<', left: { feature: 'rsi14' }, right: { const: 30 } } }
    const a = { symbol: 'AAPL', strategy: 'composed_rule', params: { rule } }
    const b = { symbol: 'aapl', strategy: 'composed_rule', params: { rule: JSON.parse(JSON.stringify(rule)) } }
    expect(strategyId(a)).toBe(strategyId(b))
  })
})
