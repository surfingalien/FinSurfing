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
})
