'use strict'

const pead = require('../lib/pead')

const DAY = 86400000
const T0 = Date.UTC(2021, 0, 4)
const key = t => new Date(t).toISOString().slice(0, 10)

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5 } }

/** Daily bars with noise; `bump(i)` adds a per-day drift (used to plant post-event drift). */
function series(n, { seed = 3, bump = () => 0, start = 100 } = {}) {
  const r = rng(seed); let c = start
  return Array.from({ length: n }, (_, i) => {
    const o = c
    c *= 1 + 0.01 * r() * 3.4 + bump(i)
    return { t: T0 + i * DAY, o, h: Math.max(o, c), l: Math.min(o, c), c }
  })
}

test('surprise %, its group, and no division by an estimate near zero', () => {
  expect(pead.surprisePct(1.1, 1.0)).toBeCloseTo(10, 6)
  expect(pead.surprisePct(-0.5, -1.0)).toBeCloseTo(50, 6)       // a smaller loss is a beat
  expect(pead.surprisePct(0.2, 0.004)).toBeNull()
  expect([pead.groupOf(6), pead.groupOf(-7), pead.groupOf(1)]).toEqual(['beat', 'miss', 'inline'])
})

test('tone counts plain business words, stems included, and refuses too few words', () => {
  const up = pead.toneScore('Strong quarter, record revenue, improving margins and accelerating growth. We are confident and pleased. Solid gains, robust demand, healthy backlog, raised guidance. Headwinds remain.')
  expect(up.score).toBeGreaterThan(0.6)
  expect(up.neg).toBe(1)
  expect(pead.toneScore('Thank you, operator.')).toBeNull()
})

test('entry is the open of the first session AFTER the report date — never the report day — and pays the cost', () => {
  const bars = series(60)
  const date = key(bars[10].t)
  const bench = series(60, { seed: 9 })
  const r = pead.eventReturn(bars, date, { hold: 20, benchByDay: new Map(bench.map(b => [key(b.t), b])), costBps: 10 })
  expect(r.entryDate).toBe(key(bars[11].t))
  expect(r.exitDate).toBe(key(bars[30].t))
  expect(r.ret).toBeCloseTo((bars[30].c / bars[11].o - 1) * 100 - 0.1, 2)
  expect(r.abn).toBeCloseTo(r.ret - ((bench[30].c / bench[11].o - 1) * 100), 2)
  expect(pead.eventReturn(bars, key(bars[45].t), { hold: 20 })).toBeNull()          // window not finished
})

test('call tone is matched to its event and compared with the previous call', () => {
  const bars = series(300)
  const ev = pead.buildEvents({
    symbol: 'ACME', bars, benchBars: bars,
    surprises: [{ date: key(bars[100].t), epsActual: 1.2, epsEstimated: 1.0 }, { date: key(bars[190].t), actualEarningResult: 1.0, estimatedEarning: 1.1 }],
    transcripts: [
      { date: key(bars[101].t), content: 'strong record growth improving robust solid healthy gains confident pleased challenging' },
      { date: key(bars[190].t), content: 'challenging weak decline headwinds pressure uncertain cautious softness strong delays' },
    ],
  })
  expect(ev.map(e => e.group)).toEqual(['beat', 'miss'])
  expect(ev[0].toneChange).toBeNull()                     // no earlier call to compare
  expect(ev[1].toneChange).toBeLessThan(0)
})

function universe({ drift, names = 30, quarters = 18 }) {
  const bench = series(1300, { seed: 77 })
  const out = []
  for (let k = 0; k < names; k++) {
    const days = []
    const surprises = []
    for (let q = 0; q < quarters; q++) {
      const d = 60 + q * 63 + (k % 5) * 3
      const beat = (k + q) % 3 !== 0
      days.push([d, beat])
      surprises.push({ date: key(T0 + d * DAY), epsActual: beat ? 1.12 : 0.9, epsEstimated: 1.0 })
    }
    const bump = i => { for (const [d, beat] of days) if (i > d && i <= d + 20) return beat ? drift : -drift; return 0 }
    const bars = series(1300, { seed: 100 + k, bump })
    out.push(...pead.buildEvents({ symbol: `S${k}`, surprises, bars, benchBars: bench }))
  }
  return out
}

test('planted drift after beats is validated on both halves, with misses as the control', () => {
  const s = pead.study(universe({ drift: 0.002 }))
  expect(s.strategy.verdict).toBe('validated')
  expect(s.strategy.train.meanAbn).toBeGreaterThan(0)
  expect(s.strategy.holdout.meanAbn).toBeGreaterThan(0)
  expect(s.groups.miss.meanAbn).toBeLessThan(0)
  expect(s.spreadVsMiss).toBeGreaterThan(0)
})

test('no drift is not validated, and the t-stat is taken across months, not events', () => {
  const s = pead.study(universe({ drift: 0 }))
  expect(s.strategy.verdict).not.toBe('validated')
  expect(s.groups.beat.months).toBeLessThan(s.groups.beat.n / 5)   // many events share a month
})

test('too few events is insufficient, and tone is not judged on a handful', () => {
  const s = pead.study(universe({ drift: 0.002, names: 2, quarters: 6 }))
  expect(s.strategy.verdict).toBe('insufficient')
  expect(s.tone.verdict).toBe('insufficient')
})

test('drift window: sessions since the report and whether it is still open', () => {
  const bars = series(40)
  expect(pead.windowState({ date: key(bars[29].t), group: 'beat' }, bars)).toEqual({ sessionsSince: 10, inWindow: true, remaining: 10 })
  expect(pead.windowState({ date: key(bars[5].t), group: 'beat' }, bars).inWindow).toBe(false)
})

test('runStudy fetches per name, tolerates failures, saves, and keeps each name\'s latest event', async () => {
  const bars = series(400)
  const fetchBars = jest.fn(async () => bars)
  const fetchSurprises = jest.fn(async s => (s === 'BAD' ? Promise.reject(new Error('x')) : [{ date: key(bars[300].t), epsActual: 1.2, epsEstimated: 1 }]))
  const out = await pead.runStudy({ universe: ['AAA', 'BAD'], fetchBars, fetchSurprises, toneQuarters: 0, minUniverse: 1 })
  expect(out.analystNames).toBe(1)
  expect(out.universe).toBe(1)
  expect(out.missing).toEqual(['BAD'])
  expect(out.latestBySymbol.AAA).toMatchObject({ group: 'beat', surprisePct: 20 })
  expect(pead.readStudy()).toMatchObject({ universe: 1 })
  await expect(pead.runStudy({ universe: ['A'], fetchBars: async () => [], fetchSurprises })).rejects.toThrow(/no SPY bars/)
})

test('an exhausted FMP quota never overwrites the stored study', async () => {
  pead.saveStudy({ ranAt: 'last-week', events: 900 })
  const bars = series(400)
  const fetchSurprises = async () => { throw new Error('Limit Reach . Please upgrade your plan') }
  await expect(pead.runStudy({ universe: ['A', 'B', 'C'], fetchBars: async () => bars, fetchSurprises, toneQuarters: 0 }))
    .rejects.toThrow(/only 0 of 3 names had earnings history \(e.g. Limit Reach/)
  expect(pead.readStudy().ranAt).toBe('last-week')
})

// Quarterly EPS one year apart: a steady +0.10/yr trend with small wobble, then a jump.
function epsHistory(n, { jumpAt = null } = {}) {
  const out = []
  for (let q = 0; q < n; q++) {
    const end = new Date(Date.UTC(2020, 2, 31) + q * 91.3 * 86400000).toISOString().slice(0, 10)
    const filed = new Date(Date.parse(end) + 35 * 86400000).toISOString().slice(0, 10)
    out.push({ end, filed, val: 1 + 0.025 * q + 0.01 * ((q * 7) % 3) + (jumpAt != null && q >= jumpAt ? 0.5 : 0) })
  }
  return out
}

test('SUE: change on the same quarter a year earlier, scaled by its own history; nothing without enough history', () => {
  const s = pead.sueSeries(epsHistory(14, { jumpAt: 13 }))
  expect(s.length).toBeGreaterThan(0)
  expect(s.every(q => q.end >= '2021-03-01')).toBe(true)          // needs a year back AND four prior changes
  const last = s.at(-1)
  expect(last.change).toBeGreaterThan(0.5)
  expect(last.sue).toBeGreaterThan(pead.SUE_BEAT)
  expect(pead.sueSeries(epsHistory(6))).toEqual([])
})

test('SUE events enter after the FILING date, and a value is never computed from a later quarter', () => {
  const bars = series(1800)
  const eps = epsHistory(20, { jumpAt: 17 })
  const ev = pead.sueEvents({ symbol: 'ACME', eps, bars, benchBars: bars })
  for (const e of ev) {
    const q = eps.find(x => x.end === e.periodEnd)
    expect(e.date).toBe(q.filed)
    if (e.entryDate) expect(e.entryDate > q.filed).toBe(true)
  }
  // truncating the future leaves past SUE values unchanged
  const past = pead.sueSeries(eps.slice(0, 15))
  expect(pead.sueSeries(eps).slice(0, past.length)).toEqual(past)
})

test('the study runs on SEC-reported EPS alone when FMP is unavailable', async () => {
  const bars = series(1800)
  const fetchSurprises = async () => { throw new Error('Limit Reach') }
  const out = await pead.runStudy({ universe: ['A', 'B'], fetchBars: async () => bars, fetchSurprises, fetchEps: async () => epsHistory(20, { jumpAt: 16 }), toneQuarters: 0, minUniverse: 2, save: false })
  expect(out.universe).toBe(2)
  expect(out.analystNames).toBe(0)
  expect(out.events).toBe(0)
  expect(out.sue.events).toBeGreaterThan(0)
  expect(out.sue.params.source).toMatch(/no analyst estimates/)
  expect(out.latestBySymbol.A.sue).toEqual(expect.objectContaining({ value: expect.any(Number), group: expect.any(String) }))
})
