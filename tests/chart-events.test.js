const C = require('../lib/chart-events')

describe('chartEvents', () => {
  const recent = {
    form:       ['8-K', '10-Q', '8-K', '8-K/A', '10-K', '4', '8-K'],
    filingDate: ['2026-10-30', '2026-10-31', '2026-09-01', '2026-08-02', '2026-02-01', '2026-01-05', '2026-10-30'],
    items:      ['2.02,9.01', '', '5.02', '2.02', '', '', '2.02'],
  }
  test('earnings releases, periodic filings and theses, oldest first, one per day and kind', () => {
    const ev = C.chartEvents({ recent, theses: [{ at: '2026-06-15T14:00:00Z', judgement: { verdict: 'actionable' } }, { at: '2026-07-01T10:00:00Z', judgement: { verdict: 'no-trade' } }] })
    expect(ev.map(e => [e.date, e.kind])).toEqual([
      ['2026-02-01', 'filing'], ['2026-06-15', 'thesis'], ['2026-07-01', 'thesis'], ['2026-10-30', 'earnings'], ['2026-10-31', 'filing'],
    ])
    expect(ev[1].text).toMatch(/actionable/)
    expect(ev[2].text).toMatch(/no trade/)
  })
  test('`from` drops older events; nothing to read is an empty list', () => {
    expect(C.chartEvents({ recent, from: '2026-10-01' }).map(e => e.date)).toEqual(['2026-10-30', '2026-10-31'])
    expect(C.chartEvents()).toEqual([])
    expect(C.chartEvents({ recent: { form: ['10-K'] } })).toEqual([])
  })
  test('alerts carry their message, cut short', () => {
    const [a] = C.chartEvents({ alerts: [{ at: '2026-03-03T15:00:00Z', message: 'x'.repeat(200) }] })
    expect(a.kind).toBe('alert')
    expect(a.text.length).toBeLessThan(100)
  })
})

describe('snapMarkers', () => {
  const days = ['2026-01-05', '2026-01-06', '2026-01-09', '2026-01-12']
  test('a non-session day lands on the next session; a session day stays', () => {
    const { markers, dropped } = C.snapMarkers([{ date: '2026-01-07', kind: 'filing' }, { date: '2026-01-06', kind: 'earnings' }, { date: '2026-01-10', kind: 'thesis' }], days)
    expect(markers.map(m => [m.time, m.kind])).toEqual([['2026-01-06', 'earnings'], ['2026-01-09', 'filing'], ['2026-01-12', 'thesis']])
    expect(dropped).toBe(0)
  })
  test('events outside the drawn range are dropped and counted, never pinned to an edge', () => {
    const { markers, dropped } = C.snapMarkers([{ date: '2025-12-31', kind: 'filing' }, { date: '2026-01-13', kind: 'filing' }, { date: 'soon', kind: 'x' }], days)
    expect(markers).toEqual([])
    expect(dropped).toBe(3)
    expect(C.snapMarkers([{ date: '2026-01-05', kind: 'x' }], []).dropped).toBe(1)
  })
})

describe('planLevels', () => {
  test('the plan grid as lines; a missing or zero level is left out', () => {
    const plan = { entry: { low: 98, high: 101 }, stop: { price: 92 }, booking: [{ label: 'T1 — book partial profit', price: 110 }, { label: 'T2 — target', price: 120 }, { label: 'T3', price: 0 }] }
    expect(C.planLevels(plan)).toEqual([
      { price: 101, label: 'Entry high', role: 'entry' }, { price: 98, label: 'Entry low', role: 'entry' },
      { price: 92, label: 'Stop', role: 'stop' }, { price: 110, label: 'T1', role: 'target' }, { price: 120, label: 'T2', role: 'target' },
    ])
    expect(C.planLevels(null)).toEqual([])
    expect(C.planLevels({ stop: { price: NaN } })).toEqual([])
  })
})

describe('indexSeries', () => {
  const s = (pairs) => pairs.map(([date, close]) => ({ date, close }))
  test('percent change from the first day all symbols share', () => {
    const r = C.indexSeries({
      A: s([['2026-01-02', 50], ['2026-01-05', 100], ['2026-01-06', 110], ['2026-01-07', 120]]),
      B: s([['2026-01-05', 200], ['2026-01-06', 190], ['2026-01-07', 210], ['2026-01-08', 400]]),
    })
    expect(r.from).toBe('2026-01-05')
    expect(r.days).toBe(3)
    expect(r.series.find(x => x.symbol === 'A').points.map(p => p.value)).toEqual([0, 10, 20])
    expect(r.series.find(x => x.symbol === 'B').points.map(p => p.value)).toEqual([0, -5, 5])
  })
  test('a symbol with no usable history is named, not drawn flat', () => {
    const r = C.indexSeries({ A: s([['2026-01-05', 100], ['2026-01-06', 110]]), EMPTY: [] })
    expect(r.skipped).toEqual(['EMPTY'])
    expect(r.series).toHaveLength(1)
  })
  test('no shared days: nothing to draw', () => {
    expect(C.indexSeries({ A: s([['2026-01-05', 1], ['2026-01-06', 2]]), B: s([['2026-02-05', 1], ['2026-02-06', 2]]) }).series).toEqual([])
  })
})
