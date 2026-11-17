'use strict'
const BT = require('../utils/backtest')
const SL = require('../lib/strategy-lab')
const { rng } = require('../lib/quant/linalg')

function bars(n = 600, seed = 1, drift = 0.0005) {
  const g = rng(seed), closes = [], highs = [], lows = []; let p = 100
  for (let i = 0; i < n; i++) {
    p *= 1 + drift + 0.015 * g.normal()
    closes.push(p); highs.push(p * (1 + Math.abs(0.008 * g.normal()))); lows.push(p * (1 - Math.abs(0.008 * g.normal())))
  }
  return { closes, highs, lows }
}
const NEW = { donchian_breakout: { entryPeriod: 20, exitPeriod: 10 }, range_breakout_atr: { entryPeriod: 20, exitPeriod: 10, atrPeriod: 14, expansion: 1.2 }, adx_trend: { period: 14, threshold: 20, maPeriod: 50 }, supertrend: { period: 10, mult: 3 } }

describe('breakout and ADX strategies', () => {
  test('each is in the catalog, the backtest route list and has a default hypothesis', () => {
    for (const k of Object.keys(NEW)) {
      expect(SL.STRATEGY_CATALOG[k]).toBeDefined()
      expect(SL.STRATEGY_CATALOG[k].expects).toBeTruthy()
    }
    expect(require('fs').readFileSync(require('path').join(__dirname, '../routes/backtest.js'), 'utf8')).toMatch(/'adx_trend'/)
  })

  test('no look-ahead: signals up to day i never change when later bars are appended', () => {
    const b = bars(700, 3)
    for (const [k, params] of Object.entries(NEW)) {
      const cut = 450
      const short = BT.generateSignals(b.closes.slice(0, cut), k, params, { highs: b.highs.slice(0, cut), lows: b.lows.slice(0, cut) })
      const full = BT.generateSignals(b.closes, k, params, { highs: b.highs, lows: b.lows })
      expect(full.slice(0, cut)).toEqual(short)
      expect(full.some(s => s === 1)).toBe(true)
    }
  })

  test('Donchian buys a close above the PRIOR channel high and sells below the prior low; signals alternate', () => {
    const closes = [...Array(30).fill(100), 101, 102, 103, 99, 95, 90]
    const sig = BT.generateSignals(closes, 'donchian_breakout', { entryPeriod: 20, exitPeriod: 3 })
    expect(sig.indexOf(1)).toBe(30)
    expect(sig.indexOf(-1)).toBe(33)
    const nz = sig.filter(Boolean)
    for (let i = 1; i < nz.length; i++) expect(nz[i]).toBe(-nz[i - 1])
  })

  test('the ATR filter takes a breakout only on a wide-range day', () => {
    const n = 60, closes = Array(n).fill(100), highs = Array(n).fill(101), lows = Array(n).fill(99)
    closes[40] = 101.5; highs[40] = 101.6; lows[40] = 100.9          // narrow breakout: range 0.7 vs ATR ≈ 2
    closes[50] = 102; highs[50] = 104; lows[50] = 99.5                 // wide breakout: range 4.5
    const sig = BT.generateSignals(closes, 'range_breakout_atr', { entryPeriod: 20, exitPeriod: 10, atrPeriod: 14, expansion: 1.5 }, { highs, lows })
    expect(sig[40]).toBe(0)
    expect(sig[50]).toBe(1)
    expect(BT.generateSignals(closes, 'donchian_breakout', { entryPeriod: 20, exitPeriod: 10 }, { highs, lows })[40]).toBe(1)   // the plain breakout takes the narrow day
  })

  test('ADX is bounded, rises in a steady trend with +DI above −DI, and the rule is long in it', () => {
    const n = 200, closes = [], highs = [], lows = []
    for (let i = 0; i < n; i++) { const p = 100 + i * 0.5; closes.push(p); highs.push(p + 0.4); lows.push(p - 0.4) }
    const { adx, plusDI, minusDI } = BT.adxSeries(highs, lows, closes, 14)
    const last = n - 1
    expect(adx[last]).toBeGreaterThan(50)
    expect(adx[last]).toBeLessThanOrEqual(100)
    expect(plusDI[last]).toBeGreaterThan(minusDI[last])
    expect(Number.isNaN(adx[26])).toBe(true)
    expect(Number.isFinite(adx[27])).toBe(true)
    const sig = BT.generateSignals(closes, 'adx_trend', { period: 14, threshold: 25, maPeriod: 50 }, { highs, lows })
    expect(sig.filter(s => s === 1)).toHaveLength(1)
    expect(sig.indexOf(-1)).toBe(-1)
  })

  test('without highs/lows they fall back to closes instead of failing', () => {
    const b = bars(500, 7)
    for (const [k, params] of Object.entries(NEW)) {
      const sig = BT.generateSignals(b.closes, k, params)
      expect(sig).toHaveLength(500)
      expect(sig.every(s => s === 0 || s === 1 || s === -1)).toBe(true)
    }
  })

  test('passing highs/lows alone does not change a simulation (only the execution model reads them)', () => {
    const b = bars(400, 9), ts = b.closes.map((_, i) => 1.6e9 + i * 86400)
    const sig = BT.generateSignals(b.closes, 'sma_crossover', { fastPeriod: 10, slowPeriod: 30 })
    const a = BT.simulateWithSignals(ts, b.closes, sig, 10000, { costBps: 10 }).metrics
    const c = BT.simulateWithSignals(ts, b.closes, sig, 10000, { costBps: 10, highs: b.highs, lows: b.lows }).metrics
    expect(c).toEqual(a)
  })
})

describe('supertrend', () => {
  const line = (n, f) => { const closes = Array.from({ length: n }, (_, i) => f(i)); return { closes, highs: closes.map(c => c * 1.005), lows: closes.map(c => c * 0.995) } }
  test('gets in during a steady rise after a fall, and out when the rise breaks', () => {
    // down 60 bars, up 120, then a sharp fall
    const b = line(240, i => (i < 60 ? 100 - i * 0.5 : i < 180 ? 70 + (i - 60) * 0.6 : 142 - (i - 180) * 1.5))
    const sig = BT.generateSignals(b.closes, 'supertrend', { period: 10, mult: 3 }, { highs: b.highs, lows: b.lows })
    const buys = sig.map((s, i) => (s === 1 ? i : -1)).filter(i => i >= 0), sells = sig.map((s, i) => (s === -1 ? i : -1)).filter(i => i >= 0)
    expect(buys).toHaveLength(1)
    expect(buys[0]).toBeGreaterThan(60); expect(buys[0]).toBeLessThan(100)
    expect(sells).toHaveLength(1)
    expect(sells[0]).toBeGreaterThan(180); expect(sells[0]).toBeLessThan(200)
  })
  test('a wider multiplier trades less often; too little history trades never', () => {
    const b = bars(900, 9)
    const count = mult => BT.generateSignals(b.closes, 'supertrend', { period: 10, mult }, { highs: b.highs, lows: b.lows }).filter(s => s === 1).length
    expect(count(1.5)).toBeGreaterThan(count(4))
    expect(BT.generateSignals([1, 2, 3], 'supertrend', {}).every(s => s === 0)).toBe(true)
  })
})
