const E = require('../lib/event-study')
const { rng } = require('../lib/quant/linalg')

const DAY = 86400000
/** Weekday bars from 2020-01-01. `ret(i)` = close-to-close return of bar i; open = previous close. */
function makeBars(n, ret) {
  const out = []
  let t = Date.UTC(2020, 0, 1), c = 100
  while (out.length < n) {
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) {
      const o = c
      c = c * (1 + ret(out.length))
      out.push({ t, o, c })
    }
    t += DAY
  }
  return out
}
const dayOf = b => new Date(b.t).toISOString().slice(0, 10)
const flat = n => makeBars(n, () => 0)

describe('eventDates', () => {
  const recent = {
    form:       ['8-K', '10-Q', '8-K', '8-K/A', '8-K', '10-K', '4'],
    filingDate: ['2026-10-30', '2026-10-31', '2026-09-01', '2026-08-02', '2026-07-30', '2026-02-01', '2026-01-05'],
    items:      ['2.02,9.01', '', '5.02', '2.02', '9.01,2.02', '', ''],
  }
  test('earnings = original 8-Ks carrying Item 2.02, oldest first', () => {
    expect(E.eventDates(recent, 'earnings').map(e => e.date)).toEqual(['2026-07-30', '2026-10-30'])
  })
  test('filings = the periodic reports', () => {
    expect(E.eventDates(recent, 'filings').map(e => e.form)).toEqual(['10-K', '10-Q'])
  })
  test('nothing to read → empty, never a throw', () => {
    expect(E.eventDates(null, 'earnings')).toEqual([])
    expect(E.eventDates({ form: ['8-K'] }, 'earnings')).toEqual([])
  })
})

describe('parseCustomDates', () => {
  test('keeps real dates, names the rest, caps the list at the newest MAX_DATES', () => {
    const many = Array.from({ length: E.MAX_DATES + 5 }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * DAY).toISOString().slice(0, 10))
    const p = E.parseCustomDates([...many, '2024-02-30', 'tomorrow', many[0]])
    expect(p.events).toHaveLength(E.MAX_DATES)
    expect(p.dropped).toBe(5)
    expect(p.invalid).toEqual(['2024-02-30', 'tomorrow'])
    expect(p.events[p.events.length - 1].date).toBe(many[many.length - 1])
  })
})

describe('study', () => {
  test('entry is the open of the first session strictly after the event date', () => {
    const bars = flat(60), bench = flat(60)
    const r = E.study({ bars, benchBars: bench, events: [{ date: dayOf(bars[10]) }], costBps: 0 })
    expect(r.table[0].entryDate).toBe(dayOf(bars[11]))
    // An event on a Saturday enters on Monday.
    const fri = bars.findIndex(b => new Date(b.t).getUTCDay() === 5)
    const sat = new Date(bars[fri].t + DAY).toISOString().slice(0, 10)
    expect(E.study({ bars, benchBars: bench, events: [{ date: sat }], costBps: 0 }).table[0].entryDate).toBe(dayOf(bars[fri + 1]))
  })

  test('no lookahead: the drift ignores every bar up to the event day, and the reaction ignores bars after the first session', () => {
    const r = rng(7).uniform
    const base = makeBars(120, () => (r() - 0.5) * 0.02), bench = flat(120)
    const ev = [{ date: dayOf(base[50]) }]
    const a = E.study({ bars: base, benchBars: bench, events: ev, costBps: 0 })
    // Rewrite history up to and including the event day (keeping the entry bar's open).
    const past = base.map((b, i) => (i <= 50 ? { ...b, o: b.o * 3, c: b.c * 3 } : b))
    const b = E.study({ bars: past, benchBars: bench, events: ev, costBps: 0 })
    expect(b.table[0].abn1).toBe(a.table[0].abn1)
    expect(b.table[0].abn20).toBe(a.table[0].abn20)
    // Rewrite everything after the 20-session window: nothing measured changes.
    const future = base.map((x, i) => (i > 51 + 19 ? { ...x, o: x.o * 5, c: x.c * 5 } : x))
    const c = E.study({ bars: future, benchBars: bench, events: ev, costBps: 0 })
    expect(c.table[0]).toEqual(a.table[0])
  })

  test('the return is net of cost and of the benchmark over the same sessions', () => {
    const bars = makeBars(40, i => (i === 11 ? 0.05 : 0))        // +5% on the entry day
    const bench = makeBars(40, i => (i === 11 ? 0.02 : 0))       // the market did +2% that day
    const r = E.study({ bars, benchBars: bench, events: [{ date: dayOf(bars[10]) }], costBps: 10 })
    expect(r.table[0].abn1).toBeCloseTo(5 - 0.1 - 2, 6)
    expect(r.table[0].reactionAbn).toBeCloseTo(3, 6)             // close[10] → close[11], vs the benchmark
  })

  test('a planted drift is found; noise is not', () => {
    const quarterly = Array.from({ length: 20 }, (_, k) => 30 + k * 63)
    const inWindow = i => quarterly.some(q => i > q && i <= q + 20)
    const r = rng(11).uniform
    const noisy = () => (r() - 0.5) * 0.02
    const drift = makeBars(1400, i => noisy() + (inWindow(i) ? 0.004 : 0))
    const bench = makeBars(1400, () => 0)
    const events = quarterly.map(q => ({ date: dayOf(drift[q]) }))
    const found = E.study({ bars: drift, benchBars: bench, events })
    const h20 = found.horizons.find(h => h.horizon === 20)
    expect(h20.n).toBe(20)
    expect(h20.verdict).toBe('positive')
    expect(found.path).toHaveLength(20)
    expect(found.path[19].mean).toBeGreaterThan(found.path[0].mean)

    let falsePositives = 0
    for (let seed = 1; seed <= 20; seed++) {
      const rr = rng(100 + seed).uniform
      const noise = makeBars(1400, () => (rr() - 0.5) * 0.02)
      const res = E.study({ bars: noise, benchBars: bench, events: quarterly.map(q => ({ date: dayOf(noise[q]) })) })
      if (res.horizons.some(h => h.verdict === 'positive' || h.verdict === 'negative')) falsePositives += 1
    }
    expect(falsePositives).toBeLessThanOrEqual(2)   // three horizons, 5% family-wise
  })

  test('fewer than MIN_EVENTS usable events is insufficient, whatever the mean', () => {
    const bars = makeBars(400, i => (i % 30 < 20 ? 0.01 : 0)), bench = flat(400)
    const events = Array.from({ length: E.MIN_EVENTS - 1 }, (_, k) => ({ date: dayOf(bars[5 + k * 30]) }))
    const r = E.study({ bars, benchBars: bench, events })
    expect(r.horizons.every(h => h.verdict === 'insufficient')).toBe(true)
  })

  test('windows of one horizon never overlap; the dropped events are counted', () => {
    const bars = flat(200), bench = flat(200)
    const events = [10, 15, 40].map(i => ({ date: dayOf(bars[i]) }))   // the second falls inside the first's 20 sessions
    const r = E.study({ bars, benchBars: bench, events, costBps: 0 })
    const by = Object.fromEntries(r.horizons.map(h => [h.horizon, h]))
    expect(by[20].n).toBe(2)
    expect(by[20].overlapped).toBe(1)
    expect(by[1].n).toBe(3)
    expect(by[1].overlapped).toBe(0)
  })

  test('events outside the price history are skipped and counted, never scored', () => {
    const bars = flat(60), bench = flat(60)
    const r = E.study({ bars, benchBars: bench, events: [{ date: '2019-06-01' }, { date: dayOf(bars[59]) }, { date: dayOf(bars[50]) }] })
    expect(r.skipped).toEqual({ beforeHistory: 1, tooRecent: 1, noBenchmark: 0 })
    expect(r.events).toBe(1)
    expect(r.horizons.find(h => h.horizon === 20).pending).toBe(1)   // window not complete yet
    expect(r.table[0].abn20).toBeNull()
  })

  test('no bars or no events: an empty result, not a throw', () => {
    const r = E.study({ bars: [], benchBars: [], events: [{ date: '2024-01-02' }] })
    expect(r.events).toBe(0)
    expect(r.reaction).toBeNull()
    expect(E.describe(r)).toHaveLength(3)
  })

  test('the bar rises with the number of horizons and with fewer months', () => {
    expect(E.tBar(3, 19)).toBeGreaterThan(E.tBar(1, 19))
    expect(E.tBar(3, 5)).toBeGreaterThan(E.tBar(3, 50))
    expect(E.tBar(1, 1e6)).toBeCloseTo(1.96, 2)
  })
})
