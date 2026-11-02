'use strict'

// The Agent Desk: a supervised loop with no survival goal, a kill switch, a
// spend cap, proposals that only an admin can apply, and an audit trail.

const fs = require('fs')
const desk = require('../lib/agent-desk')
const sv = require('../lib/strategy-versions')

beforeEach(() => {
  for (const f of [desk.LOG_FILE, desk.STATE_FILE, sv.VERSIONS_LOG]) { try { fs.unlinkSync(f) } catch { /* fresh */ } }
  process.env.AGENT_DESK_ENABLED = 'true'
  delete process.env.AGENT_MONTHLY_BUDGET_USD
})
afterAll(() => { delete process.env.AGENT_DESK_ENABLED })

const ENTRY = { id: 'lib1', symbol: 'TEST', strategy: 'sma_crossover', params: { fastPeriod: 3, slowPeriod: 10 }, name: 'sma_crossover on TEST', fitness: 10, status: 'active' }
const PROMOTED = {
  status: 'promoted', reason: 'beat its parent', version: 'v1.1', parentVersion: 'v1.0', change: 'skip entries when the 20-day z-score is above 1', hypothesis: 'it lost when stretched', source: 'diagnosis',
  filter: { op: '<=', left: { feature: 'zscore20' }, right: { const: 1 } }, checks: [{ check: 'validation', pass: true }],
  parent: { val: { totalReturn: 1 }, test: { totalReturn: 2 } }, candidate: { val: { totalReturn: 5, alpha: 3, sharpe: 1.1, trades: 4 }, test: { totalReturn: 6, alpha: 4, sharpe: 1.2, trades: 3, totalReturn2: 0 } },
  diagnosis: { trades: 30, metrics: {}, findings: [{ key: 'stretched-up', state: 'stretched up', trades: 8, avgPnlPct: -2, othersAvgPnlPct: 1, filter: {} }] },
}

function fakeLibrary(entries) {
  const rows = [...entries]
  return {
    rows,
    readLibrary: () => { const m = new Map(); for (const r of rows) m.set(r.id, r); return [...m.values()] },
    appendEntry: e => { rows.push(e); return true },
    buildEntry: require('../lib/strategy-library').buildEntry,
  }
}
const deps = (over = {}) => ({
  library: fakeLibrary([ENTRY]),
  fetchBars: async () => [{ t: 0, c: 1 }],
  toSeries: () => ({ closes: [] }),
  costBps: () => 10,
  versions: { ...sv, improve: () => PROMOTED },
  callModel: async () => { throw new Error('the model must not be called when a fix was already promoted') },
  brainInputs: async () => ({ stats: { exitQuality: { ready: true, winnersNearStop: { rate: 0.45, lo: 0.35, hi: 0.55, n: 60 } } } }),
  byMethod: () => ({ single: { n: 60, winRate: 0.4 }, debate: { n: 60, winRate: 0.75 } }),
  ...over,
})

test('off by default and pausable; a paused desk does nothing', async () => {
  delete process.env.AGENT_DESK_ENABLED
  expect(await desk.runCycle({ deps: deps() })).toMatchObject({ ran: false, reason: expect.stringMatching(/AGENT_DESK_ENABLED/) })
  process.env.AGENT_DESK_ENABLED = 'true'
  desk.pause({ by: 'admin@test', reason: 'holiday' })
  expect(await desk.runCycle({ deps: deps() })).toMatchObject({ ran: false, reason: expect.stringMatching(/paused by admin@test — holiday/) })
  desk.resume({ by: 'admin@test' })
  expect(desk.stopReason()).toBeNull()
  expect(desk.readLog().map(r => r.kind)).toEqual(['pause', 'resume'])
})

test('a cycle covers strategies, the Brain and Research, and only PROPOSES', async () => {
  const d = deps()
  const out = await desk.runCycle({ deps: d })
  expect(out.ran).toBe(true)
  expect(out.steps.map(s => s.name)).toEqual(['impact', 'strategy', 'brain', 'research'])
  expect(out.proposals.map(p => p.type).sort()).toEqual(['brain-finding', 'research-default-method', 'strategy-version'])
  // Nothing applied: the library is untouched and the research default is unchanged.
  expect(d.library.rows).toHaveLength(1)
  expect(desk.researchDefaultMethod()).toBe('single')
  expect(sv.loadVersions()[0]).toMatchObject({ strategyId: 'lib1', status: 'promoted', version: 'v1.1' })
  // A rerun does not queue the same proposals twice.
  const again = await desk.runCycle({ deps: d })
  expect(again.proposals).toHaveLength(0)
})

test('approving a strategy version adds it to the library with lineage and retires the parent; approving a method sets the default', async () => {
  const d = deps()
  await desk.runCycle({ deps: d })
  const props = desk.proposalsOf(desk.readLog())
  const sp = props.find(p => p.type === 'strategy-version')
  const row = desk.decide(sp.id, 'approved', { by: 'admin@test', deps: { library: d.library, versions: sv } })
  expect(row.applied).toMatchObject({ version: 'v1.1', retired: 'lib1' })
  const lib = d.library.readLibrary()
  expect(lib.find(e => e.id === 'lib1').status).toBe('retired')
  expect(lib.find(e => e.version === 'v1.1')).toMatchObject({ lineage: { parentId: 'lib1', version: 'v1.1' }, params: { filter: { op: '<=' } } })
  expect(() => desk.decide(sp.id, 'approved', { by: 'admin@test' })).toThrow(/already approved/)

  const rp = props.find(p => p.type === 'research-default-method')
  desk.decide(rp.id, 'approved', { by: 'admin@test' })
  expect(desk.researchDefaultMethod()).toBe('debate')
  const bp = props.find(p => p.type === 'brain-finding')
  expect(desk.decide(bp.id, 'rejected', { by: 'admin@test', note: 'known' }).applied).toBeNull()
})

test('the spend cap stops model calls; the env can never raise it past the ceiling', async () => {
  const audit = require('../lib/ai-audit')
  process.env.AGENT_MONTHLY_BUDGET_USD = '0'
  let asked = 0
  const reverted = { ...PROMOTED, status: 'reverted', version: null }
  await desk.runCycle({ deps: deps({ versions: { ...sv, improve: () => reverted }, callModel: async () => { asked++; return { filters: [] } } }) })
  expect(asked).toBe(0)
  expect(desk.readLog().some(r => r.kind === 'budget-stop')).toBe(true)
  expect(sv.loadVersions().at(-1).modelNote).toMatch(/budget/)

  process.env.AGENT_MONTHLY_BUDGET_USD = '1000000'
  expect(desk.budgetUsd()).toBe(desk.BUDGET_CEILING_USD)
  expect(desk.budgetStatus(new Date(), { spendSince: () => ({ costUsd: 1 }) })).toMatchObject({ spentUsd: 1, exhausted: false })
  expect(typeof audit.spendSince).toBe('function')
})

test('a pause during a cycle stops it at the next step', async () => {
  const d = deps({ brainInputs: async () => { desk.pause({ by: 'admin@test' }); return {} } })
  const out = await desk.runCycle({ deps: d })
  expect(out.steps.map(s => s.name)).toEqual(['impact', 'halted'])
  expect(out.steps.at(-1).reason).toMatch(/paused/)
})

describe('ledger — no survival goal', () => {
  const hist = (n, from, step) => Array.from({ length: n }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, equity: from + i * step }))
  const now = new Date('2026-11-25T12:00:00Z')
  test('too early under 15 days of results', () => {
    expect(desk.ledger({ aiMonthUsd: 3, equityHistory: hist(5, 100_000, 10), now }).verdict).toBe('too-early')
  })
  test('when it does not cover its costs, it recommends scaling down', () => {
    const L = desk.ledger({ aiMonthUsd: 40, infraMonthUsd: 20, equityHistory: [{ date: '2026-10-31', equity: 100_000 }, ...hist(20, 100_000, -5)], now })
    expect(L).toMatchObject({ verdict: 'does-not-cover', costs: { totalUsd: 60 } })
    expect(L.recommendation).toMatch(/lower its budget|pause it/)
  })
  test('paper P&L scales to the notional size and is called a simulation, not income', () => {
    const L = desk.ledger({ aiMonthUsd: 5, equityHistory: [{ date: '2026-10-31', equity: 100_000 }, ...hist(20, 100_000, 50)], notionalUsd: 10_000, now })
    expect(L.value).toMatchObject({ paperPnl: 950, atNotional: 95 })
    expect(L.verdict).toBe('covers-costs')
    expect(L.recommendation).toMatch(/simulation/)
  })
})

test('research: a default is proposed only when the 95% intervals separate', () => {
  expect(desk.researchFinding({ single: { n: 10, winRate: 0.4 }, debate: { n: 10, winRate: 0.8 } }).verdict).toBe('insufficient')
  expect(desk.researchFinding({ single: { n: 40, winRate: 0.5 }, debate: { n: 40, winRate: 0.6 } }).verdict).toBe('no-clear-difference')
  expect(desk.researchFinding({ single: { n: 80, winRate: 0.35 }, debate: { n: 80, winRate: 0.7 } })).toMatchObject({ verdict: 'debate-better', method: 'debate' })
})

test('strategies examined in the last 14 days are not re-examined; weakest first', () => {
  const now = Date.parse('2026-11-20T00:00:00Z')
  const lib = [{ id: 'a', fitness: 50 }, { id: 'b', fitness: 5 }, { id: 'c', fitness: 1, status: 'retired' }, { id: 'd', fitness: 3 }]
  expect(desk.strategiesToImprove(lib, [{ strategyId: 'd', at: '2026-11-15T00:00:00Z' }], { now }).map(e => e.id)).toEqual(['b', 'a'])
})

describe('impact — did approved changes help?', () => {
  const { rng } = require('../lib/quant/linalg')
  const toSeries = require('../lib/brain-evolution').toSeries
  // 600 daily bars ending today; a choppy random walk so the SMA rule trades.
  const bars = (() => { const r = rng(11); let p = 100; const end = Date.now(); return Array.from({ length: 600 }, (_, i) => { p *= Math.exp(0.0002 + 0.015 * r.normal()); return { t: end - (599 - i) * 86_400_000, o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1e6 } }) })()

  test('a version approved today is too early; one approved 200 days ago is traded forward against its retired parent', async () => {
    const lib = fakeLibrary([ENTRY])
    const base = { strategyId: 'lib1', symbol: 'TEST', status: 'approved', libraryId: 'v11', version: 'v1.1', parentVersion: 'v1.0', change: 'skip stretched entries', filter: { op: '<=', left: { feature: 'zscore20' }, right: { const: 1 } }, parentSpec: { strategy: 'sma_crossover', params: { fastPeriod: 3, slowPeriod: 10 }, symbol: 'TEST' } }
    sv.appendVersion({ ...base, id: 'e-new', approvedAt: new Date().toISOString() })
    sv.appendVersion({ ...base, id: 'e-old', approvedAt: new Date(Date.now() - 200 * 86_400_000).toISOString() })
    const out = await desk.measureImpact({ fetchBars: async () => bars, toSeries, costBps: () => 10, versions: sv, library: lib, brain: {} })
    const byId = Object.fromEntries(out.strategies.map(x => [x.experimentId, x]))
    expect(byId['e-new'].verdict).toBe('too-early')
    expect(['helped', 'hurt', 'same', 'no-trades-yet']).toContain(byId['e-old'].verdict)
    if (byId['e-old'].versionResult) expect(byId['e-old'].excessPct).toBeCloseTo(byId['e-old'].versionResult.totalReturn - byId['e-old'].parent.totalReturn, 1)
    expect(out.summary.tooEarly).toBeGreaterThanOrEqual(1)
  })

  test('research default: before vs after the approval, too early under 20 resolved', () => {
    const at = '2026-10-01T00:00:00Z'
    const row = (day, win, method = 'debate') => ({ surface: 'research', at: `2026-${day}T00:00:00Z`, action: 'buy', meta: { method }, outcome: { retPct: win ? 2 : -2 } })
    const before = Array.from({ length: 40 }, (_, i) => row('09-0' + ((i % 9) + 1), i % 4 === 0, 'single'))
    const afterFew = Array.from({ length: 10 }, (_, i) => row('10-1' + (i % 9), true))
    expect(desk.researchImpact([...before, ...afterFew], at, 'debate').verdict).toBe('too-early')
    const afterMany = Array.from({ length: 40 }, (_, i) => row('10-1' + (i % 9), i % 5 !== 0))
    const r = desk.researchImpact([...before, ...afterMany], at, 'debate')
    expect(r).toMatchObject({ verdict: 'helped', before: { n: 40 }, after: { n: 40 }, afterDefault: { n: 40 } })
  })

  test('an acknowledged finding is re-measured: then vs now, resolved when it no longer fires', async () => {
    await desk.runCycle({ deps: deps() })
    const bp = desk.proposalsOf(desk.readLog()).find(p => p.type === 'brain-finding')
    expect(bp.metric).toMatchObject({ value: 0.45, better: 'lower' })
    desk.decide(bp.id, 'approved', { by: 'admin@test' })
    const better = { stats: { exitQuality: { ready: true, winnersNearStop: { rate: 0.38, lo: 0.31, hi: 0.45, n: 90 } } } }
    let out = await desk.measureImpact({ fetchBars: async () => [], toSeries, costBps: () => 10, versions: sv, library: fakeLibrary([]), brain: better })
    expect(out.brain[0]).toMatchObject({ then: 0.45, now: 0.38, verdict: 'improving' })
    out = await desk.measureImpact({ fetchBars: async () => [], toSeries, costBps: () => 10, versions: sv, library: fakeLibrary([]), brain: {} })
    expect(out.brain[0].verdict).toBe('resolved')
    expect(desk.impactHeadline(out)).toMatch(/1 of 1 findings improving/)
  })
})
