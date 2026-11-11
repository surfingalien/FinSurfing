'use strict'
/**
 * lib/agentic-overview.js — the Agentic OS page's brain. Pure, so every rule is
 * pinned here without a server.
 *
 * What matters and why:
 *  - a job's "never run" after a deploy is `waiting`, not `healthy` and not `failing`;
 *  - an off or paused agent is never reported as failing;
 *  - a source that could not load is LISTED, never counted as all-clear;
 *  - every scheduled job belongs to an agent (a new job cannot silently vanish from the page);
 *  - configured is not working, and a key never appears in the output.
 */
const fs = require('fs')
const path = require('path')
const O = require('../lib/agentic-overview')

const NOW = new Date('2026-11-11T12:00:00Z')
const job = (id, o = {}) => ({ id, name: o.name || id, description: '', scheduleText: o.schedule || 'Daily at 09:00', enabled: o.enabled !== false, result: { status: o.status || 'idle', lastRun: o.lastRun ?? null, durationMs: o.durationMs ?? null, error: o.error ?? null } })
const T = (h) => new Date(`2026-11-11T${h}:00Z`).getTime()

describe('every scheduled job belongs to an agent', () => {
  test('all ids registered in lib/scheduled-jobs.js are in AGENTS, and no id is claimed twice', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/scheduled-jobs.js'), 'utf8')
    const registered = [...src.matchAll(/scheduler\.register\('([\w-]+)'/g)].map(m => m[1])
    expect(registered.length).toBeGreaterThan(20)
    const claimed = O.AGENTS.flatMap(a => a.jobs)
    expect(registered.filter(id => !claimed.includes(id))).toEqual([])
    expect(claimed.filter(id => !registered.includes(id))).toEqual([])   // no stale ids either
    expect(new Set(claimed).size).toBe(claimed.length)
  })
})

describe('agentState priority', () => {
  const def = { killSwitch: 'aiBrain' }
  const J = (status, extra = {}) => O.normalizeJob(job('x', { name: 'X', status, ...extra }))
  test('never run since restart is waiting; ran is healthy', () => {
    expect(O.agentState({}, [J('idle')], {}).state).toBe('waiting')
    expect(O.agentState({}, [J('done', { lastRun: T('10:00') })], {}).state).toBe('healthy')
  })
  test('failed names the job and its error', () => {
    const r = O.agentState({}, [J('failed', { lastRun: T('10:00'), error: 'boom' })], {})
    expect(r.state).toBe('failing')
    expect(r.detail).toMatch(/X failed: boom/)
  })
  test('off and paused outrank a failed last run; running outranks failing', () => {
    const failed = J('failed', { lastRun: T('10:00'), error: 'boom' })
    expect(O.agentState(def, [failed], { killSwitches: { aiBrain: true } }).state).toBe('off')
    expect(O.agentState({}, [failed], { switchedOff: 'Off — env' }).state).toBe('off')
    expect(O.agentState({}, [failed], { paused: true, pausedDetail: 'Paused by ana.' }).state).toBe('paused')
    expect(O.agentState({}, [failed], { running: true }).state).toBe('running')
    expect(O.agentState({}, [J('running', { lastRun: T('10:00') })], {}).state).toBe('running')
  })
  test('every job disabled is off', () => {
    expect(O.agentState({}, [O.normalizeJob(job('x', { enabled: false }))], {}).state).toBe('off')
  })
})

describe('buildAgents', () => {
  const desk = (o = {}) => ({ enabled: true, paused: false, running: false, proposals: [], lastCycle: { at: '2026-11-11T04:10:00Z' }, paper: { enabled: true, performance: { openPositions: 3 }, protections: {} }, ...o })
  const brain = (o = {}) => ({ enabled: true, paused: false, running: false, strategies: [{}, {}], runs: [{ at: '2026-11-11T03:40:00Z' }], ...o })
  const build = (o = {}) => O.buildAgents({ jobs: (o.jobs || []).map(O.normalizeJob), desk: o.desk === undefined ? desk() : o.desk, brain: o.brain === undefined ? brain() : o.brain, killSwitches: o.kill || {} })
  const get = (agents, id) => agents.find(a => a.id === id)

  test('own switches drive their agents; metrics come from the real status', () => {
    const a = build({ desk: desk({ enabled: false }), brain: brain({ paused: true, pausedBy: 'ana' }) })
    expect(get(a, 'agent-desk')).toMatchObject({ state: 'off' })
    expect(get(a, 'agent-desk').detail).toMatch(/AGENT_DESK_ENABLED/)
    expect(get(a, 'strategy-brain')).toMatchObject({ state: 'paused', metric: { label: 'Strategies found', value: '2' } })
    expect(get(a, 'paper').metric).toMatchObject({ label: 'Open positions', value: '3' })
  })
  test('paper trading off, and paused by a protection, are distinct', () => {
    expect(get(build({ desk: desk({ paper: { enabled: false } }) }), 'paper').state).toBe('off')
    const paused = get(build({ desk: desk({ paper: { enabled: true, performance: {}, protections: { global: { kind: 'daily-loss', reason: 'down 2.1% today' } } } }) }), 'paper')
    expect(paused.state).toBe('paused')
    expect(paused.detail).toMatch(/down 2.1%/)
  })
  test('pending proposals show on the Agent Desk card as a warn metric', () => {
    const a = get(build({ desk: desk({ proposals: [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }] }) }), 'agent-desk')
    expect(a.metric).toMatchObject({ label: 'Awaiting your approval', value: '2', tone: 'warn' })
  })
  test('a status that failed to load is waiting with the reason, never healthy', () => {
    const a = build({ desk: null, brain: null })
    expect(get(a, 'agent-desk')).toMatchObject({ state: 'waiting', detail: expect.stringMatching(/could not be loaded/) })
    expect(get(a, 'strategy-brain').state).toBe('waiting')
  })
  test('schedules read in Eastern Time, short', () => {
    expect(O.normalizeJob(job('x', { schedule: 'Daily at 08:30 America/New_York, Mon–Fri' })).scheduleText).toBe('Daily at 08:30 ET, Mon–Fri')
  })
  test('last run and counts come from the agent’s jobs', () => {
    const a = get(build({ jobs: [job('pre-market-scan', { status: 'done', lastRun: T('08:30') }), job('hourly-ai-scan', { status: 'failed', lastRun: T('11:00'), error: 'x' }), job('brain-learning-cycle')] }), 'ai-brain')
    expect(a.jobs).toEqual({ total: 3, ok: 1, failed: 1, running: 0, idle: 1 })
    expect(a.lastRunAt).toBe('2026-11-11T11:00:00.000Z')
    expect(a.state).toBe('failing')
  })
  test('the AI Brain kill switch turns it off', () => {
    expect(get(build({ kill: { aiBrain: true } }), 'ai-brain').state).toBe('off')
  })
})

describe('attention', () => {
  const base = { jobs: [], desk: null, brain: null, spend: null, ai: { claude: true, groq: true }, breakers: [], killSwitches: {}, persistence: null, alerts: [], unavailable: [] }
  const run = (o) => O.buildAttention({ ...base, ...o })
  const ids = (o) => run(o).map(a => a.id)

  test('quiet when everything is fine', () => { expect(run({})).toEqual([]) })

  test('failed jobs: listed one by one up to 3, then grouped; disabled jobs are ignored', () => {
    const f = (id) => O.normalizeJob(job(id, { status: 'failed', lastRun: T('10:00'), error: 'x' }))
    expect(ids({ jobs: [f('a'), f('b')] })).toEqual(['job:a', 'job:b'])
    expect(ids({ jobs: [f('a'), f('b'), f('c'), f('d')] })).toEqual(['jobs-failing'])
    expect(ids({ jobs: [O.normalizeJob(job('a', { status: 'failed', enabled: false }))] })).toEqual([])
  })
  test('AI providers: none is critical; paused and Claude-less are warnings', () => {
    expect(run({ ai: { claude: false, groq: false } })[0]).toMatchObject({ id: 'no-ai', level: 'critical' })
    expect(run({ ai: { claude: true, groq: true, paused: true, pausedUntil: '2026-12-01' } })[0]).toMatchObject({ id: 'claude-paused', level: 'warn' })
    expect(run({ ai: { claude: true, groq: false, paused: true } })[0].detail).toMatch(/which is not configured/)
    expect(run({ ai: { claude: false, groq: true } })[0]).toMatchObject({ id: 'no-claude', level: 'warn' })
  })
  test('an open circuit breaker is critical; closed ones are silent', () => {
    expect(run({ breakers: [{ name: 'claude', state: 'OPEN', failures: 5, resetInMs: 30000 }, { name: 'groq', state: 'CLOSED' }] }).map(a => a.id)).toEqual(['breaker:claude'])
  })
  test('budget: spent is critical, 80% is a warning, below is silent', () => {
    const sp = (spent) => ({ budget: { capUsd: 5, spentUsd: spent, usedPct: spent / 5 * 100, exhausted: spent >= 5 } })
    expect(run({ spend: sp(5) })[0]).toMatchObject({ id: 'budget', level: 'critical' })
    expect(run({ spend: sp(4.2) })[0]).toMatchObject({ id: 'budget', level: 'warn' })
    expect(run({ spend: sp(3) })).toEqual([])
  })
  test('pending proposals, and ops alerts mapped by severity', () => {
    const r = run({ desk: { proposals: [{ status: 'pending', title: 'Fix X' }, { status: 'approved' }] }, alerts: [{ key: 'paper-pause:daily-loss', severity: 'high', title: 'Daily loss limit hit', detail: 'd' }, { key: 'paper-rejections', severity: 'medium', title: '3 refused' }] })
    expect(r.map(a => [a.id, a.level])).toEqual([['alert:paper-pause:daily-loss', 'critical'], ['proposals', 'warn'], ['alert:paper-rejections', 'warn']])
    expect(r.find(a => a.id === 'proposals').detail).toBe('Fix X')
    expect(r.find(a => a.id === 'alert:paper-pause:daily-loss').action.route.tab).toBe('agent-desk')
  })
  test('lost persistence only matters in production; kill switches and unloadable sources are info', () => {
    expect(ids({ persistence: { enabled: false, production: false, reason: 'dev' } })).toEqual([])
    expect(ids({ persistence: { enabled: false, production: true, reason: 'no DATABASE_URL' } })).toEqual(['persistence'])
    expect(run({ killSwitches: { aiBrain: true }, unavailable: ['AI spend'] }).map(a => [a.id, a.level])).toEqual([['kill:aiBrain', 'info'], ['unavailable:AI spend', 'info']])
  })
  test('sorted worst first', () => {
    const r = run({ ai: { claude: false, groq: false }, killSwitches: { aiBrain: true }, desk: { proposals: [{ status: 'pending' }] } })
    expect(r.map(a => a.level)).toEqual(['critical', 'warn', 'info'])
  })
})

describe('verdict', () => {
  const agents = [{ state: 'healthy' }, { state: 'running' }, { state: 'off' }]
  test('critical beats attention beats ok', () => {
    expect(O.buildVerdict([{ level: 'critical', title: 'T' }, { level: 'warn' }], agents, [])).toMatchObject({ level: 'critical', headline: '1 problem to fix now', detail: 'T' })
    expect(O.buildVerdict([{ level: 'warn', title: 'W' }, { level: 'warn', title: 'W2' }], agents, [])).toMatchObject({ level: 'attention', headline: '2 things need your attention' })
    expect(O.buildVerdict([{ level: 'warn', title: 'W' }], agents, []).headline).toBe('1 thing needs your attention')
  })
  test('a deploy-fresh system is waiting (neutral), not ok; a source that could not load is named, not hidden', () => {
    expect(O.buildVerdict([], agents, [])).toMatchObject({ level: 'waiting', headline: 'Nothing has run since the last restart' })
    expect(O.buildVerdict([], agents, [{ lastRunAt: 'x' }])).toMatchObject({ level: 'ok', headline: 'Everything is running normally', detail: '2 agents active, no failures.' })
    expect(O.buildVerdict([], agents, [{ lastRunAt: 'x' }], ['Agent Desk'])).toMatchObject({ headline: 'No problems found', detail: 'Could not check: Agent Desk.' })
  })
})

describe('spend', () => {
  const audit = { total: 40, successRate: 97.5, totalCostUsd: 12.34, since: '2026-10-01T00:00:00Z', cache: { hitRate: 0.61 },
    byDay: [{ date: '2026-10-30', costUsd: 9, calls: 5 }, { date: '2026-11-02', costUsd: 1.5, calls: 3 }, { date: '2026-11-10', costUsd: 0.5, calls: 2 }],
    routes: { 'ai-brain': { calls: 10, costUsd: 5 }, copilot: { calls: 30, costUsd: 5 }, 'agent-desk': { calls: 2, costUsd: 0.1 } } }
  test('month is summed from the days in the current month only', () => {
    const s = O.buildSpend({ audit, budget: null, now: NOW })
    expect(s.monthUsd).toBe(2)
    expect(s.windowUsd).toBe(12.34)
    expect(s.cacheHitRate).toBe(0.61)
    expect(s.byDay).toHaveLength(3)
  })
  test('top routes by cost, ties by calls; budget percent', () => {
    const s = O.buildSpend({ audit, budget: { capUsd: 5, spentUsd: 1.25, exhausted: false }, now: NOW })
    expect(s.topRoutes.map(r => r.route)).toEqual(['copilot', 'ai-brain', 'agent-desk'])
    expect(s.budget).toEqual({ capUsd: 5, spentUsd: 1.25, usedPct: 25, exhausted: false })
  })
  test('no sources → null; a zero cap never divides by zero', () => {
    expect(O.buildSpend({ audit: null, budget: null, now: NOW })).toBeNull()
    expect(O.buildSpend({ audit: null, budget: { capUsd: 0, spentUsd: 0, exhausted: true }, now: NOW }).budget.usedPct).toBe(0)
  })
})

describe('connections', () => {
  const flat = (c) => Object.fromEntries(c.groups.flatMap(g => g.items).map(i => [i.id, i.state]))
  test('states reflect what is configured; keyless sources are labelled as such', () => {
    const f = flat(O.buildConnections({ env: { anthropic: true, groq: false, finnhub: true, fmp: false, fred: false, database: true, resend: false }, breakers: [], persistence: { enabled: true } }))
    expect(f).toMatchObject({ claude: 'set', groq: 'missing', finnhub: 'set', fmp: 'missing', fred: 'keyless', sec: 'keyless', postgres: 'set', persistence: 'set', email: 'missing' })
  })
  test('Claude paused is its own state; missing persistence carries its reason', () => {
    const c = O.buildConnections({ env: { anthropic: true }, ai: { paused: true, pausedUntil: '2026-12-01' }, persistence: { enabled: false, reason: 'DATABASE_URL not set' } })
    const claude = c.groups[0].items[0]
    expect(claude).toMatchObject({ state: 'paused', note: 'Paused until 2026-12-01' })
    expect(c.groups.flatMap(g => g.items).find(i => i.id === 'persistence').note).toMatch(/DATABASE_URL/)
  })
  test('a secret can never leak: only booleans are read, and no key text reaches the output', () => {
    const out = JSON.stringify(O.buildConnections({ env: { anthropic: 'sk-ant-SECRET', fmp: 'fmp-SECRET' }, breakers: [], persistence: {} }))
    expect(out).not.toMatch(/SECRET/)
  })
  test('breakers are passed through with an upper-cased state', () => {
    const c = O.buildConnections({ env: {}, breakers: [{ name: 'claude', state: 'open', failures: 3, threshold: 5, totalCalls: 9, totalFailures: 4, lastFailureAt: 'x', resetInMs: 100 }] })
    expect(c.breakers[0]).toMatchObject({ name: 'claude', state: 'OPEN', failures: 3 })
  })
})

describe('feed', () => {
  test('one timeline, newest first, limited, with the right levels', () => {
    const jobs = [O.normalizeJob(job('a', { name: 'Scan', status: 'done', lastRun: T('09:00'), durationMs: 90_000 })), O.normalizeJob(job('b', { name: 'Study', status: 'failed', lastRun: T('10:00'), error: 'timeout' })), O.normalizeJob(job('c'))]
    const deskLog = [
      { kind: 'cycle-start', at: '2026-11-11T04:10:00Z', trigger: 'scheduled' },
      { kind: 'proposal', at: '2026-11-11T04:20:00Z', title: 'Tighten filter on AAPL' },
      { kind: 'decision', at: '2026-11-11T08:00:00Z', decision: 'approved', by: 'ana' },
      { kind: 'step', at: '2026-11-11T04:11:00Z', name: 'impact' },     // internal step: not shown
    ]
    const brain = { runs: [{ at: '2026-11-11T03:40:00Z', experiments: [{}, {}, {}], stopped: null }] }
    const f = O.buildFeed({ jobs, deskLog, brain })
    expect(f.map(e => e.at)).toEqual([...f.map(e => e.at)].sort().reverse())
    expect(f.map(e => e.title)).toEqual(['Study failed', 'Scan finished', 'Proposal approved', 'New proposal waiting for approval', 'Agent Desk cycle started', 'Strategy Brain ran 3 experiments'])
    expect(f[0]).toMatchObject({ level: 'fail', detail: 'timeout' })
    expect(f[1].detail).toBe('90s')
    expect(O.buildFeed({ jobs, deskLog, brain, limit: 2 })).toHaveLength(2)
  })
  test('empty inputs are fine', () => { expect(O.buildFeed({ jobs: [] })).toEqual([]) })
})

describe('buildOverview', () => {
  test('empty inputs do not throw and every missing source is listed, not counted as healthy', () => {
    const o = O.buildOverview({ now: NOW })
    expect(o.unavailable).toEqual(['Agent Desk', 'Strategy Brain', 'AI spend'])
    expect(o.verdict.headline).toBe('No problems found')
    expect(o.agents).toHaveLength(O.AGENTS.length)
    expect(o.spend).toBeNull()
    expect(o.kpis).toMatchObject({ agentsTotal: O.AGENTS.length, jobsFailing: 0, pendingApprovals: 0, spendMonthUsd: null })
  })
  test('KPIs add up from the parts', () => {
    const o = O.buildOverview({
      now: NOW,
      jobs: [job('pre-market-scan', { status: 'done', lastRun: T('08:30') }), job('macro-pulse', { status: 'failed', lastRun: T('09:00'), error: 'FRED down' }), job('earnings-watch', { enabled: false })],
      desk: { enabled: true, paused: false, running: false, proposals: [{ status: 'pending', title: 'P' }], budget: { capUsd: 5, spentUsd: 1, exhausted: false }, paper: { enabled: true, performance: {}, protections: {} }, alerts: [] },
      brain: { enabled: true, strategies: [], runs: [] },
      audit: { total: 1, byDay: [{ date: '2026-11-10', costUsd: 0.75, calls: 1 }], routes: {}, cache: {} },
      ai: { claude: true, groq: true }, killSwitches: {}, env: {}, breakers: [], persistence: { enabled: true },
    })
    expect(o.unavailable).toEqual([])
    expect(o.kpis).toMatchObject({ jobsTotal: 2, jobsFailing: 1, pendingApprovals: 1, spendMonthUsd: 0.75 })
    expect(o.verdict.level).toBe('attention')
    expect(o.attention.map(a => a.id)).toEqual(['job:macro-pulse', 'proposals'])
    expect(o.spend.budget.usedPct).toBe(20)
  })
})
