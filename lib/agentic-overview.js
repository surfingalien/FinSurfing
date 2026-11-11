'use strict'
/**
 * Agentic OS overview — one honest answer to "what are the autonomous parts of
 * FinSurfing doing, are they healthy, what do they cost, and what needs me?"
 *
 * PURE: buildOverview() takes the raw status payloads that already exist
 * (scheduler, Agent Desk, Strategy Brain, AI audit, circuit breakers, env flags)
 * and reduces them. routes/agentic-os.js gathers the inputs; nothing here reads
 * a file, the network or process.env, so every rule is tested without a server
 * (tests/agentic-overview.test.js).
 *
 * Three rules the page depends on:
 *  - "Key set" is not "working". Connections report what is CONFIGURED and say so;
 *    live probing stays with the Research Desk's "Is it working?" check.
 *  - The scheduler keeps its run results in memory, so after every deploy every
 *    job reads "never run". That is `waiting`, not `failing` — and not `healthy`
 *    either, because nothing has proved it.
 *  - A source that failed to load is `null` and is LISTED (`unavailable`), never
 *    silently treated as "all clear".
 */

/** The autonomous parts, in the order a person thinks about them. `jobs` are scheduler ids. */
const AGENTS = [
  { id: 'ai-brain', label: 'AI Brain', blurb: 'Scans the market, logs every pick, and learns from how past picks resolved.',
    jobs: ['pre-market-scan', 'hourly-ai-scan', 'brain-learning-cycle'], open: { tab: 'brain-activity' }, killSwitch: 'aiBrain' },
  { id: 'evolution', label: 'Strategy Evolution', blurb: 'Re-tests every saved strategy on fresh data, retires the ones that decayed, discovers new ones.',
    jobs: ['brain-evolution'], open: { tab: 'strategies' } },
  { id: 'strategy-brain', label: 'Strategy Brain', blurb: 'An autonomous researcher that tries new strategy ideas nightly and learns which kinds survive.',
    jobs: ['strategy-brain'], own: 'brain', open: { tab: 'quant-lab', param: 'brain' }, controls: '/api/strategy-brain' },
  { id: 'agent-desk', label: 'Agent Desk', blurb: 'Diagnoses weak strategies and AI Brain problems, then proposes fixes for an admin to approve.',
    jobs: ['agent-desk'], own: 'desk', open: { tab: 'agent-desk' }, controls: '/api/agent-desk' },
  { id: 'paper', label: 'Paper Trader', blurb: 'Trades the AI Brain’s picks with simulated money, with an exit on every position. Never real orders.',
    jobs: ['paper-execute', 'paper-manage'], own: 'paper', open: { tab: 'agent-desk' } },
  { id: 'research', label: 'Research & Briefings', blurb: 'Morning brief, strategy desk, holdings research and the weekly Second Brain email.',
    jobs: ['morning-brief-email', 'strategy-desk-email', 'holdings-research-email', 'second-brain-weekly-email'], open: { tab: 'research-desk' } },
  { id: 'watch', label: 'Market Watch', blurb: 'Macro pulse, earnings, watchlist digest, alt data, intraday focus and entry-zone alerts.',
    jobs: ['macro-pulse', 'earnings-watch', 'watchlist-digest', 'alt-data-refresh', 'intraday-focus-hour', 'intraday-focus-half', 'entry-zone-watch-hour', 'entry-zone-watch-half'], open: { tab: 'macro' } },
  { id: 'studies', label: 'Evidence Studies', blurb: 'Weekly measurements that keep the evidence honest: factors, drift, insiders, 13F, volatility, exposure.',
    jobs: ['vol-forecast-study', 'factor-mining', 'discovery-refresh', 'pead-study', '13f-refresh', 'insider-study', 'exposure-refresh', 'symbol-db-refresh'], open: { tab: 'quant-lab' } },
  { id: 'ops', label: 'Operator Alerts', blurb: 'Watches the paper book, the data feed and the agents’ budget, and emails you once a day per problem.',
    jobs: ['ops-alerts'], open: null },
]

const LEVEL_RANK = { critical: 0, warn: 1, info: 2 }
const iso = (t) => (t == null ? null : new Date(t).toISOString())
const clip = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Scheduler job → the shape the page uses. `status` is one of idle | running | done | failed. */
function normalizeJob(j) {
  const r = j.result || {}
  return {
    id: j.id, name: j.name, description: j.description || '', scheduleText: (j.scheduleText || '').replace(/ ?America\/New_York/g, ' ET'),
    enabled: j.enabled !== false,
    status: r.status || 'idle',
    lastRunAt: iso(r.lastRun),
    durationMs: r.durationMs ?? null,
    error: r.status === 'failed' ? clip(r.error || 'failed', 240) : null,
  }
}

/**
 * The one state an agent card shows. Priority matters: an off or paused agent is
 * not "failing" however its last run ended, and a running one is shown running.
 *   off | paused | running | failing | waiting | healthy
 */
function agentState(def, jobs, own) {
  if (def.killSwitch && own?.killSwitches?.[def.killSwitch]) return { state: 'off', detail: 'Switched off by the operator.' }
  if (own?.switchedOff) return { state: 'off', detail: own.switchedOff }
  if (own?.paused) return { state: 'paused', detail: own.pausedDetail || 'Paused by an admin.' }
  if (own?.running || jobs.some(j => j.status === 'running')) return { state: 'running', detail: 'Running now.' }
  const failed = jobs.find(j => j.status === 'failed')
  if (failed) return { state: 'failing', detail: `${failed.name} failed: ${failed.error}` }
  const enabled = jobs.filter(j => j.enabled)
  if (!enabled.length && jobs.length) return { state: 'off', detail: 'Every scheduled job is switched off.' }
  const everRan = jobs.some(j => j.lastRunAt) || !!own?.lastRunAt
  // No detail: "Not run since restart" is already on the card, and the page explains it once.
  if (!everRan) return { state: 'waiting', detail: null }
  return { state: 'healthy', detail: null }
}

function ownInputs(def, { desk, brain, killSwitches }) {
  const base = { killSwitches }
  if (def.own === 'desk') {
    if (!desk) return { ...base, unavailable: true }
    const pending = (desk.proposals || []).filter(p => p.status === 'pending').length
    return {
      ...base,
      switchedOff: desk.enabled ? null : 'Off — the operator has not set AGENT_DESK_ENABLED.',
      paused: !!desk.paused, pausedDetail: `Paused${desk.pausedBy ? ` by ${desk.pausedBy}` : ''}${desk.pauseReason ? ` — ${desk.pauseReason}` : ''}.`,
      running: !!desk.running, lastRunAt: desk.lastCycle?.at || null,
      metric: { label: 'Awaiting your approval', value: String(pending), tone: pending ? 'warn' : 'neutral' },
    }
  }
  if (def.own === 'brain') {
    if (!brain) return { ...base, unavailable: true }
    const found = (brain.strategies || []).length
    return {
      ...base,
      switchedOff: brain.enabled ? null : 'Off — the operator has not set STRATEGY_BRAIN_ENABLED.',
      paused: !!brain.paused, pausedDetail: `Paused${brain.pausedBy ? ` by ${brain.pausedBy}` : ''}.`,
      running: !!brain.running, lastRunAt: brain.runs?.[0]?.at || null,
      metric: { label: 'Strategies found', value: String(found), tone: 'neutral' },
    }
  }
  if (def.own === 'paper') {
    if (!desk) return { ...base, unavailable: true }
    const p = desk.paper || {}
    const perf = p.performance || {}
    const pause = p.protections?.global
    return {
      ...base,
      switchedOff: p.enabled ? null : 'Off — the operator has not set PAPER_TRADING_ENABLED.',
      paused: !!pause, pausedDetail: pause ? `Buys paused: ${clip(pause.reason, 120)}.` : null,
      metric: { label: 'Open positions', value: String(perf.openPositions ?? 0), tone: 'neutral' },
    }
  }
  return base
}

function buildAgents({ jobs, desk, brain, killSwitches }) {
  const byId = new Map(jobs.map(j => [j.id, j]))
  return AGENTS.map(def => {
    const mine = def.jobs.map(id => byId.get(id)).filter(Boolean)
    const own = ownInputs(def, { desk, brain, killSwitches })
    const { state, detail } = own.unavailable
      ? { state: 'waiting', detail: 'Its status could not be loaded just now.' }
      : agentState(def, mine, own)
    const lastRuns = [...mine.map(j => j.lastRunAt), own.lastRunAt].filter(Boolean).sort()
    const next = mine.find(j => j.enabled)
    return {
      id: def.id, label: def.label, blurb: def.blurb, state, detail,
      lastRunAt: lastRuns.at(-1) || null,
      nextText: mine.length === 1 ? (next?.scheduleText || null) : mine.length ? `${plural(mine.filter(j => j.enabled).length, 'job')} on a schedule` : null,
      jobs: { total: mine.length, ok: mine.filter(j => j.status === 'done').length, failed: mine.filter(j => j.status === 'failed').length, running: mine.filter(j => j.status === 'running').length, idle: mine.filter(j => j.status === 'idle').length },
      jobIds: mine.map(j => j.id),
      metric: own.metric || null,
      open: def.open, controls: def.controls || null,
    }
  })
}

/** Everything that wants a person, worst first. Each item names the page that fixes it. */
function buildAttention({ jobs, desk, brain, spend, ai, breakers, killSwitches, persistence, alerts, unavailable }) {
  const out = []
  const add = (id, level, title, detail, action) => out.push({ id, level, title, detail: detail || null, action: action || null })

  const failing = jobs.filter(j => j.status === 'failed' && j.enabled)
  if (failing.length <= 3) {
    for (const j of failing) add(`job:${j.id}`, 'warn', `${j.name} failed`, j.error, { label: 'See schedule', tab: 'schedule' })
  } else {
    add('jobs-failing', 'warn', `${failing.length} scheduled jobs failed`, failing.slice(0, 4).map(j => j.name).join(', ') + '…', { label: 'See schedule', tab: 'schedule' })
  }

  if (ai) {
    if (!ai.claude && !ai.groq) add('no-ai', 'critical', 'No AI provider is configured', 'Neither ANTHROPIC_API_KEY nor GROQ_API_KEY is set, so every AI feature is down.', { label: 'See connections', tab: 'connections' })
    else if (ai.paused) add('claude-paused', 'warn', 'Claude is paused', `${ai.pausedUntil ? `Until ${ai.pausedUntil}. ` : ''}AI features run on Groq${ai.groq ? '' : ' — which is not configured, so they are down'}.`, { label: 'See connections', tab: 'connections' })
    else if (!ai.claude) add('no-claude', 'warn', 'Claude is not configured', 'AI features fall back to Groq only.', { label: 'See connections', tab: 'connections' })
  }

  for (const b of breakers || []) {
    if (String(b.state).toUpperCase() === 'OPEN') add(`breaker:${b.name}`, 'critical', `Circuit breaker “${b.name}” is open`, `${b.failures} consecutive failures; calls to it are being refused${b.resetInMs != null ? ` (retry in ${Math.ceil(b.resetInMs / 1000)}s)` : ''}.`, { label: 'See connections', tab: 'connections' })
  }

  const b = spend?.budget
  if (b && b.capUsd > 0) {
    if (b.exhausted) add('budget', 'critical', 'The agents’ AI budget is spent', `$${b.spentUsd.toFixed(2)} of $${b.capUsd.toFixed(2)} this month. The Agent Desk and Strategy Brain have stopped asking the model.`, { label: 'See spend', tab: 'overview' })
    else if (b.usedPct >= 80) add('budget', 'warn', `${Math.round(b.usedPct)}% of the agents’ AI budget used`, `$${b.spentUsd.toFixed(2)} of $${b.capUsd.toFixed(2)} this month.`, { label: 'See spend', tab: 'overview' })
  }

  const pending = (desk?.proposals || []).filter(p => p.status === 'pending')
  if (pending.length) add('proposals', 'warn', `${plural(pending.length, 'change')} waiting for approval`, pending.slice(0, 3).map(p => clip(p.title || p.summary || p.type, 70)).join(' · '), { label: 'Review', route: { tab: 'agent-desk' } })

  for (const a of alerts || []) {
    add(`alert:${a.key}`, a.severity === 'high' ? 'critical' : 'warn', clip(a.title, 120), a.detail ? clip(a.detail, 220) : null, a.key?.startsWith('paper') ? { label: 'Open Agent Desk', route: { tab: 'agent-desk' } } : null)
  }

  if (persistence && persistence.enabled === false && persistence.production) {
    add('persistence', 'warn', 'Learning records reset on every deploy', clip(persistence.reason || 'Durable storage is not active.', 200), { label: 'See connections', tab: 'connections' })
  }

  for (const [name, on] of Object.entries(killSwitches || {})) {
    if (on) add(`kill:${name}`, 'info', `Kill switch on: ${name}`, 'Set by the operator in the environment.', null)
  }
  for (const u of unavailable) add(`unavailable:${u}`, 'info', `${u} status could not be loaded`, 'It is excluded from the checks above, not counted as healthy.', null)

  return out.sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level])
}

function buildVerdict(attention, agents, jobs, unavailable = []) {
  const crit = attention.filter(a => a.level === 'critical').length
  const warn = attention.filter(a => a.level === 'warn').length
  const active = agents.filter(a => a.state === 'running' || a.state === 'healthy').length
  if (crit) return { level: 'critical', headline: `${plural(crit, 'problem')} to fix now`, detail: attention.find(a => a.level === 'critical').title }
  if (warn) return { level: 'attention', headline: `${plural(warn, 'thing')} need${warn === 1 ? 's' : ''} your attention`, detail: attention.find(a => a.level === 'warn').title }
  // A source that failed to load is not "all clear": say what was not checked.
  if (unavailable.length) return { level: 'ok', headline: 'No problems found', detail: `Could not check: ${unavailable.join(', ')}.` }
  // Nothing has run yet: neutral, not a green tick — nothing has proved anything.
  if (!jobs.some(j => j.lastRunAt)) return { level: 'waiting', headline: 'Nothing has run since the last restart', detail: 'Scheduled jobs report here once they run. This is normal right after a deploy.' }
  return { level: 'ok', headline: 'Everything is running normally', detail: `${plural(active, 'agent')} active, no failures.` }
}

function buildSpend({ audit, budget, now }) {
  if (!audit && !budget) return null
  const month = now.toISOString().slice(0, 7)
  const byDay = (audit?.byDay || []).map(d => ({ date: d.date, costUsd: d.costUsd || 0, calls: d.calls || 0 }))
  const monthUsd = +byDay.filter(d => d.date.startsWith(month)).reduce((a, d) => a + d.costUsd, 0).toFixed(4)
  const topRoutes = Object.entries(audit?.routes || {})
    .map(([route, s]) => ({ route, calls: s.calls || 0, costUsd: s.costUsd || 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls).slice(0, 6)
  return {
    month, monthUsd, windowUsd: audit?.totalCostUsd ?? null, since: audit?.since ?? null,
    calls: audit?.total ?? 0, successRate: audit?.successRate ?? null, cacheHitRate: audit?.cache?.hitRate ?? null,
    budget: budget ? { capUsd: budget.capUsd, spentUsd: budget.spentUsd, usedPct: budget.capUsd > 0 ? +(budget.spentUsd / budget.capUsd * 100).toFixed(1) : 0, exhausted: !!budget.exhausted } : null,
    topRoutes, byDay: byDay.slice(-14),
  }
}

/** Providers, grouped. State is what is CONFIGURED — see the file header. */
function buildConnections({ env, breakers, persistence, ai }) {
  const key = (v, optionalNote) => (v ? { state: 'set', note: 'Key set' } : { state: 'missing', note: optionalNote || 'No key' })
  const keyless = (note = 'No key needed') => ({ state: 'keyless', note })
  const e = env || {}
  const claude = e.anthropic
    ? (ai?.paused ? { state: 'paused', note: `Paused${ai.pausedUntil ? ` until ${ai.pausedUntil}` : ''}` } : { state: 'set', note: 'Key set' })
    : { state: 'missing', note: 'Primary model — AI features fall back to Groq' }
  const groups = [
    { id: 'ai', label: 'AI models', items: [
      { id: 'claude', label: 'Claude', ...claude, role: 'Primary reasoning and tool use' },
      { id: 'groq', label: 'Groq', ...key(e.groq, 'Fallback model — not configured'), role: 'Fallback and second-opinion scans' },
    ] },
    { id: 'market', label: 'Market data', items: [
      { id: 'finnhub', label: 'Finnhub', ...key(e.finnhub, 'Optional — the cascade skips it'), role: 'Quotes, charts, search (first in the cascade)' },
      { id: 'fmp', label: 'Financial Modeling Prep', ...key(e.fmp, 'Optional — fundamentals and screener need it'), role: 'Fundamentals, screener, earnings, fund NAVs' },
      { id: 'alphavantage', label: 'Alpha Vantage', ...key(e.alphavantage, 'Optional'), role: 'Price fallback' },
      { id: 'twelvedata', label: 'Twelve Data', ...key(e.twelvedata, 'Optional'), role: 'Price fallback and search' },
      { id: 'tiingo', label: 'Tiingo', ...key(e.tiingo, 'Optional'), role: 'Price fallback' },
      { id: 'polygon', label: 'Polygon', ...key(e.polygon, 'Optional'), role: 'Price fallback' },
      { id: 'nasdaq', label: 'Nasdaq, Stooq', ...keyless('Keyless, delayed'), role: 'Last resorts before the cached quote' },
      { id: 'crypto', label: 'Binance, Coinbase, CoinGecko', ...keyless(), role: 'Crypto prices and history' },
    ] },
    { id: 'evidence', label: 'Evidence & macro', items: [
      { id: 'fred', label: 'FRED', ...(e.fred ? { state: 'set', note: 'Key set' } : keyless('No key — using the public CSV')), role: '14 macro series and the regime' },
      { id: 'sec', label: 'SEC EDGAR', ...keyless(), role: 'Filings, insiders, 13F, point-in-time fundamentals' },
      { id: 'sentiment', label: 'StockTwits, ApeWisdom, Google News', ...keyless(), role: 'Free sentiment lanes' },
    ] },
    { id: 'infra', label: 'Infrastructure', items: [
      { id: 'postgres', label: 'PostgreSQL', ...(e.database ? { state: 'set', note: 'Connected by URL' } : { state: 'missing', note: 'Using in-memory storage — data is lost on restart' }), role: 'Accounts and portfolios' },
      { id: 'persistence', label: 'Learning-store persistence', ...(persistence?.enabled ? { state: 'set', note: 'Mirrored to the database' } : { state: 'missing', note: clip(persistence?.reason || 'Inactive — records reset on each deploy', 90) }), role: 'Keeps predictions and strategies across deploys' },
      { id: 'email', label: 'Email (Resend or SMTP)', ...key(e.resend, 'Not configured — briefings are not sent'), role: 'Morning briefs, alerts, password reset' },
      { id: 'firecrawl', label: 'Firecrawl', ...key(e.firecrawl, 'Optional — the Copilot cannot read web pages'), role: 'Copilot “read this page” tool' },
    ] },
  ]
  return { groups, breakers: (breakers || []).map(b => ({ name: b.name, state: String(b.state).toUpperCase(), failures: b.failures, threshold: b.threshold, totalCalls: b.totalCalls, totalFailures: b.totalFailures, lastFailureAt: b.lastFailureAt, resetInMs: b.resetInMs })) }
}

/** Newest first. Job runs, Agent Desk log rows and Strategy Brain runs on one timeline. */
function buildFeed({ jobs, deskLog, brain, limit = 30 }) {
  const ev = []
  for (const j of jobs) {
    if (!j.lastRunAt) continue
    ev.push({ at: j.lastRunAt, source: 'scheduler', level: j.status === 'failed' ? 'fail' : j.status === 'running' ? 'info' : 'ok',
      title: `${j.name} ${j.status === 'failed' ? 'failed' : j.status === 'running' ? 'started' : 'finished'}`,
      detail: j.status === 'failed' ? j.error : j.durationMs ? `${Math.max(1, Math.round(j.durationMs / 1000))}s` : null })
  }
  for (const r of deskLog || []) {
    const at = r.at
    if (!at) continue
    if (r.kind === 'cycle-start') ev.push({ at, source: 'agent-desk', level: 'info', title: 'Agent Desk cycle started', detail: r.trigger === 'manual' ? `Run by ${r.by || 'an admin'}` : 'Scheduled' })
    else if (r.kind === 'proposal') ev.push({ at, source: 'agent-desk', level: 'warn', title: 'New proposal waiting for approval', detail: clip(r.title || r.summary || r.type, 120) })
    else if (r.kind === 'decision') ev.push({ at, source: 'agent-desk', level: r.decision === 'rejected' ? 'info' : 'ok', title: `Proposal ${r.decision}`, detail: r.by ? `by ${r.by}` : null })
    else if (r.kind === 'budget-stop') ev.push({ at, source: 'agent-desk', level: 'warn', title: 'Stopped asking the model: monthly budget reached', detail: null })
    else if (r.kind === 'pause') ev.push({ at, source: 'agent-desk', level: 'warn', title: 'Agent Desk paused', detail: r.by ? `by ${r.by}` : null })
    else if (r.kind === 'resume') ev.push({ at, source: 'agent-desk', level: 'info', title: 'Agent Desk resumed', detail: r.by ? `by ${r.by}` : null })
  }
  for (const run of brain?.runs || []) {
    if (!run.at) continue
    const n = (run.experiments || []).length
    ev.push({ at: run.at, source: 'strategy-brain', level: run.stopped ? 'warn' : 'ok', title: `Strategy Brain ran ${plural(n, 'experiment')}`, detail: run.stopped ? `Stopped: ${clip(run.stopped, 100)}` : null })
  }
  return ev.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
}

/**
 * @param inputs.jobs       scheduler.getStatus()
 * @param inputs.desk       agent-desk status() with `alerts`, or null if it failed to load
 * @param inputs.brain      strategy-brain status(), or null
 * @param inputs.audit      ai-audit getStats(), or null
 * @param inputs.breakers   circuit-breaker getAllStatuses()
 * @param inputs.killSwitches  { aiBrain: bool, recommendations: bool }
 * @param inputs.env        booleans only: { anthropic, groq, finnhub, fmp, … } — never a key
 * @param inputs.ai         { claude, groq, paused, pausedUntil }
 * @param inputs.persistence { enabled, reason, production }
 * @param inputs.deskLog    recent agent-desk log rows
 */
function buildOverview(inputs = {}) {
  const now = inputs.now || new Date()
  const jobs = (inputs.jobs || []).map(normalizeJob)
  const desk = inputs.desk || null
  const brain = inputs.brain || null
  const unavailable = []
  if (!inputs.desk) unavailable.push('Agent Desk')
  if (!inputs.brain) unavailable.push('Strategy Brain')
  if (!inputs.audit) unavailable.push('AI spend')
  const killSwitches = inputs.killSwitches || {}
  const spend = buildSpend({ audit: inputs.audit, budget: desk?.budget || brain?.budget || null, now })
  const agents = buildAgents({ jobs, desk, brain, killSwitches })
  const attention = buildAttention({ jobs, desk, brain, spend, ai: inputs.ai, breakers: inputs.breakers, killSwitches, persistence: inputs.persistence, alerts: desk?.alerts, unavailable })
  const enabledJobs = jobs.filter(j => j.enabled)
  return {
    generatedAt: now.toISOString(),
    verdict: buildVerdict(attention, agents, jobs, unavailable),
    kpis: {
      agentsActive: agents.filter(a => a.state === 'running' || a.state === 'healthy' || a.state === 'waiting').length,
      agentsTotal: agents.length,
      jobsTotal: enabledJobs.length,
      jobsFailing: enabledJobs.filter(j => j.status === 'failed').length,
      jobsRunning: enabledJobs.filter(j => j.status === 'running').length,
      pendingApprovals: (desk?.proposals || []).filter(p => p.status === 'pending').length,
      spendMonthUsd: spend?.monthUsd ?? null,
    },
    attention, agents, jobs, spend,
    connections: buildConnections({ env: inputs.env, breakers: inputs.breakers, persistence: inputs.persistence, ai: inputs.ai }),
    feed: buildFeed({ jobs, deskLog: inputs.deskLog, brain }),
    unavailable,
  }
}

module.exports = { AGENTS, buildOverview, buildAgents, buildAttention, buildVerdict, buildSpend, buildConnections, buildFeed, agentState, normalizeJob }
