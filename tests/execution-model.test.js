'use strict'
/** lib/execution-model.js + its use in utils/backtest.js:simulateWithSignals. */
const EM = require('../lib/execution-model')
const { simulateWithSignals } = require('../utils/backtest')
const { rng } = require('../lib/quant/linalg')

const T0 = Date.UTC(2024, 0, 1) / 1000
const ts = n => Array.from({ length: n }, (_, i) => T0 + i * 86400)

/** A random walk with OHLCV. */
function walk(n, seed = 1, { vol = 0.015, volume = 1e6 } = {}) {
  const g = rng(seed); let p = 100
  const o = [], h = [], l = [], c = [], v = []
  for (let i = 0; i < n; i++) {
    const open = p * (1 + 0.003 * g.normal()); p = open * (1 + vol * g.normal())
    o.push(open); c.push(p); h.push(Math.max(open, p) * (1 + 0.004 * Math.abs(g.normal()))); l.push(Math.min(open, p) * (1 - 0.004 * Math.abs(g.normal()))); v.push(volume * (0.5 + g.uniform()))
  }
  return { opens: o, highs: h, lows: l, closes: c, volumes: v }
}
const sigEvery = (n, k) => Array.from({ length: n }, (_, i) => (i % k === 5 ? 1 : i % k === Math.floor(k / 2) + 5 ? -1 : 0))

describe('default path is unchanged', () => {
  test('no slippage / no exits / model none give identical results to before', () => {
    const b = walk(300), s = sigEvery(300, 30)
    const base = simulateWithSignals(ts(300), b.closes, s, 10000, { costBps: 10, opens: b.opens })
    const same = simulateWithSignals(ts(300), b.closes, s, 10000, { costBps: 10, opens: b.opens, highs: b.highs, lows: b.lows, volumes: b.volumes, slippage: { model: 'none' } })
    expect(same.metrics).toEqual(base.metrics)
    expect(same.trades).toEqual(base.trades)
    expect(base.metrics.slippage).toBeUndefined()
  })
})

describe('slippage', () => {
  test('range model reads the PREVIOUS bar only, and costs money', () => {
    const b = walk(300), s = sigEvery(300, 30)
    const opts = { costBps: 10, opens: b.opens, highs: b.highs, lows: b.lows, volumes: b.volumes, slippage: { model: 'range', rangeK: 0.1 } }
    expect(EM.slipFraction(10, 100, b, opts.slippage)).toBeCloseTo(0.1 * (b.highs[9] - b.lows[9]) / b.closes[9], 12)
    const h2 = b.highs.slice(); h2[10] = h2[10] * 2   // the fill bar's own high is unknown at its open
    expect(EM.slipFraction(10, 100, { ...b, highs: h2 }, opts.slippage)).toBe(EM.slipFraction(10, 100, b, opts.slippage))
    const base = simulateWithSignals(ts(300), b.closes, s, 10000, { costBps: 10, opens: b.opens })
    const slipped = simulateWithSignals(ts(300), b.closes, s, 10000, opts)
    expect(slipped.metrics.slippagePaid).toBeGreaterThan(0)
    expect(slipped.metrics.finalValue).toBeLessThan(base.metrics.finalValue)
  })

  test('impact model grows with the square root of order size', () => {
    const b = walk(100)
    const sl = { model: 'impact', coef: 1 }
    const small = EM.slipFraction(50, 10_000, b, sl), big = EM.slipFraction(50, 40_000, b, sl)
    expect(big / small).toBeCloseTo(2, 6)
    expect(EM.slipFraction(50, 10_000, { ...b, volumes: null }, sl)).toBe(0)
  })

  test('the volume cap cuts an entry, and an exit cut by it carries to the next bar', () => {
    const b = walk(120, 3, { volume: 1000 })        // thin stock: ~1,000 shares a day
    const s = new Array(120).fill(0); s[40] = 1; s[80] = -1
    const r = simulateWithSignals(ts(120), b.closes, s, 1_000_000, { costBps: 10, opens: b.opens, volumes: b.volumes, slippage: { maxParticipation: 0.1 } })
    const buy = r.trades.find(t => t.type === 'buy')
    expect(buy.shares).toBeLessThanOrEqual(Math.floor(0.1 * EM.advAt(41, b.volumes)))
    expect(r.metrics.partialFills).toBeGreaterThan(0)
    const sells = r.trades.filter(t => t.type === 'sell' && !t.open)
    expect(sells.reduce((a, t) => a + t.shares, 0) + (r.trades.find(t => t.open)?.shares || 0)).toBe(buy.shares)
  })
})

describe('bracket exits', () => {
  // A hand-made path: entry fills at 100 on bar 1 (signal on bar 0).
  const mk = rows => ({ opens: rows.map(r => r[0]), highs: rows.map(r => r[1]), lows: rows.map(r => r[2]), closes: rows.map(r => r[3]) })
  const run = (b, exits) => simulateWithSignals(ts(b.closes.length), b.closes, [1, ...new Array(b.closes.length - 1).fill(0)], 10000,
    { costBps: 0, opens: b.opens, highs: b.highs, lows: b.lows, exits })

  test('stop is hit at the stop level; nothing is checked on the entry bar itself', () => {
    const b = mk([[100, 100, 100, 100], [100, 101, 80, 99], [99, 100, 94, 95], [95, 96, 90, 91]])
    const r = run(b, { stopPct: 5 })
    const sell = r.trades.find(t => t.type === 'sell')
    expect(sell.exitKind).toBe('stop')
    expect(sell.price).toBeCloseTo(95, 6)       // bar 2 traded through 95; bar 1's 80 low was the entry bar
    expect(sell.date).toBe(new Date((T0 + 2 * 86400) * 1000).toISOString().slice(0, 10))
  })

  test('a gap through the stop fills at the open, not the better stop price', () => {
    const b = mk([[100, 100, 100, 100], [100, 101, 99, 100], [90, 92, 88, 91]])
    const sell = run(b, { stopPct: 5 }).trades.find(t => t.type === 'sell')
    expect(sell.price).toBe(90)
  })

  test('a bar touching both the stop and the target exits at the stop', () => {
    const b = mk([[100, 100, 100, 100], [100, 101, 99, 100], [100, 125, 90, 110]])
    expect(run(b, { stopPct: 5, targetPct: 20 }).trades.find(t => t.type === 'sell').exitKind).toBe('stop')
  })

  test('T1 sells half and moves the stop to breakeven; the rest goes at the target', () => {
    const b = mk([[100, 100, 100, 100], [100, 101, 99, 100], [101, 111, 100, 109], [109, 112, 104, 110], [110, 121, 108, 120]])
    const r = run(b, { stopPct: 5, t1Pct: 10, targetPct: 20 })
    const sells = r.trades.filter(t => t.type === 'sell')
    expect(sells.map(t => t.exitKind)).toEqual(['t1', 'target'])
    expect(sells[0].shares).toBe(Math.floor(r.trades[0].shares / 2))
    expect(sells[1].price).toBeCloseTo(120, 6)
    expect(r.metrics.exitsByKind).toEqual({ t1: 1, target: 1 })
  })

  test('after T1 a fall to the entry price exits at breakeven', () => {
    const b = mk([[100, 100, 100, 100], [100, 101, 99, 100], [101, 111, 100, 109], [105, 106, 98, 99]])
    const sells = run(b, { stopPct: 5, t1Pct: 10, targetPct: 20 }).trades.filter(t => t.type === 'sell')
    expect(sells[1].exitKind).toBe('breakeven-stop')
    expect(sells[1].price).toBeCloseTo(100, 6)
  })

  test('trailing stop ratchets up from the highs before each bar; time limit exits at the close', () => {
    const b = mk([[100, 100, 100, 100], [100, 101, 99, 100], [101, 120, 100, 118], [118, 119, 107, 108]])
    const sell = run(b, { trailPct: 10 }).trades.find(t => t.type === 'sell')
    expect(sell.exitKind).toBe('trailing-stop')
    expect(sell.price).toBeCloseTo(108, 6)       // 120 × 0.9
    const b2 = mk([[100, 100, 100, 100], [100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102], [102, 103, 101, 102]])
    const t = run(b2, { maxHoldBars: 2 }).trades.find(x => x.type === 'sell')
    expect(t.exitKind).toBe('time')
    expect(t.price).toBe(102)
  })

  test('ATR brackets use the bars before the fill; execOptions is empty without a stored model', () => {
    const b = walk(60)
    const br = EM.bracketFor(100, 30, b, { stopAtr: 2, targetAtr: 4 })
    const atr = EM.atrAt(30, b)
    expect(br.stop).toBeCloseTo(100 - 2 * atr, 9)
    expect(br.target).toBeCloseTo(100 + 4 * atr, 9)
    expect(EM.execOptions(null, { closes: [1, 2] })).toEqual({})
    expect(EM.execOptions({ exits: { stopPct: 5 } }, { closes: [1, 2, 3], highs: [1, 2, 3] }, 1).highs).toEqual([2, 3])
  })
})
