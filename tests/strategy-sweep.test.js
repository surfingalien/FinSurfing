'use strict'
/** lib/strategy-sweep.js — parameter sweeps judged as one batch, on a worker thread. */
const SW = require('../lib/strategy-sweep')
const { STRATEGY_CATALOG } = require('../lib/strategy-lab')
const { rng } = require('../lib/quant/linalg')

function series(n = 900, seed = 4, drift = 0.0004) {
  const g = rng(seed), closes = []; let p = 100
  for (let i = 0; i < n; i++) { p *= 1 + drift + 0.012 * g.normal(); closes.push(p) }
  const t0 = Math.floor(Date.UTC(2022, 0, 3) / 1000)
  return { timestamps: closes.map((_, i) => t0 + i * 86400), closes, opens: closes.map((c, i) => (i ? closes[i - 1] : c)), highs: closes.map(c => c * 1.006), lows: closes.map(c => c * 0.994), volumes: closes.map(() => 1e6) }
}

describe('gridFor', () => {
  test('every catalog type gets a grid inside its ranges, deterministic, never over the size', () => {
    for (const type of Object.keys(STRATEGY_CATALOG)) {
      const grid = SW.gridFor(type, 200)
      expect(grid.length).toBeGreaterThan(5)
      expect(grid.length).toBeLessThanOrEqual(200)
      expect(SW.gridFor(type, 200)).toEqual(grid)
      expect(new Set(grid.map(p => JSON.stringify(p))).size).toBe(grid.length)        // no setting twice
      for (const params of grid) {
        expect(SW.validParams(params)).toBe(true)
        for (const [k, spec] of Object.entries(STRATEGY_CATALOG[type].params)) {
          expect(params[k]).toBeGreaterThanOrEqual(spec.min); expect(params[k]).toBeLessThanOrEqual(spec.max)
          if (spec.int) expect(Number.isInteger(params[k])).toBe(true)
        }
      }
    }
    expect(() => SW.gridFor('nope')).toThrow(/unknown strategy type/)
  })
  test('a bigger size gives a finer grid; orderings that mean nothing are left out', () => {
    expect(SW.gridFor('sma_crossover', 400).length).toBeGreaterThan(SW.gridFor('sma_crossover', 40).length)
    expect(SW.gridFor('sma_crossover', 200).every(p => p.fastPeriod < p.slowPeriod)).toBe(true)
    expect(SW.validParams({ oversold: 40, overbought: 30 })).toBe(false)
  })
  test('sweep size: default 200, the env may set 20 to 1000', () => {
    expect(SW.sweepSize({})).toBe(200)
    expect(SW.sweepSize({ STRATEGY_BRAIN_SWEEP_SIZE: '50' })).toBe(50)
    expect(SW.sweepSize({ STRATEGY_BRAIN_SWEEP_SIZE: '99999' })).toBe(1000)
    expect(SW.sweepSize({ STRATEGY_BRAIN_SWEEP_SIZE: '3' })).toBe(200)
  })
})

describe('evaluateGrid', () => {
  test('every setting comes back admitted or with the reason it died, and the batch counts every setting as a trial', () => {
    const s = series()
    const configs = SW.gridFor('sma_crossover', 60)
    const out = SW.evaluateGrid({ type: 'sma_crossover', symbol: 'TEST', series: s, configs, costBps: 10 })
    expect(out.tried).toBe(configs.length)
    expect(out.rows).toHaveLength(configs.length)
    for (const r of out.rows) {
      expect(r.admit ? r.reason : typeof r.reason).toBe(r.admit ? null : 'string')
      expect(r.returns).toBeUndefined()                                   // no per-bar arrays cross the thread boundary
      if (r.deflated) expect(r.deflated.nTrials).toBe(configs.length)     // the luck line is the best of ALL of them
    }
    expect(out.rows.filter(r => r.admit).length).toBeLessThanOrEqual(SW.KEEP_PER_SWEEP)
  })

  test('on pure noise a sweep admits nothing in most histories — more settings is not more luck', () => {
    let admitted = 0
    for (let seed = 1; seed <= 6; seed++) {
      const out = SW.evaluateGrid({ type: 'rsi_threshold', symbol: 'N', series: series(900, 100 + seed, 0), configs: SW.gridFor('rsi_threshold', 60), costBps: 10 })
      admitted += out.rows.filter(r => r.admit).length
    }
    expect(admitted).toBeLessThanOrEqual(2)
  })
})

describe('runSweep', () => {
  test('runs on a worker thread and returns the same answer as running it here', async () => {
    const s = series(700, 9)
    const payload = { type: 'bb_reversion', symbol: 'W', series: s, configs: SW.gridFor('bb_reversion', 24), costBps: 10 }
    const viaWorker = await SW.runSweep(payload)
    expect(viaWorker).toEqual(SW.evaluateGrid(payload))
  }, 60_000)

  test('a failing sweep is an error, never a silent empty result; a stuck one times out', async () => {
    await expect(SW.runSweep({ type: 'nope', symbol: 'X', series: series(100), configs: [{}], costBps: 10 })).rejects.toThrow()
    class Stuck { constructor() { this.h = {} } once(ev, fn) { this.h[ev] = fn } terminate() { this.dead = true } }
    await expect(SW.runSweep({}, { timeoutMs: 20, Worker: Stuck })).rejects.toThrow(/did not finish/)
  }, 30_000)
})
