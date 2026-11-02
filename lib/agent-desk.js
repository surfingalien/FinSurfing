'use strict'
/**
 * lib/agent-desk.js — the Agent Desk: one supervised self-improvement loop
 * over the three things this app can improve about itself — its trading
 * STRATEGIES, the AI BRAIN's picks and the RESEARCH engine's methods.
 *
 *   observe → diagnose → hypothesise → test → keep/revert → report
 *
 * It is an AGENT IN A BOX, deliberately:
 *
 *   - NO SURVIVAL GOAL. It keeps a LEDGER (what it costs: AI spend, measured
 *     from lib/ai-audit.js, plus the hosting cost the operator enters; what
 *     it is worth: the paper book's P&L) and reports it. When it does not
 *     cover its costs the correct output is "recommend scaling down", and it
 *     says so. Nothing in the loop rewards it for continuing to run; being
 *     paused or switched off is never counted against anything.
 *   - KILL SWITCH. AGENT_DESK_ENABLED must be exactly 'true' (default off),
 *     and an admin can pause it from the page; both are checked before every
 *     step, so a stop takes effect at the next step, not at the end of a run.
 *   - HARD SPEND CAP. AGENT_MONTHLY_BUDGET_USD (default $5) on the desk's own
 *     model calls, enforced in code before each call. Only the operator can
 *     raise it (an env var); the desk has no write path to it.
 *   - PROPOSES, NEVER APPLIES. Everything it finds becomes a PROPOSAL in an
 *     approval queue. A strategy version enters the library, a research
 *     default changes, only when an admin approves it. It never places an
 *     order (the paper executor is a separate, separately switched job; real
 *     money is not connected at all), never moves funds, never signs up for
 *     anything, never edits its own limits, prompts or code.
 *   - AUDITED. Every step, proposal, approval, pause and budget stop is
 *     appended to data/agent-desk.jsonl.
 *
 * What "improve" means per domain:
 *   STRATEGIES — lib/strategy-versions.js on the weakest library strategies:
 *     diagnose where each loses, test one targeted entry filter against the
 *     parent on held-out data (60/20/20, costs, both trend regimes), keep or
 *     revert. A kept version is proposed for approval.
 *   AI BRAIN — measured diagnostics already computed elsewhere (exit quality,
 *     AI vs random picks, learning health, the calibration of stated
 *     confidence) turned into FINDINGS with the numbers and what to look at.
 *     The scan prompt is never edited by the desk — that stays human work.
 *   RESEARCH — the measured record of the single-call thesis vs the bull/bear
 *     debate. When one is clearly better (95% intervals that do not overlap,
 *     each past the minimum sample), the desk proposes making it the default.
 *
 * Tests: tests/agent-desk.test.js
 */

const fs = require('fs')
const path = require('path')
const atomic = require('./atomic-write')
const { DATA_DIR } = require('./data-dir')

const LOG_FILE      = process.env.AGENT_DESK_LOG || path.join(DATA_DIR, 'agent-desk.jsonl')
const STATE_FILE    = path.join(DATA_DIR, 'agent-desk-state.json')
const ROUTE_PREFIX  = 'agent-desk'
const DEFAULT_BUDGET_USD = 5
const BUDGET_CEILING_USD = 200           // the env cannot raise the cap past this
const EST_CALL_USD  = 0.05               // a call is not started unless this much budget is left
const MAX_STRATEGIES_PER_CYCLE = 2

// ── Controls ─────────────────────────────────────────────────────────────────

function readState(file = STATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}
function writeState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomic.writeJsonAtomic(file, state)
  return state
}

/** Why the desk may not act right now, or null. Env first, then the page's pause. */
function stopReason(state = readState()) {
  if (process.env.AGENT_DESK_ENABLED !== 'true') return 'AGENT_DESK_ENABLED is not "true" (the operator\'s switch)'
  if (state.paused) return `paused by ${state.pausedBy || 'an admin'}${state.pauseReason ? ` — ${state.pauseReason}` : ''}`
  return null
}

function budgetUsd() {
  const raw = Number(process.env.AGENT_MONTHLY_BUDGET_USD)
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_BUDGET_USD
  return Math.min(raw, BUDGET_CEILING_USD)
}

function monthStart(now = new Date()) {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

/** Month-to-date spend of the desk's own model calls vs the cap. */
function budgetStatus(now = new Date(), audit = require('./ai-audit')) {
  const cap = budgetUsd()
  const spent = audit.spendSince(monthStart(now), { prefix: ROUTE_PREFIX }).costUsd
  return { capUsd: cap, spentUsd: spent, leftUsd: +Math.max(0, cap - spent).toFixed(4), exhausted: spent + EST_CALL_USD > cap, month: monthStart(now).slice(0, 7) }
}

// ── Audit log ────────────────────────────────────────────────────────────────

function log(event, file = LOG_FILE) {
  const row = { at: new Date().toISOString(), ...event }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(row) + '\n')
  } catch (e) { console.warn('[agent-desk] log failed:', e.message) }
  return row
}
function readLog(file = LOG_FILE) {
  try { return atomic.readJsonl(file) } catch { return [] }
}

// ── Proposals (derived from the log: a proposal row, then decision rows) ─────

/** Current proposals, newest first, with their latest status. Pure. */
function proposalsOf(rows) {
  const byId = new Map()
  for (const r of rows || []) {
    if (r.kind === 'proposal') byId.set(r.id, { ...r, status: 'pending' })
    else if (r.kind === 'decision' && byId.has(r.proposalId)) {
      byId.set(r.proposalId, { ...byId.get(r.proposalId), status: r.decision, decidedAt: r.at, decidedBy: r.by, note: r.note ?? null, applied: r.applied ?? null })
    }
  }
  return [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/** A proposal id that is stable for the same suggestion, so a nightly rerun does not queue duplicates. */
function proposalId(type, key) {
  return require('crypto').createHash('sha1').update(`${type}:${key}`).digest('hex').slice(0, 10)
}

// ── Ledger ───────────────────────────────────────────────────────────────────

/**
 * What the desk costs vs what the paper book made, month to date. Pure given
 * its inputs. Paper P&L is NOT income: the ledger says whether the measured
 * edge would pay for the system at a notional size, nothing more.
 */
function ledger({ aiMonthUsd, agentMonthUsd, infraMonthUsd = null, equityHistory = [], startingCash = 100_000, notionalUsd = null, now = new Date() }) {
  const month = monthStart(now).slice(0, 10)
  const prior = [...equityHistory].reverse().find(h => h.date < month)
  const inMonth = equityHistory.filter(h => h.date >= month)
  const days = inMonth.length
  const open = prior?.equity ?? inMonth[0]?.equity ?? null
  const last = inMonth.at(-1)?.equity ?? null
  const paperPnl = open != null && last != null ? +(last - open).toFixed(2) : null
  const scale = notionalUsd > 0 ? notionalUsd / startingCash : 1
  const value = paperPnl == null ? null : +(paperPnl * scale).toFixed(2)
  const cost = +((aiMonthUsd || 0) + (infraMonthUsd || 0)).toFixed(2)
  let verdict, recommendation
  if (days < 15 || value == null) {
    verdict = 'too-early'
    recommendation = `${days} day(s) of paper results this month — too few to judge. Keep paper trading; nothing here is money earned.`
  } else if (value >= cost) {
    verdict = 'covers-costs'
    recommendation = `Paper P&L ${value >= 0 ? '+' : ''}$${value} at the notional size vs $${cost} of costs. This is a simulation: before real money, the record has to hold for months and every live order would still need your approval.`
  } else {
    verdict = 'does-not-cover'
    recommendation = `Paper P&L $${value} at the notional size does not cover $${cost} of costs. Recommendation: run the desk less often or lower its budget (AGENT_MONTHLY_BUDGET_USD), or pause it; that is the right call, not a failure.`
  }
  return {
    month: month.slice(0, 7), days,
    costs: { aiUsd: +(aiMonthUsd || 0).toFixed(2), agentUsd: +(agentMonthUsd || 0).toFixed(2), infraUsd: infraMonthUsd, totalUsd: cost, infraEntered: infraMonthUsd != null },
    value: { paperPnl, notionalUsd: notionalUsd || startingCash, atNotional: value, basis: notionalUsd > 0 ? `paper P&L scaled from $${startingCash} to $${notionalUsd}` : `paper book of $${startingCash}` },
    verdict, recommendation,
  }
}

// ── Domain diagnostics (pure) ────────────────────────────────────────────────

const pct = v => (v == null ? 'n/a' : `${Math.round(v * 100)}%`)

/** Brain findings from the measured stats. Each carries its numbers and what to look at; none changes anything. */
function brainFindings({ stats = null, vsRandom = null, learningHealth = null } = {}) {
  const out = []
  const eq = stats?.exitQuality
  if (eq?.ready) {
    if (eq.winnersNearStop?.lo > 0.3) out.push({ key: 'stops-in-noise', metric: { name: 'winners that first came within 20% of their stop', value: eq.winnersNearStop.rate, n: eq.winnersNearStop.n, better: 'lower' }, title: 'Stops sit inside normal noise', detail: `${pct(eq.winnersNearStop.rate)} of winners first came within 20% of their stop (95% CI ${pct(eq.winnersNearStop.lo)}–${pct(eq.winnersNearStop.hi)}, n=${eq.winnersNearStop.n}).`, look: 'Plan odds "inside noise" flags and the volatility stop on each card; consider stops at ≥ 1 ATR.' })
    if (eq.targetNearMiss?.lo > 0.25) out.push({ key: 'targets-too-far', metric: { name: 'non-target exits that reached 80% of the target', value: eq.targetNearMiss.rate, n: eq.targetNearMiss.n, better: 'lower' }, title: 'Targets sit past where moves run out', detail: `${pct(eq.targetNearMiss.rate)} of non-target exits had reached 80% of the target (CI ${pct(eq.targetNearMiss.lo)}–${pct(eq.targetNearMiss.hi)}, n=${eq.targetNearMiss.n}).`, look: 'Exit quality on the Track record; T1 partial booking already halves this.' })
  }
  if (vsRandom?.verdict === 'below-random' || vsRandom?.verdict === 'no-difference') {
    out.push({ key: `vs-random-${vsRandom.verdict}`, metric: vsRandom.ai?.[vsRandom.metric] != null && vsRandom.shadow?.[vsRandom.metric] != null ? { name: `AI minus random-pick ${vsRandom.metric === 'alphaWinRate' ? 'alpha ' : ''}win rate`, value: vsRandom.ai[vsRandom.metric] - vsRandom.shadow[vsRandom.metric], n: vsRandom.ai.n, better: 'higher' } : null, title: vsRandom.verdict === 'below-random' ? 'AI picks do worse than random picks from the same list' : 'AI picks are not distinguishable from random picks from the same list', detail: `Measured at ${vsRandom.horizon}d on the same scans (${vsRandom.metric}).`, look: 'The universe (movers) may be doing the work; the edge report shows where, if anywhere, picks beat the list.' })
  }
  if (learningHealth?.withheld) out.push({ key: 'learnings-withheld', title: 'Self-learned findings are being withheld from the scan', detail: learningHealth.withheldReason || 'picks made with them did significantly worse than without.', look: 'Learning health on "Is it working?".' })
  const calib = stats?.calibration
  if (calib && typeof calib === 'object') {
    const high = calib.High || calib.high, low = calib.Low || calib.low
    if (high?.n >= 20 && low?.n >= 20 && high.winRate != null && low.winRate != null && high.winRate <= low.winRate) {
      out.push({ key: 'confidence-uncalibrated', metric: { name: 'High minus Low confidence win rate', value: high.winRate - low.winRate, n: high.n + low.n, better: 'higher' }, title: '"High" confidence does not win more often than "Low"', detail: `High ${pct(high.winRate)} (n=${high.n}) vs Low ${pct(low.winRate)} (n=${low.n}).`, look: 'Size from the measured win rate (already the rule), not from the stated confidence.' })
    }
  }
  return out
}

function wilson(k, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 1 }
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
  return { lo: (c - m) / d, hi: (c + m) / d }
}

/** Research: is one thesis method clearly better on the measured record? Pure. */
function researchFinding(byMethod, { minN = 20 } = {}) {
  const s = byMethod?.single, d = byMethod?.debate
  const rate = c => (c?.winRate ?? c?.hitRate ?? null)
  const n = c => (c?.n ?? c?.resolved ?? 0)
  if (!s || !d || n(s) < minN || n(d) < minN || rate(s) == null || rate(d) == null) {
    return { verdict: 'insufficient', detail: `single ${n(s)} resolved, debate ${n(d)} resolved — need ${minN} each` }
  }
  const ws = wilson(Math.round(rate(s) * n(s)), n(s)), wd = wilson(Math.round(rate(d) * n(d)), n(d))
  const detail = `single ${pct(rate(s))} [${pct(ws.lo)}–${pct(ws.hi)}] n=${n(s)} · debate ${pct(rate(d))} [${pct(wd.lo)}–${pct(wd.hi)}] n=${n(d)}`
  if (wd.lo > ws.hi) return { verdict: 'debate-better', method: 'debate', detail }
  if (ws.lo > wd.hi) return { verdict: 'single-better', method: 'single', detail }
  return { verdict: 'no-clear-difference', detail }
}

/** The library strategies most worth improving: active, already traded forward, weakest fitness first. Pure. */
function strategiesToImprove(entries, recentExperiments = [], { limit = MAX_STRATEGIES_PER_CYCLE, now = Date.now() } = {}) {
  const recently = new Set(recentExperiments.filter(x => now - Date.parse(x.at) < 14 * 86_400_000).map(x => x.strategyId))
  return (entries || [])
    .filter(e => e.status !== 'retired' && !recently.has(e.id))
    .sort((a, b) => (a.fitness ?? 0) - (b.fitness ?? 0))
    .slice(0, limit)
}

// ── The cycle ────────────────────────────────────────────────────────────────

let _running = null

/**
 * One supervised cycle. Every external dependency is injectable for tests.
 * @returns {{ ran: boolean, reason?, steps, proposals }}
 */
async function runCycle({ trigger = 'schedule', by = null, deps = {} } = {}) {
  const D = {
    library: deps.library || require('./strategy-library'),
    versions: deps.versions || require('./strategy-versions'),
    fetchBars: deps.fetchBars || (sym => require('./internal-api').fetchDailyBars(sym, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 })),
    toSeries: deps.toSeries || require('./brain-evolution').toSeries,
    costBps: deps.costBps || (sym => require('../utils/backtest').costBpsForSymbol(sym)),
    callModel: deps.callModel || defaultCallModel,
    brainInputs: deps.brainInputs || defaultBrainInputs,
    byMethod: deps.byMethod || (() => require('./learning-store').getCalibration().byMethod),
    decisions: deps.decisions || (() => require('./learning-store').readDecisions()),
    now: deps.now || (() => new Date()),
  }
  const blocked = stopReason()
  if (blocked) return { ran: false, reason: blocked }
  if (_running) return { ran: false, reason: 'a cycle is already running' }

  const cycleId = `c${Date.now().toString(36)}`
  const steps = [], proposals = []
  const step = (name, detail) => { steps.push({ name, ...detail }); log({ kind: 'step', cycleId, name, ...detail }) }
  const propose = (type, key, body) => {
    const id = proposalId(type, key)
    const existing = proposalsOf(readLog()).find(p => p.id === id)
    if (existing) return existing
    const row = log({ kind: 'proposal', cycleId, id, type, ...body })
    proposals.push(row)
    return row
  }
  const halted = () => { const r = stopReason(); if (r) { step('halted', { reason: r }); return true } return false }

  _running = (async () => {
    log({ kind: 'cycle-start', cycleId, trigger, by })
    try {
      // 0. IMPACT — did what was approved earlier actually help? Measured first, before anything new.
      if (halted()) return
      const brainNow = await D.brainInputs()
      const impact = await measureImpact({ fetchBars: D.fetchBars, toSeries: D.toSeries, costBps: D.costBps, versions: D.versions, library: D.library, decisions: D.decisions(), brain: brainNow, now: D.now() })
      log({ kind: 'impact', cycleId, ...impact })
      step('impact', { result: impactHeadline(impact), detail: `${impact.strategies.length} approved version(s) measured forward, research ${impact.research ? impact.research.verdict : 'no default approved'}, ${impact.brain.length} acknowledged finding(s) re-measured` })

      // 1. STRATEGIES
      if (halted()) return
      const lib = D.library.readLibrary()
      const experiments = D.versions.latestById(D.versions.loadVersions())
      const targets = strategiesToImprove(lib, experiments, { now: D.now().getTime() })
      if (!targets.length) step('strategies', { result: 'nothing to improve', detail: lib.length ? 'every active strategy was examined in the last 14 days' : 'the strategy library is empty — the nightly evolution job fills it' })
      for (const entry of targets) {
        if (halted()) return
        const bars = await D.fetchBars(entry.symbol).catch(() => [])
        if (!bars?.length) { step('strategy', { strategyId: entry.id, symbol: entry.symbol, result: 'skipped', detail: 'no price history' }); continue }
        const series = D.toSeries(bars)
        const costBps = D.costBps(entry.symbol)
        // First pass in code; the model is asked only if the budget allows and the diagnosis found something.
        let result = D.versions.improve(entry, series, { costBps })
        let modelNote = null
        if (result.diagnosis?.findings?.length && result.status !== 'promoted') {
          const budget = budgetStatus(D.now())
          if (budget.exhausted) { modelNote = `model not asked: monthly budget $${budget.capUsd} reached`; log({ kind: 'budget-stop', cycleId, ...budget }) }
          else if (halted()) return
          else {
            const ask = await D.callModel(D.versions.filterPrompt({ entry, diagnosis: result.diagnosis })).catch(e => ({ error: e.message }))
            if (ask?.filters?.length) result = D.versions.improve(entry, series, { costBps, modelProposals: ask.filters })
            modelNote = ask?.error ? `model call failed: ${ask.error}` : `model proposed ${ask?.filters?.length || 0} filter(s)`
          }
        }
        const exp = D.versions.appendVersion({
          id: `${entry.id}:${cycleId}`, at: D.now().toISOString(), cycleId, strategyId: entry.id, symbol: entry.symbol, name: entry.name,
          // The parent itself, so its forward record can still be measured after it is retired and pruned (Impact).
          parentSpec: { strategy: entry.strategy, params: entry.params, symbol: entry.symbol },
          status: result.status, reason: result.reason, parentVersion: result.parentVersion ?? entry.version ?? 'v1.0', version: result.version ?? null,
          change: result.change ?? null, hypothesis: result.hypothesis ?? null, source: result.source ?? null, filter: result.filter ?? null,
          checks: result.checks ?? null, parent: result.parent ?? null, candidate: result.candidate ?? null, regimes: result.regimes ?? null,
          windows: result.windows ?? null, candidatesTried: result.candidatesTried ?? 0, candidates: result.candidates ?? null,
          diagnosis: result.diagnosis ? { trades: result.diagnosis.trades, metrics: result.diagnosis.metrics, findings: result.diagnosis.findings.map(({ filter, ...f }) => f) } : null,
          modelNote,
        })
        step('strategy', { strategyId: entry.id, symbol: entry.symbol, result: result.status, detail: result.reason, version: result.version ?? null })
        if (result.status === 'promoted') {
          propose('strategy-version', exp.id, {
            title: `${entry.name || entry.strategy} → ${result.version}: ${result.change}`,
            detail: `${result.hypothesis}. Validation return ${result.candidate.val.totalReturn}% vs ${result.parent.val.totalReturn}%; final test ${result.candidate.test.totalReturn}% vs ${result.parent.test.totalReturn}% (net of ${costBps}bps).`,
            effect: `Approving adds ${result.version} to the strategy library (it starts its own forward record) and retires ${entry.version || 'v1.0'}.`,
            experimentId: exp.id, strategyId: entry.id,
          })
        }
      }

      // 2. AI BRAIN
      if (halted()) return
      const brain = brainNow
      const findings = brainFindings(brain)
      step('brain', { result: `${findings.length} finding(s)`, detail: findings.map(f => f.title).join('; ') || 'no measured problem past its sample minimum' })
      for (const f of findings) propose('brain-finding', `${f.key}:${D.now().toISOString().slice(0, 7)}`, { findingKey: f.key, metric: f.metric ?? null, title: f.title, detail: f.detail, effect: `Acknowledging records that you have seen it. The desk never edits the scan prompt. Look at: ${f.look}` })

      // 3. RESEARCH
      if (halted()) return
      const r = researchFinding(D.byMethod())
      step('research', { result: r.verdict, detail: r.detail })
      const current = readState().settings?.researchDefaultMethod || 'single'
      if (r.method && r.method !== current) {
        propose('research-default-method', `${r.method}:${D.now().toISOString().slice(0, 7)}`, {
          title: `Make the ${r.method === 'debate' ? 'bull/bear debate' : 'single-call thesis'} the Research Desk default`,
          detail: r.detail, method: r.method,
          effect: `Approving makes "${r.method}" the method used when a thesis request does not name one. You can still pick either on the page.`,
        })
      }
    } catch (e) {
      step('error', { result: 'failed', detail: e.message })
    } finally {
      log({ kind: 'cycle-end', cycleId, steps: steps.length, proposals: proposals.length })
    }
  })()
  try { await _running } finally { _running = null }
  return { ran: true, cycleId, steps, proposals }
}

const FILTER_SCHEMA = (() => {
  const { str, num, oneOf, arr, obj } = require('./output-schema')
  return obj({
    filters: arr(obj({
      feature: oneOf(require('./strategy-versions').LLM_FILTER_FEATURES),
      op: oneOf(['<', '>', '<=', '>=']),
      value: num('threshold in the feature\'s own units'),
      hypothesis: str('one sentence'),
    }), 'at most 2'),
  })
})()

/** The desk's one model call: filter proposals for a diagnosed strategy, schema-constrained, budgeted. */
async function defaultCallModel(prompt) {
  const { getRouter } = require('./ai-router')
  const { tryParseAiJson } = require('./ai-json')
  const out = await getRouter(`${ROUTE_PREFIX}:strategy`).call({ prompt, maxTokens: 600, schema: FILTER_SCHEMA, schemaName: 'agent-desk-filters' })
  const parsed = tryParseAiJson(out.text)
  return { filters: Array.isArray(parsed?.filters) ? parsed.filters.slice(0, 2) : [] }
}

async function defaultBrainInputs() {
  const bl = require('./brain-learnings')
  let stats = null, vsRandom = null, learningHealth = null
  try { stats = bl.computeStats(bl.readPredictions()) } catch { /* empty record */ }
  try { const sb = require('./shadow-baseline'); vsRandom = sb.compareToShadows(bl.readPredictions(), sb.readShadows()) } catch { /* no shadows */ }
  try { learningHealth = bl.getLearningHealth() } catch { /* none */ }
  return { stats, vsRandom, learningHealth }
}

// ── Impact: did approved changes help? ───────────────────────────────────────

/**
 * Re-measure everything an admin approved, against what it replaced, on data
 * that arrived AFTER the approval (nothing the change was chosen on):
 *   - strategy versions: the version and its retired parent both traded
 *     forward from the approval date on the same bars, net of costs;
 *   - research default: theses resolved since the approval, by method, vs
 *     before it (learning-store surface `research`);
 *   - acknowledged Brain findings: the metric that raised the finding, then
 *     vs now.
 * Below the evidence minimums each says so ('too-early') instead of a number.
 */
async function measureImpact({ fetchBars, toSeries, costBps, versions, library, decisions = [], brain = {}, now = new Date() }) {
  const rows = readLog()
  const decisionsLog = rows.filter(r => r.kind === 'decision' && r.decision === 'approved')
  const props = new Map(proposalsOf(rows).map(p => [p.id, p]))
  const evolution = require('./brain-evolution')

  const strategies = []
  const exps = versions.latestById(versions.loadVersions()).filter(x => x.status === 'approved' && x.libraryId)
  const lib = library.readLibrary()
  for (const x of exps.slice(0, 10)) {
    const parent = lib.find(e => e.id === x.strategyId) || (x.parentSpec && { id: x.strategyId, ...x.parentSpec, params: x.parentSpec.params })
    const version = lib.find(e => e.id === x.libraryId) || (parent && { ...parent, id: x.libraryId, params: { ...parent.params, filter: x.filter } })
    if (!parent || !version) { strategies.push({ experimentId: x.id, symbol: x.symbol, verdict: 'unmeasurable', reason: 'the parent strategy specification is gone' }); continue }
    const bars = await fetchBars(x.symbol).catch(() => [])
    if (!bars?.length) { strategies.push({ experimentId: x.id, symbol: x.symbol, verdict: 'unmeasurable', reason: 'no price history' }); continue }
    const series = toSeries(bars), bps = costBps(x.symbol), since = x.approvedAt
    const v = evolution.forwardMetrics({ ...version, discoveredAt: since }, series, { costBps: bps })
    const p = evolution.forwardMetrics({ ...parent, discoveredAt: since }, series, { costBps: bps })
    if (v.skip || p.skip) { strategies.push({ experimentId: x.id, symbol: x.symbol, version: x.version, since: since?.slice(0, 10), verdict: 'too-early', reason: v.skip || p.skip }); continue }
    const excess = +(v.metrics.totalReturn - p.metrics.totalReturn).toFixed(2)
    strategies.push({
      experimentId: x.id, symbol: x.symbol, version: x.version, parentVersion: x.parentVersion, change: x.change, since: since?.slice(0, 10), from: v.from,
      versionResult: { totalReturn: v.metrics.totalReturn, trades: v.metrics.totalTrades, maxDrawdown: v.metrics.maxDrawdown },
      parent: { totalReturn: p.metrics.totalReturn, trades: p.metrics.totalTrades, maxDrawdown: p.metrics.maxDrawdown },
      excessPct: excess, verdict: v.metrics.totalTrades + p.metrics.totalTrades === 0 ? 'no-trades-yet' : excess > 0 ? 'helped' : excess < 0 ? 'hurt' : 'same',
    })
  }

  let research = null
  const rd = [...decisionsLog].reverse().find(d => d.applied?.researchDefaultMethod)
  if (rd) research = researchImpact(decisions, rd.at, rd.applied.researchDefaultMethod)

  const current = new Map(brainFindings(brain).map(f => [f.key, f.metric]))
  const brainRows = decisionsLog.map(d => props.get(d.proposalId)).filter(p => p?.type === 'brain-finding' && p.metric).map(p => {
    const nowM = current.get(p.findingKey)
    const then = p.metric.value
    // Not raised any more = it fell back under the threshold that raised it.
    const verdict = nowM == null ? 'resolved' : nowM.value === then ? 'unchanged' : ((p.metric.better === 'lower') === (nowM.value < then)) ? 'improving' : 'worse'
    return { title: p.title, metric: p.metric.name, then, now: nowM?.value ?? null, verdict, acknowledgedAt: p.decidedAt }
  })

  const done = strategies.filter(s => s.verdict === 'helped' || s.verdict === 'hurt' || s.verdict === 'same')
  return {
    measuredAt: now.toISOString(),
    strategies, research, brain: brainRows,
    summary: {
      versionsMeasured: done.length,
      helped: done.filter(s => s.verdict === 'helped').length,
      hurt: done.filter(s => s.verdict === 'hurt').length,
      meanExcessPct: done.length ? +(done.reduce((a, s) => a + s.excessPct, 0) / done.length).toFixed(2) : null,
      tooEarly: strategies.filter(s => s.verdict === 'too-early' || s.verdict === 'no-trades-yet').length,
    },
  }
}

/** Research theses (learning-store surface `research`) resolved before vs after a default was approved, by method. Pure. */
function researchImpact(decisions, sinceIso, method, { minN = 20 } = {}) {
  const rows = (decisions || []).filter(d => d.surface === 'research' && d.outcome?.retPct != null && d.meta?.method)
  const since = Date.parse(sinceIso)
  const seg = (fn) => { const r = rows.filter(fn); const wins = r.filter(d => (d.action === 'sell' ? d.outcome.retPct < 0 : d.outcome.retPct > 0)).length; return { n: r.length, winRate: r.length ? wins / r.length : null, ...(r.length ? wilson(wins, r.length) : {}) } }
  const before = seg(d => Date.parse(d.at) < since), after = seg(d => Date.parse(d.at) >= since)
  const afterDefault = seg(d => Date.parse(d.at) >= since && d.meta.method === method)
  const verdict = after.n < minN ? 'too-early' : after.lo > before.hi ? 'helped' : after.hi < before.lo ? 'hurt' : 'no-clear-difference'
  return { method, approvedAt: sinceIso, before, after, afterDefault, verdict, note: `${after.n} resolved since approval (need ${minN})` }
}

function impactHeadline(i) {
  const s = i.summary
  if (!s.versionsMeasured && !i.research && !i.brain.length) return s.tooEarly ? `${s.tooEarly} approved change(s), too early to measure` : 'nothing approved yet'
  const parts = []
  if (s.versionsMeasured) parts.push(`${s.helped} of ${s.versionsMeasured} strategy versions beat what they replaced (mean ${s.meanExcessPct >= 0 ? '+' : ''}${s.meanExcessPct}%)`)
  if (i.research) parts.push(`research default: ${i.research.verdict}`)
  if (i.brain.length) parts.push(`${i.brain.filter(b => b.verdict === 'improving' || b.verdict === 'resolved').length} of ${i.brain.length} findings improving`)
  return parts.join('; ')
}

// ── Decisions (admin) ────────────────────────────────────────────────────────

/**
 * Approve or reject a pending proposal. Approval applies exactly the effect
 * the proposal stated, nothing else. Returns the decision row.
 */
function decide(id, decision, { by, note = null, deps = {} } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected')
  const p = proposalsOf(readLog()).find(x => x.id === id)
  if (!p) { const e = new Error('no such proposal'); e.status = 404; throw e }
  if (p.status !== 'pending') { const e = new Error(`already ${p.status}`); e.status = 409; throw e }
  let applied = null
  if (decision === 'approved') {
    if (p.type === 'strategy-version') applied = applyStrategyVersion(p, deps)
    else if (p.type === 'research-default-method') {
      const s = readState()
      writeState({ ...s, settings: { ...(s.settings || {}), researchDefaultMethod: p.method } })
      applied = { researchDefaultMethod: p.method }
    } else applied = { acknowledged: true }
  }
  return log({ kind: 'decision', proposalId: id, decision, by, note: note ? String(note).slice(0, 500) : null, applied })
}

function applyStrategyVersion(p, deps = {}) {
  const library = deps.library || require('./strategy-library')
  const versions = deps.versions || require('./strategy-versions')
  const exp = versions.latestById(versions.loadVersions()).find(x => x.id === p.experimentId)
  const parent = library.readLibrary().find(e => e.id === p.strategyId)
  if (!exp || !parent) throw new Error('the experiment or its parent strategy is gone')
  if (parent.status === 'retired') throw new Error('the parent strategy was retired since; nothing to replace')
  const spec = versions.versionEntry(parent, exp)
  const t = exp.candidate.test
  const entry = library.buildEntry({ ...spec, metrics: { alpha: t.alpha, sharpeRatio: t.sharpe, totalTrades: t.trades, totalReturn: t.totalReturn }, verdict: 'validated' })
  library.appendEntry(entry)
  library.appendEntry({ ...parent, status: 'retired', retiredReason: `superseded by ${exp.version} (${entry.id})` })
  versions.appendVersion({ id: exp.id, approvedAt: new Date().toISOString(), libraryId: entry.id, status: 'approved' })
  return { libraryId: entry.id, retired: parent.id, version: exp.version }
}

function pause({ by, reason = null }) {
  const s = readState()
  writeState({ ...s, paused: true, pausedBy: by, pausedAt: new Date().toISOString(), pauseReason: reason ? String(reason).slice(0, 200) : null })
  return log({ kind: 'pause', by, reason })
}
function resume({ by }) {
  const s = readState()
  writeState({ ...s, paused: false, pausedBy: null, pausedAt: null, pauseReason: null })
  return log({ kind: 'resume', by })
}

/** The setting the research route reads when a request names no method. */
function researchDefaultMethod() {
  const m = readState().settings?.researchDefaultMethod
  return m === 'debate' ? 'debate' : 'single'
}

/** Everything the page shows. */
function status({ now = new Date() } = {}) {
  const rows = readLog()
  const state = readState()
  const audit = require('./ai-audit')
  const pb = require('./paper-broker')
  const snap = pb.snapshot()
  const L = ledger({
    aiMonthUsd: audit.spendSince(monthStart(now)).costUsd,
    agentMonthUsd: audit.spendSince(monthStart(now), { prefix: ROUTE_PREFIX }).costUsd,
    infraMonthUsd: Number(process.env.AGENT_INFRA_USD_MONTH) > 0 ? Number(process.env.AGENT_INFRA_USD_MONTH) : null,
    equityHistory: snap.equityHistory, startingCash: snap.performance.startingCash,
    notionalUsd: Number(process.env.AGENT_NOTIONAL_USD) > 0 ? Number(process.env.AGENT_NOTIONAL_USD) : null, now,
  })
  const cycles = rows.filter(r => r.kind === 'cycle-start')
  const lastStart = cycles.at(-1)
  return {
    enabled: process.env.AGENT_DESK_ENABLED === 'true',
    paused: !!state.paused, pausedBy: state.pausedBy ?? null, pausedAt: state.pausedAt ?? null, pauseReason: state.pauseReason ?? null,
    stopReason: stopReason(state),
    running: !!_running,
    budget: budgetStatus(now),
    ledger: L,
    settings: { researchDefaultMethod: researchDefaultMethod() },
    impact: rows.filter(r => r.kind === 'impact').at(-1) || null,
    lastCycle: lastStart ? { cycleId: lastStart.cycleId, at: lastStart.at, trigger: lastStart.trigger, steps: rows.filter(r => r.kind === 'step' && r.cycleId === lastStart.cycleId) } : null,
    proposals: proposalsOf(rows).slice(0, 50),
    experiments: require('./strategy-versions').latestById(require('./strategy-versions').loadVersions()).slice(0, 30),
    paper: { enabled: snap.enabled, performance: snap.performance, protections: snap.protections, execution: snap.execution, dayMark: snap.dayMark, equityHistory: snap.equityHistory.slice(-120) },
    limits: {
      note: 'Set by the operator in env vars. The desk has no write path to any of them.',
      AGENT_DESK_ENABLED: process.env.AGENT_DESK_ENABLED === 'true', AGENT_MONTHLY_BUDGET_USD: budgetUsd(),
      PAPER_TRADING_ENABLED: snap.enabled, paper: snap.limits, protections: snap.protectionLimits,
    },
  }
}

module.exports = {
  LOG_FILE, STATE_FILE, ROUTE_PREFIX, DEFAULT_BUDGET_USD, BUDGET_CEILING_USD, MAX_STRATEGIES_PER_CYCLE,
  stopReason, budgetUsd, budgetStatus, monthStart, readState, writeState,
  log, readLog, proposalsOf, proposalId,
  ledger, brainFindings, researchFinding, strategiesToImprove, wilson, measureImpact, researchImpact, impactHeadline,
  runCycle, decide, pause, resume, researchDefaultMethod, status,
  isRunning: () => !!_running,
}
