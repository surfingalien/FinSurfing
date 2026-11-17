'use strict'
/** lib/strategy-paper.js — the strategy paper desk; plus the drawdown gate and the funnel it feeds. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const SP = require('../lib/strategy-paper')
const SE = require('../lib/strategy-evidence')
const SB = require('../lib/strategy-brain')
const { simulateWithSignals } = require('../utils/backtest')

const DAY = 86400
const T0 = Math.floor(Date.UTC(2026, 0, 5) / 1000)
/** n daily bars; closes from f(i); open = previous close. */
function series(n, f) {
  const closes = Array.from({ length: n }, (_, i) => f(i))
  return { timestamps: closes.map((_, i) => T0 + i * DAY), closes, opens: closes.map((c, i) => (i ? closes[i - 1] : c)), highs: closes, lows: closes, volumes: closes.map(() => 1e6) }
}
const entry = (id = 's1', extra = {}) => ({ id, symbol: 'AAA', strategy: 'test_rule', params: {}, name: `rule ${id}`, fitness: 50, status: 'active', ...extra })
/** deps: signals are given per bar index of the FULL series. */
const depsWith = sig => ({ signalsFor: (_spec, s) => s.closes.map((_, i) => sig(i)), simulate: simulateWithSignals, execOptions: () => ({}) })
/** Enrolled so that bar index `k` is the first bar after enrolment. */
const enrolledAt = k => new Date((T0 + (k - 1) * DAY) * 1000 + 3600_000).getTime()

describe('enrol', () => {
  test('one program per active strategy, best fitness first, never more than the cap running, never twice', () => {
    const store = { programs: {} }
    const lib = [entry('a', { fitness: 10 }), entry('b', { fitness: 90 }), entry('c', { fitness: 50 }), entry('dead', { status: 'retired', fitness: 99 })]
    expect(SP.enrol(store, lib, { maxRunning: 2 })).toEqual(['b', 'c'])
    expect(SP.enrol(store, lib, { maxRunning: 2 })).toEqual([])
    expect(SP.enrol(store, lib, { maxRunning: 3 })).toEqual(['a'])
    expect(store.programs.b.spec).toEqual({ symbol: 'AAA', strategy: 'test_rule', params: {} })   // the spec is copied: the library drops retired entries
    expect(store.programs.dead).toBeUndefined()
  })
})

describe('step', () => {
  test('only bars after enrolment are traded, and a recorded day is never rewritten', () => {
    const s = series(60, i => 100 + i)                                   // steady rise
    let p = SP.newProgram(entry(), enrolledAt(30))
    const deps = depsWith(i => (i === 31 ? 1 : 0))                         // buy signal on the 2nd day after enrolment
    const cut = k => ({ timestamps: s.timestamps.slice(0, k), closes: s.closes.slice(0, k), opens: s.opens.slice(0, k), highs: s.highs.slice(0, k), lows: s.lows.slice(0, k), volumes: s.volumes.slice(0, k) })
    p = SP.step(p, cut(35), { costBps: 0, deps })
    expect(p.days.map(d => d.date)[0]).toBe(new Date((T0 + 30 * DAY) * 1000).toISOString().slice(0, 10))
    expect(p.days).toHaveLength(5)
    expect(p.fills).toEqual([expect.objectContaining({ type: 'buy', date: p.days[2].date })])       // fills at the NEXT bar's open
    const before = JSON.stringify(p.days)
    // History is "revised": every earlier close doubles. Days already recorded must not change.
    const revised = { ...cut(40), closes: cut(40).closes.map((c, i) => (i < 35 ? c * 2 : c)) }
    const p2 = SP.step(p, revised, { costBps: 0, deps })
    expect(JSON.stringify(p2.days.slice(0, 5))).toBe(before)
    expect(p2.days).toHaveLength(10)
    expect(p2.fills).toHaveLength(1)                                       // the same fill is not recorded twice
  })

  test('no bar after enrolment yet: nothing happens', () => {
    const s = series(30, i => 100 + i)
    const p = SP.newProgram(entry(), enrolledAt(40))
    expect(SP.step(p, s, { deps: depsWith(() => 0) })).toBe(p)
  })

  test('graduates: in profit after costs and no deeper a fall than holding', () => {
    const s = series(80, i => 100 * 1.004 ** i)
    const p = SP.step(SP.newProgram(entry(), enrolledAt(30)), s, { costBps: 10, deps: depsWith(i => (i === 30 ? 1 : 0)) })
    expect(p.days).toHaveLength(SP.SESSIONS)
    expect(p.status).toBe('graduated')
    expect(p.result.returnPct).toBeGreaterThan(0)
    expect(p.result.fills).toBe(1)
    expect(p.decidedAt).toBe(p.days[p.days.length - 1].date)
  })

  test('fails when it loses money, and says how much', () => {
    const s = series(80, i => 100 * 0.995 ** i)
    const p = SP.step(SP.newProgram(entry(), enrolledAt(30)), s, { costBps: 10, deps: depsWith(i => (i === 30 ? 1 : 0)) })
    expect(p.status).toBe('failed')
    expect(p.reason).toMatch(/ended -\d/)
  })

  test('fails when it made money but fell further than holding the stock', () => {
    // The stock only rises; the rule's own equity is what is judged, so use a simulate stub with a deep dip.
    const s = series(80, i => 100 + i * 0.01)
    const sim = (ts) => ({ trades: [{ type: 'buy', date: new Date(ts[1] * 1000).toISOString().slice(0, 10), price: 100, shares: 10 }],
      equity: ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: i === 5 ? 8000 : 10000 + i })) })
    const p = SP.step(SP.newProgram(entry(), enrolledAt(30)), s, { deps: { signalsFor: (_e, x) => x.closes.map(() => 0), simulate: sim, execOptions: () => ({}) } })
    expect(p.status).toBe('failed')
    expect(p.reason).toMatch(/deeper than holding/)
  })

  test('never held a position: no-trades, neither a pass nor a fail', () => {
    const s = series(80, i => 100 + i)
    const p = SP.step(SP.newProgram(entry(), enrolledAt(30)), s, { deps: depsWith(() => 0) })
    expect(p.status).toBe('no-trades')
    expect(p.result.returnPct).toBe(0)
    // A decided program is left alone on later runs.
    expect(SP.step(p, series(120, i => 1 + i), { deps: depsWith(() => 1) })).toBe(p)
  })
})

describe('run and summary', () => {
  test('a symbol with no data waits — an outage is never a failed strategy', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), 'paper.json')
    const s = series(80, i => 100 * 1.004 ** i)
    const bars = s.closes.map((c, i) => ({ t: s.timestamps[i] * 1000, o: s.opens[i], h: c, l: c, c, v: 1e6 }))
    const lib = [entry('good'), entry('nodata', { symbol: 'ZZZ' })]
    const deps = { library: { readLibrary: () => lib }, fetchBars: async sym => (sym === 'AAA' ? bars : []), costBps: () => 10, ...depsWith(i => (i === 30 ? 1 : 0)) }
    const r = await SP.run({ deps, file, now: enrolledAt(30) })
    expect(r).toEqual(expect.objectContaining({ enrolled: 2, noData: ['ZZZ'], decided: 1 }))
    const sum = SP.summary(SP.read(file))
    expect(sum.counts).toEqual({ running: 1, graduated: 1, failed: 0, noTrades: 0 })
    expect(sum.graduationRate).toBe(1)
    expect(sum.running[0]).toEqual(expect.objectContaining({ id: 'nodata', sessions: 0, status: 'running' }))
    expect(sum.decided[0].curve).toHaveLength(SP.SESSIONS)
    expect((await SP.run({ deps, file, now: enrolledAt(30) })).enrolled).toBe(0)     // a second run enrols nothing new
  })

  test('the graduation rate ignores programs that never traded, and is null before any is judged', () => {
    const mk = (id, status) => ({ id, symbol: 'A', name: id, spec: {}, capital: 10000, days: [], fills: [], status, decidedAt: '2026-02-01' })
    expect(SP.summary({ programs: { a: mk('a', 'running'), b: mk('b', 'no-trades') } }).graduationRate).toBeNull()
    expect(SP.summary({ programs: { a: mk('a', 'graduated'), b: mk('b', 'failed'), c: mk('c', 'failed'), d: mk('d', 'no-trades') } }).graduationRate).toBeCloseTo(0.333, 3)
  })

  test('decided programs beyond the cap are dropped oldest first; running ones never', () => {
    const programs = {}
    for (let i = 0; i < 5; i++) programs[`d${i}`] = { id: `d${i}`, status: 'failed', decidedAt: `2026-01-0${i + 1}` }
    programs.r = { id: 'r', status: 'running', decidedAt: null }
    expect(Object.keys(SP.prune({ programs }, { maxKept: 2 }).programs).sort()).toEqual(['d3', 'd4', 'r'])
  })
})

describe('drawdown limit', () => {
  test('relative to holding: deeper fails, shallower passes, missing figures never block', () => {
    const closes = [100, 120, 90, 130]                       // buy & hold's worst fall: 25%
    expect(SE.maxDrawdownPct(closes)).toBe(25)
    expect(SE.drawdownCheck(30, closes)).toEqual({ strategy: 30, buyHold: 25, deeper: true })
    expect(SE.drawdownCheck(10, closes).deeper).toBe(false)
    expect(SE.drawdownCheck(undefined, closes)).toBeNull()
    expect(SE.drawdownCheck(10, [100, 101, 102])).toBeNull()   // holding never fell: nothing to compare with
    expect(SE.evidenceProblem({ drawdown: SE.drawdownCheck(30, closes) })).toMatch(/deeper than buy & hold's \(25%\)/)
    expect(SE.evidenceProblem({ drawdown: SE.drawdownCheck(10, closes) })).toBeNull()
    expect(SE.evidenceProblem({})).toBeNull()
    const card = SE.reportCard({ drawdown: SE.drawdownCheck(30, closes) })
    expect(card.rows.find(r => r.key === 'drawdown')).toEqual(expect.objectContaining({ status: 'fail', value: 'worst fall 30% vs 25% for buy & hold' }))
    expect(SE.reportCard({}).rows.find(r => r.key === 'drawdown').status).toBe('na')
  })

  test('every evaluated strategy carries it', () => {
    const SL = require('../lib/strategy-lab')
    const n = 400, closes = Array.from({ length: n }, (_, i) => 100 + 20 * Math.sin(i / 15) + i * 0.05)
    const ts = closes.map((_, i) => T0 + i * DAY)
    const sig = closes.map((_, i) => (i % 40 === 5 ? 1 : i % 40 === 25 ? -1 : 0))
    const e = SL.evaluateSignals(ts, closes, sig, { costBps: 10 })
    expect(e.drawdown).toEqual(expect.objectContaining({ strategy: e.metrics.maxDrawdown, buyHold: SE.maxDrawdownPct(closes) }))
  })
})

describe('funnel', () => {
  test('each idea is counted at the first check it failed; untestable ones are kept apart', () => {
    const arms = {
      a: { admitted: 2, reasons: { 'not validated (rejected)': 60, 'deflated Sharpe below the luck benchmark': 10, 'too few trades to judge (4 < 20)': 20, 'batch overfits (PBO)': 5, 'not enough price history': 3 } },
      b: { admitted: 1, reasons: { 'not validated (mixed)': 30, "its worst drawdown (40%) is deeper than buy & hold's (25%)": 2, 'selection does not generalise (CPCV median path Sharpe # )': 1, 'error: boom': 4 } },
    }
    const lib = [
      { origin: { by: 'strategy-brain' }, status: 'active', validations: [{ forward: true, score: 80 }] },
      { origin: { by: 'strategy-brain' }, status: 'active', validations: [{ forward: true, score: 10 }] },
      { origin: { by: 'strategy-brain' }, status: 'retired', validations: [] },
      { origin: { by: 'evolution' }, status: 'active', validations: [{ forward: true, score: 90 }] },
    ]
    const f = SB.funnel(arms, lib, { counts: { running: 1, graduated: 1, failed: 0, noTrades: 0 } })
    expect(f.tested).toBe(131)
    expect(f.notTestable).toBe(7)
    expect(f.stages.map(s => [s.id, s.killed, s.survivors])).toEqual([['oos', 90, 41], ['luck', 10, 31], ['evidence', 22, 9], ['selection', 6, 3]])
    expect(f.admitted).toBe(3)
    expect(f.stages[f.stages.length - 1].survivors).toBe(f.admitted)        // what survives every check is what was admitted
    expect(f).toEqual(expect.objectContaining({ stillActive: 2, forwardProven: 1 }))
    expect(f.paper).toEqual({ running: 1, graduated: 1, failed: 0, noTrades: 0 })
  })
  test('nothing run yet: zeros, not NaN', () => {
    const f = SB.funnel({}, [], null)
    expect(f).toEqual(expect.objectContaining({ tested: 0, admitted: 0, stillActive: 0, paper: null }))
    expect(f.stages.every(s => s.killed === 0 && s.survivors === 0)).toBe(true)
  })
})
