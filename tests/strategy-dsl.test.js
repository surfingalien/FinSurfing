'use strict'
/**
 * Unit tests for lib/strategy-dsl.js — the widened search space.
 *
 * The validator is a security boundary (it is what stands between an LLM
 * proposal and the interpreter), so it is tested as an allow-list: unknown
 * features/operators, wrong types, wrong arity and oversized trees must all
 * be REJECTED, not coerced.
 */

const {
  FEATURES, FEATURE_NAMES, MAX_NODES, MAX_DEPTH,
  validateRule, generateRuleSignals, describeRule,
  buildCompositionPrompt, parseCompositions, featureCatalogBlock,
} = require('../lib/strategy-dsl')

// Deterministic synthetic bars: a slow rise, a dip, then a recovery.
function makeBars(n = 260) {
  const closes = Array.from({ length: n }, (_, i) => {
    const base = 100 + i * 0.2
    const dip  = i > 120 && i < 160 ? -18 : 0
    return +(base + dip + Math.sin(i / 7) * 2).toFixed(4)
  })
  return {
    opens:   closes.map(c => c * 0.998),
    highs:   closes.map(c => c * 1.01),
    lows:    closes.map(c => c * 0.99),
    closes,
    volumes: closes.map((_, i) => 1_000_000 + (i % 11) * 50_000),
    timestamps: Array.from({ length: n }, (_, i) => Math.floor(Date.UTC(2024, 0, 1) / 1000) + i * 86400),
  }
}

const simpleRule = {
  entry: { op: '<', left: { feature: 'rsi14' }, right: { const: 35 } },
  exit:  { op: '>', left: { feature: 'rsi14' }, right: { const: 65 } },
}

describe('validateRule — accepts well-formed rules', () => {
  test('a simple threshold rule', () => {
    expect(validateRule(simpleRule).ok).toBe(true)
  })

  test('a composed multi-condition rule', () => {
    const rule = {
      entry: {
        op: 'and',
        left:  { op: '<', left: { feature: 'rsi14' }, right: { const: 35 } },
        right: { op: '>', left: { feature: 'close' }, right: { feature: 'ema200' } },
      },
      exit: { op: 'cross_below', left: { feature: 'close' }, right: { feature: 'ema21' } },
    }
    expect(validateRule(rule).ok).toBe(true)
  })

  test('not / or nesting', () => {
    const rule = {
      entry: { op: 'not', operand: { op: '>', left: { feature: 'bbPctB' }, right: { const: 80 } } },
      exit:  { op: 'or',
               left:  { op: '>', left: { feature: 'rsi14' }, right: { const: 70 } },
               right: { op: '<', left: { feature: 'close' }, right: { feature: 'sma20' } } },
    }
    expect(validateRule(rule).ok).toBe(true)
  })

  test('every advertised feature name actually validates and computes', () => {
    const bars = makeBars()
    for (const name of FEATURE_NAMES) {
      const rule = {
        entry: { op: '>', left: { feature: name }, right: { const: -1e9 } },
        exit:  { op: '<', left: { feature: name }, right: { const: -1e9 } },
      }
      expect(validateRule(rule).ok).toBe(true)
      const series = FEATURES[name].fn(bars)
      expect(Array.isArray(series)).toBe(true)
      expect(series).toHaveLength(bars.closes.length)
    }
  })
})

describe('validateRule — rejects malformed rules (allow-list boundary)', () => {
  const bad = (rule, pattern) => {
    const r = validateRule(rule)
    expect(r.ok).toBe(false)
    if (pattern) expect(r.error).toMatch(pattern)
  }

  test('unknown feature is rejected', () => {
    bad({ entry: { op: '<', left: { feature: 'definitely_not_a_feature' }, right: { const: 1 } }, exit: simpleRule.exit }, /unknown feature/i)
  })

  test('unknown operator is rejected', () => {
    bad({ entry: { op: 'exec', left: { const: 1 }, right: { const: 2 } }, exit: simpleRule.exit }, /unknown operator/i)
  })

  test('entry must be boolean, not a bare number', () => {
    bad({ entry: { feature: 'rsi14' }, exit: simpleRule.exit }, /entry must be a boolean/i)
  })

  test('exit must be boolean', () => {
    bad({ entry: simpleRule.entry, exit: { const: 1 } }, /exit must be a boolean/i)
  })

  test('logic operators reject numeric operands', () => {
    bad({ entry: { op: 'and', left: { const: 1 }, right: { const: 2 } }, exit: simpleRule.exit }, /requires boolean operands/i)
  })

  test('comparisons reject boolean operands', () => {
    bad({
      entry: { op: '<', left: { op: '>', left: { const: 1 }, right: { const: 2 } }, right: { const: 3 } },
      exit: simpleRule.exit,
    }, /requires numeric operands/i)
  })

  test('non-finite and non-numeric constants are rejected', () => {
    bad({ entry: { op: '<', left: { feature: 'rsi14' }, right: { const: 'thirty' } }, exit: simpleRule.exit }, /finite number/i)
    bad({ entry: { op: '<', left: { feature: 'rsi14' }, right: { const: Infinity } }, exit: simpleRule.exit }, /finite number/i)
  })

  test('missing operand is rejected rather than defaulted', () => {
    bad({ entry: { op: 'not' }, exit: simpleRule.exit })
    bad({ entry: { op: '<', left: { feature: 'rsi14' } }, exit: simpleRule.exit })
  })

  test('junk shapes are rejected', () => {
    bad(null)
    bad({})
    bad({ entry: 'rsi14 < 30', exit: simpleRule.exit })
    bad({ entry: [{ feature: 'rsi14' }], exit: simpleRule.exit })
  })

  test('oversized (but shallow enough) trees are rejected on node count', () => {
    // A BALANCED tree stays within the depth limit while blowing the node
    // budget — this exercises MAX_NODES specifically, not MAX_DEPTH.
    const cmp = i => ({ op: '>', left: { feature: 'rsi14' }, right: { const: i } })
    let level = [cmp(1), cmp(2), cmp(3), cmp(4), cmp(5), cmp(6), cmp(7), cmp(8)]
    while (level.length > 1) {
      const next = []
      for (let i = 0; i < level.length; i += 2) next.push({ op: 'or', left: level[i], right: level[i + 1] })
      level = next
    }
    const r = validateRule({ entry: level[0], exit: simpleRule.exit })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exceeds \d+ nodes/i)
  })

  test('deeply chained trees are rejected on depth', () => {
    let node = { op: '>', left: { feature: 'rsi14' }, right: { const: 1 } }
    for (let i = 0; i < MAX_NODES; i++) {
      node = { op: 'or', left: node, right: { op: '>', left: { feature: 'rsi14' }, right: { const: i } } }
    }
    bad({ entry: node, exit: simpleRule.exit }, /deeper than \d+/i)
  })

  test('over-deep trees are rejected', () => {
    let node = { op: '>', left: { feature: 'rsi14' }, right: { const: 1 } }
    for (let i = 0; i < MAX_DEPTH + 2; i++) node = { op: 'not', operand: node }
    bad({ entry: node, exit: simpleRule.exit }, /deeper|nodes/i)
  })

  test('a rule that smuggles a code-like string is just an invalid node', () => {
    bad({ entry: { op: '<', left: { feature: 'process.exit(1)' }, right: { const: 1 } }, exit: simpleRule.exit }, /unknown feature/i)
  })
})

describe('generateRuleSignals', () => {
  const bars = makeBars()

  test('produces a signal array aligned to the bars', () => {
    const sig = generateRuleSignals(simpleRule, bars)
    expect(sig).toHaveLength(bars.closes.length)
    expect(sig.every(s => s === 1 || s === -1 || s === 0)).toBe(true)
  })

  test('emits both entries and exits on data that oscillates', () => {
    const sig = generateRuleSignals(simpleRule, bars)
    expect(sig.some(s => s === 1)).toBe(true)
    expect(sig.some(s => s === -1)).toBe(true)
  })

  test('undefined warm-up values never produce a signal', () => {
    // ema200 is NaN for the first 199 bars — comparisons must yield no signal
    const rule = {
      entry: { op: '>', left: { feature: 'close' }, right: { feature: 'ema200' } },
      exit:  { op: '<', left: { feature: 'close' }, right: { feature: 'ema200' } },
    }
    const sig = generateRuleSignals(rule, bars)
    expect(sig.slice(0, 150).every(s => s === 0)).toBe(true)
  })

  test('EXIT takes precedence when entry and exit are both true (risk-off)', () => {
    const always = {
      entry: { op: '>', left: { feature: 'close' }, right: { const: 0 } },
      exit:  { op: '>', left: { feature: 'close' }, right: { const: 0 } },
    }
    const sig = generateRuleSignals(always, bars)
    expect(sig[sig.length - 1]).toBe(-1)
  })

  test('a never-true rule produces no trades at all', () => {
    const never = {
      entry: { op: '<', left: { feature: 'close' }, right: { const: -1 } },
      exit:  { op: '<', left: { feature: 'close' }, right: { const: -1 } },
    }
    expect(generateRuleSignals(never, bars).every(s => s === 0)).toBe(true)
  })

  test('cross_above fires only on the crossing bar, not while merely above', () => {
    const cross = {
      entry: { op: 'cross_above', left: { feature: 'close' }, right: { feature: 'sma50' } },
      exit:  { op: 'cross_below', left: { feature: 'close' }, right: { feature: 'sma50' } },
    }
    const above = {
      entry: { op: '>', left: { feature: 'close' }, right: { feature: 'sma50' } },
      exit:  { op: '<', left: { feature: 'close' }, right: { feature: 'sma50' } },
    }
    const crossBuys = generateRuleSignals(cross, bars).filter(s => s === 1).length
    const aboveBuys = generateRuleSignals(above, bars).filter(s => s === 1).length
    expect(crossBuys).toBeLessThan(aboveBuys)
    expect(crossBuys).toBeGreaterThan(0)
  })

  test('throws on an invalid rule rather than silently returning zeros', () => {
    expect(() => generateRuleSignals({ entry: { feature: 'rsi14' }, exit: simpleRule.exit }, bars)).toThrow()
  })
})

describe('integration with the real backtest engine', () => {
  test('composed signals run through simulateWithSignals and yield real metrics', () => {
    const { simulateWithSignals } = require('../utils/backtest')
    const bars = makeBars()
    const signals = generateRuleSignals(simpleRule, bars)
    const { metrics } = simulateWithSignals(bars.timestamps, bars.closes, signals)
    expect(typeof metrics.totalReturn).toBe('number')
    expect(typeof metrics.alpha).toBe('number')
    expect(typeof metrics.sharpeRatio).toBe('number')
    expect(metrics.totalTrades).toBeGreaterThanOrEqual(0)
  })

  test('simulate() and simulateWithSignals() agree for a catalog strategy', () => {
    const { simulate, simulateWithSignals, generateSignals } = require('../utils/backtest')
    const bars = makeBars()
    const params = { fastPeriod: 10, slowPeriod: 30 }
    const a = simulate(bars.timestamps, bars.closes, 'sma_crossover', params)
    const b = simulateWithSignals(bars.timestamps, bars.closes, generateSignals(bars.closes, 'sma_crossover', params))
    expect(b.metrics).toEqual(a.metrics)
  })
})

describe('parseCompositions', () => {
  const valid = JSON.stringify({
    strategies: [
      { name: 'Oversold in uptrend', rule: simpleRule, rationale: 'r', marketFit: 'm' },
    ],
  })

  test('accepts valid strategies and attaches a description', () => {
    const { strategies, rejected } = parseCompositions(valid)
    expect(strategies).toHaveLength(1)
    expect(rejected).toHaveLength(0)
    expect(strategies[0].description).toMatch(/ENTRY/)
  })

  test('drops invalid rules with a reason instead of failing the batch', () => {
    const mixed = JSON.stringify({
      strategies: [
        { name: 'bad', rule: { entry: { feature: 'nope' }, exit: simpleRule.exit } },
        { name: 'good', rule: simpleRule },
      ],
    })
    const { strategies, rejected } = parseCompositions(mixed)
    expect(strategies).toHaveLength(1)
    expect(strategies[0].name).toBe('good')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/unknown feature/i)
  })

  test('dedupes identical rules', () => {
    const dupes = JSON.stringify({ strategies: [
      { name: 'a', rule: simpleRule }, { name: 'b', rule: simpleRule },
    ] })
    expect(parseCompositions(dupes).strategies).toHaveLength(1)
  })

  test('non-JSON or empty responses yield nothing rather than throwing', () => {
    expect(parseCompositions('not json').strategies).toEqual([])
    expect(parseCompositions('').strategies).toEqual([])
    expect(parseCompositions('{"strategies":"nope"}').strategies).toEqual([])
  })

  test('respects the max count', () => {
    const many = JSON.stringify({ strategies: Array.from({ length: 9 }, (_, i) => ({
      name: `s${i}`,
      rule: { entry: { op: '<', left: { feature: 'rsi14' }, right: { const: 20 + i } }, exit: simpleRule.exit },
    })) })
    expect(parseCompositions(many, 3).strategies).toHaveLength(3)
  })
})

describe('prompt surface', () => {
  test('catalog block lists real feature names only', () => {
    const block = featureCatalogBlock()
    expect(block).toContain('rsi14')
    expect(block).toContain('ema200')
  })

  test('composition prompt names the symbol and forbids invented numbers', () => {
    const p = buildCompositionPrompt({ symbol: 'NVDA', range: '2y', taLine: 'NVDA: RSI=55', count: 3 })
    expect(p).toContain('NVDA')
    expect(p).toContain('Do NOT claim any performance numbers')
    expect(p).toContain('rsi14')
  })
})

describe('describeRule', () => {
  test('renders a readable description', () => {
    expect(describeRule(simpleRule)).toBe('ENTRY (rsi14 < 35) | EXIT (rsi14 > 65)')
  })

  test('never throws on a malformed rule', () => {
    expect(describeRule(null)).toBe('invalid rule')
  })
})
