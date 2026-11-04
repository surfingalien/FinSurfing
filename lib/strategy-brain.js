'use strict'
/**
 * lib/strategy-brain.js — the Strategy Brain: an autonomous researcher that
 * builds new trading strategies (rule-based, model-composed and machine-
 * learning), tests them in the Quant Lab's engine, admits the survivors to the
 * strategy library on its own, and teaches itself which kinds of research are
 * worth its time.
 *
 * RESEARCH ARMS — the ways it can look for a strategy:
 *   ml:<model>    a machine-learning model as a rule (lib/ml-strategy.js) —
 *                 logistic, naive Bayes, tree, random forest, boosting,
 *                 linear SVM, LDA, MLP, and an ensemble it composes from three
 *                 of them; four variants per try (2 horizons × 2 thresholds)
 *   catalog-grid  random parameter draws for the four catalog strategies
 *                 (seeded, no model call)
 *   catalog-bracket  the same draws traded the way the paper broker trades:
 *                 an ATR bracket (stop, half at T1 then breakeven, T2, time
 *                 limit — lib/execution-model.js BRACKET_PRESETS) and slippage
 *                 of 10% of the previous day's range. The bracket is stored on
 *                 the strategy (params.exec), so forward re-tests use it too
 *   catalog-llm   a language model proposes catalog strategies from the
 *                 symbol's computed technicals (brain-evolution)
 *   dsl-llm       a language model composes NEW rules from the allow-listed
 *                 rule language (strategy-dsl; nothing it writes is executed)
 *
 * ONE JUDGE. Whatever the arm, a strategy enters the library only through the
 * existing gates: next-day fills, the asset's costs, 'validated' in BOTH the
 * older 70% and the newest 30% of five years, the deflated Sharpe for every
 * variant tried in the batch, and not from an overfitting batch (PBO); catalog
 * strategies also need a parameter plateau. After admission the nightly
 * evolution job re-tests every strategy FORWARD, on bars after it was found,
 * and retires the ones that decay.
 *
 * SELF-IMPROVEMENT (Thompson sampling). Each arm keeps a Beta posterior on
 * "a try finds a strategy that holds up": admissions count once, and forward
 * re-tests of what the arm admitted count twice — a pass forward is the
 * evidence that matters, a fail forward is the overfitting the backtest
 * missed. Every run samples the posteriors to decide where to spend its tries,
 * so arms that produce durable strategies get more tries and arms that
 * produce nothing — or backtest winners that die forward — are starved. The
 * rejection reasons per arm are kept as lessons.
 *
 * AUTONOMOUS, IN A BOX. It runs nightly and admits strategies without asking —
 * the library is research, not money. It never places an order (paper or
 * real), never changes a limit, prompt or its own code. Off unless
 * STRATEGY_BRAIN_ENABLED=true; an admin can pause it; it checks both before
 * every experiment. Its model calls share the Agent Desk's monthly budget
 * (AGENT_MONTHLY_BUDGET_USD); when that is spent, the model-using arms are
 * skipped and the free ones carry on.
 *
 * Store: data/strategy-brain.json (arms, pause, last 30 runs). Tests:
 * tests/strategy-brain.test.js
 */

const fs = require('fs')
const path = require('path')
const atomic = require('./atomic-write')
const { DATA_DIR } = require('./data-dir')
const L = require('./quant/linalg')

const STATE_FILE = path.join(DATA_DIR, 'strategy-brain.json')
const ROUTE = 'strategy-brain'
const DEFAULT_EXPERIMENTS = 8
const MAX_EXPERIMENTS = 30
const FORWARD_WEIGHT = 2
const PASS_SCORE = 50

function arms() {
  const ml = Object.keys(require('./ml-strategy').STRATEGY_MODELS).map(id => ({ id: `ml:${id}`, kind: 'ml', model: id, llm: false, label: `ML · ${require('./ml-strategy').STRATEGY_MODELS[id].label}` }))
  return [
    ...ml,
    { id: 'catalog-grid', kind: 'catalog-grid', llm: false, label: 'Catalog strategies · random parameters' },
    { id: 'catalog-bracket', kind: 'catalog-bracket', llm: false, label: 'Catalog strategies · bracket exits + slippage' },
    { id: 'catalog-llm', kind: 'catalog-llm', llm: true, label: 'Catalog strategies · proposed by a language model' },
    { id: 'dsl-llm', kind: 'dsl-llm', llm: true, label: 'New rules · composed by a language model' },
  ]
}

// ── State ────────────────────────────────────────────────────────────────────

function readState(file = STATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { arms: {}, runs: [] } }
}
function writeState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomic.writeJsonAtomic(file, state)
  return state
}

function stopReason(state = readState()) {
  if (process.env.STRATEGY_BRAIN_ENABLED !== 'true') return 'STRATEGY_BRAIN_ENABLED is not "true" (the operator\'s switch)'
  if (state.paused) return `paused by ${state.pausedBy || 'an admin'}`
  return null
}

function experimentsPerRun() {
  const n = Math.round(Number(process.env.STRATEGY_BRAIN_EXPERIMENTS))
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_EXPERIMENTS) : DEFAULT_EXPERIMENTS
}

// ── Learning: what each arm has earned ───────────────────────────────────────

/**
 * Forward record of the strategies each arm admitted, from the library
 * (validations marked `forward` are on bars after admission). Pure.
 */
function forwardByArm(libraryEntries) {
  const out = {}
  for (const e of libraryEntries || []) {
    const arm = e.origin?.by === 'strategy-brain' ? e.origin.arm : null
    if (!arm) continue
    const o = (out[arm] ||= { admitted: 0, active: 0, retired: 0, forwardPass: 0, forwardFail: 0 })
    o.admitted++
    if (e.status === 'retired') o.retired++; else o.active++
    for (const v of e.validations || []) if (v.forward) { if (v.score >= PASS_SCORE) o.forwardPass++; else o.forwardFail++ }
  }
  return out
}

/** Beta posterior per arm: successes = admissions + 2 × forward passes; failures = empty tries + 2 × forward fails. Pure. */
function posteriors(armList, stateArms = {}, forward = {}) {
  return armList.map(a => {
    const s = stateArms[a.id] || {}, f = forward[a.id] || {}
    const tries = s.tries || 0, hits = s.hits || 0
    const alpha = 1 + hits + FORWARD_WEIGHT * (f.forwardPass || 0)
    const beta = 1 + (tries - hits) + FORWARD_WEIGHT * (f.forwardFail || 0)
    return { ...a, tries, hits, admitted: s.admitted || 0, forward: f, alpha, beta, mean: alpha / (alpha + beta), reasons: s.reasons || {} }
  })
}

// Beta sampling from a seeded generator (Marsaglia–Tsang gamma), so a run is reproducible.
function gamma(k, g) {
  if (k < 1) return gamma(k + 1, g) * Math.pow(g.uniform(), 1 / k)
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x, v
    do { x = g.normal(); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = g.uniform()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
function betaSample(a, b, g) { const x = gamma(a, g), y = gamma(b, g); return x / (x + y) }

/**
 * Thompson sampling: draw from each eligible arm's posterior, pick the
 * highest. `eligible(arm)` lets the caller exclude model-using arms when the
 * budget is spent. Pure given the generator.
 */
function chooseArm(posts, g, eligible = () => true) {
  let best = null, bestDraw = -1
  for (const a of posts) {
    if (!eligible(a)) continue
    const d = betaSample(a.alpha, a.beta, g)
    if (d > bestDraw) { bestDraw = d; best = a }
  }
  return best
}

/** P(each arm is the best) by Monte Carlo over the posteriors — what the page shows. Pure. */
function probabilityBest(posts, { draws = 2000, seed = 7 } = {}) {
  const g = L.rng(seed), wins = Object.fromEntries(posts.map(a => [a.id, 0]))
  for (let i = 0; i < draws; i++) {
    let best = null, top = -1
    for (const a of posts) { const d = betaSample(a.alpha, a.beta, g); if (d > top) { top = d; best = a.id } }
    wins[best]++
  }
  return Object.fromEntries(Object.entries(wins).map(([k, v]) => [k, +(v / draws).toFixed(3)]))
}

// ── Where to look ────────────────────────────────────────────────────────────

/** Symbols for a run: the owner's holdings and the evolution universe, interleaved, rotated by day. Pure. */
function symbolPlan(holdings, universe, n, day = 0) {
  const h = [...new Set(holdings || [])], u = [...new Set(universe || [])].filter(s => !h.includes(s))
  const rot = (arr, k) => (arr.length ? arr.map((_, i) => arr[(i + k) % arr.length]) : [])
  const H = rot(h, day % Math.max(1, h.length)), U = rot(u, (day * 3) % Math.max(1, u.length))
  const out = []
  for (let i = 0; out.length < n && (i < H.length || i < U.length); i++) {
    if (i < H.length) out.push(H[i])
    if (out.length < n && i < U.length) out.push(U[i])
  }
  const base = out.slice()
  while (out.length < n && base.length) out.push(base[out.length % base.length])   // short lists repeat
  return out.slice(0, n)
}

/** Seeded random draws over the catalog's parameter ranges (orderings respected). Pure. */
function randomCatalogConfigs(g, count = 6) {
  const { STRATEGY_CATALOG } = require('./strategy-lab')
  const types = Object.keys(STRATEGY_CATALOG), out = []
  let guard = 0
  while (out.length < count && guard++ < count * 20) {
    const type = types[Math.floor(g.uniform() * types.length)], params = {}
    for (const [k, spec] of Object.entries(STRATEGY_CATALOG[type].params)) {
      const v = spec.min + g.uniform() * (spec.max - spec.min)
      params[k] = spec.int ? Math.round(v) : +v.toFixed(2)
    }
    if (params.fastPeriod >= params.slowPeriod || params.fast >= params.slow || params.oversold >= params.overbought) continue
    out.push({ strategy: type, params, name: `${type} (random draw)`, rationale: 'Strategy Brain: random parameter draw', marketFit: '' })
  }
  return out
}

// ── One experiment ───────────────────────────────────────────────────────────

/**
 * Run one experiment for `arm` on `symbol`. Returns { admitted, tried,
 * reasons: {reason: count}, survivors }. Every dependency is injectable.
 */
async function runExperiment(arm, symbol, D) {
  const origin = { by: 'strategy-brain', arm: arm.id, at: D.now().toISOString() }
  const reasons = {}, survivors = []
  const note = r => { reasons[r] = (reasons[r] || 0) + 1 }

  if (arm.kind === 'catalog-llm' || arm.kind === 'dsl-llm') {
    const fn = arm.kind === 'catalog-llm' ? D.evolution.discoverStrategies : D.evolution.discoverCompositions
    const r = await fn({ symbols: [symbol], route: ROUTE, origin, headers: { 'x-internal': '1' } })
    const tried = r.proposed || 0
    if (!tried) note('no usable proposal')
    if (r.invalid) reasons['rule rejected by the allow-list'] = r.invalid
    const notValidated = tried - (r.invalid || 0) - (r.validated || 0)
    if (notValidated > 0) reasons['not validated in both windows'] = notValidated
    if (r.deflated) reasons['deflated Sharpe below the luck benchmark'] = r.deflated
    if (r.overfit) reasons['batch overfits (PBO)'] = r.overfit
    for (const s of r.survivors || []) survivors.push({ symbol, name: s.description || s.strategy, fitness: s.fitness })
    return { admitted: r.stored || 0, tried, reasons, survivors }
  }

  const bars = await D.fetchBars(symbol).catch(() => [])
  // No data is not a verdict on the method: the try is recorded but not counted against the arm.
  if (!bars?.length || bars.length < 500) { note('not enough price history'); return { admitted: 0, tried: 0, reasons, survivors, skipped: true } }
  const series = D.toSeries(bars), costBps = D.costBps(symbol)

  if (arm.kind === 'ml') {
    const ms = D.mlStrategy
    const out = await ms.evaluateMlBatch(series, ms.variantsFor(arm.model), { costBps, yieldFn: D.yieldFn })
    let admitted = 0
    for (const x of out) {
      if (!x.admit) { note(x.reason.replace(/[\d.]+/g, '#')); continue }
      const entry = D.library.recordValidation(
        { symbol, strategy: ms.ML_TYPE, params: x.params, name: x.name, description: x.description, rationale: `Strategy Brain (${arm.label})`, marketFit: '', origin },
        { metrics: x.metrics, verdict: 'validated', deflated: x.deflated, pbo: x.pbo, cpcv: x.cpcv },
      )
      admitted++; survivors.push({ symbol, name: x.name, fitness: entry.fitness })
    }
    return { admitted, tried: out.length, reasons, survivors }
  }

  if (arm.kind === 'catalog-grid') {
    const configs = randomCatalogConfigs(D.rng(), 6)
    const out = D.strategyLab.evaluateProposals(configs, series.timestamps, series.closes, 10000, { costBps, opens: series.opens })
    let admitted = 0
    for (const p of out) {
      if (p.verdict !== 'validated') { note(`not validated (${p.verdict})`); continue }
      if (p.deflated && !p.deflated.pass) { note('deflated Sharpe below the luck benchmark'); continue }
      const sel = D.strategyLab.selectionProblem ? D.strategyLab.selectionProblem(p) : (p.pbo?.overfit ? 'batch overfits (PBO)' : null)
      if (sel) { note(sel); continue }
      const entry = D.library.recordValidation({ symbol, strategy: p.strategy, params: p.params, name: `${p.strategy} on ${symbol}`, rationale: 'Strategy Brain (random parameters)', marketFit: '', origin }, { metrics: p.metrics, verdict: p.verdict, deflated: p.deflated, pbo: p.pbo, cpcv: p.cpcv })
      admitted++; survivors.push({ symbol, name: `${p.strategy} ${JSON.stringify(p.params)}`, fitness: entry.fitness })
    }
    return { admitted, tried: out.length, reasons, survivors }
  }
  if (arm.kind === 'catalog-bracket') {
    const EM = require('./execution-model')
    const g = D.rng()
    const preset = EM.BRACKET_PRESETS[Math.floor(g.uniform() * EM.BRACKET_PRESETS.length)]
    const exec = { exits: preset.exits, slippage: EM.RESEARCH_SLIPPAGE }
    const configs = randomCatalogConfigs(g, 6)
    const out = D.strategyLab.evaluateProposals(configs, series.timestamps, series.closes, 10000, {
      costBps, opens: series.opens, highs: series.highs, lows: series.lows, volumes: series.volumes, ...exec,
    })
    let admitted = 0
    for (const p of out) {
      if (p.verdict !== 'validated') { note(`not validated (${p.verdict})`); continue }
      if (p.deflated && !p.deflated.pass) { note('deflated Sharpe below the luck benchmark'); continue }
      const sel = D.strategyLab.selectionProblem ? D.strategyLab.selectionProblem(p) : null
      if (sel) { note(sel); continue }
      const entry = D.library.recordValidation(
        { symbol, strategy: p.strategy, params: { ...p.params, exec }, name: `${p.strategy} on ${symbol} · bracket ${preset.id}`, rationale: 'Strategy Brain (random parameters, bracket exits)', marketFit: '', origin },
        { metrics: p.metrics, verdict: p.verdict, deflated: p.deflated, pbo: p.pbo, cpcv: p.cpcv },
      )
      admitted++; survivors.push({ symbol, name: `${p.strategy} ${JSON.stringify(p.params)} · ${preset.id}`, fitness: entry.fitness })
    }
    return { admitted, tried: out.length, reasons, survivors }
  }
  throw new Error(`unknown arm ${arm.id}`)
}

// ── The run ──────────────────────────────────────────────────────────────────

let _running = false

async function run({ trigger = 'schedule', by = null, deps = {} } = {}) {
  const D = {
    library: deps.library || require('./strategy-library'),
    evolution: deps.evolution || require('./brain-evolution'),
    mlStrategy: deps.mlStrategy || require('./ml-strategy'),
    strategyLab: deps.strategyLab || require('./strategy-lab'),
    fetchBars: deps.fetchBars || (s => require('./internal-api').fetchDailyBars(s, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 })),
    toSeries: deps.toSeries || require('./brain-evolution').toSeries,
    costBps: deps.costBps || (s => require('../utils/backtest').costBpsForSymbol(s)),
    holdings: deps.holdings || defaultHoldings,
    budget: deps.budget || (() => require('./agent-desk').budgetStatus()),
    // No provider key = the model-using methods cannot run; skip them rather than score an outage as a failure.
    aiAvailable: deps.aiAvailable || (() => !!(process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY)),
    now: deps.now || (() => new Date()),
    yieldFn: deps.yieldFn || (() => new Promise(r => setImmediate(r))),
    rng: null,
  }
  const blocked = stopReason()
  if (blocked) return { ran: false, reason: blocked }
  if (_running) return { ran: false, reason: 'a run is already in progress' }
  _running = true
  const started = D.now()
  const seed = Math.floor(started.getTime() / 86_400_000)
  const g = L.rng(seed)
  D.rng = () => L.rng(seed + Math.floor(g.uniform() * 1e6))
  const runRec = { at: started.toISOString(), trigger, by, experiments: [], stopped: null }
  try {
    const n = experimentsPerRun()
    const holdings = await D.holdings().catch(() => [])
    const symbols = symbolPlan(holdings, D.evolution.EVOLUTION_UNIVERSE, n, seed)
    for (let i = 0; i < n; i++) {
      const st = readState()
      const stop = stopReason(st)
      if (stop) { runRec.stopped = stop; break }
      const forward = forwardByArm(D.library.readLibrary())
      const posts = posteriors(arms(), st.arms, forward)
      const budget = D.budget()
      const llmOk = !budget.exhausted && D.aiAvailable()
      const arm = chooseArm(posts, g, a => !a.llm || llmOk)
      const symbol = symbols[i]
      if (!arm || !symbol) break
      const t0 = Date.now()
      let res
      try { res = await runExperiment(arm, symbol, D) } catch (e) { res = { admitted: 0, tried: 0, reasons: { [`error: ${e.message}`]: 1 }, survivors: [] } }
      // Learn: a try that admitted something is a hit; reasons accumulate as lessons.
      if (res.skipped) { runRec.experiments.push({ arm: arm.id, symbol, tried: 0, admitted: 0, reasons: res.reasons, survivors: [], skipped: true, ms: Date.now() - t0 }); continue }
      const next = readState()
      const a = (next.arms ||= {})[arm.id] ||= { tries: 0, hits: 0, admitted: 0, reasons: {} }
      a.tries++; if (res.admitted > 0) a.hits++; a.admitted += res.admitted
      for (const [r, c] of Object.entries(res.reasons || {})) a.reasons[r] = (a.reasons[r] || 0) + c
      a.lastAt = new Date().toISOString()
      writeState(next)
      runRec.experiments.push({ arm: arm.id, symbol, tried: res.tried, admitted: res.admitted, reasons: res.reasons, survivors: res.survivors, ms: Date.now() - t0, budgetExhausted: budget.exhausted })
    }
  } finally {
    runRec.finishedAt = new Date().toISOString()
    const st = readState()
    st.runs = [...(st.runs || []), runRec].slice(-30)
    writeState(st)
    _running = false
  }
  return { ran: true, ...runRec }
}

async function defaultHoldings() {
  const email = process.env.MORNING_BRIEF_EMAIL || process.env.ADMIN_EMAIL
  if (!email) return []
  const uh = require('./user-holdings')
  return uh.holdingSymbols(await uh.userIdForEmail(email))
}

function pause({ by }) { const s = readState(); return writeState({ ...s, paused: true, pausedBy: by, pausedAt: new Date().toISOString() }) }
function resume() { const s = readState(); return writeState({ ...s, paused: false, pausedBy: null, pausedAt: null }) }

/** Everything the Quant Lab tab shows. */
function status() {
  const st = readState()
  const library = require('./strategy-library').readLibrary()
  const forward = forwardByArm(library)
  const posts = posteriors(arms(), st.arms, forward)
  const pBest = probabilityBest(posts)
  return {
    enabled: process.env.STRATEGY_BRAIN_ENABLED === 'true',
    paused: !!st.paused, pausedBy: st.pausedBy ?? null, stopReason: stopReason(st), running: _running,
    experimentsPerRun: experimentsPerRun(),
    budget: (() => { try { return require('./agent-desk').budgetStatus() } catch { return null } })(),
    arms: posts.map(a => ({ id: a.id, label: a.label, llm: a.llm, tries: a.tries, hits: a.hits, admitted: a.admitted, forward: a.forward, mean: +a.mean.toFixed(3), pBest: pBest[a.id], lessons: Object.entries(a.reasons).sort((x, y) => y[1] - x[1]).slice(0, 4) })).sort((a, b) => b.mean - a.mean),
    strategies: library.filter(e => e.origin?.by === 'strategy-brain').map(e => ({ id: e.id, symbol: e.symbol, name: e.name, arm: e.origin.arm, status: e.status, fitness: e.fitness, description: e.description, discoveredAt: e.discoveredAt, forwardPasses: (e.validations || []).filter(v => v.forward && v.score >= PASS_SCORE).length, forwardTests: (e.validations || []).filter(v => v.forward).length })),
    runs: (st.runs || []).slice(-10).reverse(),
  }
}

module.exports = {
  STATE_FILE, ROUTE, DEFAULT_EXPERIMENTS, MAX_EXPERIMENTS, FORWARD_WEIGHT,
  arms, readState, writeState, stopReason, experimentsPerRun,
  forwardByArm, posteriors, betaSample, chooseArm, probabilityBest, symbolPlan, randomCatalogConfigs,
  runExperiment, run, pause, resume, status, isRunning: () => _running,
}
