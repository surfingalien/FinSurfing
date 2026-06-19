'use strict'
/**
 * Unit tests for lib/technical-indicators.js — pure math, no HTTP.
 */

const ta = require('../lib/technical-indicators')

// Synthetic uptrend with mild oscillation: 60 bars climbing from ~100
const closes  = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 4) * 2)
const opens   = closes.map((c, i) => (i ? closes[i - 1] : c))
const highs   = closes.map(c => c * 1.01)
const lows    = closes.map(c => c * 0.99)
const volumes = closes.map(() => 1_000_000)

describe('computeRSI', () => {
  test('returns null with insufficient data', () => {
    expect(ta.computeRSI([1, 2, 3])).toBe(null)
  })

  test('stays within 0-100', () => {
    const rsi = ta.computeRSI(closes)
    expect(rsi).toBeGreaterThanOrEqual(0)
    expect(rsi).toBeLessThanOrEqual(100)
  })

  test('monotonic rise gives RSI 100', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i)
    expect(ta.computeRSI(rising)).toBe(100)
  })

  test('uptrend reads above 50', () => {
    expect(ta.computeRSI(closes)).toBeGreaterThan(50)
  })
})

describe('computeEMA', () => {
  test('returns null with insufficient data', () => {
    expect(ta.computeEMA([1, 2], 9)).toBe(null)
  })

  test('flat series EMA equals the constant', () => {
    const flat = Array(30).fill(50)
    expect(ta.computeEMA(flat, 9)).toBe(50)
  })

  test('EMA trails price in an uptrend', () => {
    const ema = ta.computeEMA(closes, 21)
    expect(ema).toBeLessThan(closes[closes.length - 1])
    expect(ema).toBeGreaterThan(closes[0])
  })
})

describe('computeMACD', () => {
  test('returns null with insufficient data', () => {
    expect(ta.computeMACD(closes.slice(0, 20))).toBe(null)
  })

  test('returns trend and histogram direction', () => {
    const macd = ta.computeMACD(closes)
    expect(['bullish', 'bearish']).toContain(macd.trend)
    expect(['increasing', 'decreasing']).toContain(macd.histogramDir)
  })

  test('steady uptrend reads bullish', () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i))
    expect(ta.computeMACD(rising).trend).toBe('bullish')
  })
})

describe('computeBB', () => {
  test('price inside bands for oscillating series', () => {
    const bb = ta.computeBB(closes)
    expect(bb.lower).toBeLessThan(bb.middle)
    expect(bb.middle).toBeLessThan(bb.upper)
  })

  test('flat series squeezes', () => {
    const flat = Array(30).fill(100)
    expect(ta.computeBB(flat).squeeze).toBe(true)
  })
})

describe('computeATR', () => {
  test('returns null with insufficient data', () => {
    expect(ta.computeATR([1], [1], [1])).toBe(null)
  })

  test('positive for any moving series', () => {
    expect(ta.computeATR(highs, lows, closes)).toBeGreaterThan(0)
  })
})

describe('findSR', () => {
  test('support below price, resistance above (when both exist)', () => {
    const price = closes[closes.length - 1]
    const { support, resistance } = ta.findSR(highs, lows, closes)
    if (support != null)    expect(support).toBeLessThan(price)
    if (resistance != null) expect(resistance).toBeGreaterThan(price)
  })

  test('insufficient data returns nulls without throwing', () => {
    expect(ta.findSR([1, 2], [1, 2], [1, 2])).toEqual({ support: null, resistance: null })
  })
})

describe('volumeAnalysis', () => {
  test('flat volume ratio ≈ 1, no spike', () => {
    const v = ta.volumeAnalysis(volumes)
    expect(v.ratio).toBeCloseTo(1, 1)
    expect(v.spike).toBe(false)
  })

  test('volume spike detected at >2x average', () => {
    const spiked = [...volumes.slice(0, -1), 5_000_000]
    expect(ta.volumeAnalysis(spiked).spike).toBe(true)
  })
})

describe('computeADX', () => {
  test('returns null with insufficient data', () => {
    expect(ta.computeADX(highs.slice(0, 10), lows.slice(0, 10), closes.slice(0, 10))).toBe(null)
  })

  test('returns a value in 0-100 range for a valid uptrend series', () => {
    const adx = ta.computeADX(highs, lows, closes)
    expect(adx).not.toBe(null)
    expect(adx).toBeGreaterThanOrEqual(0)
    expect(adx).toBeLessThanOrEqual(100)
  })

  test('steady monotonic uptrend yields high ADX (strong trend)', () => {
    const n = 60
    const ch = Array.from({ length: n }, (_, i) => 100 + i * 2)
    const cl = Array.from({ length: n }, (_, i) => 99 + i * 2)
    const cc = Array.from({ length: n }, (_, i) => 100 + i * 2)
    const adx = ta.computeADX(ch, cl, cc)
    expect(adx).toBeGreaterThan(25)
  })

  test('flat/sideways market yields low ADX (ranging)', () => {
    const n = 60
    const ch = Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1))
    const cl = Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? -1 : 1))
    const cc = Array.from({ length: n }, () => 100)
    const adx = ta.computeADX(ch, cl, cc)
    expect(adx).toBeLessThan(25)
  })
})

describe('compactTaLine', () => {
  test('returns null with insufficient history', () => {
    expect(ta.compactTaLine('X', opens.slice(0, 5), highs.slice(0, 5), lows.slice(0, 5), closes.slice(0, 5), volumes.slice(0, 5))).toBe(null)
  })

  test('produces a prompt-ready one-liner with the symbol and core indicators', () => {
    const line = ta.compactTaLine('NVDA', opens, highs, lows, closes, volumes)
    expect(line).toMatch(/^NVDA: /)
    expect(line).toMatch(/RSI=/)
    expect(line).toMatch(/MACD=/)
  })

  test('includes ADX and 52w% position when enough bars available', () => {
    const line = ta.compactTaLine('NVDA', opens, highs, lows, closes, volumes)
    expect(line).toMatch(/ADX=/)
    expect(line).toMatch(/52w%=/)
  })

  test('includes VWAP% deviation when volumes are provided', () => {
    const line = ta.compactTaLine('NVDA', opens, highs, lows, closes, volumes)
    expect(line).toMatch(/VWAP%=/)
  })

  test('includes BB%B Bollinger position', () => {
    const line = ta.compactTaLine('NVDA', opens, highs, lows, closes, volumes)
    expect(line).toMatch(/BB%B=/)
  })

  test('includes OBV trend direction', () => {
    const line = ta.compactTaLine('NVDA', opens, highs, lows, closes, volumes)
    expect(line).toMatch(/OBV=(rising|falling)/)
  })
})

describe('OBV divergence detection', () => {
  test('detects obv_bullish_divergence: price falling but big buy volume (accumulation)', () => {
    // Each 2-bar cycle: price nets -1 (up 0.5, down 1.5), but OBV nets +9.9M (buy 10M, sell 0.1M)
    const n = 60
    const c = [], v = []
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) {
        c.push(i === 0 ? 100 : c[i - 1] + 0.5)
        v.push(10_000_000)
      } else {
        c.push(c[i - 1] - 1.5)
        v.push(100_000)
      }
    }
    const h = c.map(v => v * 1.005)
    const l = c.map(v => v * 0.995)
    const o = c.map((v, i) => i ? c[i - 1] : v)
    const patterns = ta.detectPatterns(o, h, l, c, v)
    expect(patterns).toContain('obv_bullish_divergence')
  })

  test('detects obv_bearish_divergence: price rising but big sell volume (distribution)', () => {
    // Each 2-bar cycle: price nets +1 (up 1.5, down 0.5), but OBV nets -9.9M (buy 0.1M, sell 10M)
    const n = 60
    const c = [], v = []
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) {
        c.push(i === 0 ? 100 : c[i - 1] + 1.5)
        v.push(100_000)
      } else {
        c.push(c[i - 1] - 0.5)
        v.push(10_000_000)
      }
    }
    const h = c.map(v => v * 1.005)
    const l = c.map(v => v * 0.995)
    const o = c.map((v, i) => i ? c[i - 1] : v)
    const patterns = ta.detectPatterns(o, h, l, c, v)
    expect(patterns).toContain('obv_bearish_divergence')
  })

  test('no OBV divergence when price and OBV trend together', () => {
    // Clean uptrend: price rises, buy volume dominant → OBV rising, price rising → no divergence
    const n = 60
    const c = Array.from({ length: n }, (_, i) => 100 + i * 0.5)
    const v = Array(n).fill(1_000_000)
    const h = c.map(v => v * 1.005)
    const l = c.map(v => v * 0.995)
    const o = c.map((v, i) => i ? c[i - 1] : v)
    const patterns = ta.detectPatterns(o, h, l, c, v)
    expect(patterns).not.toContain('obv_bullish_divergence')
    expect(patterns).not.toContain('obv_bearish_divergence')
  })
})

describe('RSI divergence detection', () => {
  // For bearish divergence: need price higher high but RSI lower high.
  // Flat baseline gives RSI=100 (avgLoss=0). A sharp 8-bar rise keeps RSI=100.
  // A slow steady rise to a HIGHER price ends with RSI ~80 — clearly below 100-3.
  test('detects bearish divergence: price higher high, RSI lower high', () => {
    const c = [
      ...Array.from({ length: 30 }, () => 100),               // flat → RSI=100
      ...Array.from({ length: 8 },  (_, i) => 100 + (i+1)*10), // 110..180 (sharp rise, RSI=100)
      ...Array.from({ length: 7 },  (_, i) => 175 - i * 5),   // 175..145 (pullback)
      ...Array.from({ length: 15 }, (_, i) => 145 + i * (40/14)), // slow rise 145→185 (RSI~80)
    ]
    const h = c.map(v => v * 1.005)
    const l = c.map(v => v * 0.995)
    const o = c.map((v, i) => i ? c[i - 1] : v)
    const vol = Array(c.length).fill(1_000_000)
    const patterns = ta.detectPatterns(o, h, l, c, vol)
    expect(patterns).toContain('bearish_rsi_divergence')
  })

  // For bullish divergence: need price lower low but RSI higher low.
  // Flat baseline gives RSI=100 initially. A sharp 8-bar drop makes RSI=0 (avgGain=0).
  // A slow steady drop to a LOWER price ends with RSI ~20 — clearly above 0+3.
  test('detects bullish divergence: price lower low, RSI higher low', () => {
    const c = [
      ...Array.from({ length: 30 }, () => 200),                // flat → RSI=100
      ...Array.from({ length: 8 },  (_, i) => 200 - (i+1)*10), // 190..120 (sharp drop, RSI→0)
      ...Array.from({ length: 7 },  (_, i) => 125 + i * 5),    // 125..155 (bounce)
      ...Array.from({ length: 15 }, (_, i) => 155 - i * (40/14)), // slow drop 155→115 (RSI~20)
    ]
    const h = c.map(v => v * 1.005)
    const l = c.map(v => v * 0.995)
    const o = c.map((v, i) => i ? c[i - 1] : v)
    const vol = Array(c.length).fill(1_000_000)
    const patterns = ta.detectPatterns(o, h, l, c, vol)
    expect(patterns).toContain('bullish_rsi_divergence')
  })

  test('no divergence for simple steady uptrend', () => {
    const n = 60
    const c = Array.from({ length: n }, (_, i) => 100 + i * 2)
    const h = c.map(v => v * 1.01)
    const l = c.map(v => v * 0.99)
    const o = c.map((v, i) => i ? c[i - 1] : v)
    const vol = Array(n).fill(1_000_000)
    const patterns = ta.detectPatterns(o, h, l, c, vol)
    expect(patterns).not.toContain('bearish_rsi_divergence')
    expect(patterns).not.toContain('bullish_rsi_divergence')
  })
})

describe('computeRsRanks', () => {
  test('ranks 3 symbols by 20-day return: weakest=0, strongest=100', () => {
    const m = new Map([['A', 5], ['B', 15], ['C', -3]])
    const r = ta.computeRsRanks(m)
    expect(r.get('C')).toBe(0)   // weakest
    expect(r.get('A')).toBe(50)  // middle of 3
    expect(r.get('B')).toBe(100) // strongest
  })

  test('ties share the same rank slot (lower index wins)', () => {
    const m = new Map([['X', 10], ['Y', 10], ['Z', -5]])
    const r = ta.computeRsRanks(m)
    expect(r.get('Z')).toBe(0)
    // X and Y both appear — ranks depend on sort stability but both are assigned
    expect(r.has('X')).toBe(true)
    expect(r.has('Y')).toBe(true)
  })

  test('returns empty Map for fewer than 2 symbols', () => {
    expect(ta.computeRsRanks(new Map([['A', 10]])).size).toBe(0)
    expect(ta.computeRsRanks(new Map()).size).toBe(0)
    expect(ta.computeRsRanks(null).size).toBe(0)
  })

  test('5-symbol universe produces correct percentile spread', () => {
    const m = new Map([['A', 20], ['B', 10], ['C', 0], ['D', -10], ['E', -20]])
    const r = ta.computeRsRanks(m)
    expect(r.get('E')).toBe(0)
    expect(r.get('D')).toBe(25)
    expect(r.get('C')).toBe(50)
    expect(r.get('B')).toBe(75)
    expect(r.get('A')).toBe(100)
  })
})
