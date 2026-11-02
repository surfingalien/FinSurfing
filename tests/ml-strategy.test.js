'use strict'
const ms = require('../lib/ml-strategy')
const sv = require('../lib/strategy-versions')
const { rng } = require('../lib/quant/linalg')

const toSeries = b => ({ timestamps: b.map(x => x.t / 1000), opens: b.map(x => x.o), highs: b.map(x => x.h), lows: b.map(x => x.l), closes: b.map(x => x.c), volumes: b.map(x => x.v) })
// planted: after a 5-day drop of more than 3%, the next 5 days drift up 0.7%/day (on a slightly falling stock,
// so buying and holding is not the answer). Otherwise a pure random walk.
function bars(seed, planted, n = 1260) {
  const r = rng(seed); let p = 100, boost = 0; const c = [], out = []
  for (let i = 0; i < n; i++) {
    let ret = 0.01 * r.normal() - 0.0004
    if (planted && boost > 0) { ret += 0.007; boost-- }
    p *= Math.exp(ret); c.push(p)
    if (planted && boost === 0 && c.length > 6 && p / c[c.length - 6] < 0.97) boost = 5
    out.push({ t: Date.UTC(2021, 0, 4) + i * 86_400_000, o: p, h: p * 1.005, l: p * 0.995, c: p, v: 1e6 })
  }
  return out
}
const noYield = async () => {}

test('no look-ahead: changing prices after a day never changes the signals up to that day', () => {
  const a = bars(3, true), cut = 900
  const b = a.map((x, i) => (i < cut ? x : { ...x, c: x.c * (1 + 0.05 * Math.sin(i)), o: x.o * 1.01 }))
  const sa = ms.mlSignals(toSeries(a), { model: 'logistic', horizon: 5, enter: 0.55, exit: 0.5, blocks: 6 })
  const sb = ms.mlSignals(toSeries(b), { model: 'logistic', horizon: 5, enter: 0.55, exit: 0.5, blocks: 6 })
  expect(sa.slice(0, cut)).toEqual(sb.slice(0, cut))
  expect(sa.slice(cut)).not.toEqual(sb.slice(cut))
})

test('the warm-up block never trades, and the newest bars still get a signal (so the rule can be re-tested forward)', () => {
  const s = toSeries(bars(2, true))
  const { prob, fits } = ms.walkForwardProbabilities(ms.barsOf(s), { model: 'logistic', horizon: 5, blocks: 6 })
  expect(fits).toBeGreaterThanOrEqual(4)
  expect(prob.has(s.timestamps[100] * 1000)).toBe(false)
  expect(prob.has(s.timestamps.at(-1) * 1000)).toBe(true)
})

test('a real pattern is found as a strategy in some histories; noise never is', async () => {
  let planted = 0, noise = 0
  for (let seed = 1; seed <= 6; seed++) {
    if ((await ms.evaluateMlBatch(toSeries(bars(seed, true)), ms.variantsFor('logistic'), { costBps: 10, yieldFn: noYield })).some(x => x.admit)) planted++
    if ((await ms.evaluateMlBatch(toSeries(bars(seed, false)), ms.variantsFor('logistic'), { costBps: 10, yieldFn: noYield })).some(x => x.admit)) noise++
  }
  expect(planted).toBeGreaterThanOrEqual(1)
  expect(noise).toBe(0)
})

test('every variant is a trial: four per model, each with a deflated Sharpe over all four and a reason', async () => {
  const out = await ms.evaluateMlBatch(toSeries(bars(4, false)), ms.variantsFor('naive_bayes'), { costBps: 10, yieldFn: noYield })
  expect(out).toHaveLength(4)
  for (const x of out) { expect(x.deflated?.nTrials).toBe(4); expect(typeof x.reason).toBe('string'); expect(x.returns).toBeUndefined() }
})

test('an ML strategy in the library is re-tested through the same signalsFor as every other strategy; the ensemble trains', () => {
  const s = toSeries(bars(5, true, 700))
  const sig = sv.signalsFor({ strategy: 'ml_model', params: { model: 'ensemble', horizon: 5, enter: 0.55, exit: 0.5, blocks: 6 } }, s)
  expect(sig).toHaveLength(s.closes.length)
  expect(sig.some(x => x !== 0)).toBe(true)
  expect(() => ms.mlSignals(s, { model: 'eval' })).toThrow(/unknown model/)
})
