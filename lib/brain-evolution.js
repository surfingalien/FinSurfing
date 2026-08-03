'use strict'
/**
 * lib/brain-evolution.js
 *
 * The nightly evolution cycle — where the AI Brain actually changes.
 *
 * Two loops run here, both with a deterministic falsifier the LLM cannot argue
 * with:
 *
 *   1. STRATEGY EVOLUTION (discover → validate → survive)
 *      - RE-VALIDATE first: every strategy already in the library is re-run on
 *        the LATEST bars. Strategies that stopped working lose fitness and are
 *        retired automatically. This is the selection pressure — without it a
 *        library is just an append log of lucky backtests.
 *      - DISCOVER second: the LLM proposes new configs for a rotating set of
 *        symbols; each is immediately backtested, and only survivors are kept.
 *      The model proposes; utils/backtest.js decides. Every number stored came
 *      from the engine.
 *
 *   2. OUTCOME RESOLUTION (act → measure → calibrate)
 *      Resolves pending cross-surface decisions in the learning store against
 *      real historical bars at the intended horizon, so calibration reflects
 *      what actually happened rather than what was hoped for.
 *
 * Symbol rotation matters: re-proposing for the same names nightly would just
 * overfit them. Each cycle takes a bounded slice, rotating by day-of-year, so
 * coverage broadens over time without unbounded API spend.
 *
 * Tests: tests/brain-evolution.test.js (pure helpers)
 */

const { fetchDailyBars }  = require('./internal-api')
const { compactTaLine }   = require('./technical-indicators')
const { buildProposalPrompt, parseProposals, evaluateProposals } = require('./strategy-lab')
const { buildCompositionPrompt, parseCompositions, generateRuleSignals, describeRule } = require('./strategy-dsl')
const { simulate, simulateWithSignals } = require('../utils/backtest')
const library             = require('./strategy-library')
const learningStore       = require('./learning-store')

// Bounded per-cycle work — this runs unattended, so it must have a hard
// ceiling on both LLM calls and data fetches.
const MAX_DISCOVERY_SYMBOLS  = 6
const MAX_REVALIDATIONS      = 25
const PROPOSALS_PER_SYMBOL   = 3
const BACKTEST_RANGE         = '2y'
const MIN_BARS               = 60

// Composed strategies (built from DSL primitives rather than the fixed
// catalog) are stored under this strategy type.
const COMPOSED_TYPE = 'composed_rule'
// Symbols per cycle for composition — kept smaller than catalog discovery
// because the search space is far larger and each proposal costs a backtest.
const MAX_COMPOSITION_SYMBOLS = 3
const COMPOSITIONS_PER_SYMBOL = 3

// Universe the discovery loop rotates through.
const EVOLUTION_UNIVERSE = [
  'NVDA','MSFT','AAPL','AMZN','GOOGL','META','TSLA','AMD','AVGO','CRM',
  'JPM','BAC','GS','V','MA','LLY','UNH','JNJ','ABBV','XOM',
  'CVX','WMT','COST','CAT','HD','SPY','QQQ','IWM','GLD','TLT',
  'BTC-USD','ETH-USD','SOL-USD',
]

/**
 * Deterministic rotating slice — same day ⇒ same symbols (idempotent reruns),
 * different days ⇒ full coverage over time. Pure.
 */
function rotateUniverse(universe, count, date = new Date()) {
  const list = (universe || []).filter(Boolean)
  if (!list.length || count <= 0) return []
  const n = Math.min(count, list.length)
  // Day-of-year as the rotation cursor
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  const doy   = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000)
  const offset = (doy * n) % list.length
  return Array.from({ length: n }, (_, i) => list[(offset + i) % list.length])
}

/** Bars → the shape simulate() and compactTaLine() need. Pure. */
function toSeries(bars) {
  return {
    timestamps: bars.map(b => Math.floor(b.t / 1000)),
    opens:  bars.map(b => b.o ?? b.c),
    highs:  bars.map(b => b.h ?? b.c),
    lows:   bars.map(b => b.l ?? b.c),
    closes: bars.map(b => b.c),
    volumes: bars.map(b => b.v ?? 0),
  }
}

// ── 1a. Re-validation: selection pressure on the existing library ────────────

async function revalidateLibrary({ headers = {}, limit = MAX_REVALIDATIONS } = {}) {
  const entries = library.readLibrary().filter(e => e.status !== 'retired')
  if (!entries.length) return { revalidated: 0, retired: 0, survived: 0 }

  // Oldest-validated first — everything gets re-examined in rotation.
  const due = [...entries]
    .sort((a, b) => new Date(a.lastValidatedAt || 0) - new Date(b.lastValidatedAt || 0))
    .slice(0, limit)

  // Group by symbol so each symbol's bars are fetched once.
  const bySymbol = new Map()
  for (const e of due) {
    if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, [])
    bySymbol.get(e.symbol).push(e)
  }

  let revalidated = 0, retired = 0, survived = 0
  for (const [symbol, group] of bySymbol) {
    const bars = await fetchDailyBars(symbol, { range: BACKTEST_RANGE, headers, timeoutMs: 20_000 })
    if (bars.length < MIN_BARS) continue
    const { timestamps, closes } = toSeries(bars)

    const series = toSeries(bars)
    for (const entry of group) {
      try {
        // Composed strategies are re-validated through the interpreter; catalog
        // strategies through generateSignals. Both land in the SAME trade
        // engine, so survival is judged on one scale.
        const { metrics } = entry.strategy === COMPOSED_TYPE
          ? simulateWithSignals(timestamps, closes, generateRuleSignals(entry.params.rule, series))
          : simulate(timestamps, closes, entry.strategy, entry.params)
        const updated = library.recordValidation(
          { symbol: entry.symbol, strategy: entry.strategy, params: entry.params },
          { metrics, verdict: metrics.totalTrades < 2 ? 'insufficient_trades' : (metrics.alpha > 0 ? 'validated' : 'rejected') },
        )
        revalidated++
        if (updated.status === 'retired') retired++
        else survived++
      } catch (e) {
        console.warn(`[brain-evolution] revalidate ${entry.symbol}/${entry.strategy} failed:`, e.message)
      }
    }
  }
  return { revalidated, retired, survived }
}

// ── 1b. Discovery: propose new configs, keep only what the engine validates ──

async function discoverStrategies({ headers = {}, symbols = null, date = new Date() } = {}) {
  // Lazy require: only the discovery stage needs an LLM, so the pure helpers
  // (and their tests) don't pull in the Anthropic SDK.
  const { getRouter } = require('./ai-router')
  const aiRouter = getRouter('brain-evolution')
  const targets  = symbols?.length ? symbols : rotateUniverse(EVOLUTION_UNIVERSE, MAX_DISCOVERY_SYMBOLS, date)

  let proposed = 0, validated = 0, stored = 0
  const survivors = []

  for (const symbol of targets) {
    try {
      const bars = await fetchDailyBars(symbol, { range: BACKTEST_RANGE, headers, timeoutMs: 20_000 })
      if (bars.length < MIN_BARS) continue
      const { timestamps, opens, highs, lows, closes, volumes } = toSeries(bars)
      const taLine = compactTaLine(symbol, opens, highs, lows, closes, volumes)

      const prompt = buildProposalPrompt({ symbol, range: BACKTEST_RANGE, taLine, count: PROPOSALS_PER_SYMBOL })
      const { text } = await aiRouter.call({ prompt, maxTokens: 2048, symbols: [symbol] })

      const proposals = parseProposals(text, PROPOSALS_PER_SYMBOL)
      proposed += proposals.length
      if (!proposals.length) continue

      // The engine is the judge — the LLM's rationale never affects the verdict.
      const evaluated = evaluateProposals(proposals, timestamps, closes)
      for (const p of evaluated) {
        if (p.verdict !== 'validated') continue   // only survivors enter the library
        validated++
        const entry = library.recordValidation(
          { symbol, strategy: p.strategy, params: p.params, name: p.name, rationale: p.rationale, marketFit: p.marketFit },
          { metrics: p.metrics, verdict: p.verdict },
        )
        stored++
        survivors.push({ symbol, strategy: p.strategy, fitness: entry.fitness, generation: entry.generation })
      }
    } catch (e) {
      console.warn(`[brain-evolution] discovery ${symbol} failed:`, e.message)
    }
  }
  return { symbols: targets, proposed, validated, stored, survivors }
}

// ── 1c. Composition: invent strategies outside the fixed catalog ────────────
// This is the search-space widening. The model composes rule TREES from
// whitelisted primitives; lib/strategy-dsl.js validates them structurally, a
// deterministic interpreter turns them into signals, and the same backtest
// engine judges them. No LLM-authored code is ever executed.

async function discoverCompositions({ headers = {}, symbols = null, date = new Date() } = {}) {
  const { getRouter } = require('./ai-router')
  const aiRouter = getRouter('brain-evolution')
  // Offset the rotation so composition explores different names than the
  // catalog discovery running in the same cycle.
  const targets = symbols?.length
    ? symbols
    : rotateUniverse(EVOLUTION_UNIVERSE, MAX_COMPOSITION_SYMBOLS,
        new Date(date.getTime() + MAX_DISCOVERY_SYMBOLS * 86400000))

  let proposed = 0, invalid = 0, validated = 0, stored = 0
  const survivors = []

  for (const symbol of targets) {
    try {
      const bars = await fetchDailyBars(symbol, { range: BACKTEST_RANGE, headers, timeoutMs: 20_000 })
      if (bars.length < MIN_BARS) continue
      const series = toSeries(bars)
      const taLine = compactTaLine(symbol, series.opens, series.highs, series.lows, series.closes, series.volumes)

      const prompt = buildCompositionPrompt({ symbol, range: BACKTEST_RANGE, taLine, count: COMPOSITIONS_PER_SYMBOL })
      const { text } = await aiRouter.call({ prompt, maxTokens: 3000, symbols: [symbol] })

      // Structurally invalid trees are discarded here, before anything runs.
      const { strategies, rejected } = parseCompositions(text, COMPOSITIONS_PER_SYMBOL)
      proposed += strategies.length + rejected.length
      invalid  += rejected.length
      if (rejected.length) {
        console.warn(`[brain-evolution] ${symbol}: ${rejected.length} invalid rule(s) rejected — ${rejected.map(r => r.reason).join('; ')}`)
      }

      for (const s of strategies) {
        let metrics
        try {
          metrics = simulateWithSignals(series.timestamps, series.closes, generateRuleSignals(s.rule, series)).metrics
        } catch (e) {
          invalid++
          console.warn(`[brain-evolution] ${symbol}: rule failed to evaluate — ${e.message}`)
          continue
        }
        // Same bar as catalog strategies: must beat buy & hold with enough
        // trades to mean anything. A novel rule gets no special leniency.
        const passed = metrics.totalTrades >= 2 && metrics.alpha > 0
        if (!passed) continue
        validated++

        const entry = library.recordValidation(
          {
            symbol, strategy: COMPOSED_TYPE, params: { rule: s.rule },
            name: s.name, rationale: s.rationale, marketFit: s.marketFit,
            description: s.description,
          },
          { metrics, verdict: 'validated' },
        )
        stored++
        survivors.push({ symbol, description: s.description, fitness: entry.fitness, generation: entry.generation })
        console.log(`[brain-evolution] composed survivor ${symbol}: ${describeRule(s.rule)} (alpha ${metrics.alpha}%, fitness ${entry.fitness})`)
      }
    } catch (e) {
      console.warn(`[brain-evolution] composition ${symbol} failed:`, e.message)
    }
  }
  return { symbols: targets, proposed, invalid, validated, stored, survivors }
}

// ── 2. Resolve cross-surface decision outcomes ───────────────────────────────

function benchmarkFor(symbol) {
  return /-USD$/.test(symbol || '') ? 'BTC-USD' : 'SPY'
}

/** Close of the bar nearest a target time, within tolerance. Pure. */
function nearestClose(bars, targetMs, toleranceDays = 4) {
  if (!bars?.length) return null
  let best = null, bestDist = Infinity
  for (const b of bars) {
    const d = Math.abs(b.t - targetMs)
    if (d < bestDist) { bestDist = d; best = b }
  }
  return (!best || bestDist > toleranceDays * 86400000) ? null : best.c
}

async function resolveDecisionOutcomes({ headers = {}, horizonDays = 7, now = Date.now() } = {}) {
  const all     = learningStore.readDecisions()
  const pending = learningStore.pendingDecisions(all, { horizonDays, now })
  if (!pending.length) return { resolved: 0, pending: 0 }

  const symbols = [...new Set(pending.map(d => d.symbol))]
  const benches = [...new Set(pending.map(d => benchmarkFor(d.symbol)))]
  const barsMap = {}
  await Promise.all([...new Set([...symbols, ...benches])].map(async sym => {
    barsMap[sym] = await fetchDailyBars(sym, { range: '1y', headers, timeoutMs: 20_000 })
  }))

  const pendingIds = new Set(pending.map(d => `${d.surface}|${d.symbol}|${d.at}`))
  let resolved = 0

  const updated = all.map(d => {
    if (!pendingIds.has(`${d.surface}|${d.symbol}|${d.at}`)) return d
    const bars = barsMap[d.symbol]
    if (!bars?.length) return d
    const decidedMs = new Date(d.at).getTime()
    const targetMs  = decidedMs + horizonDays * 86400000
    const px = nearestClose(bars, targetMs)
    if (px == null) return d

    // Benchmark move over the SAME window, so a win is a real relative win
    const bBars = barsMap[benchmarkFor(d.symbol)] || []
    const bBase = nearestClose(bBars, decidedMs)
    const bPx   = nearestClose(bBars, targetMs)
    const benchRetPct = (bBase > 0 && bPx != null) ? +(((bPx - bBase) / bBase) * 100).toFixed(2) : null

    resolved++
    return learningStore.resolveDecision(d, { price: px, benchRetPct, horizonDays })
  })

  if (resolved) learningStore.writeDecisions(updated)
  return { resolved, pending: pending.length - resolved }
}

// ── Full cycle ────────────────────────────────────────────────────────────────

/**
 * One evolution cycle. Each stage is independently fault-tolerant: a failure
 * in discovery must not prevent re-validation or outcome resolution from
 * running, or one bad night would stall learning entirely.
 */
async function runEvolutionCycle({ headers = {}, date = new Date(), skipDiscovery = false } = {}) {
  const startedAt = new Date().toISOString()
  const result = { startedAt, revalidation: null, discovery: null, composition: null, outcomes: null, library: null, errors: [] }

  try {
    result.revalidation = await revalidateLibrary({ headers })
  } catch (e) {
    result.errors.push(`revalidation: ${e.message}`)
    console.error('[brain-evolution] revalidation failed:', e.stack || e.message)
  }

  if (!skipDiscovery) {
    try {
      result.discovery = await discoverStrategies({ headers, date })
    } catch (e) {
      result.errors.push(`discovery: ${e.message}`)
      console.error('[brain-evolution] discovery failed:', e.stack || e.message)
    }
    // Composition runs separately from catalog discovery so a failure in the
    // larger, more speculative search can't take the reliable one down with it.
    try {
      result.composition = await discoverCompositions({ headers, date })
    } catch (e) {
      result.errors.push(`composition: ${e.message}`)
      console.error('[brain-evolution] composition failed:', e.stack || e.message)
    }
  }

  try {
    result.outcomes = await resolveDecisionOutcomes({ headers })
  } catch (e) {
    result.errors.push(`outcomes: ${e.message}`)
    console.error('[brain-evolution] outcome resolution failed:', e.stack || e.message)
  }

  // Prune AFTER the cycle so retirements from this run take effect immediately.
  try {
    const pruned = library.pruneLibrary(library.readLibrary())
    library.writeLibrary(pruned)
    result.library = library.libraryStats(pruned)
  } catch (e) {
    result.errors.push(`prune: ${e.message}`)
  }

  result.finishedAt = new Date().toISOString()
  console.log(`[brain-evolution] cycle complete: revalidated=${result.revalidation?.revalidated ?? 0} retired=${result.revalidation?.retired ?? 0} discovered=${result.discovery?.stored ?? 0} composed=${result.composition?.stored ?? 0} (${result.composition?.invalid ?? 0} invalid) outcomes=${result.outcomes?.resolved ?? 0} library=${result.library?.active ?? 0} active`)
  return result
}

module.exports = {
  EVOLUTION_UNIVERSE, MAX_DISCOVERY_SYMBOLS, MAX_REVALIDATIONS,
  COMPOSED_TYPE, MAX_COMPOSITION_SYMBOLS, COMPOSITIONS_PER_SYMBOL,
  // pure
  rotateUniverse, toSeries, nearestClose, benchmarkFor,
  // stages
  revalidateLibrary, discoverStrategies, discoverCompositions, resolveDecisionOutcomes, runEvolutionCycle,
}
